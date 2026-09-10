import { describe, expect, it } from "vitest";
import type { AnimeTitle } from "@shared/types";
import {
  mergeExternalMetadata,
  metadataProviderOrder,
  normalizeTitleForMatch,
  pickBestMatch,
  PROVIDER_RATING_SOURCE,
  sanitizeDescription,
  scoreCandidate,
  type ExternalMetadata,
} from "@shared/externalMetadata";

function title(overrides: Partial<AnimeTitle> = {}): AnimeTitle {
  return { id: "1", sourceId: "anichi", englishName: "Frieren", ...overrides };
}

function external(overrides: Partial<ExternalMetadata> = {}): ExternalMetadata {
  return { provider: "anilist", externalId: 154587, anilistId: 154587, ...overrides };
}

describe("sanitizeDescription", () => {
  it("turns AniList's HTML into plain text", () => {
    expect(sanitizeDescription("A hero <i>and</i> an elf.<br><br>Ten years pass.")).toBe(
      "A hero and an elf.\n\nTen years pass.",
    );
  });

  it("drops spoiler blocks entirely rather than just their tags", () => {
    const text = sanitizeDescription('Safe. <span class="markdown_spoiler">The hero dies.</span>');
    expect(text).toBe("Safe.");
  });

  it("drops the trailing source note", () => {
    expect(sanitizeDescription("A synopsis.\n(Source: MAL)")).toBe("A synopsis.");
  });

  it("decodes entities and returns null for an empty description", () => {
    expect(sanitizeDescription("Tom &amp; Jerry&#039;s")).toBe("Tom & Jerry's");
    expect(sanitizeDescription("<br>")).toBeNull();
    expect(sanitizeDescription(null)).toBeNull();
  });
});

describe("normalizeTitleForMatch", () => {
  it("collapses the season wording sites disagree about", () => {
    expect(normalizeTitleForMatch("Mushoku Tensei II: 2nd Season")).toBe(normalizeTitleForMatch("Mushoku Tensei II - Season 2"));
  });

  it("keeps non-latin scripts", () => {
    expect(normalizeTitleForMatch("葬送のフリーレン")).toBe("葬送のフリーレン");
  });
});

describe("scoreCandidate", () => {
  const anime = title({ englishName: "Frieren: Beyond Journey's End", year: 2023, type: "tv" });

  it("scores an exact name with a matching year and type at the top", () => {
    const score = scoreCandidate(anime, { externalId: 1, names: ["Frieren: Beyond Journey's End"], year: 2023, type: "tv" });
    expect(score).toBe(1);
  });

  it("ignores a one-year disagreement between sites", () => {
    const near = scoreCandidate(anime, { externalId: 1, names: ["Frieren: Beyond Journey's End"], year: 2024, type: "tv" });
    const off = scoreCandidate(anime, { externalId: 1, names: ["Frieren: Beyond Journey's End"], year: 2018, type: "tv" });
    expect(near).toBe(1);
    expect(off).toBeLessThan(near);
  });

  it("refuses a candidate that shares no name", () => {
    expect(scoreCandidate(anime, { externalId: 2, names: ["Bocchi the Rock!"], year: 2023, type: "tv" })).toBe(0);
  });

  it("matches on a synonym when the main names differ", () => {
    const dubbed = title({ englishName: "Sousou no Frieren", synonyms: ["Frieren at the Funeral"], year: 2023 });
    expect(scoreCandidate(dubbed, { externalId: 3, names: ["Frieren at the Funeral"], year: 2023 })).toBeGreaterThan(0.6);
  });

  it("scores a candidate with no type on names and year alone", () => {
    const movie = title({ englishName: "A Silent Voice", type: "movie", year: 2016 });
    const scored = scoreCandidate(movie, { externalId: 4, names: ["A Silent Voice"], year: 2016 });
    expect(scored).toBeGreaterThan(0.6);
    expect(scored).toBeLessThan(1);
  });
});

describe("pickBestMatch", () => {
  const anime = title({ englishName: "Mushoku Tensei", year: 2023, type: "tv" });

  it("separates a sequel from its movie by year and type", () => {
    const best = pickBestMatch(anime, [
      { externalId: 10, names: ["Mushoku Tensei"], year: 2021, type: "tv" },
      { externalId: 11, names: ["Mushoku Tensei"], year: 2023, type: "tv" },
      { externalId: 12, names: ["Mushoku Tensei"], year: 2023, type: "movie" },
    ]);
    expect(best?.externalId).toBe(11);
  });

  it("returns nothing rather than a weak guess", () => {
    expect(pickBestMatch(anime, [{ externalId: 20, names: ["Something Else"], year: 2023 }])).toBeNull();
  });
});

describe("metadataProviderOrder", () => {
  const preferences = { enabled: true, overrides: {}, provider: "anilist" as const, fallbackEnabled: true };

  it("asks nothing for a source that did not ask for it", () => {
    expect(metadataProviderOrder(preferences, "ani-liberty", false)).toEqual([]);
  });

  it("puts the preferred provider first and the other behind it", () => {
    expect(metadataProviderOrder(preferences, "anichi", true)).toEqual(["anilist", "mal"]);
    expect(metadataProviderOrder({ ...preferences, provider: "mal" }, "anichi", true)).toEqual(["mal", "anilist"]);
  });

  it("asks only the preferred provider when fallback is off", () => {
    expect(metadataProviderOrder({ ...preferences, fallbackEnabled: false }, "anichi", true)).toEqual(["anilist"]);
  });

  it("follows the global switch, and a per-source override over it", () => {
    expect(metadataProviderOrder({ ...preferences, enabled: false }, "anichi", true)).toEqual([]);
    expect(metadataProviderOrder({ ...preferences, enabled: false, overrides: { anichi: true } }, "anichi", true)).toEqual(["anilist", "mal"]);
    expect(metadataProviderOrder({ ...preferences, overrides: { anichi: false } }, "anichi", true)).toEqual([]);
  });
});

describe("mergeExternalMetadata", () => {
  it("keeps the source's title unchanged when there is no match", () => {
    const source = title({ description: "Source text" });
    expect(mergeExternalMetadata(source, null)).toBe(source);
  });

  it("never touches what the source knows about playback", () => {
    const source = title({ availableEpisodeCount: 7, id: "abc", sourceId: "anichi" });
    const merged = mergeExternalMetadata(source, external({ episodeCount: 28 }));
    expect(merged.availableEpisodeCount).toBe(7);
    expect(merged.episodeCount).toBe(28);
    expect(merged.id).toBe("abc");
    expect(merged.sourceId).toBe("anichi");
  });

  it("keeps the source's related titles, whose ids only that source can resolve", () => {
    const related = [{ id: "sequel-1", title: "Season 2" }];
    expect(mergeExternalMetadata(title({ relatedAnime: related }), external()).relatedAnime).toBe(related);
  });

  it("keeps the source's value for a field AniList left empty", () => {
    const source = title({ description: "Source text", genres: ["Fantasy"], posterUrl: "https://source/poster.jpg" });
    const merged = mergeExternalMetadata(source, external({ description: null, genres: [], posterUrl: undefined }));
    expect(merged.description).toBe("Source text");
    expect(merged.genres).toEqual(["Fantasy"]);
    expect(merged.posterUrl).toBe("https://source/poster.jpg");
  });

  it("keeps a Russian name AniList cannot provide", () => {
    const merged = mergeExternalMetadata(title({ russianName: "Провожающая в последний путь Фрирен" }), external({ englishName: "Frieren" }));
    expect(merged.russianName).toBe("Провожающая в последний путь Фрирен");
    expect(merged.englishName).toBe("Frieren");
  });

  it("files the score under its provider without duplicating itself on a refetch", () => {
    const source = title({ ratings: [{ source: "Shikimori", value: 8.9 }] });
    const once = mergeExternalMetadata(source, external({ score: 9.2 }));
    const twice = mergeExternalMetadata(once, external({ score: 9.1, scoreVotes: 918_577 }));
    expect(twice.ratings).toEqual([
      { source: PROVIDER_RATING_SOURCE.anilist, value: 9.1, votes: 918_577 },
      { source: "Shikimori", value: 8.9 },
    ]);
  });

  it("replaces the other provider's rating on a switch instead of showing both", () => {
    const fromAniList = mergeExternalMetadata(title(), external({ score: 9.2 }));
    const fromMal = mergeExternalMetadata(fromAniList, { provider: "mal", externalId: 52991, malId: 52991, score: 9.25 });
    expect(fromMal.ratings).toEqual([{ source: PROVIDER_RATING_SOURCE.mal, value: 9.25, votes: null }]);
  });

  it("adds no rating when the provider has no score", () => {
    const source = title({ ratings: [{ source: "Shikimori", value: 8.9 }] });
    expect(mergeExternalMetadata(source, external({ score: null })).ratings).toEqual([{ source: "Shikimori", value: 8.9 }]);
  });

  it("takes an age rating from a provider that has one, and keeps the source's otherwise", () => {
    const source = title({ ageRating: "16+" });
    expect(mergeExternalMetadata(source, external({ ageRating: null })).ageRating).toBe("16+");
    expect(mergeExternalMetadata(source, external({ ageRating: "PG-13 - Teens 13 or older" })).ageRating).toBe("PG-13 - Teens 13 or older");
  });
});
