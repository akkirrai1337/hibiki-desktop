// AniList's GraphQL response, reshaped into the provider-neutral ExternalMetadata. Pure, so the
// mapping is testable without touching the network; the client itself is main/metadata/anilist.ts.
import { sanitizeDescription, type ExternalMetadata, type MatchCandidate } from "./externalMetadata";
import type { AnimeStatus, AnimeType } from "./types";

/** The field selection both the by-id and the search query ask for. */
export const ANILIST_MEDIA_FIELDS = `
  id
  idMal
  title { romaji english native }
  synonyms
  description
  coverImage { extraLarge large }
  bannerImage
  genres
  seasonYear
  startDate { year }
  format
  status
  episodes
  averageScore
  isAdult
  studios(isMain: true) { nodes { name } }
  nextAiringEpisode { airingAt }
`;

export interface AniListMedia {
  id: number;
  idMal?: number | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null;
  synonyms?: string[] | null;
  description?: string | null;
  coverImage?: { extraLarge?: string | null; large?: string | null } | null;
  bannerImage?: string | null;
  genres?: string[] | null;
  seasonYear?: number | null;
  startDate?: { year?: number | null } | null;
  format?: string | null;
  status?: string | null;
  episodes?: number | null;
  averageScore?: number | null;
  isAdult?: boolean | null;
  studios?: { nodes?: Array<{ name?: string | null }> | null } | null;
  nextAiringEpisode?: { airingAt?: number | null } | null;
}

const FORMAT_TO_TYPE: Record<string, AnimeType> = {
  TV: "tv",
  TV_SHORT: "tv",
  MOVIE: "movie",
  OVA: "ova",
  ONA: "ona",
  SPECIAL: "special",
  MUSIC: "special",
};

// CANCELLED and HIATUS have no equivalent in AnimeStatus (three values, mirrored from Android's own
// enum) and are deliberately absent: an unmapped status falls back to the source's, which at least
// says something the app can render, rather than being forced into a wrong one.
const MEDIA_STATUS_TO_STATUS: Record<string, AnimeStatus> = {
  RELEASING: "ongoing",
  FINISHED: "released",
  NOT_YET_RELEASED: "announced",
};

export function mapAniListFormat(format: string | null | undefined): AnimeType | null {
  return format ? (FORMAT_TO_TYPE[format] ?? null) : null;
}

export function mapAniListStatus(status: string | null | undefined): AnimeStatus | null {
  return status ? (MEDIA_STATUS_TO_STATUS[status] ?? null) : null;
}

export function toExternalMetadata(media: AniListMedia): ExternalMetadata {
  return {
    provider: "anilist",
    externalId: media.id,
    anilistId: media.id,
    malId: media.idMal ?? null,
    romajiName: media.title?.romaji ?? null,
    englishName: media.title?.english ?? null,
    nativeName: media.title?.native ?? null,
    synonyms: media.synonyms ?? [],
    description: sanitizeDescription(media.description),
    posterUrl: media.coverImage?.extraLarge ?? media.coverImage?.large ?? null,
    bannerUrl: media.bannerImage ?? null,
    studios: (media.studios?.nodes ?? []).map((node) => node?.name).filter((name): name is string => !!name),
    genres: media.genres ?? [],
    year: media.seasonYear ?? media.startDate?.year ?? null,
    type: mapAniListFormat(media.format),
    status: mapAniListStatus(media.status),
    episodeCount: media.episodes ?? null,
    // AniList scores out of 100; ExternalMetadata.score is out of 10, like every source's own.
    score: media.averageScore != null ? Math.round(media.averageScore) / 10 : null,
    // AniList's averageScore carries no vote count in this selection, and asking for popularity
    // instead would report something else entirely.
    scoreVotes: null,
    // AniList has no age-rating field at all, only an adult flag - so this always falls back to
    // whatever the source reported.
    ageRating: null,
    // AniList reports airing times in epoch *seconds*; AnimeTitle.nextEpisodeAt is milliseconds
    // (see the title page's isUpcomingDay, which feeds it straight to `new Date`).
    nextEpisodeAt: media.nextAiringEpisode?.airingAt != null ? media.nextAiringEpisode.airingAt * 1000 : null,
    isAdult: media.isAdult ?? false,
  };
}

export function toMatchCandidate(media: AniListMedia): MatchCandidate {
  return {
    externalId: media.id,
    names: [media.title?.romaji, media.title?.english, media.title?.native, ...(media.synonyms ?? [])].filter(
      (value): value is string => typeof value === "string",
    ),
    year: media.seasonYear ?? media.startDate?.year ?? null,
    type: mapAniListFormat(media.format),
  };
}
