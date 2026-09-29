import { useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { hibiki } from "@/lib/hibiki";
import { animeTitle } from "@/components/AnimeCard";
import { SmoothImage } from "@/components/SmoothImage";
import { cn } from "@/lib/cn";
import { CALENDAR_HORIZON_DAYS, startOfDay, type CalendarDay, type CalendarEntry } from "@/lib/releaseCalendar";

/** The release schedule as a strip of days (each with how many episodes it brings) and the titles
 * of the picked day underneath. Only the day matters - sources rarely know the hour. */
export function ReleaseCalendarPanel({ days, className }: { days: CalendarDay[]; className?: string }) {
  const { t, i18n } = useTranslation();
  const sourcesQuery = useQuery({ queryKey: ["sources"], queryFn: () => hibiki.sources.list() });
  const sourceById = useMemo(() => new Map((sourcesQuery.data ?? []).map((source) => [source.id, source])), [sourcesQuery.data]);
  const stripRef = useRef<HTMLDivElement>(null);

  const today = startOfDay(Date.now());
  const slots = useMemo(() => {
    const byDay = new Map(days.map((group) => [group.day, group.entries]));
    return Array.from({ length: CALENDAR_HORIZON_DAYS }, (_, index) => {
      const date = new Date(today);
      date.setDate(date.getDate() + index);
      const day = date.getTime();
      return { day, date, entries: byDay.get(day) ?? [] };
    });
  }, [days, today]);

  const [picked, setPicked] = useState<number | null>(null);
  // Until a day is picked, the first one that has anything - an empty "today" is not a useful landing.
  const selected = picked ?? slots.find((slot) => slot.entries.length > 0)?.day ?? today;
  const selectedEntries = slots.find((slot) => slot.day === selected)?.entries ?? [];

  const scrollStrip = (direction: number) => stripRef.current?.scrollBy({ left: direction * 300, behavior: "smooth" });

  return (
    <div className={cn("rounded-2xl border border-border bg-app-surface p-4", className)}>
      <div className="flex items-end gap-1">
        <button type="button" onClick={() => scrollStrip(-1)} className="mb-1 shrink-0 rounded-lg p-1 text-muted transition-colors hover:bg-text/[.06] hover:text-text" aria-label="←">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div ref={stripRef} className="flex flex-1 gap-2 overflow-x-auto pt-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {slots.map((slot, index) => {
            const monthStart = index === 0 || slot.date.getDate() === 1;
            const weekend = slot.date.getDay() === 0 || slot.date.getDay() === 6;
            const active = slot.day === selected;
            return (
              <div key={slot.day} className="relative flex shrink-0 flex-col pt-5">
                {monthStart && (
                  <span className="absolute left-0 top-0 whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-muted">
                    {slot.date.toLocaleDateString(i18n.language, { month: "long" })}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setPicked(slot.day)}
                  className={cn(
                    "relative flex h-14 w-12 flex-col items-center justify-center rounded-xl transition-colors",
                    active ? "bg-accent text-accent-fg" : "bg-text/[.06] text-text hover:bg-text/[.1]",
                  )}
                >
                  <span className={cn("text-[11px] font-semibold capitalize", !active && weekend && "text-rose-400")}>
                    {slot.date.toLocaleDateString(i18n.language, { weekday: "short" })}
                  </span>
                  <span className="text-lg font-bold leading-tight">{slot.date.getDate()}</span>
                  {slot.entries.length > 0 && (
                    <span className="absolute -right-1.5 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-500 px-1 text-[11px] font-bold text-white">
                      {slot.entries.length}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <button type="button" onClick={() => scrollStrip(1)} className="mb-1 shrink-0 rounded-lg p-1 text-muted transition-colors hover:bg-text/[.06] hover:text-text" aria-label="→">
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      <div className="mt-4 flex max-h-[26rem] flex-col gap-2 overflow-y-auto">
        {selectedEntries.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">{t("calendar.noneOnDay")}</p>
        ) : (
          selectedEntries.map((entry) => (
            <ReleaseRow key={`${entry.anime.sourceId}:${entry.anime.id}`} entry={entry} sourceName={sourceById.get(entry.anime.sourceId)?.name} />
          ))
        )}
      </div>
    </div>
  );
}

function ReleaseRow({ entry, sourceName }: { entry: CalendarEntry; sourceName?: string }) {
  const { t } = useTranslation();
  const { anime } = entry;
  // Sources count what is already out; the one being announced is the next one after that.
  const episode = anime.availableEpisodeCount != null ? anime.availableEpisodeCount + 1 : null;
  return (
    <Link
      to="/anime/$sourceId/$animeId"
      params={{ sourceId: anime.sourceId, animeId: anime.id }}
      className="flex items-center gap-3 overflow-hidden rounded-xl bg-text/[.05] transition-colors hover:bg-text/[.09]"
    >
      <div className="h-16 w-11 shrink-0 bg-surface">
        {anime.posterUrl && <SmoothImage src={anime.posterUrl} alt="" loading="lazy" className="h-full w-full" />}
      </div>
      <div className="min-w-0 flex-1 py-2 pr-3">
        <p className="truncate text-sm font-semibold text-text">{animeTitle(anime)}</p>
        <p className="mt-0.5 truncate text-xs text-muted">
          {episode !== null ? t("calendar.episode", { number: episode }) : t("calendar.newEpisode")}
          {sourceName ? ` · ${sourceName}` : ""}
        </p>
      </div>
    </Link>
  );
}
