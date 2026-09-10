import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Play, Radio } from "lucide-react";
import { hibiki } from "@/lib/hibiki";
import { useCachedTitleList } from "@/lib/cachedTitleList";
import { AnimeCard, PosterGrid, PosterGridSkeleton, animeTitle } from "@/components/AnimeCard";
import { ContinueWatchingFrameRow } from "@/components/ContinueWatchingRow";
import { ErrorBanner } from "@/components/ErrorBanner";
import { useDescribedTitles } from "@/lib/describedTitles";
import { HERO_ACTION_CLASS, HeroCarousel, type HeroSlide } from "@/components/Hero";
import { AggregatorHome } from "@/components/AggregatorHome";
import { useContinueWatching } from "@/lib/continueWatching";
import { useUiStore } from "@/stores/uiStore";
import { useAggregatorBrowsing, useMetadataProviderKey } from "@/lib/aggregatorBrowsing";
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
  const aggregatorBrowsing = useAggregatorBrowsing(source);
  const providerKey = useMetadataProviderKey(source);
  const sortMode = source?.supportedSorts.includes("RATING") ? "RATING" : undefined;
  const hero = useCachedTitleList({
    queryKey: ["hero", source?.id],
    cacheKey: source ? `hero:${source.id}` : null,
    enabled: !!source && !aggregatorBrowsing,
    queryFn: () => hibiki.sources.search(source!.id, { limit: HERO_SLIDE_COUNT, sort: sortMode }),
  });
  // Compute the source's window in the same render that enables the query. Keeping this in state
  // and replacing it from an effect after `source` arrived let React Query start one request with
  // the old offset and then immediately start a second with the new one.
  const poolOffset = useMemo(randomPoolOffset, [source?.id]);
  const pool = useCachedTitleList({
    queryKey: ["popular-pool", source?.id, poolOffset],
    // Deliberately without the offset: this visit's slice is meant to be a different one, so the
    // useful thing to paint while it loads is the slice from last time.
    cacheKey: source ? `popular-pool:${source.id}` : null,
    enabled: !!source && !aggregatorBrowsing,
    queryFn: async () => {
      const window = await hibiki.sources.search(source!.id, { offset: poolOffset, limit: POOL_WINDOW, sort: sortMode });
      // A short catalog can have fewer titles than our random offset - fall back to the start
      // of the ranking rather than showing an empty section.
      if (window.length > 0 || poolOffset === 0) return window;
      return hibiki.sources.search(source!.id, { offset: 0, limit: POOL_WINDOW, sort: sortMode });
    },
  });
  // Shared with the profile page's own "continue watching" row - see useContinueWatching, which
  // caches per-title lookups under query keys both pages agree on so whichever loads first does
  // the actual work.
  const { hasHistory } = useContinueWatching();
  // Both rows are described by the metadata provider once the whole row is - see
  // useDescribedTitles for why it is all at once rather than card by card.
  const { titles: heroSlides, describing: describingHero } = useDescribedTitles(source?.id, aggregatorBrowsing ? undefined : hero.data, providerKey);
  const { titles: poolTitles, describing: describingPool } = useDescribedTitles(source?.id, aggregatorBrowsing ? undefined : pool.data, providerKey);
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
  return <div className="min-h-full bg-app-bg pb-12">
    {sources.isLoading && <HeroSkeleton />}{sources.data?.length === 0 && <EmptySources />}{sources.isError && <ErrorBanner message={(sources.error as Error).message} className="m-8" />}
    {source && <>
      {/* The aggregator's home replaces everything except continue-watching, which is about
          episodes already started - the source's own titles, with the source's own progress. */}
      {aggregatorBrowsing ? (
        <AggregatorHome source={source}>
          {!isNew && (
            <div className="space-y-12 px-8 pt-10">
              <Section title={t("catalog.continueWatching")} action={t("catalog.viewHistory")} to="/history">
                <ContinueWatchingFrameRow sourceById={sourceById} />
              </Section>
            </div>
          )}
        </AggregatorHome>
      ) : <>
      {heroSlides.length > 0 && !describingHero
        ? <HeroCarousel slides={heroSlides.map((slide) => toHeroSlide(slide, t("catalog.openTitle")))} label={t("catalog.trendingOn", { source: source.name })} />
        : (hero.isLoading || describingHero) && <HeroSkeleton />}
      <div className="space-y-12 px-8 pt-10">
        {pool.isError && <ErrorBanner message={(pool.error as Error).message} />}
        {/* Always the frame row: swapping to poster cards below a threshold meant the section
            changed shape as history filled up, and a single captured frame still reads as "here's
            where you left off" better than a poster does. */}
        {!isNew && <Section title={t("catalog.continueWatching")} action={t("catalog.viewHistory")} to="/history">
          <ContinueWatchingFrameRow sourceById={sourceById} />
        </Section>}
        <Section title={isNew ? t("catalog.popularNow") : t("catalog.becauseYouWatched")} action={t("catalog.openCatalog")} to="/catalog">
          {pool.isLoading || describingPool ? <PosterGridSkeleton count={15} /> : <PosterGrid>{recommended.map(item => <AnimeCard key={`${item.sourceId}:${item.id}`} anime={item} />)}</PosterGrid>}
        </Section>
        {genreSection && !describingPool && <Section title={t("catalog.genreSection", { genre: genreSection.genre })} action={t("catalog.openCatalog")} to="/catalog">
          <PosterGrid>{genreSection.items.map(item => <AnimeCard key={`${item.sourceId}:${item.id}`} anime={item} />)}</PosterGrid>
        </Section>}
      </div>
      </>}
    </>}
  </div>;
}
/** A source title as the shared carousel wants it - see HeroSlide for why this mapping exists at
 * all rather than the carousel taking an AnimeTitle. */
function toHeroSlide(anime: AnimeTitle, openLabel: string): HeroSlide {
  return {
    key: `${anime.sourceId}:${anime.id}`,
    title: animeTitle(anime),
    description: anime.description,
    posterUrl: anime.posterUrl,
    type: anime.type,
    year: anime.year,
    episodeCount: anime.availableEpisodeCount,
    action: (
      <Link to="/anime/$sourceId/$animeId" params={{ sourceId: anime.sourceId, animeId: anime.id }} className={HERO_ACTION_CLASS}>
        <Play className="h-4 w-4 fill-current" strokeWidth={0} />
        {openLabel}
      </Link>
    ),
  };
}

function Section({ title, action, to, children }: { title: string; action: string; to: "/catalog" | "/history"; children: React.ReactNode }) { return <section><div className="mb-5 flex items-center justify-between"><h2 className="text-2xl font-bold tracking-[-.02em] text-text">{title}</h2><Link to={to} className="text-sm font-semibold text-muted transition-colors hover:text-accent-text">{action} →</Link></div>{children}</section>; }
function HeroSkeleton() { return <div className="min-h-[420px] animate-pulse border-b border-white/[.04] bg-white/[.03] px-8 py-16"><div className="h-3 w-40 rounded bg-white/[.08]" /><div className="mt-5 h-12 w-96 rounded bg-white/[.08]" /><div className="mt-5 h-3 w-full max-w-lg rounded bg-white/[.06]" /><div className="mt-2 h-3 w-4/5 max-w-lg rounded bg-white/[.06]" /></div>; }
function EmptySources() { const { t } = useTranslation(); return <div className="flex min-h-[calc(100vh-76px)] items-center justify-center p-8"><div className="max-w-sm text-center"><div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-text/[.06]"><Radio className="h-6 w-6 text-muted" strokeWidth={1.75} /></div><h1 className="text-xl font-bold text-text">{t("catalog.emptySourcesTitle")}</h1><p className="mt-3 text-sm leading-6 text-muted">{t("catalog.emptySourcesText")}</p><Link to="/sources" className="mt-6 inline-block rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-accent-fg">{t("catalog.openSources")}</Link></div></div>; }
