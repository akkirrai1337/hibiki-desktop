import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CalendarDays } from "lucide-react";
import { hibiki } from "@/lib/hibiki";
import { animeTitle } from "@/components/AnimeCard";
import { SmoothImage } from "@/components/SmoothImage";
import { startOfDay, type CalendarEntry } from "@/lib/releaseCalendar";
import { useReleaseCalendar } from "@/lib/useReleaseCalendar";

// Rendered persistently from __root.tsx instead - see index.tsx for why.
export function CalendarPage() {
  const { t, i18n } = useTranslation();
  const sourcesQuery = useQuery({ queryKey: ["sources"], queryFn: () => hibiki.sources.list() });
  const { days, loading } = useReleaseCalendar();
  const now = Date.now();
  const sourceById = useMemo(() => new Map((sourcesQuery.data ?? []).map((source) => [source.id, source])), [sourcesQuery.data]);
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
