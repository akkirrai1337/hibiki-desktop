// External metadata: describing a source's titles from a metadata aggregator instead of from the
// source's own pages. A source that admits its own metadata is the weaker half of what it returns
// declares `useExternalMetadata` in its manifest, and the app fills in name, description, poster,
// genres, score and airing from AniList or MAL.
//
// This file is the provider-neutral core - the shape both providers normalize into, how a source
// title is matched to an entry, and which fields that entry is then allowed to replace. Each
// provider's own response mapping is its own file (anilistMapping.ts, malMapping.ts), and the
// network and cache live in main/metadata. Everything here is pure, because matching rules and
// merge rules are the two things worth testing and neither needs a network to answer.
import type { AnimeStatus, AnimeTitle, AnimeType, ExternalMetadataPreferences, TitleRating } from "./types";

/** The aggregators the app can describe a title from. "mal" is reached through Jikan, MAL's own
 * unofficial read-only API, which needs no key; "kitsu" through Kitsu's own public JSON:API. */
export type MetadataProviderId = "anilist" | "mal" | "kitsu";

export const METADATA_PROVIDER_IDS: MetadataProviderId[] = ["anilist", "mal", "kitsu"];

/** How each provider's score is labelled in AnimeTitle.ratings - the same shape a source uses for
 * its own ("Shikimori", "MAL", ...). */
export const PROVIDER_RATING_SOURCE: Record<MetadataProviderId, string> = {
  anilist: "AniList",
  mal: "MAL",
  kitsu: "Kitsu",
};

// Every label this layer may have written before. The merge clears all of them rather than only
// the provider it is writing now: switching provider must not leave yesterday's AniList score
// sitting next to today's MAL one, as if the source had reported both.
const PROVIDER_RATING_SOURCES = Object.values(PROVIDER_RATING_SOURCE);

/** One title as described by one provider, normalized at the provider edge so nothing downstream
 * has to know about `coverImage.extraLarge` or `images.jpg.large_image_url`. */
export interface ExternalMetadata {
  provider: MetadataProviderId;
  /** This provider's own id for the title - an AniList media id, or a MAL id. */
  externalId: number;
  /** The *other* provider's id, when this one publishes it. What lets a switch between providers,
   * or a fallback to one, reuse a match that is already established instead of searching by name
   * again - which matters because search is the fragile, rate-limited half of both APIs. */
  anilistId?: number | null;
  malId?: number | null;
  kitsuId?: number | null;
  romajiName?: string | null;
  englishName?: string | null;
  nativeName?: string | null;
  synonyms?: string[];
  description?: string | null;
  posterUrl?: string | null;
  /** Carried even though mergeExternalMetadata has nowhere to put them yet - AnimeTitle has no
   * banner field, and adding one is the title page's job, not this layer's. Fetching them now
   * costs nothing and saves a cache-wide refetch when the page grows a banner. */
  bannerUrl?: string | null;
  studios?: string[];
  genres?: string[];
  year?: number | null;
  type?: AnimeType | null;
  status?: AnimeStatus | null;
  episodeCount?: number | null;
  /** Out of 10, converted at the provider edge - AniList scores out of 100, MAL out of 10, and the
   * title page renders every rating through one formatter. */
  score?: number | null;
  scoreVotes?: number | null;
  /** MAL publishes one, AniList has no equivalent field at all. */
  ageRating?: string | null;
  /** Epoch milliseconds. AniList reports a next-airing timestamp; MAL does not, so a title
   * described from MAL keeps whatever countdown its source reported. */
  nextEpisodeAt?: number | null;
  isAdult?: boolean;
}

/**
 * Which providers to try, in order, for a given source.
 *
 * Empty means "describe this title from its source alone": either the source never asked for
 * external metadata, or the user turned it off. Otherwise the preferred provider comes first and
 * the other follows as a fallback - the reason being that both APIs go down (AniList's was
 * disabled outright while this was written, and Jikan's search endpoint was timing out under the
 * load that caused), and a page that silently falls back to the other one still looks right.
 */
export function metadataProviderOrder(
  preferences: ExternalMetadataPreferences,
  sourceId: string,
  sourceDeclaresIt: boolean,
): MetadataProviderId[] {
  if (!sourceDeclaresIt) return [];
  const enabled = preferences.overrides[sourceId] ?? preferences.enabled;
  if (!enabled) return [];
  const preferred = preferences.provider;
  if (!preferences.fallbackEnabled) return [preferred];
  return [preferred, ...METADATA_PROVIDER_IDS.filter((id) => id !== preferred)];
}

/** One provider's entry, as identified by the user rather than by the matcher. Kitsu's own web
 * URLs name a title by slug rather than by id, so a reference carries one or the other. */
export interface MetadataReference {
  provider: MetadataProviderId;
  externalId?: number;
  slug?: string;
}

/**
 * Reads a provider entry out of whatever the user pasted into the manual-rebind box: an AniList or
 * MAL page URL, or a bare id belonging to `defaultProvider`.
 *
 * A URL carries the provider with it, which is the point - pasting the page you are looking at is
 * the one way to fix a wrong match that works even while both providers' *search* endpoints are
 * down, which is exactly the state they were in when this was written.
 */
export function parseMetadataReference(
  input: string,
  defaultProvider: MetadataProviderId,
): MetadataReference | null {
  const text = input.trim();
  if (!text) return null;
  const anilist = /anilist\.co\/(?:anime|manga)\/(\d+)/i.exec(text);
  if (anilist) return { provider: "anilist", externalId: Number(anilist[1]) };
  const mal = /myanimelist\.net\/anime\/(\d+)/i.exec(text);
  if (mal) return { provider: "mal", externalId: Number(mal[1]) };
  // kitsu.io is the old domain and kitsu.app the current one; both are still in circulation, and a
  // link is pasted as it was found.
  const kitsu = /kitsu\.(?:io|app)\/anime\/([A-Za-z0-9-]+)/i.exec(text);
  if (kitsu) {
    const id = kitsu[1];
    return /^\d+$/.test(id) ? { provider: "kitsu", externalId: Number(id) } : { provider: "kitsu", slug: id };
  }
  // A bare number is an id for whichever provider is currently in charge - the ids are unrelated
  // between the two, so guessing the other one would bind the title to a different show entirely.
  if (/^\d+$/.test(text)) return { provider: defaultProvider, externalId: Number(text) };
  return null;
}

/** Where to send someone who wants to look at the entry a title is bound to. */
export function metadataEntryUrl(provider: MetadataProviderId, externalId: number): string {
  if (provider === "anilist") return `https://anilist.co/anime/${externalId}`;
  if (provider === "mal") return `https://myanimelist.net/anime/${externalId}`;
  return `https://kitsu.app/anime/${externalId}`;
}

/**
 * Turns a provider's HTML or marked-up synopsis into plain text.
 *
 * Both providers need this, for different reasons: AniList descriptions are HTML, including
 * `<span class="markdown_spoiler">` blocks holding actual plot spoilers, which have to *go* rather
 * than merely lose their tags; MAL synopses are plain text but carry a writer credit at the end.
 */
export function sanitizeDescription(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw
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
    // Attribution tails - "(Source: MAL)" on AniList, "[Written by MAL Rewrite]" on MAL - say
    // nothing to a reader looking at a description inside another app, and both put one on a large
    // share of their entries.
    .replace(/\n*\(Source:[^)]*\)\s*$/i, "")
    .replace(/\n*\[Written by[^\]]*\]\s*$/i, "")
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
  // Deliberately not russianName: neither provider holds Russian titles, so matching against one
  // can only ever produce noise (and a Russian source's romaji name is already in the list).
  const names = [anime.englishName, anime.originalName, ...(anime.synonyms ?? [])]
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map(normalizeTitleForMatch)
    .filter((name) => name.length > 0);
  return [...new Set(names)];
}

export interface MatchCandidate {
  externalId: number;
  names: string[];
  year?: number | null;
  type?: AnimeType | null;
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

  // A year that is one off is not evidence against a match: a late-season show airs in December on
  // one site and January on another, and the two disagree by a calendar year every time.
  const yearScore = anime.year == null || candidate.year == null
    ? 0
    : Math.abs(anime.year - candidate.year) <= 1 ? 1 : -1;
  const typeScore = anime.type == null || candidate.type == null ? 0 : anime.type === candidate.type ? 1 : -1;

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
): { externalId: number; confidence: number } | null {
  let best: { externalId: number; confidence: number } | null = null;
  for (const candidate of candidates) {
    const confidence = scoreCandidate(anime, candidate);
    if (confidence >= MATCH_CONFIDENCE_THRESHOLD && (!best || confidence > best.confidence)) {
      best = { externalId: candidate.externalId, confidence };
    }
  }
  return best;
}

/** Replaces whatever this layer wrote before rather than appending - a title refetched five times,
 * or described from the other provider after a switch, should not grow five rating rows. */
function withProviderRating(existing: TitleRating[] | undefined, external: ExternalMetadata): TitleRating[] | undefined {
  const others = (existing ?? []).filter((rating) => !PROVIDER_RATING_SOURCES.includes(rating.source));
  if (external.score == null) return existing;
  return [
    { source: PROVIDER_RATING_SOURCE[external.provider], value: external.score, votes: external.scoreVotes ?? null },
    ...others,
  ];
}

function preferExternal<T>(external: T | null | undefined, own: T | null | undefined): T | null | undefined {
  return external == null || (Array.isArray(external) && external.length === 0) ? own : external;
}

/**
 * The whole point of the feature, in one function: descriptive fields come from the provider, and
 * anything describing what is actually playable stays with the source.
 *
 * Field by field rather than object-level replacement, so a partially-filled entry (they exist - an
 * announced title has no episode count and no score, and MAL publishes no airing timestamp at all)
 * degrades to the source's value for that one field instead of blanking it.
 *
 * Not replaced, on purpose:
 * - `id`/`sourceId`, `availableEpisodeCount`, and everything playback-related: the source is the
 *   only thing that knows what it has actually uploaded.
 * - `russianName`: neither provider has Russian titles, and dropping the source's would make a
 *   Russian source's page worse, not better.
 * - `relatedAnime`/`franchiseAnime`/`similarAnime`: their ids address *this source's* catalog, and
 *   a provider's ids would make every one of those cards a dead link. Replacing them needs a
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
    ageRating: preferExternal(external.ageRating, anime.ageRating),
    nextEpisodeAt: preferExternal(external.nextEpisodeAt, anime.nextEpisodeAt),
    ratings: withProviderRating(anime.ratings, external),
  };
}
