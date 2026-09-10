// AniList's GraphQL endpoint. Requests only - the response mapping is shared/anilistMapping.ts, and
// matching and caching belong to externalMetadataService.ts.
//
// Note for anyone wondering why a page is describing itself from MAL: AniList disabled this API
// outright while this was written ("temporarily disabled due to severe stability issues", HTTP 403
// on every query), which is exactly the case the service's provider fallback exists for.
import { ANILIST_MEDIA_FIELDS, toExternalMetadata, toMatchCandidate, type AniListMedia } from "@shared/anilistMapping";
import { seasonOf, type ExternalCatalogRequest, type ExternalMetadata, type MatchCandidate } from "@shared/externalMetadata";
import { logger } from "../logger";
import { rateLimitedJson } from "./requestQueue";

const ENDPOINT = "https://graphql.anilist.co";

// AniList allows about 90 requests a minute per IP. Nothing here is latency-critical (a title page
// paints from the source first and fills metadata in as it arrives), so this stays well under the
// limit rather than racing to it and living on 429s.
const MIN_REQUEST_INTERVAL_MS = 700;

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  const body = await rateLimitedJson<{ data?: T; errors?: Array<{ message?: string }> }>({
    queue: "anilist",
    minIntervalMs: MIN_REQUEST_INTERVAL_MS,
    scope: "anilist",
    url: ENDPOINT,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    },
  });
  if (!body) return null;
  if (body.errors?.length) logger.warn("anilist", `GraphQL error: ${body.errors[0]?.message ?? "unknown"}`);
  return body.data ?? null;
}

export async function fetchById(anilistId: number): Promise<ExternalMetadata | null> {
  const data = await graphql<{ Media?: AniListMedia | null }>(
    `query ($id: Int) { Media(id: $id, type: ANIME) { ${ANILIST_MEDIA_FIELDS} } }`,
    { id: anilistId },
  );
  return data?.Media ? toExternalMetadata(data.Media) : null;
}

/** Looks a title up by its MAL id - what lets a match established through MAL be reused here
 * without searching by name again. */
export async function fetchByMalId(malId: number): Promise<ExternalMetadata | null> {
  const data = await graphql<{ Media?: AniListMedia | null }>(
    `query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) { ${ANILIST_MEDIA_FIELDS} } }`,
    { idMal: malId },
  );
  return data?.Media ? toExternalMetadata(data.Media) : null;
}

const SEASON_TO_ANILIST: Record<string, string> = {
  winter: "WINTER",
  spring: "SPRING",
  summer: "SUMMER",
  fall: "FALL",
};

/**
 * A page of AniList's catalog.
 *
 * Its "trending" is genuinely trending - what people are watching and talking about this week -
 * rather than a lifetime popularity ranking, which is the one thing AniList does better than Kitsu
 * for a catalog and the reason it is preferred here when it is reachable at all.
 */
export async function browse(request: ExternalCatalogRequest): Promise<ExternalMetadata[] | null> {
  const now = seasonOf(new Date());
  const seasonal = request.mode === "season";
  const data = await graphql<{ Page?: { media?: AniListMedia[] | null } | null }>(
    `query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int) {
      Page(page: $page, perPage: $perPage) {
        media(type: ANIME, sort: ${request.mode === "popular" ? "POPULARITY_DESC" : "TRENDING_DESC"}, season: $season, seasonYear: $seasonYear, isAdult: false) { ${ANILIST_MEDIA_FIELDS} }
      }
    }`,
    {
      // AniList pages by number, not by offset, so a caller's offset has to divide evenly by the
      // page size - which it does, since the catalog screen only ever asks for whole pages.
      page: Math.floor(request.offset / request.limit) + 1,
      perPage: request.limit,
      season: seasonal ? SEASON_TO_ANILIST[request.season ?? now.season] : null,
      seasonYear: seasonal ? (request.seasonYear ?? now.year) : null,
    },
  );
  if (!data) return null;
  return (data.Page?.media ?? []).map(toExternalMetadata);
}

/** Null when the request itself failed - distinct from an empty list, which is AniList genuinely
 * not carrying this title. The service has to tell them apart before it writes a "no match" that
 * would outlive the outage that caused it. */
export async function search(name: string): Promise<Array<{ candidate: MatchCandidate; media: ExternalMetadata }> | null> {
  const data = await graphql<{ Page?: { media?: AniListMedia[] | null } | null }>(
    `query ($search: String) { Page(perPage: 10) { media(search: $search, type: ANIME) { ${ANILIST_MEDIA_FIELDS} } } }`,
    { search: name },
  );
  if (!data) return null;
  return (data.Page?.media ?? []).map((media) => ({
    candidate: toMatchCandidate(media),
    media: toExternalMetadata(media),
  }));
}
