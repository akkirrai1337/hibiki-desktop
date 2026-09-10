// AniList as a *metadata* provider: a source that declares `useExternalMetadata` in its manifest
// keeps everything describing what is actually playable (episodes, playback groups, player links,
// availableEpisodeCount) and hands the descriptive half of its AnimeTitle - name, description,
// poster, genres, score, airing - to AniList instead.
//
// Everything in this file is pure on purpose: matching a source title to an AniList entry and
// deciding which field wins are the two things worth testing, and neither needs a network or a
// database to answer. The GraphQL client and the caches around it live in
// main/metadata/anilistProvider.ts.
import type { AnimeStatus, AnimeTitle, AnimeType, TitleRating } from "./types";

/** The normalized shape a provider returns - AniList's own GraphQL response reshaped once, at the
 * edge, so nothing downstream has to know about `coverImage.extraLarge` or `seasonYear`. */
export interface ExternalMetadata {
  anilistId: number;
  malId?: number | null;
  romajiName?: string | null;
  englishName?: string | null;
  nativeName?: string | null;
  synonyms?: string[];
  description?: string | null;
  posterUrl?: string | null;
  // Carried through the provider even though mergeExternalMetadata has nowhere to put them yet -
  // AnimeTitle has no banner/studio field, and adding one is the title page's job, not this
  // layer's. Fetching them now costs nothing (same GraphQL query) and saves a cache-wide refetch
  // when the page grows a banner.
  bannerUrl?: string | null;
  studios?: string[];
  genres?: string[];
  year?: number | null;
  type?: AnimeType | null;
  status?: AnimeStatus | null;
  episodeCount?: number | null;
  averageScore?: number | null;
  nextEpisodeAt?: number | null;
  isAdult?: boolean;
}

/** The rating source name AniList's score is filed under in AnimeTitle.ratings - matches how
 * sources name theirs ("Shikimori", "MAL", ...), and is what lets the merge below replace only
 * *its own* previous entry instead of wiping the ratings a source collected. */
export const ANILIST_RATING_SOURCE = "AniList";

const FORMAT_TO_TYPE: Record<string, AnimeType> = {
  TV: "tv",
  TV_SHORT: "tv",
  MOVIE: "movie",
  OVA: "ova",
  ONA: "ona",
  SPECIAL: "special",
  MUSIC: "special",
};

// CANCELLED and HIATUS have no equivalent in AnimeStatus (three values, mirrored from Android's
// own enum) and are deliberately absent: an unmapped status falls back to the source's, which at
// least says something the app can render, rather than being forced into a wrong one.
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

/**
 * AniList descriptions are HTML, not text: `<br>` line breaks, `<i>`, and - the reason this can't
 * just be a tag strip - `<span class="markdown_spoiler">` blocks holding actual plot spoilers,
 * which have to *go*, not merely lose their tags.
 */
export function sanitizeAniListDescription(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<span[^>]*markdown_spoiler[^>]*>[\s\S]*?<\/span>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    // Source-note tails ("(Source: MAL)") say nothing to a reader looking at a description inside
    // another app, and AniList puts one on a large share of entries.
    .replace(/\n*\(Source:[^)]*\)\s*$/i, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}

/** Comparison form for title matching: case, punctuation, and the ordinal season wording that
 * differs between every site ("2nd Season" vs "Season 2") all removed, so the only thing left to
 * differ is the words themselves. Latin, Cyrillic, kana and CJK all survive; everything else is
 * treated as a separator. */
export function normalizeTitleForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/(\d+)(?:st|nd|rd|th)\s+season/g, "season $1")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Every name a source title is known by, in normalized form - a match on any one of them counts,
 * since sources disagree wildly about which of the three is the "main" one. */
export function candidateNames(
  anime: Pick<AnimeTitle, "englishName" | "originalName" | "russianName" | "synonyms">,
): string[] {
  // Deliberately not russianName: AniList holds no Russian titles, so matching against one can
  // only ever produce noise (and a Russian source's romaji name is already in the list).
  const names = [anime.englishName, anime.originalName, ...(anime.synonyms ?? [])]
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map(normalizeTitleForMatch)
    .filter((name) => name.length > 0);
  return [...new Set(names)];
}

export interface MatchCandidate {
  anilistId: number;
  names: string[];
  year?: number | null;
  type?: AnimeType | null;
  format?: string | null;
}

/** How sure a match is, 0..1. Only names decide whether a candidate is *possible*; year and type
 * decide between the several candidates an exact-name search always returns for anything with a
 * sequel, a movie, and an OVA sharing one name. */
export function scoreCandidate(
  anime: Pick<AnimeTitle, "englishName" | "originalName" | "russianName" | "synonyms" | "year" | "type">,
  candidate: MatchCandidate,
): number {
  const wanted = candidateNames(anime);
  if (wanted.length === 0) return 0;
  const offered = candidate.names.map(normalizeTitleForMatch).filter((name) => name.length > 0);
  if (offered.length === 0) return 0;

  let nameScore: number;
  if (wanted.some((name) => offered.includes(name))) nameScore = 1;
  else if (wanted.some((name) => offered.some((other) => other.startsWith(name) || name.startsWith(other)))) nameScore = 0.7;
  else return 0;

  const candidateType = candidate.type ?? mapAniListFormat(candidate.format);
  // A year that is one off is not evidence against a match: a late-season show airs in December on
  // one site and January on another, and the two disagree by a calendar year every time.
  const yearScore = anime.year == null || candidate.year == null
    ? 0
    : Math.abs(anime.year - candidate.year) <= 1 ? 1 : -1;
  const typeScore = anime.type == null || candidateType == null ? 0 : anime.type === candidateType ? 1 : -1;

  // Rounded because these weights sum to 0.9999999999999999 in binary floating point, and a score
  // is also persisted as a percentage - two reasons for a perfect match to read as exactly 1.
  const score = Math.round((nameScore * 0.7 + yearScore * 0.2 + typeScore * 0.1) * 1000) / 1000;
  return Math.max(0, Math.min(1, score));
}

/** Below this a match is treated as no match at all. A prefix-only name hit that also contradicts
 * the year lands under it; anything with an exact name and no contradiction clears it. */
export const MATCH_CONFIDENCE_THRESHOLD = 0.6;

export function pickBestMatch(
  anime: Pick<AnimeTitle, "englishName" | "originalName" | "russianName" | "synonyms" | "year" | "type">,
  candidates: MatchCandidate[],
): { anilistId: number; confidence: number } | null {
  let best: { anilistId: number; confidence: number } | null = null;
  for (const candidate of candidates) {
    const confidence = scoreCandidate(anime, candidate);
    if (confidence >= MATCH_CONFIDENCE_THRESHOLD && (!best || confidence > best.confidence)) {
      best = { anilistId: candidate.anilistId, confidence };
    }
  }
  return best;
}

/** Replaces this provider's own previous rating rather than appending - a title page refetched
 * five times should not grow five AniList rows in its ratings list. */
function withAniListRating(
  existing: TitleRating[] | undefined,
  averageScore: number | null | undefined,
): TitleRating[] | undefined {
  if (averageScore == null) return existing;
  const others = (existing ?? []).filter((rating) => rating.source !== ANILIST_RATING_SOURCE);
  // AniList scores out of 100, every source in this app scores out of 10, and the title page
  // renders them all through one formatter.
  return [{ source: ANILIST_RATING_SOURCE, value: Math.round(averageScore) / 10, votes: null }, ...others];
}

function preferExternal<T>(external: T | null | undefined, own: T | null | undefined): T | null | undefined {
  return external == null || (Array.isArray(external) && external.length === 0) ? own : external;
}

/**
 * The whole point of the feature, in one function: descriptive fields come from AniList, and
 * anything describing what is actually playable stays with the source.
 *
 * Field by field rather than object-level replacement, so a partially-filled AniList entry (they
 * exist - an announced title has no episode count and no score) degrades to the source's value for
 * that one field instead of blanking it.
 *
 * Not replaced, on purpose:
 * - `id`/`sourceId`, `availableEpisodeCount`, and everything playback-related: the source is the
 *   only thing that knows what it has actually uploaded.
 * - `russianName`: AniList has no Russian titles, and dropping the source's would make a Russian
 *   source's page worse, not better.
 * - `ageRating`: AniList has no equivalent field (only an adult flag), so there is nothing to
 *   replace it with.
 * - `relatedAnime`/`franchiseAnime`/`similarAnime`: their ids address *this source's* catalog, and
 *   AniList ids would make every one of those cards a dead link. Replacing them needs a
 *   search-by-name jump that does not exist yet.
 */
export function mergeExternalMetadata(anime: AnimeTitle, external: ExternalMetadata | null): AnimeTitle {
  if (!external) return anime;
  return {
    ...anime,
    englishName: preferExternal(external.englishName, anime.englishName),
    originalName: preferExternal(external.romajiName ?? external.nativeName, anime.originalName),
    synonyms: preferExternal(external.synonyms, anime.synonyms) ?? undefined,
    description: preferExternal(external.description, anime.description),
    posterUrl: preferExternal(external.posterUrl, anime.posterUrl),
    genres: preferExternal(external.genres, anime.genres) ?? undefined,
    year: preferExternal(external.year, anime.year),
    type: preferExternal(external.type, anime.type),
    status: preferExternal(external.status, anime.status),
    episodeCount: preferExternal(external.episodeCount, anime.episodeCount),
    nextEpisodeAt: preferExternal(external.nextEpisodeAt, anime.nextEpisodeAt),
    ratings: withAniListRating(anime.ratings, external.averageScore),
  };
}
