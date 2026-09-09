import { eq, and, or } from "drizzle-orm";
import type { AnimeTitle, CachedAnimeEntry, CachedPlaybackGroupsEntry, DownloadedEpisode, PlaybackGroup } from "@shared/types";
import { getDb } from "./db";
import { cachedAnime, cachedPlaybackGroups, downloadedEpisodes } from "./db/schema";

/** Strips the parts of an AnimeTitle that are only useful for navigating to *other* titles
 * (related/franchise/similar anime) before it goes into cachedAnime - offline, there's nothing to
 * navigate to (those titles' own pages likely aren't cached), so this would just be dead weight in
 * the table for every title that ever has one episode downloaded. */
function stripForCache(anime: AnimeTitle): AnimeTitle {
  const { relatedAnime: _related, franchiseAnime: _franchise, similarAnime: _similar, ...rest } = anime;
  return rest;
}

/**
 * Everything already on disk for the given titles, keyed "sourceId:animeId".
 *
 * This table has been written on every successful getById since it was added, but until now it was
 * only ever *read* in the catch branch - a fallback for when the source is unreachable. So a home
 * screen full of titles the app had already fetched a dozen times still waited on the network to
 * draw a name and a poster it had on disk the whole time. Reading all of it costs about a
 * millisecond; one getById costs a few hundred.
 *
 * Deliberately keyed by request rather than "give me everything": the table grows with every title
 * ever opened, and a screen only ever needs the handful it is about to draw.
 */
export function getCachedAnimeMany(
  keys: Array<{ sourceId: string; animeId: string }>,
): Record<string, CachedAnimeEntry> {
  if (keys.length === 0) return {};
  const result: Record<string, CachedAnimeEntry> = {};
  // Two bound values per title. Keep comfortably below SQLite's common 999-variable limit while
  // turning the normal 12-card screen from twelve statements into one.
  const unique = [...new Map(keys.map((key) => [`${key.sourceId}:${key.animeId}`, key])).values()];
  const BATCH_SIZE = 400;
  for (let offset = 0; offset < unique.length; offset += BATCH_SIZE) {
    const batch = unique.slice(offset, offset + BATCH_SIZE);
    const rows = getDb()
      .select()
      .from(cachedAnime)
      .where(or(...batch.map(({ sourceId, animeId }) => and(eq(cachedAnime.sourceId, sourceId), eq(cachedAnime.animeId, animeId)))))
      .all();
    // `cachedAt` travels with the title on purpose: it is what lets a caller answer "is this still
    // good enough" without a round trip. Without it the only options are to trust the cache
    // forever or to refetch every time, and this data sits squarely between the two.
    for (const row of rows) {
      result[`${row.sourceId}:${row.animeId}`] = { title: JSON.parse(row.animeJson) as AnimeTitle, cachedAt: row.cachedAt };
    }
  }
  return result;
}

export function cacheAnime(sourceId: string, animeId: string, anime: AnimeTitle): void {
  getDb()
    .insert(cachedAnime)
    .values({ sourceId, animeId, animeJson: JSON.stringify(stripForCache(anime)), cachedAt: Date.now() })
    .onConflictDoUpdate({
      target: [cachedAnime.sourceId, cachedAnime.animeId],
      set: { animeJson: JSON.stringify(stripForCache(anime)), cachedAt: Date.now() },
    })
    .run();
}

export function getCachedAnime(sourceId: string, animeId: string): AnimeTitle | null {
  const row = getDb().select().from(cachedAnime).where(and(eq(cachedAnime.sourceId, sourceId), eq(cachedAnime.animeId, animeId))).get();
  return row ? (JSON.parse(row.animeJson) as AnimeTitle) : null;
}

export function cachePlaybackGroups(sourceId: string, animeId: string, groups: PlaybackGroup[]): void {
  getDb()
    .insert(cachedPlaybackGroups)
    .values({ sourceId, animeId, groupsJson: JSON.stringify(groups), cachedAt: Date.now() })
    .onConflictDoUpdate({
      target: [cachedPlaybackGroups.sourceId, cachedPlaybackGroups.animeId],
      set: { groupsJson: JSON.stringify(groups), cachedAt: Date.now() },
    })
    .run();
}

export function getCachedPlaybackGroups(sourceId: string, animeId: string): PlaybackGroup[] | null {
  return getCachedPlaybackGroupsEntry(sourceId, animeId)?.groups ?? null;
}

export function getCachedPlaybackGroupsEntry(sourceId: string, animeId: string): CachedPlaybackGroupsEntry | null {
  const row = getDb()
    .select()
    .from(cachedPlaybackGroups)
    .where(and(eq(cachedPlaybackGroups.sourceId, sourceId), eq(cachedPlaybackGroups.animeId, animeId)))
    .get();
  return row ? { groups: JSON.parse(row.groupsJson) as PlaybackGroup[], cachedAt: row.cachedAt } : null;
}

export function recordDownloadedEpisode(entry: {
  sourceId: string;
  animeId: string;
  groupId: string;
  episodeId: string;
  episodeNumber: number;
  episodeLabel: string;
  filePath: string;
  fileSizeBytes: number;
  durationMs: number | null;
  quality: string | null;
}): void {
  getDb()
    .insert(downloadedEpisodes)
    .values({ ...entry, downloadedAt: Date.now() })
    .onConflictDoUpdate({
      target: [downloadedEpisodes.sourceId, downloadedEpisodes.animeId, downloadedEpisodes.episodeId],
      set: {
        groupId: entry.groupId,
        episodeNumber: entry.episodeNumber,
        episodeLabel: entry.episodeLabel,
        filePath: entry.filePath,
        fileSizeBytes: entry.fileSizeBytes,
        durationMs: entry.durationMs,
        quality: entry.quality,
        downloadedAt: Date.now(),
      },
    })
    .run();
}

function titleFor(anime: AnimeTitle | null, fallbackId: string): string {
  return anime?.russianName || anime?.englishName || anime?.originalName || fallbackId;
}

// Joined with cachedAnime in-memory after one batched lookup. Keeping the JSON decode here is
// simpler than a SQL join while avoiding the old extra indexed statement for every episode row.
export function listDownloadedEpisodes(): DownloadedEpisode[] {
  const rows = getDb()
    .select()
    .from(downloadedEpisodes)
    .all();
  const cached = getCachedAnimeMany(rows.map((row) => ({ sourceId: row.sourceId, animeId: row.animeId })));
  return rows.map((r) => {
    const anime = cached[`${r.sourceId}:${r.animeId}`]?.title ?? null;
    return {
      sourceId: r.sourceId,
      animeId: r.animeId,
      groupId: r.groupId,
      episodeId: r.episodeId,
      episodeNumber: r.episodeNumber,
      episodeLabel: r.episodeLabel,
      filePath: r.filePath,
      fileSizeBytes: r.fileSizeBytes,
      durationMs: r.durationMs,
      downloadedAt: r.downloadedAt,
      animeTitle: titleFor(anime, r.animeId),
      animePosterUrl: anime?.posterUrl ?? null,
    };
  });
}

export function getDownloadedEpisode(sourceId: string, animeId: string, episodeId: string): { filePath: string; durationMs: number | null; quality: string | null } | null {
  const row = getDb()
    .select({ filePath: downloadedEpisodes.filePath, durationMs: downloadedEpisodes.durationMs, quality: downloadedEpisodes.quality })
    .from(downloadedEpisodes)
    .where(and(eq(downloadedEpisodes.sourceId, sourceId), eq(downloadedEpisodes.animeId, animeId), eq(downloadedEpisodes.episodeId, episodeId)))
    .get();
  return row ?? null;
}

export function deleteDownloadedEpisodeRow(sourceId: string, animeId: string, episodeId: string): void {
  getDb()
    .delete(downloadedEpisodes)
    .where(and(eq(downloadedEpisodes.sourceId, sourceId), eq(downloadedEpisodes.animeId, animeId), eq(downloadedEpisodes.episodeId, episodeId)))
    .run();
}
