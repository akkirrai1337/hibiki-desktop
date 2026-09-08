import { memo } from "react";
import { SmoothImage } from "@/components/SmoothImage";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Radio, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import type { AnimeTitle } from "@shared/types";

export function animeTitle(anime: AnimeTitle) { return anime.russianName || anime.englishName || anime.originalName || anime.id; }

// Same pick Android makes for a compact rating label (LocalProfileSnapshot.kt: `ratings.firstOrNull()`)
// - a source orders its own ratings list with its native rating first (see e.g. yummy-anime.js's
// toRatings()), ahead of cross-referenced ones (MAL, Shikimori, ...), rather than us trying to pick
// "the best" source ourselves.
function formatRating(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

// Matches AnimeCard's own poster/title/meta proportions so a grid mixing loaded cards and
// still-loading slots doesn't visibly hitch when a skeleton flips over to the real thing.
export function SkeletonCard() {
  return <div>
    <div className="aspect-[2/3] animate-pulse rounded-xl bg-text/[.06]" />
    <div className="mt-2.5 h-3.5 w-4/5 animate-pulse rounded bg-text/[.06]" />
    <div className="mt-1.5 h-3 w-2/5 animate-pulse rounded bg-text/[.05]" />
  </div>;
}

// Which source a title came from - only worth showing where a list can mix titles from several
// installed sources at once (continue watching, library), same as the Android app's
// AnimeSourceBadge; a single-source grid (catalog, search, popular-on-this-source) doesn't need it.
export interface AnimeCardSource {
  name: string;
  iconUrl?: string | null;
  // The extension this title came from is no longer installed (see knownSourcesStore) - the badge
  // still shows its remembered name/icon (same as Android's AnimeSourceBadge), but flags it with
  // error-tinted styling and a trailing delete icon, and stays visible instead of only on hover so
  // it isn't missed on a card the source can no longer resolve fresh data for.
  missing?: boolean;
}

// Its own component rather than markup inlined in AnimeCard: the continue-watching row's frame
// cards (ContinueWatchingRow) aren't AnimeCards at all - they show a captured video frame - but
// need the exact same badge, in the same corner, revealed by the same hover.
//
// Positioned absolutely against whatever it's dropped into, and keyed off that container's own
// `group` hover - so the parent has to be `relative` and carry `group`.
export function SourceBadge({ source }: { source?: AnimeCardSource }) {
  if (!source) return null;
  return (
    <div
      className={cn(
        "pointer-events-none absolute left-2 top-2 z-10 flex max-w-[calc(100%-16px)] items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 shadow-sm backdrop-blur-sm transition-opacity duration-200",
        source.missing ? "bg-rose-500/20 opacity-100" : "bg-black/70 opacity-0 group-hover:opacity-100",
      )}
    >
      <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-full", source.missing ? "bg-rose-500/20" : "bg-white/15")}>
        {source.iconUrl ? <img src={source.iconUrl} alt="" className="h-full w-full object-cover" /> : <Radio className={cn("h-2.5 w-2.5", source.missing ? "text-rose-200" : "text-zinc-300")} strokeWidth={2} />}
      </span>
      <span className={cn("truncate text-[11px] font-medium", source.missing ? "text-rose-200" : "text-zinc-100")}>{source.name}</span>
      {source.missing && <Trash2 className="h-2.5 w-2.5 shrink-0 text-rose-200" strokeWidth={2.5} />}
    </div>
  );
}

export const AnimeCard = memo(function AnimeCard({ anime, progress, source }: { anime: AnimeTitle; progress?: number; source?: AnimeCardSource }) {
  const { t } = useTranslation();
  const title = animeTitle(anime);
  const rating = anime.ratings?.[0]?.value;
  const meta = [
    anime.year,
    anime.availableEpisodeCount && t("common.episodesShort", { count: anime.availableEpisodeCount }),
    rating && `★ ${formatRating(rating)}`,
  ].filter(Boolean).join(" · ");
  return <Link
    to="/anime/$sourceId/$animeId"
    params={{ sourceId: anime.sourceId, animeId: anime.id }}
    className="group block w-full [contain-intrinsic-size:auto_440px] [content-visibility:auto]"
  >
    <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-surface ring-1 ring-border">
      {anime.posterUrl ? <SmoothImage
        src={anime.posterUrl}
        alt={title}
        loading="lazy"
        // `will-change` only while actually hovered, not unconditionally - applied to every card
        // at once, it makes the browser keep a persistent GPU compositing layer alive for every
        // single poster in the grid for as long as it's mounted, not just the one about to
        // transform. That layer bookkeeping cost scales with how many cards have accumulated as
        // more catalog pages load, working against scroll performance instead of for it - the
        // opposite of what `will-change` is supposed to buy here.
        className="h-full w-full transition-transform duration-500 ease-out group-hover:scale-[1.035] group-hover:will-change-transform"
      /> : <div className="flex h-full items-center justify-center px-3 text-center text-sm text-muted">{t("common.noPoster")}</div>}
      <SourceBadge source={source} />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-1.5 p-3 opacity-0 transition-[opacity,transform] duration-300 group-hover:translate-y-0 group-hover:opacity-100">
        {anime.genres && anime.genres.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {anime.genres.slice(0, 3).map((genre) => (
              <span key={genre} className="rounded-md bg-white/20 px-1.5 py-0.5 text-[11px] font-medium text-white shadow-sm">{genre}</span>
            ))}
          </div>
        )}
        {anime.description ? (
          <p className="line-clamp-4 select-text text-xs leading-relaxed text-zinc-300">{anime.description}</p>
        ) : !anime.genres?.length ? (
          <p className="line-clamp-2 select-text text-base font-semibold leading-snug text-white">{title}</p>
        ) : null}
      </div>
      {progress !== undefined && <div className="absolute inset-x-0 bottom-0 h-[3px] bg-white/15 opacity-0 transition-opacity duration-300 group-hover:opacity-100"><div className="h-full bg-red-500" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} /></div>}
    </div>
    <p className="mt-3 line-clamp-2 select-text text-base font-semibold leading-snug tracking-[-.01em] text-text/90 transition-colors group-hover:text-text">{title}</p>
    <div className="mt-1 flex items-center gap-1.5">
      {anime.type && <span className="shrink-0 rounded-md bg-text/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted">{anime.type}</span>}
      <p className="line-clamp-1 text-sm text-muted">{meta || t("common.anime")}</p>
    </div>
  </Link>;
});
