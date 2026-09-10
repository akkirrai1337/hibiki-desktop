// Kitsu's JSON:API response, reshaped into the provider-neutral ExternalMetadata. Pure, so the
// mapping is testable without touching the network; the client itself is main/metadata/kitsu.ts.
//
// Kitsu earns its place for two things neither of the others has together: it carries banner art,
// an age rating and a next-episode timestamp all at once, and it publishes the AniList and MAL ids
// for the same title - which is how a name is turned into the other providers' ids without asking
// their own search endpoints anything.
import { sanitizeDescription, type ExternalMetadata, type MatchCandidate } from "./externalMetadata";
import type { AnimeStatus, AnimeType } from "./types";

/** The `include` both the by-id and the search request ask for: genres live in `categories` (the
 * `genres` relationship is empty on every entry checked), and `mappings` is what carries the other
 * providers' ids. */
export const KITSU_INCLUDE = "categories,mappings";

interface KitsuImage {
  original?: string | null;
  large?: string | null;
  medium?: string | null;
  small?: string | null;
}

interface KitsuRelationshipRef {
  type?: string | null;
  id?: string | null;
}

export interface KitsuAnime {
  id: string;
  attributes?: {
    slug?: string | null;
    synopsis?: string | null;
    description?: string | null;
    canonicalTitle?: string | null;
    /** Keyed by language tag - "en", "en_jp" (romaji), "ja_jp", plus whichever others exist. */
    titles?: Record<string, string | null> | null;
    abbreviatedTitles?: string[] | null;
    /** Out of 100, as a string. */
    averageRating?: string | null;
    userCount?: number | null;
    startDate?: string | null;
    /** ISO timestamp of the next episode, on an airing title. */
    nextRelease?: string | null;
    ageRating?: string | null;
    ageRatingGuide?: string | null;
    subtype?: string | null;
    status?: string | null;
    posterImage?: KitsuImage | null;
    coverImage?: KitsuImage | null;
    episodeCount?: number | null;
    nsfw?: boolean | null;
  } | null;
  relationships?: Record<string, { data?: KitsuRelationshipRef[] | KitsuRelationshipRef | null } | null> | null;
}

export interface KitsuIncluded {
  id: string;
  type: string;
  attributes?: {
    /** A category's display name. Kitsu calls it `title`, not `name`. */
    title?: string | null;
    externalSite?: string | null;
    externalId?: string | null;
  } | null;
}

const SUBTYPE_TO_TYPE: Record<string, AnimeType> = {
  tv: "tv",
  movie: "movie",
  ova: "ova",
  ona: "ona",
  special: "special",
  music: "special",
};

// "tba" and "unreleased" both mean "announced, no date" here. Anything unrecognised is left null so
// the source's own status survives the merge.
const STATUS_TO_STATUS: Record<string, AnimeStatus> = {
  finished: "released",
  current: "ongoing",
  upcoming: "announced",
  tba: "announced",
  unreleased: "announced",
};

export function mapKitsuSubtype(subtype: string | null | undefined): AnimeType | null {
  return subtype ? (SUBTYPE_TO_TYPE[subtype.trim().toLowerCase()] ?? null) : null;
}

export function mapKitsuStatus(status: string | null | undefined): AnimeStatus | null {
  return status ? (STATUS_TO_STATUS[status.trim().toLowerCase()] ?? null) : null;
}

/** The included entries this one anime actually points at - a search returns one flat `included`
 * array for every result at once, and only each result's own relationship linkage says which of
 * them are its. */
function relatedIncluded(anime: KitsuAnime, relationship: string, included: KitsuIncluded[]): KitsuIncluded[] {
  const linkage = anime.relationships?.[relationship]?.data;
  const refs = Array.isArray(linkage) ? linkage : linkage ? [linkage] : [];
  const wanted = new Set(refs.map((ref) => `${ref.type}:${ref.id}`));
  return included.filter((entry) => wanted.has(`${entry.type}:${entry.id}`));
}

function names(anime: KitsuAnime): string[] {
  const attributes = anime.attributes;
  // Every localized title is worth offering the matcher: an English source may well name a title
  // the way Kitsu's Italian or Portuguese entry does, and none of them can produce a false match
  // on their own (the score still needs the year and type to agree).
  return [
    attributes?.canonicalTitle,
    ...Object.values(attributes?.titles ?? {}),
    ...(attributes?.abbreviatedTitles ?? []),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function ageRating(anime: KitsuAnime): string | null {
  const rating = anime.attributes?.ageRating?.trim();
  const guide = anime.attributes?.ageRatingGuide?.trim();
  if (!rating) return guide || null;
  // Reads as MAL's own does ("PG-13 - Teens 13 or older"), which is what the title page already
  // shows for a MAL-described title.
  return guide ? `${rating} - ${guide}` : rating;
}

function year(anime: KitsuAnime): number | null {
  const startDate = anime.attributes?.startDate;
  if (!startDate) return null;
  const parsed = Number(startDate.slice(0, 4));
  return Number.isFinite(parsed) ? parsed : null;
}

export function toExternalMetadata(anime: KitsuAnime, included: KitsuIncluded[] = []): ExternalMetadata {
  const attributes = anime.attributes;
  const mappings = relatedIncluded(anime, "mappings", included);
  const externalIdOn = (site: string): number | null => {
    const raw = mappings.find((entry) => entry.attributes?.externalSite === site)?.attributes?.externalId;
    const parsed = Number(raw);
    return raw != null && Number.isFinite(parsed) ? parsed : null;
  };
  const rating = Number(attributes?.averageRating);

  return {
    provider: "kitsu",
    externalId: Number(anime.id),
    kitsuId: Number(anime.id),
    anilistId: externalIdOn("anilist/anime"),
    malId: externalIdOn("myanimelist/anime"),
    // Kitsu's "en_jp" is the romanized Japanese title, which is what romajiName means everywhere
    // else here; canonicalTitle is usually the same string and stands in when it is absent.
    romajiName: attributes?.titles?.en_jp ?? attributes?.canonicalTitle ?? null,
    englishName: attributes?.titles?.en ?? attributes?.titles?.en_us ?? null,
    nativeName: attributes?.titles?.ja_jp ?? null,
    synonyms: attributes?.abbreviatedTitles ?? [],
    description: sanitizeDescription(attributes?.synopsis ?? attributes?.description),
    posterUrl: attributes?.posterImage?.original ?? attributes?.posterImage?.large ?? null,
    bannerUrl: attributes?.coverImage?.original ?? attributes?.coverImage?.large ?? null,
    // Kitsu's `productions` relationship cannot be read the way the others can (the endpoint
    // answers 400), so studios stay with the source.
    studios: [],
    genres: relatedIncluded(anime, "categories", included)
      .map((entry) => entry.attributes?.title)
      .filter((title): title is string => !!title),
    year: year(anime),
    type: mapKitsuSubtype(attributes?.subtype),
    status: mapKitsuStatus(attributes?.status),
    episodeCount: attributes?.episodeCount ?? null,
    // Out of 100 like AniList's, but as a decimal string.
    score: Number.isFinite(rating) ? Math.round(rating) / 10 : null,
    scoreVotes: attributes?.userCount ?? null,
    ageRating: ageRating(anime),
    nextEpisodeAt: attributes?.nextRelease ? (Date.parse(attributes.nextRelease) || null) : null,
    isAdult: attributes?.nsfw === true,
  };
}

export function toMatchCandidate(anime: KitsuAnime): MatchCandidate {
  return {
    externalId: Number(anime.id),
    names: names(anime),
    year: year(anime),
    type: mapKitsuSubtype(anime.attributes?.subtype),
  };
}
