import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { hibiki } from "@/lib/hibiki";
import type { AnimeTitle, WatchProgress } from "@shared/types";

const RECENT_FETCH_LIMIT = 12;

export interface ContinueWatchingSlot {
  progress: WatchProgress;
  // undefined = title metadata still loading, null = resolved but failed (dead source, removed
  // title, ...) and should be skipped, AnimeTitle = ready to render.
  anime: AnimeTitle | null | undefined;
}

// Shared by the home page, the profile page's own "continue watching" row, and the full history
// page (a bigger `limit`) - they show the same underlying data, so this fetches it once per limit
// under query keys every caller agrees on: react-query's cache means whichever page loads first
// does the actual work for that limit, and another caller asking for the same limit reads it back
// instantly instead of re-running its own redundant getById calls per title. The limit is part of
// the key (not a separate query) so a delete's `invalidateQueries({queryKey: ["recent-progress"]})`
// (a prefix match) still reaches every limit currently in use, not just one.
/** How long a cached title stays good enough to draw a card from without asking the source again.
 * A day, because the fields a card shows don't change - this is "check back eventually in case a
 * source rewrote a title's name or artwork", not a freshness requirement. */
const CARD_METADATA_STALE_MS = 24 * 60 * 60_000;

/** Distinct titles among a set of progress rows, in the order they first appear. */
function distinctTitles(rows: WatchProgress[]): WatchProgress[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.sourceId}:${row.titleId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Title metadata for a set of progress rows, keyed "sourceId:titleId".
 *
 * Shared by both hooks below deliberately: they each used to carry their own copy of this, which
 * is exactly how the on-disk cache ended up wired into one of them and not the other. A card shows
 * four things - name, poster, type, year - and none of them change over a title's life, while
 * fetching them costs a full getById: three requests and ~56KB per card, on every launch.
 *
 * So the cache is read first and handed to react-query as initialData *with the time it was
 * written*, letting react-query's own staleness rule decide: a recent entry is used as-is and no
 * request is made at all, an older one refetches exactly as before. Measured with twelve cards:
 * twelve getById calls before, zero when the cache is fresh, and still twelve when it is stale.
 *
 * The queries are not created until the lookup has answered - initialData is read once, when a
 * query is first created, so building them while the lookup was in flight had every one of them
 * start a request and then receive the cached copy far too late to matter. That lookup is a local
 * SQLite read behind one IPC hop; waiting a frame for it is the whole difference.
 *
 * The detail page is untouched by any of this. It keys its own query separately and always fetches
 * live, so nothing that genuinely changes - episode counts, related titles - is ever read here.
 */
function useCardTitles(rows: WatchProgress[]): Record<string, AnimeTitle | null | undefined> {
  const unique = useMemo(() => distinctTitles(rows), [rows]);
  const cached = useQuery({
    queryKey: ["cached-titles", unique.map((row) => `${row.sourceId}:${row.titleId}`).join(",")],
    queryFn: () => hibiki.sources.cachedTitles(unique.map((row) => ({ sourceId: row.sourceId, animeId: row.titleId }))),
    enabled: unique.length > 0,
    staleTime: Infinity,
  });
  const cachedTitles = cached.data;

  const queries = useQueries({
    queries: (cachedTitles ? unique : []).map((row) => {
      const key = `${row.sourceId}:${row.titleId}`;
      return {
        queryKey: ["continue-item", row.sourceId, row.titleId],
        // Each title resolves independently - a slow or dead source shouldn't block the others.
        queryFn: async (): Promise<AnimeTitle | null> => {
          try {
            return await hibiki.sources.getById(row.sourceId, row.titleId);
          } catch {
            return null;
          }
        },
        initialData: cachedTitles?.[key]?.title,
        initialDataUpdatedAt: cachedTitles?.[key]?.cachedAt,
        staleTime: CARD_METADATA_STALE_MS,
      };
    }),
  });

  const result: Record<string, AnimeTitle | null | undefined> = {};
  unique.forEach((row, index) => {
    result[`${row.sourceId}:${row.titleId}`] = queries[index]?.data;
  });
  return result;
}

export function useContinueWatching(limit: number = RECENT_FETCH_LIMIT): { slots: ContinueWatchingSlot[]; hasHistory: boolean } {
  const recent = useQuery({ queryKey: ["recent-progress", limit], queryFn: () => hibiki.progress.listRecent(limit) });
  // Progress is tracked per episode, so recently-watched episodes of the same title show up as
  // separate rows - dedupe on the title identity alone, before firing any network calls.
  const recentUnique = useMemo(() => distinctTitles(recent.data ?? []), [recent.data]);
  const titles = useCardTitles(recentUnique);
  // Cheap enough (12 items, no work per item) to just recompute on every render rather than reach
  // for useMemo with an awkward dependency key over the per-item query results.
  const slots = recentUnique.map((progress) => ({ progress, anime: titles[`${progress.sourceId}:${progress.titleId}`] }));
  return { slots, hasHistory: !!recent.data?.length };
}

export interface WatchHistoryEntry {
  progress: WatchProgress;
  anime: AnimeTitle | null | undefined;
}

// The history page's own feed (routes/history.tsx) - same ["recent-progress", limit] query as
// useContinueWatching above (same cache entry at a shared limit, same delete-invalidation prefix),
// but deliberately NOT deduped by title: every episode with saved progress gets its own entry,
// since the point of this page is "which episodes did I stop on", not "which titles". Anime
// metadata is still fetched once per unique title (no reason to refetch it per episode).
export function useWatchHistory(limit: number): { entries: WatchHistoryEntry[] } {
  const recent = useQuery({ queryKey: ["recent-progress", limit], queryFn: () => hibiki.progress.listRecent(limit) });
  const rows = recent.data ?? [];
  const titles = useCardTitles(rows);
  // Plain recompute every render, same reasoning as useContinueWatching's `slots` above.
  const entries = rows.map((progress) => ({ progress, anime: titles[`${progress.sourceId}:${progress.titleId}`] }));
  return { entries };
}
