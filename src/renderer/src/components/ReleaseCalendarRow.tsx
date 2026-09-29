import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { HorizontalScrollRow } from "@/components/HorizontalScrollRow";
import { SmoothImage } from "@/components/SmoothImage";
import { animeTitle } from "@/components/AnimeCard";
import { startOfDay, type CalendarEntry } from "@/lib/releaseCalendar";
import { useReleaseCalendar } from "@/lib/useReleaseCalendar";

const CARD_WIDTH_CLASSES = "w-[calc((100%-4*1rem)/5.4)] xl:w-[calc((100%-5*1rem)/6.4)]";
const MAX_CARDS = 20;

/** The next releases across the titles the user follows, soonest first, as a poster strip. Renders
 * nothing until there is something to show, so a home page whose sources give no dates is unchanged. */
export function ReleaseCalendarRow() {
  const { t, i18n } = useTranslation();
  const { days } = useReleaseCalendar();
  const entries = useMemo(() => days.flatMap((day) => day.entries).slice(0, MAX_CARDS), [days]);
  if (entries.length === 0) return null;
  const today = startOfDay(Date.now());
  const dayLabel = (at: number) => {
    const diff = Math.round((startOfDay(at) - today) / 86_400_000);
    if (diff === 0) return t("calendar.today");
    if (diff === 1) return t("calendar.tomorrow");
    return new Date(at).toLocaleDateString(i18n.language, { weekday: "short", day: "numeric", month: "short" });
  };
  return (
    <HorizontalScrollRow
      items={entries}
      getKey={(entry) => `${entry.anime.sourceId}:${entry.anime.id}`}
      renderItem={(entry) => <ReleaseCard entry={entry} label={dayLabel(entry.at)} />}
      cardWidthClassName={CARD_WIDTH_CLASSES}
    />
  );
}

function ReleaseCard({ entry, label }: { entry: CalendarEntry; label: string }) {
  const { t } = useTranslation();
  const { anime } = entry;
  const episode = anime.availableEpisodeCount != null ? anime.availableEpisodeCount + 1 : null;
  return (
    <Link to="/anime/$sourceId/$animeId" params={{ sourceId: anime.sourceId, animeId: anime.id }} className="group block w-full">
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-surface ring-1 ring-border">
        {anime.posterUrl && <SmoothImage src={anime.posterUrl} alt={animeTitle(anime)} loading="lazy" className="h-full w-full transition-transform duration-500 ease-out group-hover:scale-[1.035]" />}
        <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-semibold capitalize text-zinc-100 backdrop-blur-sm">{label}</span>
      </div>
      <p className="mt-3 line-clamp-2 text-base font-semibold leading-snug tracking-[-.01em] text-text/90 transition-colors group-hover:text-text">{animeTitle(anime)}</p>
      <p className="mt-1 text-sm text-muted">{episode !== null ? t("calendar.episode", { number: episode }) : t("calendar.newEpisode")}</p>
    </Link>
  );
}
