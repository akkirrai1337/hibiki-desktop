// Where a title actually gets described: which provider to ask, how a source title is bound to one
// of that provider's entries, and what is cached so neither question is asked twice.
//
// The two clients (anilistClient.ts, malClient.ts) only make requests. The rules for scoring a
// match and merging fields are pure and live in shared/externalMetadata.ts. This file owns
// everything stateful in between.
import { and, eq, inArray } from "drizzle-orm";
import {
  MATCH_CONFIDENCE_THRESHOLD,
  pickBestMatch,
  type ExternalMetadata,
  type MatchCandidate,
  type MetadataProviderId,
} from "@shared/externalMetadata";
import type { AnimeTitle } from "@shared/types";
import { getDb } from "../db";
import { externalMetadataMatches, externalMetadataMedia } from "../db/schema";
import { logger } from "../logger";
import * as anilist from "./anilistClient";
import * as mal from "./malClient";

interface ProviderClient {
  fetchById(externalId: number): Promise<ExternalMetadata | null>;
  search(name: string): Promise<Array<{ candidate: MatchCandidate; media: ExternalMetadata }> | null>;
}

const CLIENTS: Record<MetadataProviderId, ProviderClient> = {
  anilist: { fetchById: anilist.fetchById, search: anilist.search },
  mal: { fetchById: mal.fetchById, search: mal.search },
};

const OTHER_PROVIDER: Record<MetadataProviderId, MetadataProviderId> = { anilist: "mal", mal: "anilist" };

// A finished show's metadata is effectively frozen; an airing one moves every week and carries the
// next-episode countdown the title page prints.
const TTL_SETTLED_MS = 14 * 24 * 60 * 60 * 1000;
const TTL_AIRING_MS = 12 * 60 * 60 * 1000;
// A search that completed and found nothing is remembered too, or every visit to a title the
// provider does not have re-runs the same fruitless search. Short enough that an entry added later
// is picked up within a week.
const TTL_NO_MATCH_MS = 7 * 24 * 60 * 60 * 1000;

function ttlFor(media: ExternalMetadata): number {
  return media.status === "released" ? TTL_SETTLED_MS : TTL_AIRING_MS;
}

function readCachedMedia(provider: MetadataProviderId, externalId: number): { media: ExternalMetadata; fresh: boolean } | null {
  const row = getDb()
    .select()
    .from(externalMetadataMedia)
    .where(and(eq(externalMetadataMedia.provider, provider), eq(externalMetadataMedia.externalId, externalId)))
    .get();
  if (!row) return null;
  const media = JSON.parse(row.mediaJson) as ExternalMetadata;
  return { media, fresh: Date.now() - row.cachedAt < ttlFor(media) };
}

function writeCachedMedia(media: ExternalMetadata): void {
  const values = {
    provider: media.provider,
    externalId: media.externalId,
    mediaJson: JSON.stringify(media),
    cachedAt: Date.now(),
  };
  getDb()
    .insert(externalMetadataMedia)
    .values(values)
    .onConflictDoUpdate({
      target: [externalMetadataMedia.provider, externalMetadataMedia.externalId],
      set: { mediaJson: values.mediaJson, cachedAt: values.cachedAt },
    })
    .run();
}

function readMatch(sourceId: string, animeId: string, provider: MetadataProviderId) {
  return getDb()
    .select()
    .from(externalMetadataMatches)
    .where(
      and(
        eq(externalMetadataMatches.sourceId, sourceId),
        eq(externalMetadataMatches.animeId, animeId),
        eq(externalMetadataMatches.provider, provider),
      ),
    )
    .get();
}

function writeMatch(
  sourceId: string,
  animeId: string,
  provider: MetadataProviderId,
  externalId: number | null,
  confidence: number | null,
  manual: boolean,
): void {
  // A manual binding is the user's own correction, and every write passes through here - so this is
  // the one place that has to refuse to walk over it.
  if (!manual && readMatch(sourceId, animeId, provider)?.manual) return;
  const matchedAt = Date.now();
  getDb()
    .insert(externalMetadataMatches)
    .values({ sourceId, animeId, provider, externalId, confidence, manual, matchedAt })
    .onConflictDoUpdate({
      target: [externalMetadataMatches.sourceId, externalMetadataMatches.animeId, externalMetadataMatches.provider],
      set: { externalId, confidence, manual, matchedAt },
    })
    .run();
}

/** Records the cross-provider id a provider handed us as the other provider's match, so a switch or
 * a fallback never repeats the search that established this one. Only ever fills a gap: an existing
 * match (manual or not) is left exactly as it is. */
function recordCrossMatch(sourceId: string, animeId: string, media: ExternalMetadata): void {
  const pairs: Array<[MetadataProviderId, number | null | undefined]> = [
    ["anilist", media.anilistId],
    ["mal", media.malId],
  ];
  for (const [provider, externalId] of pairs) {
    if (provider === media.provider || externalId == null) continue;
    if (readMatch(sourceId, animeId, provider)) continue;
    writeMatch(sourceId, animeId, provider, externalId, null, false);
  }
}

/**
 * Establishes this provider's entry from what the *other* provider already knows, rather than by
 * searching for the title's name again.
 *
 * Worth a request of its own because search is the fragile, heavily rate-limited half of both APIs
 * and the half that guesses; a lookup by id is neither. AniList indexes MAL ids directly, and a
 * stored AniList entry carries the MAL id that MAL itself can be asked for - so a title matched
 * through one provider can be bound to the other exactly, both ways.
 */
async function crossLookup(sourceId: string, animeId: string, provider: MetadataProviderId): Promise<ExternalMetadata | null> {
  const other = OTHER_PROVIDER[provider];
  const otherMatch = readMatch(sourceId, animeId, other);
  if (!otherMatch?.externalId) return null;
  const malId = other === "mal" ? otherMatch.externalId : readCachedMedia(other, otherMatch.externalId)?.media.malId;
  if (malId == null) return null;
  return provider === "anilist" ? anilist.fetchByMalId(malId) : mal.fetchById(malId);
}

/** The provider entry bound to this title, refreshing a stale one and falling back to what is
 * stored when the provider cannot be reached. Null means this provider has nothing for it. */
async function metadataForProvider(anime: AnimeTitle, provider: MetadataProviderId): Promise<ExternalMetadata | null> {
  const { sourceId, id: animeId } = anime;
  const client = CLIENTS[provider];
  const match = readMatch(sourceId, animeId, provider);

  if (match) {
    if (match.externalId == null) {
      // A remembered failure. Manual "no match" is not a thing, so only the TTL retires it.
      if (Date.now() - match.matchedAt < TTL_NO_MATCH_MS) return null;
    } else {
      const cached = readCachedMedia(provider, match.externalId);
      if (cached?.fresh) return cached.media;
      const refreshed = await client.fetchById(match.externalId);
      if (refreshed) {
        writeCachedMedia(refreshed);
        recordCrossMatch(sourceId, animeId, refreshed);
        return refreshed;
      }
      // Offline, or the provider is down. A stale entry beats an empty page.
      return cached?.media ?? null;
    }
  }

  const crossMatched = await crossLookup(sourceId, animeId, provider);
  if (crossMatched) {
    writeCachedMedia(crossMatched);
    writeMatch(sourceId, animeId, provider, crossMatched.externalId, null, false);
    recordCrossMatch(sourceId, animeId, crossMatched);
    logger.debug("metadata", `${provider} bound ${sourceId}:${animeId} to ${crossMatched.externalId} via ${OTHER_PROVIDER[provider]}`);
    return crossMatched;
  }

  // Two shots at most - a third search costs another request for a title that is very likely simply
  // absent from this provider.
  const searchNames = [anime.englishName, anime.originalName, ...(anime.synonyms ?? [])]
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .slice(0, 2);

  let searched = false;
  for (const name of searchNames) {
    const results = await client.search(name);
    // The provider is unreachable, rate-limiting us, or - as AniList was while this was written -
    // disabled outright. Give up on it for now and leave no record: a remembered "no match" is a
    // seven-day statement about the *title*, and writing one because of an outage would keep the
    // page thin long after the provider is back.
    if (!results) return null;
    searched = true;
    const best = pickBestMatch(anime, results.map((result) => result.candidate));
    if (!best) continue;
    const found = results.find((result) => result.media.externalId === best.externalId)?.media;
    if (!found) continue;
    writeCachedMedia(found);
    writeMatch(sourceId, animeId, provider, best.externalId, Math.round(best.confidence * 100), false);
    recordCrossMatch(sourceId, animeId, found);
    logger.debug("metadata", `${provider} matched ${sourceId}:${animeId} to ${best.externalId} (${Math.round(best.confidence * 100)}%)`);
    return found;
  }

  if (searched) {
    writeMatch(sourceId, animeId, provider, null, null, false);
    logger.debug("metadata", `${provider} has no match for ${sourceId}:${animeId} (threshold ${MATCH_CONFIDENCE_THRESHOLD})`);
  }
  return null;
}

/**
 * Describes one title from the first provider in `order` that can, trying the next when one cannot.
 *
 * Never throws: a caller merges whatever comes back, and null simply means the page keeps the
 * source's own metadata.
 */
export async function getExternalMetadata(anime: AnimeTitle, order: MetadataProviderId[]): Promise<ExternalMetadata | null> {
  for (const provider of order) {
    const media = await metadataForProvider(anime, provider).catch((error) => {
      logger.warn("metadata", `${provider} lookup failed for ${anime.sourceId}:${anime.id}: ${String(error)}`);
      return null;
    });
    if (media) return media;
  }
  return null;
}

/** What currently describes this title, for the title page's own "metadata" line - the first
 * provider in `order` that has a usable binding, and whether the user set it by hand. */
export function currentMatch(
  sourceId: string,
  animeId: string,
  order: MetadataProviderId[],
): { provider: MetadataProviderId; externalId: number; manual: boolean; confidence: number | null } | null {
  for (const provider of order) {
    const match = readMatch(sourceId, animeId, provider);
    if (match?.externalId == null) continue;
    return { provider, externalId: match.externalId, manual: match.manual, confidence: match.confidence };
  }
  return null;
}

/** Candidates for the title page's manual picker, from the first provider in `order` whose search
 * endpoint answers - both providers' searches go down independently, and the picker is the one
 * screen where a person is waiting on one. */
export async function searchProviders(
  query: string,
  order: MetadataProviderId[],
): Promise<{ results: ExternalMetadata[]; searchedProvider: MetadataProviderId | null }> {
  for (const provider of order) {
    const results = await CLIENTS[provider].search(query).catch(() => null);
    if (!results) continue;
    for (const result of results) writeCachedMedia(result.media);
    return { results: results.map((result) => result.media), searchedProvider: provider };
  }
  // No provider answered at all. The picker says so, and its paste-an-id path still works.
  return { results: [], searchedProvider: null };
}

/** One entry by id, for the picker's paste-a-URL path - the way a title gets rebound while every
 * search endpoint is down. */
export async function fetchEntry(provider: MetadataProviderId, externalId: number): Promise<ExternalMetadata | null> {
  const media = await CLIENTS[provider].fetchById(externalId).catch(() => null);
  if (media) writeCachedMedia(media);
  return media ?? readCachedMedia(provider, externalId)?.media ?? null;
}

/** Binds a title to a provider entry by hand, from the title page. Marked manual, which is what
 * stops the automatic matcher from ever overwriting it again. */
export async function setManualMatch(
  sourceId: string,
  animeId: string,
  provider: MetadataProviderId,
  externalId: number,
): Promise<ExternalMetadata | null> {
  const media = (await CLIENTS[provider].fetchById(externalId)) ?? readCachedMedia(provider, externalId)?.media ?? null;
  if (media) writeCachedMedia(media);
  writeMatch(sourceId, animeId, provider, externalId, null, true);
  return media;
}

/** Drops a title's bindings for every provider, so the next lookup matches it again from scratch. */
export function clearMatch(sourceId: string, animeId: string): void {
  getDb()
    .delete(externalMetadataMatches)
    .where(and(eq(externalMetadataMatches.sourceId, sourceId), eq(externalMetadataMatches.animeId, animeId)))
    .run();
}

/**
 * Cached-only lookup for the several titles a list screen is about - it draws from disk without
 * ever waiting on a provider, and lets the per-title path above fill the gaps in the background.
 *
 * Keyed "sourceId:animeId", carrying whichever provider's entry is stored for it; a title matched
 * to both is reported from the first provider in `order` that has one, so a list and the title page
 * it leads to agree.
 */
export function getCachedExternalMetadataMany(
  keys: Array<{ sourceId: string; animeId: string }>,
  order: MetadataProviderId[],
): Record<string, ExternalMetadata> {
  if (keys.length === 0 || order.length === 0) return {};
  const db = getDb();
  const result: Record<string, ExternalMetadata> = {};
  const unique = [...new Map(keys.map((key) => [`${key.sourceId}:${key.animeId}`, key])).values()];
  const BATCH_SIZE = 400;
  for (let offset = 0; offset < unique.length; offset += BATCH_SIZE) {
    const batch = unique.slice(offset, offset + BATCH_SIZE);
    const matches = db
      .select()
      .from(externalMetadataMatches)
      // One bound value per title (well below SQLite's 999-variable limit) rather than a
      // (sourceId, animeId, provider) triple each: ids collide across sources rarely enough that
      // fetching the few extra rows and dropping them below beats tripling the variable count.
      .where(inArray(externalMetadataMatches.animeId, batch.map((key) => key.animeId)))
      .all()
      .filter((row) => batch.some((key) => key.sourceId === row.sourceId && key.animeId === row.animeId));
    const ids = matches.map((row) => row.externalId).filter((id): id is number => id != null);
    if (ids.length === 0) continue;
    const media = new Map(
      db
        .select()
        .from(externalMetadataMedia)
        .where(inArray(externalMetadataMedia.externalId, ids))
        .all()
        .map((row) => [`${row.provider}:${row.externalId}`, JSON.parse(row.mediaJson) as ExternalMetadata]),
    );
    for (const row of matches) {
      const key = `${row.sourceId}:${row.animeId}`;
      const stored = row.externalId != null ? media.get(`${row.provider}:${row.externalId}`) : undefined;
      if (!stored) continue;
      const existing = result[key];
      // Ranked by the caller's provider order, not by which row SQLite happened to return first.
      if (!existing || order.indexOf(stored.provider) < order.indexOf(existing.provider)) result[key] = stored;
    }
  }
  return result;
}
