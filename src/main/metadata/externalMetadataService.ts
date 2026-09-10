// Where a title actually gets described: which provider to ask, how a source title is bound to one
// of that provider's entries, and what is cached so neither question is asked twice.
//
// The two clients (anilistClient.ts, malClient.ts) only make requests. The rules for scoring a
// match and merging fields are pure and live in shared/externalMetadata.ts. This file owns
// everything stateful in between.
import { and, eq } from "drizzle-orm";
import {
  MATCH_CONFIDENCE_THRESHOLD,
  METADATA_PROVIDER_IDS,
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
import * as kitsu from "./kitsuClient";
import * as mal from "./malClient";

interface ProviderClient {
  fetchById(externalId: number): Promise<ExternalMetadata | null>;
  search(name: string): Promise<Array<{ candidate: MatchCandidate; media: ExternalMetadata }> | null>;
  /** Looks a title up by its MAL id, which is the id every provider here either *is* or publishes -
   * the common currency that lets one provider's match become another's without a search. MAL's own
   * client needs no such method: its id is that currency. */
  fetchByMalId?(malId: number): Promise<ExternalMetadata | null>;
  /** Only Kitsu names titles by slug in its web URLs, so only Kitsu can resolve one. */
  fetchBySlug?(slug: string): Promise<ExternalMetadata | null>;
}

const CLIENTS: Record<MetadataProviderId, ProviderClient> = {
  anilist: { fetchById: anilist.fetchById, search: anilist.search, fetchByMalId: anilist.fetchByMalId },
  mal: { fetchById: mal.fetchById, search: mal.search },
  kitsu: {
    fetchById: kitsu.fetchById,
    search: kitsu.search,
    fetchByMalId: kitsu.fetchByMalId,
    fetchBySlug: kitsu.fetchBySlug,
  },
};

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
    ["kitsu", media.kitsuId],
  ];
  for (const [provider, externalId] of pairs) {
    if (provider === media.provider || externalId == null) continue;
    if (readMatch(sourceId, animeId, provider)) continue;
    writeMatch(sourceId, animeId, provider, externalId, null, false);
  }
}

/** The MAL id this title is already known by, from any provider that has been matched to it - the
 * common currency between all three. */
function knownMalId(sourceId: string, animeId: string): number | null {
  for (const provider of METADATA_PROVIDER_IDS) {
    const match = readMatch(sourceId, animeId, provider);
    if (!match?.externalId) continue;
    if (provider === "mal") return match.externalId;
    const malId = readCachedMedia(provider, match.externalId)?.media.malId;
    if (malId != null) return malId;
  }
  return null;
}

/**
 * Establishes this provider's entry from what another provider already knows, rather than by
 * searching for the title's name again.
 *
 * Worth a request of its own because search is the fragile, heavily rate-limited half of every one
 * of these APIs, and the half that guesses; a lookup by id is neither. AniList and Kitsu both index
 * MAL ids, and both publish one, so a title matched through any provider can be bound to the others
 * exactly.
 */
async function crossLookup(sourceId: string, animeId: string, provider: MetadataProviderId): Promise<ExternalMetadata | null> {
  const malId = knownMalId(sourceId, animeId);
  if (malId == null) return null;
  if (provider === "mal") return mal.fetchById(malId);
  return CLIENTS[provider].fetchByMalId?.(malId) ?? null;
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
    logger.debug("metadata", `${provider} bound ${sourceId}:${animeId} to ${crossMatched.externalId} by cross-reference`);
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

/** One entry by id or by Kitsu slug, for the picker's paste-a-URL path - the way a title gets
 * rebound while every search endpoint is down. */
export async function fetchEntry(
  provider: MetadataProviderId,
  reference: { externalId?: number; slug?: string },
): Promise<ExternalMetadata | null> {
  const client = CLIENTS[provider];
  const media = await (reference.slug
    ? (client.fetchBySlug?.(reference.slug) ?? Promise.resolve(null))
    : reference.externalId != null
      ? client.fetchById(reference.externalId)
      : Promise.resolve(null)
  ).catch(() => null);
  if (media) writeCachedMedia(media);
  if (media) return media;
  return reference.externalId != null ? (readCachedMedia(provider, reference.externalId)?.media ?? null) : null;
}

/**
 * Describes a whole screenful of titles, in one pass, as a background job.
 *
 * All at once rather than title by title on purpose: a list where some cards are named by the
 * provider and the rest by their source reads as broken even when every entry is right, so the
 * caller swaps the whole screen over at the end or not at all.
 *
 * Sequential, because both queues are serialized anyway (see requestQueue.ts) and a screen of
 * uncached titles is a request each; running them "in parallel" would only queue them in a less
 * predictable order. Titles already matched cost nothing but a cache read.
 */
export async function describeMany(
  titles: AnimeTitle[],
  order: MetadataProviderId[],
): Promise<Array<{ animeId: string; media: ExternalMetadata }>> {
  const described: Array<{ animeId: string; media: ExternalMetadata }> = [];
  for (const title of titles) {
    const media = await getExternalMetadata(title, order);
    if (media) described.push({ animeId: title.id, media });
  }
  return described;
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
