import { describe, expect, it } from "vitest";
import type { AnimeTitle } from "@shared/types";
import {
  ANILIST_RATING_SOURCE,
  mergeExternalMetadata,
  normalizeTitleForMatch,
  pickBestMatch,
  sanitizeAniListDescription,
  scoreCandidate,
  type ExternalMetadata,
} from "@shared/anilistMetadata";

function title(overrides: Partial<AnimeTitle> = {}): AnimeTitle {
  return { id: "1", sourceId: "anichi", englishName: "Frieren", ...overrides };
}

function external(overrides: Partial<ExternalMetadata> = {}): ExternalMetadata {
  return { anilistId: 154587, ...overrides };
}

describe("sanitizeAniListDescription", () => {
  it("turns AniList's HTML into plain text", () => {
    expect(sanitizeAniListDescription("A hero <i>and</i> an elf.<br><br>Ten years pass.")).toBe(
      "A hero and an elf.\n\nTen years pass.",
    );
  });

  it("drops spoiler blocks entirely rather than just their tags", () => {
    const text = sanitizeAniListDescription('Safe. <span class="markdown_spoiler">The hero dies.</span>');
    expect(text).toBe("Safe.");
  });

  it("drops the trailing source note", () => {
    expect(sanitizeAniListDescription("A synopsis.\n(Source: MAL)")).toBe("A synopsis.");
  });

  it("decodes entities and returns null for an empty description", () => {
    expect(sanitizeAniListDescription("Tom &amp; Jerry&#039;s")).toBe("Tom & Jerry's");
    expect(sanitizeAniListDescription("<br>")).toBeNull();
    expect(sanitizeAniListDescription(null)).toBeNull();
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
    const score = scoreCandidate(anime, { anilistId: 1, names: ["Frieren: Beyond Journey's End"], year: 2023, type: "tv" });
    expect(score).toBe(1);
  });

  it("ignores a one-year disagreement between sites", () => {
    const near = scoreCandidate(anime, { anilistId: 1, names: ["Frieren: Beyond Journey's End"], year: 2024, type: "tv" });
    const off = scoreCandidate(anime, { anilistId: 1, names: ["Frieren: Beyond Journey's End"], year: 2018, type: "tv" });
    expect(near).toBe(1);
    expect(off).toBeLessThan(near);
  });

  it("refuses a candidate that shares no name", () => {
    expect(scoreCandidate(anime, { anilistId: 2, names: ["Bocchi the Rock!"], year: 2023, type: "tv" })).toBe(0);
  });

  it("matches on a synonym when the main names differ", () => {
    const dubbed = title({ englishName: "Sousou no Frieren", synonyms: ["Frieren at the Funeral"], year: 2023 });
    expect(scoreCandidate(dubbed, { anilistId: 3, names: ["Frieren at the Funeral"], year: 2023 })).toBeGreaterThan(0.6);
  });

  it("derives the type from an AniList format when the candidate has none", () => {
    const movie = title({ englishName: "A Silent Voice", type: "movie", year: 2016 });
    expect(scoreCandidate(movie, { anilistId: 4, names: ["A Silent Voice"], year: 2016, format: "MOVIE" })).toBe(1);
  });
});

describe("pickBestMatch", () => {
  const anime = title({ englishName: "Mushoku Tensei", year: 2023, type: "tv" });

  it("separates a sequel from its movie by year and type", () => {
    const best = pickBestMatch(anime, [
      { anilistId: 10, names: ["Mushoku Tensei"], year: 2021, type: "tv" },
      { anilistId: 11, names: ["Mushoku Tensei"], year: 2023, type: "tv" },
      { anilistId: 12, names: ["Mushoku Tensei"], year: 2023, type: "movie" },
    ]);
    expect(best?.anilistId).toBe(11);
  });

  it("returns nothing rather than a weak guess", () => {
    expect(pickBestMatch(anime, [{ anilistId: 20, names: ["Something Else"], year: 2023 }])).toBeNull();
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

  it("files the score as a ten-point rating without duplicating itself on a refetch", () => {
    const source = title({ ratings: [{ source: "Shikimori", value: 8.9 }] });
    const once = mergeExternalMetadata(source, external({ averageScore: 92 }));
    const twice = mergeExternalMetadata(once, external({ averageScore: 91 }));
    expect(twice.ratings).toEqual([
      { source: ANILIST_RATING_SOURCE, value: 9.1, votes: null },
      { source: "Shikimori", value: 8.9 },
    ]);
  });

  it("converts nothing when AniList has no score", () => {
    const source = title({ ratings: [{ source: "Shikimori", value: 8.9 }] });
    expect(mergeExternalMetadata(source, external({ averageScore: null })).ratings).toEqual([{ source: "Shikimori", value: 8.9 }]);
  });
});
