import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PullToRefresh } from "@/components/PullToRefresh";
import { useTranslation } from "react-i18next";
import { Play, Radio, RefreshCw, WifiOff } from "lucide-react";
import { hibiki } from "@/lib/hibiki";
import { AnimeCard, PosterGrid, PosterGridSkeleton, PosterRow, PosterRowSkeleton, animeTitle } from "@/components/AnimeCard";
import { ContinueWatchingFrameRow } from "@/components/ContinueWatchingRow";
import { ErrorBanner } from "@/components/ErrorBanner";
import { HERO_ACTION_CLASS, HeroCarousel, type HeroSlide } from "@/components/Hero";
import { MobileHero } from "@/components/MobileHero";
import { isMobile } from "@/lib/mobile";
import { cn } from "@/lib/cn";
import { useContinueWatching } from "@/lib/continueWatching";
import { useUiStore } from "@/stores/uiStore";
import { pickRelevanceSort } from "@/lib/catalogSort";
import type { AnimeTitle } from "@shared/types";

const RECOMMENDED_COUNT = 20;
const POOL_WINDOW = 24;
// The pool window is fetched starting at a random offset into the source's "popular" ranking
// (0..MAX_POOL_OFFSET), so "you might like" pulls from a different slice of the catalog each
// visit instead of always reshuffling the same top N titles.
const MAX_POOL_OFFSET = 100;
const HERO_SLIDE_COUNT = 5;
// A genre row only earns its place if enough of the pool actually shares a genre - otherwise
// it'd just be a near-duplicate of "you might like" with 2-3 items.
const MIN_GENRE_MATCHES = 4;

function randomPoolOffset(): number {
  return Math.floor(Math.random() * (MAX_POOL_OFFSET + 1));
}

// Fisher-Yates - picked once per fetched pool (see the useMemo below), not on every render, so
// the grid doesn't jumble itself while the user is looking at it.
function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function CatalogPage() {
  const { t } = useTranslation();
  const sources = useQuery({ queryKey: ["sources"], queryFn: () => hibiki.sources.list() });
  const activeSourceId = useUiStore((s) => s.activeSourceId);
  const source = sources.data?.find((s) => s.id === activeSourceId) ?? sources.data?.[0];
  // The source's own best-known order, once we know what it offers (undefined = its default listing).
  const settings = useQuery({
    queryKey: ["filterCatalog", source?.id],
    enabled: !!source,
    queryFn: () => hibiki.sources.filterCatalog(source!.id),
  });
  // A user-picked override (Settings > Home) wins whenever the current source still actually offers
  // that sort id - a source can change its own sort ids between versions, and silently falling back
  // to the auto-guess is safer than sending a now-nonexistent id to the source.
  const homeSortOverride = useUiStore((s) => (source ? s.homeSortBySource[source.id] : undefined));
  const sortOptions = settings.data?.sortOptions ?? [];
  const sortMode = (homeSortOverride && sortOptions.some((o) => o.id === homeSortOverride))
    ? homeSortOverride
    : pickRelevanceSort(sortOptions);
  const settingsReady = settings.isFetched;
  const hero = useQuery({
    queryKey: ["hero", source?.id, sortMode ?? ""],
    enabled: !!source && settingsReady,
    queryFn: () => hibiki.sources.search(source!.id, { limit: HERO_SLIDE_COUNT, sort: sortMode }),
  });
  // Compute the source's window in the same render that enables the query. Keeping this in state
  // and replacing it from an effect after `source` arrived let React Query start one request with
  // the old offset and then immediately start a second with the new one.
  const poolOffset = useMemo(randomPoolOffset, [source?.id]);
  const pool = useQuery({
    queryKey: ["popular-pool", source?.id, poolOffset, sortMode ?? ""],
    enabled: !!source && settingsReady,
    queryFn: async () => {
      const window = await hibiki.sources.search(source!.id, { offset: poolOffset, limit: POOL_WINDOW, sort: sortMode });
      // A short catalog can have fewer titles than our random offset - fall back to the start
      // of the ranking rather than showing an empty section.
      if (window.length > 0 || poolOffset === 0) return window;
      return hibiki.sources.search(source!.id, { offset: 0, limit: POOL_WINDOW, sort: sortMode });
    },
  });
  // What was watched on this source, turned into what to watch next on it (core/recommendations).
  // Only asked once there is history; the backend reuses its answer until the history changes.
  const { hasHistory } = useContinueWatching();
  const recommendations = useQuery({
    queryKey: ["recommendations", source?.id, sortMode ?? ""],
    enabled: !!source && settingsReady && hasHistory,
    queryFn: () => hibiki.sources.recommendations(source!.id, sortMode),
    staleTime: 5 * 60 * 1000,
  });
  const picks = recommendations.data?.picks ?? [];
  const continuations = recommendations.data?.continuations ?? [];
  // Shared with the profile page's own "continue watching" row - see useContinueWatching, which
  // caches per-title lookups under query keys both pages agree on so whichever loads first does
  // the actual work.
  const heroSlides = useMemo(() => hero.data ?? [], [hero.data]);
  const poolTitles = useMemo(() => pool.data ?? [], [pool.data]);
  const isNew = !hasHistory;
  const sourceById = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s])), [sources.data]);
  // Re-shuffled each time a fresh pool comes in (new source, new random offset, ...) so this
  // section doesn't always show the same titles in the same order.
  const recommended = useMemo(() => shuffled(poolTitles).slice(0, RECOMMENDED_COUNT), [poolTitles]);
  // Most common genre in the current pool, with at least MIN_GENRE_MATCHES titles sharing it -
  // gives a themed row using only data we already fetched, no extra request.
  const genreSection = useMemo(() => {
    const items = poolTitles;
    const counts = new Map<string, number>();
    for (const item of items) for (const genre of item.genres ?? []) counts.set(genre, (counts.get(genre) ?? 0) + 1);
    let topGenre: string | null = null; let topCount = 0;
    for (const [genre, count] of counts) if (count > topCount) { topGenre = genre; topCount = count; }
    if (!topGenre || topCount < MIN_GENRE_MATCHES) return null;
    return { genre: topGenre, items: items.filter((item) => item.genres?.includes(topGenre!)) };
  }, [poolTitles]);
  const queryClient = useQueryClient();
  const refreshHome = () => Promise.all([
    sources.refetch(),
    // Only with a source: without one these have nothing to ask (and are switched off).
    ...(source ? [hero.refetch(), pool.refetch()] : []),
    queryClient.invalidateQueries({ queryKey: ["recent-progress"] }),
    queryClient.invalidateQueries({ queryKey: ["recommendations"] }),
  ]);
  return <div className="min-h-full bg-app-bg pb-12">
    <PullToRefresh onRefresh={refreshHome} />
    {sources.isLoading && <HeroSkeleton />}{sources.data?.length === 0 && <EmptySources />}{sources.isError && <ErrorBanner message={(sources.error as Error).message} className="m-8" />}
    {source && <>
      {/* Neither answered: the source is down or the phone is offline. One plain statement of that,
          instead of a missing hero over an empty section under a raw error. What is local - the
          continue-watching row - still shows below. (The previous visit's titles used to be painted
          from disk meanwhile; they were always different titles, swapped out a second later.) */}
      {hero.isError && pool.isError ? <SourceUnavailable name={source.name} retrying={hero.isFetching || pool.isFetching} onRetry={() => void refreshHome()} /> : heroSlides.length > 0
        ? isMobile
          ? <MobileHero slides={heroSlides.map((slide) => toHeroSlide(slide, t("catalog.openTitle"), source.iconUrl))} label={t("catalog.trendingOnPrefix")} sourceName={source.name} />
          : <HeroCarousel slides={heroSlides.map((slide) => toHeroSlide(slide, t("catalog.openTitle"), source.iconUrl))} label={t("catalog.trendingOnPrefix")} sourceName={source.name} />
        : hero.isPending && <HeroSkeleton />}
      <div className="space-y-12 px-8 pt-10 mobile:space-y-8 mobile:px-4 mobile:pt-5">
        {pool.isError && !hero.isError && <ErrorBanner message={(pool.error as Error).message} onRetry={() => void pool.refetch()} />}
        {/* Always the frame row: swapping to poster cards below a threshold meant the section
            changed shape as history filled up, and a single captured frame still reads as "here's
            where you left off" better than a poster does. */}
        {!isNew && <Section title={t("catalog.continueWatching")} action={t("catalog.viewHistory")} to="/history">
          <ContinueWatchingFrameRow sourceById={sourceById} />
        </Section>}
        {continuations.length > 0 && <Section title={t("catalog.continuations")}>
          <HomeTitles>{continuations.map(({ anime }) => <AnimeCard key={anime.id} anime={anime} />)}</HomeTitles>
        </Section>}
        {picks.length > 0 && <Section title={t("catalog.forYou", { source: source.name })}>
          <HomeTitles>{picks.map(({ anime }) => <AnimeCard key={anime.id} anime={anime} />)}</HomeTitles>
        </Section>}
        {/* The pool is what is popular on the source, nothing more - personal picks are above. */}
        {!pool.isError && <Section title={t("catalog.popularNow")} action={t("catalog.openCatalog")} to="/catalog">
          {pool.isPending ? (isMobile ? <PosterRowSkeleton /> : <PosterGridSkeleton count={15} />) : <HomeTitles>{recommended.map(item => <AnimeCard key={`${item.sourceId}:${item.id}`} anime={item} />)}</HomeTitles>}
        </Section>}
        {genreSection && <Section title={t("catalog.genreSection", { genre: genreSection.genre })} action={t("catalog.openCatalog")} to="/catalog">
          <HomeTitles>{genreSection.items.map(item => <AnimeCard key={`${item.sourceId}:${item.id}`} anime={item} />)}</HomeTitles>
        </Section>}
      </div>
    </>}
  </div>;
}
/** A source title as the shared carousel wants it - see HeroSlide for why this mapping exists at
 * all rather than the carousel taking an AnimeTitle. */
function toHeroSlide(anime: AnimeTitle, openLabel: string, sourceIconUrl?: string | null): HeroSlide {
  return {
    key: `${anime.sourceId}:${anime.id}`,
    sourceId: anime.sourceId,
    sourceIconUrl,
    title: animeTitle(anime),
    description: anime.description,
    posterUrl: anime.posterUrl,
    type: anime.type,
    year: anime.year,
    episodeCount: anime.availableEpisodeCount,
    genres: anime.genres,
    rating: anime.ratings?.[0] ? { value: anime.ratings[0].value, source: anime.ratings[0].source } : null,
    action: (
      <Link to="/anime/$sourceId/$animeId" params={{ sourceId: anime.sourceId, animeId: anime.id }} className={HERO_ACTION_CLASS}>
        <Play className="ml-0.5 h-4 w-4 fill-current" strokeWidth={0} />
        {openLabel}
      </Link>
    ),
  };
}

function Section({ title, action, to, children }: { title: string; action?: string; to?: "/catalog" | "/history"; children: React.ReactNode }) { return <section><div className="mb-5 flex items-center justify-between gap-3 mobile:mb-3"><h2 className="text-2xl font-bold tracking-[-.02em] text-text mobile:truncate mobile:text-[19px]">{title}</h2>{action && to && <Link to={to} className="text-sm font-semibold text-muted transition-colors hover:text-accent-text mobile:shrink-0 mobile:text-[13px]">{action} →</Link>}</div>{children}</section>; }
// A grid on desktop; on the phone a row the thumb scrolls sideways, so a section stays one screen-line tall.
function HomeTitles({ children }: { children: React.ReactNode }) { return isMobile ? <PosterRow>{children}</PosterRow> : <PosterGrid>{children}</PosterGrid>; }
/**
 * The hero while its titles load, in the hero's own shape - the full-bleed slide with its text at
 * the bottom on the phone, the tall banner on the desktop - so nothing below moves when it arrives.
 * (Its query waits for the source's sort orders first, which on a slow source is most of the wait.)
 */
function HeroSkeleton() {
  if (isMobile) {
    return <div aria-hidden className="relative -mt-[var(--safe-top)] overflow-hidden" style={{ height: "calc(min(46vh, 420px) + var(--safe-top))", minHeight: 340 }}>
      <div className="skeleton absolute inset-0 opacity-60" />
      <div className="absolute inset-0" style={{ background: "linear-gradient(to bottom, transparent 30%, rgb(var(--color-bg) / 0.85) 80%, rgb(var(--color-bg)))" }} />
      <div className="absolute inset-x-0 bottom-0 px-4 pb-4">
        <div className="skeleton h-2.5 w-24 rounded-full" />
        <div className="skeleton mt-3 h-7 w-4/5 rounded-lg" />
        <div className="skeleton mt-2 h-7 w-1/2 rounded-lg" />
        <div className="skeleton mt-3 h-3 w-2/5 rounded-full" />
        <div className="mt-4 flex items-center justify-between">
          <div className="skeleton h-10 w-32 rounded-full" />
          <div className="flex gap-1.5"><div className="skeleton h-1 w-6 rounded-full" /><div className="skeleton h-1 w-1.5 rounded-full" /><div className="skeleton h-1 w-1.5 rounded-full" /></div>
        </div>
      </div>
    </div>;
  }
  return <div aria-hidden className="relative min-h-[520px] overflow-hidden border-b border-white/[.04] px-8 py-20">
    <div className="skeleton absolute inset-0 opacity-40" />
    <div className="relative flex min-h-[360px] max-w-2xl flex-col justify-end">
      <div className="skeleton h-3 w-40 rounded-full" />
      <div className="skeleton mt-5 h-12 w-[28rem] max-w-full rounded-xl" />
      <div className="skeleton mt-5 h-3 w-full max-w-lg rounded-full" />
      <div className="skeleton mt-2 h-3 w-4/5 max-w-lg rounded-full" />
      <div className="skeleton mt-8 h-11 w-40 rounded-xl" />
    </div>
  </div>;
}
function SourceUnavailable({ name, retrying, onRetry }: { name: string; retrying: boolean; onRetry: () => void }) {
  const { t } = useTranslation();
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  return <div className="flex min-h-[340px] items-center justify-center px-8 py-16 mobile:min-h-[300px] mobile:px-6 mobile:pb-6 mobile:pt-[calc(4rem+var(--safe-top))]">
    <div className="max-w-sm text-center">
      <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-text/[.06]"><WifiOff className="h-6 w-6 text-muted" strokeWidth={1.75} /></div>
      <h1 className="text-xl font-bold text-text">{t("catalog.sourceUnavailableTitle", { source: name })}</h1>
      <p className="mt-3 text-sm leading-6 text-muted">{offline ? t("common.offlineHint") : t("catalog.sourceUnavailableText")}</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <button onClick={onRetry} disabled={retrying} className="inline-flex items-center gap-2 rounded-xl bg-text/[.08] px-4 py-2.5 text-sm font-bold text-text transition-colors hover:bg-text/[.14] disabled:opacity-60 mobile:rounded-full mobile:px-5">
          <RefreshCw className={cn("h-4 w-4", retrying && "animate-spin")} strokeWidth={2} />{t("common.retry")}
        </button>
        {offline && <Link to="/downloads" className="rounded-xl px-4 py-2.5 text-sm font-semibold text-muted transition-colors hover:text-text mobile:rounded-full">{t("common.openDownloads")}</Link>}
      </div>
    </div>
  </div>;
}
function EmptySources() { const { t } = useTranslation(); return <div className="flex min-h-[calc(100vh-76px)] items-center justify-center p-8"><div className="max-w-sm text-center"><div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-text/[.06]"><Radio className="h-6 w-6 text-muted" strokeWidth={1.75} /></div><h1 className="text-xl font-bold text-text">{t("catalog.emptySourcesTitle")}</h1><p className="mt-3 text-sm leading-6 text-muted">{t("catalog.emptySourcesText")}</p><Link to="/sources" className="mt-6 inline-block rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-accent-fg">{t("catalog.openSources")}</Link></div></div>; }
