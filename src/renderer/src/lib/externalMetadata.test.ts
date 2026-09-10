import { describe, expect, it } from "vitest";
import type { AnimeTitle } from "@shared/types";
import {
  mergeExternalMetadata,
  metadataProviderOrder,
  metadataEntryUrl,
  normalizeTitleForMatch,
  parseMetadataReference,
  pickSourceTitleFor,
  searchQueriesFor,
  sourceSearchQueriesFor,
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

describe("normalizeTitleForMatch, on seasons", () => {
  it("reads a Roman season numeral as the number it is", () => {
    expect(normalizeTitleForMatch("Classroom of the Elite IV")).toBe("classroom of the elite 4");
    expect(normalizeTitleForMatch("Is It Wrong to Try to Pick Up Girls in a Dungeon? V")).toBe(
      "is it wrong to try to pick up girls in a dungeon 5",
    );
  });

  it("leaves a numeral that is part of the name alone", () => {
    // Only a trailing one is read as a season, and only from the values a season takes.
    expect(normalizeTitleForMatch("X")).toBe("x");
    expect(normalizeTitleForMatch("Ergo Proxy")).toBe("ergo proxy");
  });
});

describe("searchQueriesFor", () => {
  it("offers the name as written first", () => {
    expect(searchQueriesFor({ englishName: "Frieren: Beyond Journey's End" })[0]).toBe("Frieren: Beyond Journey's End");
  });

  it("strips a tag the source appended for its own catalog", () => {
    expect(searchQueriesFor({ englishName: "Jujutsu Kaisen (TV)" })).toEqual(["Jujutsu Kaisen (TV)", "Jujutsu Kaisen"]);
    expect(searchQueriesFor({ englishName: "Onimai: I'm Now Your Sister! [UNCENSORED]" })[1]).toBe("Onimai: I'm Now Your Sister!");
  });

  it("flattens dashes used as brackets, which stop a text search finding the show at all", () => {
    expect(searchQueriesFor({ englishName: "Re:ZERO -Starting Life in Another World- Season 3" })).toEqual([
      "Re:ZERO -Starting Life in Another World- Season 3",
      "Re:ZERO Starting Life in Another World Season 3",
      "Re:ZERO Starting Life in Another World",
    ]);
  });

  it("counts two spellings of one query as one", () => {
    expect(searchQueriesFor({ englishName: "Death Note" })).toEqual(["Death Note"]);
  });

  it("falls back to the other names a title carries", () => {
    expect(searchQueriesFor({ englishName: "Frieren", originalName: "Sousou no Frieren" })).toEqual([
      "Frieren",
      "Sousou no Frieren",
    ]);
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

  it("matches the same season written two different ways", () => {
    const fourthSeason = title({ englishName: "Classroom of the Elite IV", year: null, type: null });
    const score = scoreCandidate(fourthSeason, {
      externalId: 5,
      names: ["Classroom of the Elite 4th Season: Second Year, First Semester"],
    });
    expect(score).toBeGreaterThan(0.6);
  });

  it("still refuses a sequel offered for its own first season", () => {
    const firstSeason = title({ englishName: "Frieren: Beyond Journey's End", year: 2023, type: "tv" });
    expect(scoreCandidate(firstSeason, { externalId: 6, names: ["Sousou no Frieren 2nd Season"], year: 2026, type: "tv" })).toBe(0);
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

  it("puts the preferred provider first and the others behind it", () => {
    expect(metadataProviderOrder(preferences, "anichi", true)).toEqual(["anilist", "mal", "kitsu"]);
    expect(metadataProviderOrder({ ...preferences, provider: "kitsu" }, "anichi", true)).toEqual(["kitsu", "anilist", "mal"]);
  });

  it("asks only the preferred provider when fallback is off", () => {
    expect(metadataProviderOrder({ ...preferences, fallbackEnabled: false }, "anichi", true)).toEqual(["anilist"]);
  });

  it("follows the global switch, and a per-source override over it", () => {
    expect(metadataProviderOrder({ ...preferences, enabled: false }, "anichi", true)).toEqual([]);
    expect(metadataProviderOrder({ ...preferences, enabled: false, overrides: { anichi: true } }, "anichi", true)).toEqual(["anilist", "mal", "kitsu"]);
    expect(metadataProviderOrder({ ...preferences, overrides: { anichi: false } }, "anichi", true)).toEqual([]);
  });
});

describe("parseMetadataReference", () => {
  it("reads the provider off a pasted page URL, whichever is selected", () => {
    expect(parseMetadataReference("https://anilist.co/anime/154587/Sousou-no-Frieren/", "mal")).toEqual({
      provider: "anilist",
      externalId: 154587,
    });
    expect(parseMetadataReference("https://myanimelist.net/anime/52991/Sousou_no_Frieren", "anilist")).toEqual({
      provider: "mal",
      externalId: 52991,
    });
  });

  it("reads a bare id as the selected provider's, since the two number spaces are unrelated", () => {
    expect(parseMetadataReference("52991", "mal")).toEqual({ provider: "mal", externalId: 52991 });
    expect(parseMetadataReference(" 154587 ", "anilist")).toEqual({ provider: "anilist", externalId: 154587 });
  });

  it("reads a Kitsu link on either of its domains, by slug or by id", () => {
    expect(parseMetadataReference("https://kitsu.app/anime/sousou-no-frieren", "mal")).toEqual({
      provider: "kitsu",
      slug: "sousou-no-frieren",
    });
    expect(parseMetadataReference("https://kitsu.io/anime/46474", "mal")).toEqual({
      provider: "kitsu",
      externalId: 46474,
    });
  });

  it("returns nothing for a plain title, which is a search and not a reference", () => {
    expect(parseMetadataReference("Frieren", "anilist")).toBeNull();
    expect(parseMetadataReference("", "anilist")).toBeNull();
  });

  it("round-trips through the entry URL it builds", () => {
    for (const provider of ["anilist", "mal"] as const) {
      expect(parseMetadataReference(metadataEntryUrl(provider, 1234), provider)).toEqual({ provider, externalId: 1234 });
    }
  });
});

describe("pickSourceTitleFor", () => {
  // What a source's search actually returns: a name, sometimes a year, rarely a type - which is why
  // this direction is the weaker one.
  const entry = external({
    romajiName: "Sousou no Frieren",
    englishName: "Frieren: Beyond Journey's End",
    year: 2023,
    type: "tv",
  });

  it("picks the title whose name is the entry's, by any of its names", () => {
    const picked = pickSourceTitleFor(entry, [
      { id: "a", englishName: "Bocchi the Rock!" },
      { id: "b", englishName: "Sousou no Frieren" },
    ]);
    expect(picked?.animeId).toBe("b");
  });

  it("separates a season from its sequel when the source says which year it is", () => {
    const picked = pickSourceTitleFor(entry, [
      { id: "s2", englishName: "Frieren: Beyond Journey's End", year: 2026 },
      { id: "s1", englishName: "Frieren: Beyond Journey's End", year: 2023 },
    ]);
    expect(picked?.animeId).toBe("s1");
  });

  it("refuses a sequel offered for the entry's own first season", () => {
    expect(pickSourceTitleFor(entry, [{ id: "s2", englishName: "Frieren: Beyond Journey's End Season 2" }])).toBeNull();
  });

  it("returns nothing rather than the closest of several unrelated titles", () => {
    expect(pickSourceTitleFor(entry, [{ id: "x", englishName: "Death Note" }, { id: "y", englishName: "One Piece" }])).toBeNull();
  });

  it("has nothing to decide on when the source returned nothing", () => {
    expect(pickSourceTitleFor(entry, [])).toBeNull();
  });
});

describe("sourceSearchQueriesFor", () => {
  it("asks a source for the romaji name first, then the English one", () => {
    expect(sourceSearchQueriesFor(external({ romajiName: "Sousou no Frieren", englishName: "Frieren: Beyond Journey's End" }))).toEqual([
      "Sousou no Frieren",
      "Frieren: Beyond Journey's End",
    ]);
  });

  it("counts one name written twice as one query", () => {
    expect(sourceSearchQueriesFor(external({ romajiName: "Death Note", englishName: "Death Note" }))).toEqual(["Death Note"]);
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
