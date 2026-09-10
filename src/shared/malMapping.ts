// Jikan's response (MAL's unofficial read-only API - no key, no account), reshaped into the
// provider-neutral ExternalMetadata. Pure, so the mapping is testable without touching the
// network; the client itself is main/metadata/mal.ts.
import { sanitizeDescription, type ExternalMetadata, type MatchCandidate } from "./externalMetadata";
import type { AnimeStatus, AnimeType } from "./types";

export interface JikanTitle {
  type?: string | null;
  title?: string | null;
}

export interface JikanNamed {
  name?: string | null;
}

export interface JikanAnime {
  mal_id: number;
  titles?: JikanTitle[] | null;
  title?: string | null;
  title_english?: string | null;
  title_japanese?: string | null;
  title_synonyms?: string[] | null;
  synopsis?: string | null;
  images?: { webp?: { large_image_url?: string | null } | null; jpg?: { large_image_url?: string | null; image_url?: string | null } | null } | null;
  type?: string | null;
  status?: string | null;
  episodes?: number | null;
  score?: number | null;
  scored_by?: number | null;
  rating?: string | null;
  year?: number | null;
  aired?: { from?: string | null } | null;
  genres?: JikanNamed[] | null;
  themes?: JikanNamed[] | null;
  demographics?: JikanNamed[] | null;
  studios?: JikanNamed[] | null;
  approved?: boolean | null;
}

// MAL writes these as display words rather than constants, so the map is keyed on the lowercased
// value and anything unrecognised falls back to the source's own.
const TYPE_TO_TYPE: Record<string, AnimeType> = {
  tv: "tv",
  "tv special": "special",
  movie: "movie",
  ova: "ova",
  ona: "ona",
  special: "special",
  music: "special",
  cm: "special",
  pv: "special",
};

const STATUS_TO_STATUS: Record<string, AnimeStatus> = {
  "currently airing": "ongoing",
  "finished airing": "released",
  "not yet aired": "announced",
};

export function mapMalType(type: string | null | undefined): AnimeType | null {
  return type ? (TYPE_TO_TYPE[type.trim().toLowerCase()] ?? null) : null;
}

export function mapMalStatus(status: string | null | undefined): AnimeStatus | null {
  return status ? (STATUS_TO_STATUS[status.trim().toLowerCase()] ?? null) : null;
}

function titleOfType(anime: JikanAnime, type: string): string | null {
  return (anime.titles ?? []).find((entry) => entry.type?.toLowerCase() === type)?.title ?? null;
}

function names(anime: JikanAnime): string[] {
  const fromTitles = (anime.titles ?? []).map((entry) => entry.title);
  return [anime.title, anime.title_english, anime.title_japanese, ...fromTitles, ...(anime.title_synonyms ?? [])].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

function airedYear(anime: JikanAnime): number | null {
  if (anime.year != null) return anime.year;
  // A fair share of entries (specials and older titles especially) leave `year` null and carry the
  // date only on `aired.from`, and the year is half of what separates a sequel from its prequel
  // when matching.
  const from = anime.aired?.from;
  if (!from) return null;
  const year = new Date(from).getUTCFullYear();
  return Number.isFinite(year) ? year : null;
}

export function toExternalMetadata(anime: JikanAnime): ExternalMetadata {
  return {
    provider: "mal",
    externalId: anime.mal_id,
    malId: anime.mal_id,
    // Jikan publishes no AniList id, so a switch to AniList still has to search by name once -
    // unlike the other direction, where AniList hands over `idMal`.
    anilistId: null,
    // MAL's "Default" title is the romaji one, which is what this field means everywhere else.
    romajiName: titleOfType(anime, "default") ?? anime.title ?? null,
    englishName: anime.title_english ?? titleOfType(anime, "english"),
    nativeName: anime.title_japanese ?? titleOfType(anime, "japanese"),
    synonyms: anime.title_synonyms ?? [],
    description: sanitizeDescription(anime.synopsis),
    // WebP first: MAL's CDN serves it at roughly half the bytes of the JPEG for the same poster,
    // and Chromium renders both.
    posterUrl: anime.images?.webp?.large_image_url ?? anime.images?.jpg?.large_image_url ?? anime.images?.jpg?.image_url ?? null,
    // MAL has no banner artwork of any kind.
    bannerUrl: null,
    studios: (anime.studios ?? []).map((studio) => studio.name).filter((name): name is string => !!name),
    // MAL splits what every source (and AniList) calls genres across three lists - "Fantasy" is a
    // genre, "Isekai" a theme, "Shounen" a demographic - and the app has one genre row to show
    // them in.
    genres: [...(anime.genres ?? []), ...(anime.themes ?? []), ...(anime.demographics ?? [])]
      .map((entry) => entry.name)
      .filter((name): name is string => !!name),
    year: airedYear(anime),
    type: mapMalType(anime.type),
    status: mapMalStatus(anime.status),
    episodeCount: anime.episodes ?? null,
    // Already out of 10, the same scale ExternalMetadata.score uses.
    score: anime.score ?? null,
    scoreVotes: anime.scored_by ?? null,
    ageRating: anime.rating ?? null,
    // MAL publishes a weekly broadcast slot ("Fridays at 23:00 (JST)") but no timestamp for the
    // next episode, so a title described from MAL keeps whatever countdown its source reported.
    nextEpisodeAt: null,
    isAdult: (anime.rating ?? "").toLowerCase().startsWith("rx"),
  };
}

export function toMatchCandidate(anime: JikanAnime): MatchCandidate {
  return {
    externalId: anime.mal_id,
    names: names(anime),
    year: airedYear(anime),
    type: mapMalType(anime.type),
  };
}
