import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CalendarDays } from "lucide-react";
import { hibiki } from "@/lib/hibiki";
import { animeTitle } from "@/components/AnimeCard";
import { SmoothImage } from "@/components/SmoothImage";
import { groupByDay, startOfDay, upcomingRelease, type CalendarEntry } from "@/lib/releaseCalendar";

// Titles worth watching for a release: the library minus what is finished or abandoned, plus what
// was recently watched. Capped because each one is a live request to its source.
const TRACKED_LIMIT = 40;
const RECENT_LIMIT = 30;
const DETAILS_STALE_MS = 6 * 60 * 60_000;

interface TrackedTitle {
  sourceId: string;
  animeId: string;
}

// Rendered persistently from __root.tsx instead - see index.tsx for why.
export function CalendarPage() {
  const { t, i18n } = useTranslation();
  const libraryQuery = useQuery({ queryKey: ["library"], queryFn: () => hibiki.library.list() });
  const recentQuery = useQuery({ queryKey: ["recent-progress", RECENT_LIMIT], queryFn: () => hibiki.progress.listRecent(RECENT_LIMIT) });
  const sourcesQuery = useQuery({ queryKey: ["sources"], queryFn: () => hibiki.sources.list() });

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

  const sourceById = useMemo(() => new Map((sourcesQuery.data ?? []).map((source) => [source.id, source])), [sourcesQuery.data]);
  const loading = libraryQuery.isPending || recentQuery.isPending || details.some((query) => query.isPending);
  const today = startOfDay(now);

  const dayLabel = (day: number) => {
    const diff = Math.round((day - today) / 86_400_000);
    const date = new Date(day).toLocaleDateString(i18n.language, { weekday: "long", day: "numeric", month: "long" });
    if (diff === 0) return `${t("calendar.today")} · ${date}`;
    if (diff === 1) return `${t("calendar.tomorrow")} · ${date}`;
    return date;
  };

  return (
    <div className="min-h-full bg-app-bg px-8 py-8 pb-16">
      <div className="mx-auto max-w-4xl">
        <p className="mb-6 text-sm text-muted">{t("calendar.hint")}</p>
        {days.length === 0 ? (
          loading ? <p className="text-sm text-muted">{t("calendar.loading")}</p> : (
            <div className="flex flex-col items-center gap-3 py-24 text-center text-muted">
              <CalendarDays className="h-9 w-9" strokeWidth={1.5} />
              <p className="max-w-sm text-sm">{t("calendar.empty")}</p>
            </div>
          )
        ) : (
          <div className="flex flex-col gap-8">
            {days.map((group) => (
              <section key={group.day}>
                <h2 className="mb-3 text-sm font-bold capitalize tracking-wide text-text">{dayLabel(group.day)}</h2>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {group.entries.map((entry) => (
                    <CalendarRow key={`${entry.anime.sourceId}:${entry.anime.id}`} entry={entry} sourceName={sourceById.get(entry.anime.sourceId)?.name} />
                  ))}
                </div>
              </section>
            ))}
            {loading && <p className="text-xs text-muted">{t("calendar.loading")}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function CalendarRow({ entry, sourceName }: { entry: CalendarEntry; sourceName?: string }) {
  const { t } = useTranslation();
  const { anime } = entry;
  // Sources count what is already out; the one being announced is the next one after that.
  const episode = anime.availableEpisodeCount != null ? anime.availableEpisodeCount + 1 : null;
  return (
    <Link
      to="/anime/$sourceId/$animeId"
      params={{ sourceId: anime.sourceId, animeId: anime.id }}
      className="group flex items-center gap-3 rounded-xl border border-border bg-app-surface p-2.5 transition-colors hover:bg-text/[.05]"
    >
      <div className="aspect-[2/3] w-14 shrink-0 overflow-hidden rounded-lg bg-surface ring-1 ring-border">
        {anime.posterUrl && <SmoothImage src={anime.posterUrl} alt="" loading="lazy" className="h-full w-full" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm font-semibold leading-snug text-text">{animeTitle(anime)}</p>
        <p className="mt-1 text-xs text-muted">
          {episode !== null ? t("calendar.episode", { number: episode }) : t("calendar.newEpisode")}
          {sourceName ? ` · ${sourceName}` : ""}
        </p>
      </div>
    </Link>
  );
}
