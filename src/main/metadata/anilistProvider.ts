// The networked half of the AniList metadata provider: one GraphQL client, the two caches behind
// it, and the matching flow that turns a source's title into an AniList entry. The rules for
// *what* that entry then replaces are pure and live in shared/anilistMetadata.ts.
import { and, eq, inArray } from "drizzle-orm";
import type { AnimeTitle } from "@shared/types";
import {
  MATCH_CONFIDENCE_THRESHOLD,
  mapAniListFormat,
  mapAniListStatus,
  pickBestMatch,
  sanitizeAniListDescription,
  type ExternalMetadata,
  type MatchCandidate,
} from "@shared/anilistMetadata";
import { getDb } from "../db";
import { anilistMatches, anilistMedia } from "../db/schema";
import { logger } from "../logger";

const ENDPOINT = "https://graphql.anilist.co";

// AniList allows about 90 requests a minute per IP. Nothing here is latency-critical (a title page
// paints from the source first and fills in metadata as it arrives), so the queue below stays well
// under that rather than racing to the limit and living on 429s.
const MIN_REQUEST_INTERVAL_MS = 700;

// A finished show's metadata is effectively frozen; an airing one moves every week and carries the
// next-episode countdown the title page prints.
const TTL_SETTLED_MS = 14 * 24 * 60 * 60 * 1000;
const TTL_AIRING_MS = 12 * 60 * 60 * 1000;
// A search that found nothing is remembered too, or every visit to a title AniList does not have
// re-runs the same fruitless search. Short enough that a newly added entry is picked up in a week.
const TTL_NO_MATCH_MS = 7 * 24 * 60 * 60 * 1000;

const MEDIA_FIELDS = `
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

interface RawMedia {
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

function toExternalMetadata(media: RawMedia): ExternalMetadata {
  return {
    anilistId: media.id,
    malId: media.idMal ?? null,
    romajiName: media.title?.romaji ?? null,
    englishName: media.title?.english ?? null,
    nativeName: media.title?.native ?? null,
    synonyms: media.synonyms ?? [],
    description: sanitizeAniListDescription(media.description),
    posterUrl: media.coverImage?.extraLarge ?? media.coverImage?.large ?? null,
    bannerUrl: media.bannerImage ?? null,
    studios: (media.studios?.nodes ?? []).map((node) => node?.name).filter((name): name is string => !!name),
    genres: media.genres ?? [],
    year: media.seasonYear ?? media.startDate?.year ?? null,
    type: mapAniListFormat(media.format),
    status: mapAniListStatus(media.status),
    episodeCount: media.episodes ?? null,
    averageScore: media.averageScore ?? null,
    // AniList reports airing times in epoch *seconds*; AnimeTitle.nextEpisodeAt is milliseconds
    // (see the title page's isUpcomingDay, which feeds it straight to `new Date`).
    nextEpisodeAt: media.nextAiringEpisode?.airingAt != null ? media.nextAiringEpisode.airingAt * 1000 : null,
    isAdult: media.isAdult ?? false,
  };
}

// One request at a time, spaced out - a home screen resolving twelve cards at once would otherwise
// open twelve sockets and collect a 429 for most of them.
let queueTail: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  const run = async (): Promise<T | null> => {
    const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    for (let attempt = 0; attempt < 3; attempt++) {
      lastRequestAt = Date.now();
      try {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ query, variables }),
        });
        if (response.status === 429) {
          // AniList states how long to wait; its own header is far more accurate than any backoff
          // guessed here, and ignoring it just earns another 429.
          const retryAfter = Number(response.headers.get("Retry-After") ?? "");
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000;
          logger.warn("anilist", `rate limited, retrying in ${Math.round(delay / 1000)}s`);
          await sleep(delay);
          continue;
        }
        if (!response.ok) {
          logger.warn("anilist", `HTTP ${response.status}`);
          return null;
        }
        const body = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };
        if (body.errors?.length) logger.warn("anilist", `GraphQL error: ${body.errors[0]?.message ?? "unknown"}`);
        return body.data ?? null;
      } catch (error) {
        logger.warn("anilist", `request failed: ${String(error)}`);
        return null;
      }
    }
    return null;
  };
  // Chained rather than run immediately: this is the whole rate limiter. Failures are swallowed
  // above, so the tail never rejects and never needs a catch of its own.
  const result = queueTail.then(run);
  queueTail = result;
  return result;
}

async function fetchMediaById(anilistId: number): Promise<ExternalMetadata | null> {
  const data = await graphql<{ Media?: RawMedia | null }>(
    `query ($id: Int) { Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} } }`,
    { id: anilistId },
  );
  return data?.Media ? toExternalMetadata(data.Media) : null;
}

async function searchCandidates(name: string): Promise<{ candidates: MatchCandidate[]; media: Map<number, ExternalMetadata> }> {
  const data = await graphql<{ Page?: { media?: RawMedia[] | null } | null }>(
    `query ($search: String) { Page(perPage: 10) { media(search: $search, type: ANIME) { ${MEDIA_FIELDS} } } }`,
    { search: name },
  );
  const media = new Map<number, ExternalMetadata>();
  const candidates: MatchCandidate[] = [];
  for (const raw of data?.Page?.media ?? []) {
    const normalized = toExternalMetadata(raw);
    media.set(normalized.anilistId, normalized);
    candidates.push({
      anilistId: normalized.anilistId,
      names: [raw.title?.romaji, raw.title?.english, raw.title?.native, ...(raw.synonyms ?? [])]
        .filter((value): value is string => typeof value === "string"),
      year: normalized.year,
      type: normalized.type,
    });
  }
  return { candidates, media };
}

function ttlFor(media: ExternalMetadata): number {
  return media.status === "released" ? TTL_SETTLED_MS : TTL_AIRING_MS;
}

function readCachedMedia(anilistId: number): { media: ExternalMetadata; fresh: boolean } | null {
  const row = getDb().select().from(anilistMedia).where(eq(anilistMedia.anilistId, anilistId)).get();
  if (!row) return null;
  const media = JSON.parse(row.mediaJson) as ExternalMetadata;
  return { media, fresh: Date.now() - row.cachedAt < ttlFor(media) };
}

function writeCachedMedia(media: ExternalMetadata): void {
  const values = { anilistId: media.anilistId, mediaJson: JSON.stringify(media), cachedAt: Date.now() };
  getDb()
    .insert(anilistMedia)
    .values(values)
    .onConflictDoUpdate({ target: anilistMedia.anilistId, set: { mediaJson: values.mediaJson, cachedAt: values.cachedAt } })
    .run();
}

function readMatch(sourceId: string, animeId: string) {
  return getDb()
    .select()
    .from(anilistMatches)
    .where(and(eq(anilistMatches.sourceId, sourceId), eq(anilistMatches.animeId, animeId)))
    .get();
}

function writeMatch(sourceId: string, animeId: string, anilistId: number | null, confidence: number | null, manual: boolean): void {
  const values = { sourceId, animeId, anilistId, confidence, manual, matchedAt: Date.now() };
  getDb()
    .insert(anilistMatches)
    .values(values)
    .onConflictDoUpdate({
      target: [anilistMatches.sourceId, anilistMatches.animeId],
      set: { anilistId, confidence, manual, matchedAt: values.matchedAt },
    })
    .run();
}

/** Binds a title to an AniList entry by hand, from the title page. Marked manual, which is what
 * stops the automatic matcher from ever overwriting it again. */
export async function setManualMatch(sourceId: string, animeId: string, anilistId: number): Promise<ExternalMetadata | null> {
  const media = (await fetchMediaById(anilistId)) ?? readCachedMedia(anilistId)?.media ?? null;
  if (media) writeCachedMedia(media);
  writeMatch(sourceId, animeId, anilistId, null, true);
  return media;
}

/** Drops a title's binding entirely, so the next lookup matches it again from scratch. */
export function clearMatch(sourceId: string, animeId: string): void {
  getDb()
    .delete(anilistMatches)
    .where(and(eq(anilistMatches.sourceId, sourceId), eq(anilistMatches.animeId, animeId)))
    .run();
}

/**
 * The AniList entry for one source title, or null when there is none to be had.
 *
 * Never throws and never blocks on the network longer than the queue above allows: a caller merges
 * whatever comes back, and null simply means the page keeps the source's own metadata.
 */
export async function getExternalMetadata(anime: AnimeTitle): Promise<ExternalMetadata | null> {
  const { sourceId, id: animeId } = anime;
  const match = readMatch(sourceId, animeId);

  if (match) {
    if (match.anilistId == null) {
      // A remembered failure. Manual "no match" is not a thing, so only the TTL can retire it.
      if (Date.now() - match.matchedAt < TTL_NO_MATCH_MS) return null;
    } else {
      const cached = readCachedMedia(match.anilistId);
      if (cached?.fresh) return cached.media;
      const refreshed = await fetchMediaById(match.anilistId);
      if (refreshed) {
        writeCachedMedia(refreshed);
        return refreshed;
      }
      // Offline, or AniList is down. A stale entry beats an empty page.
      return cached?.media ?? null;
    }
  }

  const searchNames = [anime.englishName, anime.originalName, ...(anime.synonyms ?? [])]
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .slice(0, 2); // Two shots at most - a third search costs another request for a title that is very likely simply absent.

  for (const name of searchNames) {
    const { candidates, media } = await searchCandidates(name);
    const best = pickBestMatch(anime, candidates);
    if (!best) continue;
    const found = media.get(best.anilistId);
    if (!found) continue;
    writeCachedMedia(found);
    writeMatch(sourceId, animeId, best.anilistId, Math.round(best.confidence * 100), false);
    logger.debug("anilist", `matched ${sourceId}:${animeId} to ${best.anilistId} (${Math.round(best.confidence * 100)}%)`);
    return found;
  }

  writeMatch(sourceId, animeId, null, null, false);
  logger.debug("anilist", `no match for ${sourceId}:${animeId} (threshold ${MATCH_CONFIDENCE_THRESHOLD})`);
  return null;
}

/** Cached-only lookup for the several titles a list screen is about - it draws from disk without
 * ever waiting on AniList, and lets the per-title path above fill the gaps in the background. */
export function getCachedExternalMetadataMany(
  keys: Array<{ sourceId: string; animeId: string }>,
): Record<string, ExternalMetadata> {
  if (keys.length === 0) return {};
  const db = getDb();
  const result: Record<string, ExternalMetadata> = {};
  const unique = [...new Map(keys.map((key) => [`${key.sourceId}:${key.animeId}`, key])).values()];
  const BATCH_SIZE = 400;
  for (let offset = 0; offset < unique.length; offset += BATCH_SIZE) {
    const batch = unique.slice(offset, offset + BATCH_SIZE);
    const matches = db
      .select()
      .from(anilistMatches)
      // One bound value per title (well below SQLite's 999-variable limit) rather than an
      // (sourceId, animeId) pair each: ids collide across sources rarely enough that fetching the
      // few extra rows and dropping them below beats doubling the variable count.
      .where(inArray(anilistMatches.animeId, batch.map((key) => key.animeId)))
      .all()
      .filter((row) => batch.some((key) => key.sourceId === row.sourceId && key.animeId === row.animeId));
    const ids = matches.map((row) => row.anilistId).filter((id): id is number => id != null);
    if (ids.length === 0) continue;
    const media = new Map(
      db
        .select()
        .from(anilistMedia)
        .where(inArray(anilistMedia.anilistId, ids))
        .all()
        .map((row) => [row.anilistId, JSON.parse(row.mediaJson) as ExternalMetadata]),
    );
    for (const row of matches) {
      const found = row.anilistId != null ? media.get(row.anilistId) : undefined;
      if (found) result[`${row.sourceId}:${row.animeId}`] = found;
    }
  }
  return result;
}
