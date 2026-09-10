import { describe, expect, it } from "vitest";
import { toExternalMetadata as fromAniList, toMatchCandidate as aniListCandidate, type AniListMedia } from "@shared/anilistMapping";
import { mapMalStatus, mapMalType, toExternalMetadata as fromMal, toMatchCandidate as malCandidate, type JikanAnime } from "@shared/malMapping";
import {
  mapKitsuStatus,
  mapKitsuSubtype,
  toExternalMetadata as fromKitsu,
  toMatchCandidate as kitsuCandidate,
  type KitsuAnime,
  type KitsuIncluded,
} from "@shared/kitsuMapping";

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

// Kitsu answers JSON:API, so the fields an entry points at arrive in one flat `included` array
// shared by every result of a search - the linkage below is what says which are this title's.
const kitsuAnime: KitsuAnime = {
  id: "46474",
  attributes: {
    slug: "sousou-no-frieren",
    synopsis: "The adventure is over but life goes on.",
    canonicalTitle: "Sousou no Frieren",
    titles: { en: "Frieren: Beyond Journey's End", en_jp: "Sousou no Frieren", ja_jp: "葬送のフリーレン", it_it: "Frieren: Oltre la Fine del Viaggio" },
    abbreviatedTitles: ["Frieren at the Funeral"],
    averageRating: "88.81",
    userCount: 21_050,
    startDate: "2023-09-29",
    nextRelease: null,
    ageRating: "PG",
    ageRatingGuide: "Teens 13 or Older",
    subtype: "TV",
    status: "finished",
    posterImage: { original: "https://kitsu/poster.jpg", large: "https://kitsu/poster-large.jpg" },
    coverImage: { original: "https://kitsu/cover.jpg" },
    episodeCount: 28,
    nsfw: false,
  },
  relationships: {
    categories: { data: [{ type: "categories", id: "156" }, { type: "categories", id: "10" }] },
    mappings: { data: [{ type: "mappings", id: "332791" }, { type: "mappings", id: "321557" }] },
  },
};

const kitsuIncluded: KitsuIncluded[] = [
  { id: "156", type: "categories", attributes: { title: "Fantasy" } },
  { id: "10", type: "categories", attributes: { title: "Adventure" } },
  { id: "999", type: "categories", attributes: { title: "Someone else's category" } },
  { id: "332791", type: "mappings", attributes: { externalSite: "myanimelist/anime", externalId: "52991" } },
  { id: "321557", type: "mappings", attributes: { externalSite: "anilist/anime", externalId: "154587" } },
  { id: "343007", type: "mappings", attributes: { externalSite: "myanimelist/anime", externalId: "59978" } },
];

describe("Kitsu mapping", () => {
  const mapped = fromKitsu(kitsuAnime, kitsuIncluded);

  it("publishes both other providers' ids, which is why it can match without searching them", () => {
    expect(mapped.provider).toBe("kitsu");
    expect(mapped.externalId).toBe(46474);
    expect(mapped.malId).toBe(52991);
    expect(mapped.anilistId).toBe(154587);
  });

  it("takes only the included entries this title actually points at", () => {
    expect(mapped.genres).toEqual(["Fantasy", "Adventure"]);
    expect(mapped.malId).not.toBe(59978);
  });

  it("carries banner art and an age rating, which no single other provider does", () => {
    expect(mapped.bannerUrl).toBe("https://kitsu/cover.jpg");
    expect(mapped.ageRating).toBe("PG - Teens 13 or Older");
  });

  it("converts the hundred-point score and reports how many rated it", () => {
    expect(mapped.score).toBe(8.9);
    expect(mapped.scoreVotes).toBe(21_050);
  });

  it("reads a next-episode time as a timestamp rather than a date string", () => {
    const airing = fromKitsu({
      ...kitsuAnime,
      attributes: { ...kitsuAnime.attributes, status: "current", nextRelease: "2026-01-16T15:00:00.000Z" },
    });
    expect(airing.nextEpisodeAt).toBe(Date.parse("2026-01-16T15:00:00.000Z"));
    expect(airing.status).toBe("ongoing");
  });

  it("offers every localized title to the matcher", () => {
    const names = kitsuCandidate(kitsuAnime).names;
    expect(names).toContain("Frieren: Oltre la Fine del Viaggio");
    expect(names).toContain("Frieren at the Funeral");
    expect(kitsuCandidate(kitsuAnime).year).toBe(2023);
  });

  it("maps Kitsu's own words for subtype and status", () => {
    expect(mapKitsuSubtype("TV")).toBe("tv");
    expect(mapKitsuSubtype("ONA")).toBe("ona");
    expect(mapKitsuStatus("current")).toBe("ongoing");
    expect(mapKitsuStatus("upcoming")).toBe("announced");
    expect(mapKitsuStatus("something new")).toBeNull();
  });

  it("agrees with the other two about the facts the title page prints", () => {
    const a = fromAniList(anilistMedia);
    expect([mapped.year, mapped.type, mapped.status, mapped.episodeCount]).toEqual([a.year, a.type, a.status, a.episodeCount]);
    expect(mapped.englishName).toBe(fromMal(jikanAnime).englishName);
  });
});
