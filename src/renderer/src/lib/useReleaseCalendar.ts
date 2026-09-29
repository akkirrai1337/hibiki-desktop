import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { hibiki } from "@/lib/hibiki";
import { groupByDay, upcomingRelease, type CalendarDay, type CalendarEntry } from "@/lib/releaseCalendar";

// Titles worth watching for a release: the library minus what is finished or abandoned, plus what
// was recently watched. Capped because each one is a live request to its source.
const TRACKED_LIMIT = 40;
const RECENT_LIMIT = 30;
const DETAILS_STALE_MS = 6 * 60 * 60_000;

interface TrackedTitle {
  sourceId: string;
  animeId: string;
}

/** Upcoming releases of the titles the user follows, per day. Shared by the calendar page and the
 * home page's strip, which read the same query keys and so cost the sources one request per title. */
export function useReleaseCalendar(): { days: CalendarDay[]; loading: boolean } {
  const libraryQuery = useQuery({ queryKey: ["library"], queryFn: () => hibiki.library.list() });
  const recentQuery = useQuery({ queryKey: ["recent-progress", RECENT_LIMIT], queryFn: () => hibiki.progress.listRecent(RECENT_LIMIT) });

  const tracked = useMemo<TrackedTitle[]>(() => {
    const seen = new Set<string>();
    const result: TrackedTitle[] = [];
    const add = (entry: TrackedTitle) => {
      const key = `${entry.sourceId}:${entry.animeId}`;
      if (seen.has(key)) return;
      seen.add(key);
      result.push(entry);
    };
    for (const entry of libraryQuery.data ?? []) {
      if (entry.category === "completed" || entry.category === "dropped") continue;
      // What the library saved may be old, but a show it already saw as finished is not coming back.
      if (entry.anime?.status === "released") continue;
      add({ sourceId: entry.sourceId, animeId: entry.animeId });
    }
    for (const row of recentQuery.data ?? []) add({ sourceId: row.sourceId, animeId: row.titleId });
    return result.slice(0, TRACKED_LIMIT);
  }, [libraryQuery.data, recentQuery.data]);

  const details = useQueries({
    queries: tracked.map((entry) => ({
      queryKey: ["calendar-title", entry.sourceId, entry.animeId],
      queryFn: () => hibiki.sources.getById(entry.sourceId, entry.animeId),
      staleTime: DETAILS_STALE_MS,
      retry: false,
    })),
  });

  const now = Date.now();
  const days = useMemo(() => {
    const entries: CalendarEntry[] = [];
    for (const query of details) {
      if (!query.data) continue;
      const at = upcomingRelease(query.data, now);
      if (at !== null) entries.push({ anime: query.data, at });
    }
    return groupByDay(entries);
    // `now` moves every render; the result only needs refreshing when a detail lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [details.map((query) => query.dataUpdatedAt).join(",")]);

  const loading = libraryQuery.isPending || recentQuery.isPending || details.some((query) => query.isPending);
  return { days, loading };
}
