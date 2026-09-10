import { ipcMain } from "electron";
import { eq, and, gte, desc, sql } from "drizzle-orm";
import { IPC } from "@shared/ipc";
import type { DailyActivity, LibraryEntry, WatchProgress } from "@shared/types";
import { getDb } from "../db";
import { library, watchProgress, dailyActivity, titleRatings } from "../db/schema";
import type { ExtensionRuntime } from "../extensions/runtime";
import { logger } from "../logger";

// A day's "date" key is the local calendar day (not UTC), so activity attributes to the day the
// user actually watched it in their own timezone.
function localDateKey(epochMs: number): string {
  const d = new Date(epochMs);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Caps a single progress-save's contribution to "time watched today" - saves land every few
// seconds during real playback, so a legitimate delta is small; without a cap, seeking far
// forward would inflate watch-time stats by the size of the seek instead of time actually spent.
const MAX_WATCHED_DELTA_MS = 30_000;

/**
 * Mirrors one library change to the source's account, when that source syncs.
 *
 * Here rather than in the screens that change the library: there are already four callers and
 * every future one would have to remember. Deliberately not awaited and never allowed to throw -
 * a library change is local and must succeed whether or not a website is reachable, and a failed
 * push is a log line, not a refused edit. The next change to that title pushes the current state
 * anyway, so nothing needs a retry queue to stay eventually correct.
 */
function pushToAccount(
  runtime: ExtensionRuntime,
  sourceId: string,
  animeId: string,
  category: string | null,
): void {
  if (!runtime.isLibrarySyncEnabled(sourceId)) return;
  void runtime
    .syncLibraryEntry(sourceId, { animeId, category })
    .then(() => logger.debug("sync", `${sourceId}/${animeId} -> ${category ?? "removed"}`))
    .catch((error: unknown) => {
      logger.warn("sync", `${sourceId}/${animeId} not synced: ${error instanceof Error ? error.message : String(error)}`);
    });
}

/**
 * Mirrors a rating to the source's account, carrying the category the title already has there.
 *
 * The category matters: a source reads `syncLibraryEntry` as one statement about a title, and
 * YummyAnime removes it from its lists when that statement carries no category. So a rating sent
 * without one would quietly un-list a title the user only meant to score. The local library answers
 * that for anything in it, and for anything else the source's own list is asked once - and if that
 * cannot be reached, nothing is sent at all rather than something wrong.
 */
async function pushRating(runtime: ExtensionRuntime, sourceId: string, animeId: string, rating: number): Promise<void> {
  if (!runtime.isLibrarySyncEnabled(sourceId)) return;
  const local = getDb()
    .select()
    .from(library)
    .where(and(eq(library.sourceId, sourceId), eq(library.animeId, animeId)))
    .get();
  let category = local?.category ?? null;
  if (!category) {
    const remote = await runtime.listLibrary(sourceId);
    category = remote.find((entry) => entry.animeId === animeId)?.category ?? null;
  }
  await runtime.syncLibraryEntry(sourceId, { animeId, category, rating });
}

export function registerLibraryHandlers(runtime: ExtensionRuntime): void {
  ipcMain.handle(IPC.ratingGet, (_e, sourceId: string, animeId: string): number | null => {
    const row = getDb()
      .select()
      .from(titleRatings)
      .where(and(eq(titleRatings.sourceId, sourceId), eq(titleRatings.animeId, animeId)))
      .get();
    return row?.rating ?? null;
  });

  ipcMain.handle(IPC.ratingSet, async (_e, sourceId: string, animeId: string, rating: number | null) => {
    const db = getDb();
    if (rating == null) {
      db.delete(titleRatings).where(and(eq(titleRatings.sourceId, sourceId), eq(titleRatings.animeId, animeId))).run();
    } else {
      const values = { sourceId, animeId, rating, ratedAt: Date.now() };
      db.insert(titleRatings)
        .values(values)
        .onConflictDoUpdate({ target: [titleRatings.sourceId, titleRatings.animeId], set: { rating, ratedAt: values.ratedAt } })
        .run();
    }
    // Kept local first and pushed after: a rating is this app's own record, and a source that is
    // unreachable, signed out, or simply slow must not cost the user their answer. Awaited, unlike
    // the library push, so the screen can say whether the account got it.
    if (rating != null) {
      await pushRating(runtime, sourceId, animeId, rating).catch((error: unknown) => {
        logger.warn("sync", `${sourceId}/${animeId} rating not synced: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  });

  ipcMain.handle(IPC.libraryList, (): LibraryEntry[] => {
    const rows = getDb().select().from(library).all();
    return rows.map((r) => ({
      animeId: r.animeId,
      sourceId: r.sourceId,
      category: r.category as LibraryEntry["category"],
      addedAt: r.addedAt,
      anime: JSON.parse(r.animeJson),
    }));
  });

  ipcMain.handle(IPC.libraryUpsert, (_e, entry: LibraryEntry) => {
    getDb()
      .insert(library)
      .values({
        animeId: entry.animeId,
        sourceId: entry.sourceId,
        category: entry.category,
        addedAt: entry.addedAt,
        animeJson: JSON.stringify(entry.anime),
      })
      .onConflictDoUpdate({
        target: [library.sourceId, library.animeId],
        set: { category: entry.category, animeJson: JSON.stringify(entry.anime) },
      })
      .run();
    pushToAccount(runtime, entry.sourceId, entry.animeId, entry.category);
  });

  ipcMain.handle(IPC.libraryRemove, (_e, sourceId: string, animeId: string) => {
    getDb()
      .delete(library)
      .where(and(eq(library.sourceId, sourceId), eq(library.animeId, animeId)))
      .run();
    pushToAccount(runtime, sourceId, animeId, null);
  });

  ipcMain.handle(IPC.progressGet, (_e, sourceId: string, titleId: string, episodeId: string): WatchProgress | null => {
    const row = getDb()
      .select()
      .from(watchProgress)
      .where(
        and(
          eq(watchProgress.sourceId, sourceId),
          eq(watchProgress.titleId, titleId),
          eq(watchProgress.episodeId, episodeId),
        ),
      )
      .get();
    return row ?? null;
  });

  ipcMain.handle(IPC.progressUpsert, (_e, incoming: WatchProgress) => {
    // Split off before the row is written: it describes this save, not the episode, and there is
    // no column for it.
    const { watchedDeltaMs: measuredWatchedMs, ...progress } = incoming;
    const db = getDb();
    const previous = db
      .select()
      .from(watchProgress)
      .where(
        and(
          eq(watchProgress.sourceId, progress.sourceId),
          eq(watchProgress.titleId, progress.titleId),
          eq(watchProgress.episodeId, progress.episodeId),
        ),
      )
      .get();

    db.insert(watchProgress)
      .values(progress)
      .onConflictDoUpdate({
        target: [watchProgress.sourceId, watchProgress.titleId, watchProgress.episodeId],
        set: {
          episodeNumber: progress.episodeNumber,
          groupId: progress.groupId,
          positionMs: progress.positionMs,
          durationMs: progress.durationMs,
          quality: progress.quality,
          translation: progress.translation,
          playerName: progress.playerName,
          // Sticky: once an episode is marked watched, a later rewind-and-stop shouldn't un-mark
          // it. Coerced to 0/1 — better-sqlite3 can't bind a raw JS boolean as a sql`` param (the
          // "watched" column itself round-trips fine through drizzle's own boolean mode, but a
          // value interpolated straight into a raw sql`` template bypasses that conversion).
          watched: sql`${watchProgress.watched} OR ${progress.watched ? 1 : 0}`,
          updatedAt: progress.updatedAt,
        },
      })
      .run();

    // Attribute this save to the local day it happened on, for the profile's activity stats.
    //
    // How far the position moved is only a stand-in for time watched, and a poor one: seeking
    // across a film books the whole jump as watched, capped at MAX_WATCHED_DELTA_MS per save but
    // still wrong every time. The player counts what actually played and sends it, so use that
    // whenever it is there; the fallback is for callers that only move the position.
    const watchedDeltaMs =
      measuredWatchedMs !== undefined
        ? Math.max(0, measuredWatchedMs)
        : Math.max(0, Math.min(progress.positionMs - (previous?.positionMs ?? 0), MAX_WATCHED_DELTA_MS));
    const newlyCompleted = progress.watched && !(previous?.watched ?? false);
    if (watchedDeltaMs > 0 || newlyCompleted) {
      const date = localDateKey(progress.updatedAt);
      db.insert(dailyActivity)
        .values({ date, watchedMs: watchedDeltaMs, completedCount: newlyCompleted ? 1 : 0 })
        .onConflictDoUpdate({
          target: dailyActivity.date,
          set: {
            watchedMs: sql`${dailyActivity.watchedMs} + ${watchedDeltaMs}`,
            completedCount: sql`${dailyActivity.completedCount} + ${newlyCompleted ? 1 : 0}`,
          },
        })
        .run();
    }
  });

  ipcMain.handle(IPC.progressListRecent, (_e, limit: number) =>
    getDb().select().from(watchProgress).orderBy(desc(watchProgress.updatedAt)).limit(limit).all(),
  );

  ipcMain.handle(IPC.progressListForAnime, (_e, sourceId: string, titleId: string): WatchProgress[] =>
    getDb()
      .select()
      .from(watchProgress)
      .where(and(eq(watchProgress.sourceId, sourceId), eq(watchProgress.titleId, titleId)))
      .all(),
  );

  ipcMain.handle(IPC.progressRemoveForAnime, (_e, sourceId: string, titleId: string) => {
    getDb()
      .delete(watchProgress)
      .where(and(eq(watchProgress.sourceId, sourceId), eq(watchProgress.titleId, titleId)))
      .run();
  });

  // Same as progressRemoveForAnime but scoped to one episode - the history page (see
  // routes/history.tsx) shows one row per episode rather than per anime, so "delete this entry"
  // there means just this row, not every episode of the title.
  ipcMain.handle(IPC.progressRemoveEpisode, (_e, sourceId: string, titleId: string, episodeId: string) => {
    getDb()
      .delete(watchProgress)
      .where(and(eq(watchProgress.sourceId, sourceId), eq(watchProgress.titleId, titleId), eq(watchProgress.episodeId, episodeId)))
      .run();
  });

  // Only ever updates an existing row (see VideoPlayer's onCaptureThumbnail, fired on pause/leave)
  // - a progress row for this episode should already exist by the time a real frame is worth
  // capturing; if one doesn't yet (playback just started), this is a harmless no-op update of 0
  // rows rather than inventing a progress row from just a thumbnail.
  ipcMain.handle(IPC.progressSaveThumbnail, (_e, sourceId: string, titleId: string, episodeId: string, dataUrl: string) => {
    getDb()
      .update(watchProgress)
      .set({ thumbnailDataUrl: dataUrl })
      .where(and(eq(watchProgress.sourceId, sourceId), eq(watchProgress.titleId, titleId), eq(watchProgress.episodeId, episodeId)))
      .run();
  });

  ipcMain.handle(IPC.progressListDailyActivity, (_e, days: number): DailyActivity[] => {
    const since = localDateKey(Date.now() - (days - 1) * 86_400_000);
    return getDb()
      .select()
      .from(dailyActivity)
      .where(gte(dailyActivity.date, since))
      .orderBy(dailyActivity.date)
      .all();
  });
}
