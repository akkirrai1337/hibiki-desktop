import type { AnimeTitle } from "@shared/types";

export interface CalendarEntry {
  anime: AnimeTitle;
  /** Epoch ms of the release, as the source reported it - only its calendar day is meaningful. */
  at: number;
}

export interface CalendarDay {
  /** Local midnight of the day, epoch ms. */
  day: number;
  entries: CalendarEntry[];
}

/** How far ahead the calendar looks. Far enough to cover a weekly show's next two airings. */
export const CALENDAR_HORIZON_DAYS = 14;

export function startOfDay(epochMs: number): number {
  const date = new Date(epochMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The release a title announces, if it is still ahead of (or on) `now`'s calendar day. A source
 * only ever knows the day, so "today" stays today for its whole length. A title the source already
 * calls released is skipped: a stale nextEpisodeAt on a finished show is not a release. */
export function upcomingRelease(anime: AnimeTitle, now: number): number | null {
  if (!anime.nextEpisodeAt || anime.nextEpisodeAt <= 0) return null;
  if (anime.status === "released") return null;
  const today = startOfDay(now);
  const day = startOfDay(anime.nextEpisodeAt);
  return day >= today && day < today + CALENDAR_HORIZON_DAYS * 86_400_000 ? anime.nextEpisodeAt : null;
}

/** Entries grouped per calendar day, earliest day first; days with nothing are left out. */
export function groupByDay(entries: CalendarEntry[]): CalendarDay[] {
  const byDay = new Map<number, CalendarEntry[]>();
  for (const entry of entries) {
    const day = startOfDay(entry.at);
    const list = byDay.get(day);
    if (list) list.push(entry);
    else byDay.set(day, [entry]);
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([day, list]) => ({ day, entries: list }));
}
