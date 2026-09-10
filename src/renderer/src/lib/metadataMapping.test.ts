import { describe, expect, it } from "vitest";
import { toExternalMetadata as fromAniList, toMatchCandidate as aniListCandidate, type AniListMedia } from "@shared/anilistMapping";
import { mapMalStatus, mapMalType, toExternalMetadata as fromMal, toMatchCandidate as malCandidate, type JikanAnime } from "@shared/malMapping";

// Both fixtures are the real fields the clients ask for, trimmed from live responses for the same
// show (AniList media 154587 / MAL 52991) - so the two mappings can be compared against each other
// and not just against themselves.
const anilistMedia: AniListMedia = {
  id: 154587,
  idMal: 52991,
  title: { romaji: "Sousou no Frieren", english: "Frieren: Beyond Journey's End", native: "葬送のフリーレン" },
  synonyms: ["Frieren at the Funeral"],
  description: "The adventure is over<br>but life goes on.<br><br>(Source: Crunchyroll)",
  coverImage: { extraLarge: "https://anilist/cover-xl.jpg", large: "https://anilist/cover-l.jpg" },
  bannerImage: "https://anilist/banner.jpg",
  genres: ["Adventure", "Drama", "Fantasy"],
  seasonYear: 2023,
  startDate: { year: 2023 },
  format: "TV",
  status: "FINISHED",
  episodes: 28,
  averageScore: 90,
  isAdult: false,
  studios: { nodes: [{ name: "Madhouse" }] },
  nextAiringEpisode: null,
};

const jikanAnime: JikanAnime = {
  mal_id: 52991,
  title: "Sousou no Frieren",
  title_english: "Frieren: Beyond Journey's End",
  title_japanese: "葬送のフリーレン",
  title_synonyms: ["Frieren at the Funeral", "Frieren The Slayer"],
  titles: [
    { type: "Default", title: "Sousou no Frieren" },
    { type: "English", title: "Frieren: Beyond Journey's End" },
    { type: "Japanese", title: "葬送のフリーレン" },
  ],
  synopsis: "The adventure is over but life goes on.\n\n[Written by MAL Rewrite]",
  images: { webp: { large_image_url: "https://mal/poster.webp" }, jpg: { large_image_url: "https://mal/poster.jpg" } },
  type: "TV",
  status: "Finished Airing",
  episodes: 28,
  score: 9.25,
  scored_by: 918_577,
  rating: "PG-13 - Teens 13 or older",
  year: 2023,
  aired: { from: "2023-09-29T00:00:00+00:00" },
  genres: [{ name: "Adventure" }, { name: "Drama" }, { name: "Fantasy" }],
  themes: [],
  demographics: [{ name: "Shounen" }],
  studios: [{ name: "Madhouse" }],
  approved: true,
};

describe("AniList mapping", () => {
  const mapped = fromAniList(anilistMedia);

  it("normalizes names, artwork and the cross-provider id", () => {
    expect(mapped.provider).toBe("anilist");
    expect(mapped.externalId).toBe(154587);
    expect(mapped.malId).toBe(52991);
    expect(mapped.romajiName).toBe("Sousou no Frieren");
    expect(mapped.posterUrl).toBe("https://anilist/cover-xl.jpg");
    expect(mapped.bannerUrl).toBe("https://anilist/banner.jpg");
  });

  it("converts the hundred-point score and leaves the age rating to the source", () => {
    expect(mapped.score).toBe(9);
    expect(mapped.ageRating).toBeNull();
  });

  it("strips the HTML and the attribution tail from the description", () => {
    expect(mapped.description).toBe("The adventure is over\nbut life goes on.");
  });

  it("converts an airing timestamp from seconds to milliseconds", () => {
    const airing = fromAniList({ ...anilistMedia, status: "RELEASING", nextAiringEpisode: { airingAt: 1_700_000_000 } });
    expect(airing.nextEpisodeAt).toBe(1_700_000_000_000);
    expect(airing.status).toBe("ongoing");
  });

  it("leaves an unmapped status null so the source's own survives the merge", () => {
    expect(fromAniList({ ...anilistMedia, status: "CANCELLED" }).status).toBeNull();
  });

  it("offers every title it knows as a match candidate", () => {
    expect(aniListCandidate(anilistMedia).names).toContain("Frieren at the Funeral");
    expect(aniListCandidate(anilistMedia).type).toBe("tv");
  });
});

describe("MAL mapping", () => {
  const mapped = fromMal(jikanAnime);

  it("normalizes names, artwork and the cross-provider id", () => {
    expect(mapped.provider).toBe("mal");
    expect(mapped.externalId).toBe(52991);
    expect(mapped.malId).toBe(52991);
    expect(mapped.anilistId).toBeNull();
    expect(mapped.romajiName).toBe("Sousou no Frieren");
    // MAL has no banner artwork, so the page keeps whatever the source gave it.
    expect(mapped.bannerUrl).toBeNull();
  });

  it("prefers the smaller WebP poster over the JPEG", () => {
    expect(mapped.posterUrl).toBe("https://mal/poster.webp");
  });

  it("keeps the ten-point score as it stands, with its vote count", () => {
    expect(mapped.score).toBe(9.25);
    expect(mapped.scoreVotes).toBe(918_577);
  });

  it("carries the age rating AniList does not have", () => {
    expect(mapped.ageRating).toBe("PG-13 - Teens 13 or older");
  });

  it("folds themes and demographics into the one genre row the app shows", () => {
    expect(mapped.genres).toEqual(["Adventure", "Drama", "Fantasy", "Shounen"]);
  });

  it("drops the writer credit from the synopsis", () => {
    expect(mapped.description).toBe("The adventure is over but life goes on.");
  });

  it("reads the year off the airing date when the year field is empty", () => {
    expect(fromMal({ ...jikanAnime, year: null }).year).toBe(2023);
    expect(malCandidate({ ...jikanAnime, year: null }).year).toBe(2023);
  });

  it("maps MAL's display words for type and status", () => {
    expect(mapMalType("TV")).toBe("tv");
    expect(mapMalType("TV Special")).toBe("special");
    expect(mapMalStatus("Currently Airing")).toBe("ongoing");
    expect(mapMalStatus("Not yet aired")).toBe("announced");
    expect(mapMalType("Unheard Of")).toBeNull();
  });

  it("has no airing timestamp to report", () => {
    expect(fromMal({ ...jikanAnime, status: "Currently Airing" }).nextEpisodeAt).toBeNull();
  });
});

describe("the two providers described the same show", () => {
  it("agree on everything the title page shows as a fact", () => {
    const a = fromAniList(anilistMedia);
    const m = fromMal(jikanAnime);
    expect([a.year, a.type, a.status, a.episodeCount]).toEqual([m.year, m.type, m.status, m.episodeCount]);
    expect(a.englishName).toBe(m.englishName);
    expect(a.studios).toEqual(m.studios);
  });
});
