// Kitsu's public JSON:API. No key, no account.
//
// Requests only - the response mapping is shared/kitsuMapping.ts, and matching and caching belong
// to externalMetadataService.ts.
import {
  KITSU_INCLUDE,
  toExternalMetadata,
  toMatchCandidate,
  type KitsuAnime,
  type KitsuIncluded,
} from "@shared/kitsuMapping";
import type { ExternalMetadata, MatchCandidate } from "@shared/externalMetadata";
import { rateLimitedJson } from "./requestQueue";

const BASE_URL = "https://kitsu.io/api/edge";

// Kitsu publishes no hard rate limit, so this is a courtesy pace rather than a documented one -
// still comfortably faster than the other two, since a title page waits on it.
const MIN_REQUEST_INTERVAL_MS = 400;

interface KitsuResponse<T> {
  data?: T | null;
  included?: KitsuIncluded[] | null;
}

async function get<T>(path: string): Promise<KitsuResponse<T> | null> {
  return rateLimitedJson<KitsuResponse<T>>({
    queue: "kitsu",
    minIntervalMs: MIN_REQUEST_INTERVAL_MS,
    scope: "kitsu",
    url: `${BASE_URL}${path}`,
    // JSON:API's own media type. Kitsu answers without it too, but this is what its documentation
    // asks for and what keeps it answering if that ever stops being true.
    init: { headers: { Accept: "application/vnd.api+json" } },
  });
}

export async function fetchById(kitsuId: number): Promise<ExternalMetadata | null> {
  const body = await get<KitsuAnime>(`/anime/${kitsuId}?include=${KITSU_INCLUDE}`);
  return body?.data ? toExternalMetadata(body.data, body.included ?? []) : null;
}

/** Kitsu's web URLs name a title by slug, so a pasted link resolves through this rather than by
 * id. */
export async function fetchBySlug(slug: string): Promise<ExternalMetadata | null> {
  const body = await get<KitsuAnime[]>(`/anime?filter[slug]=${encodeURIComponent(slug)}&include=${KITSU_INCLUDE}`);
  const anime = body?.data?.[0];
  return anime ? toExternalMetadata(anime, body?.included ?? []) : null;
}

/** Kitsu indexes the other providers' ids as first-class records, so a title already matched
 * elsewhere can be bound here exactly, with no search and no guessing. */
export async function fetchByMalId(malId: number): Promise<ExternalMetadata | null> {
  const body = await get<Array<{ relationships?: { item?: { data?: { id?: string } | null } | null } }>>(
    `/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}`,
  );
  const kitsuId = Number(body?.data?.[0]?.relationships?.item?.data?.id);
  return Number.isFinite(kitsuId) ? fetchById(kitsuId) : null;
}

/** Null when the request itself failed - distinct from an empty list, which is Kitsu genuinely not
 * carrying this title. */
export async function search(name: string): Promise<Array<{ candidate: MatchCandidate; media: ExternalMetadata }> | null> {
  const body = await get<KitsuAnime[]>(
    `/anime?filter[text]=${encodeURIComponent(name)}&page[limit]=10&include=${KITSU_INCLUDE}`,
  );
  if (!body) return null;
  const included = body.included ?? [];
  return (body.data ?? []).map((anime) => ({
    candidate: toMatchCandidate(anime),
    media: toExternalMetadata(anime, included),
  }));
}
