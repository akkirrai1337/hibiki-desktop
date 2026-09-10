// Jikan, MAL's unofficial read-only API. No key and no account, which is the reason it is the
// second provider: the official MAL API needs a registered client id even to read.
//
// Requests only - the response mapping is shared/malMapping.ts, and matching and caching belong to
// externalMetadataService.ts.
import { toExternalMetadata, toMatchCandidate, type JikanAnime } from "@shared/malMapping";
import type { ExternalMetadata, MatchCandidate } from "@shared/externalMetadata";
import { rateLimitedJson } from "./requestQueue";

const BASE_URL = "https://api.jikan.moe/v4";

// Jikan publishes two limits, 3 requests a second and 60 a minute; the minute one is the binding
// constraint, so this paces to just under it rather than to the burst allowance.
const MIN_REQUEST_INTERVAL_MS = 1_100;

async function get<T>(path: string): Promise<T | null> {
  return rateLimitedJson<T>({
    queue: "mal",
    minIntervalMs: MIN_REQUEST_INTERVAL_MS,
    scope: "mal",
    url: `${BASE_URL}${path}`,
    init: { headers: { Accept: "application/json" } },
  });
}

export async function fetchById(malId: number): Promise<ExternalMetadata | null> {
  const body = await get<{ data?: JikanAnime | null }>(`/anime/${malId}`);
  return body?.data ? toExternalMetadata(body.data) : null;
}

/** Null when the request itself failed - distinct from an empty list, which is MAL genuinely not
 * carrying this title. Jikan's search endpoint was answering 504 for minutes at a time while this
 * was written, so the two really do need telling apart. */
export async function search(name: string): Promise<Array<{ candidate: MatchCandidate; media: ExternalMetadata }> | null> {
  // `sfw` keeps adult entries out of the candidate pool, which matters because a name that matches
  // a mainstream show also matches its parody often enough to pick the wrong one.
  const body = await get<{ data?: JikanAnime[] | null }>(`/anime?q=${encodeURIComponent(name)}&limit=10&sfw=true`);
  if (!body) return null;
  return (body.data ?? [])
    // Jikan serves unapproved, user-submitted entries too; they are frequently duplicates of a
    // real one with worse data.
    .filter((anime) => anime.approved !== false)
    .map((anime) => ({ candidate: toMatchCandidate(anime), media: toExternalMetadata(anime) }));
}
