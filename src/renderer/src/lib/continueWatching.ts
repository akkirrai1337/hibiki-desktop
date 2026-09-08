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
export function useContinueWatching(limit: number = RECENT_FETCH_LIMIT): { slots: ContinueWatchingSlot[]; hasHistory: boolean } {
  const recent = useQuery({ queryKey: ["recent-progress", limit], queryFn: () => hibiki.progress.listRecent(limit) });
  // Progress is tracked per episode, so recently-watched episodes of the same title show up as
  // separate rows - dedupe on the title identity alone, before firing any network calls.
  const recentUnique = useMemo(() => {
    const seen = new Set<string>();
    return (recent.data ?? []).filter((p) => {
      const key = `${p.sourceId}:${p.titleId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [recent.data]);
  // Each title resolves independently (a slow or dead source shouldn't block the other slots) -
  // the slot count is known immediately from local watch-progress rows.
  const queries = useQueries({
    queries: recentUnique.map((progress) => ({
      queryKey: ["continue-item", progress.sourceId, progress.titleId],
      queryFn: async (): Promise<AnimeTitle | null> => {
        try {
          return await hibiki.sources.getById(progress.sourceId, progress.titleId);
        } catch {
          return null;
        }
      },
    })),
  });
  // Cheap enough (12 items, no work per item) to just recompute on every render rather than
  // reach for useMemo with an awkward dependency key over the per-item query results.
  const slots = recentUnique.map((progress, i) => ({ progress, anime: queries[i].data }));
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
  const entries = recent.data ?? [];
  const uniqueTitles = useMemo(() => {
    const seen = new Set<string>();
    return entries.filter((p) => {
      const key = `${p.sourceId}:${p.titleId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [entries]);
  const queries = useQueries({
    queries: uniqueTitles.map((progress) => ({
      queryKey: ["continue-item", progress.sourceId, progress.titleId],
      queryFn: async (): Promise<AnimeTitle | null> => {
        try {
          return await hibiki.sources.getById(progress.sourceId, progress.titleId);
        } catch {
          return null;
        }
      },
    })),
  });
  // Plain recompute every render, same reasoning as useContinueWatching's own `slots` above - a
  // handful of entries with no real work per item doesn't need useMemo's added complexity here.
  const animeByTitleKey = new Map<string, AnimeTitle | null | undefined>();
  uniqueTitles.forEach((progress, i) => animeByTitleKey.set(`${progress.sourceId}:${progress.titleId}`, queries[i].data));
  return { entries: entries.map((progress) => ({ progress, anime: animeByTitleKey.get(`${progress.sourceId}:${progress.titleId}`) })) };
}
