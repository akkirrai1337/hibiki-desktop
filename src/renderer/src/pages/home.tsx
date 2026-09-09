import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Radio, Play } from "lucide-react";
import { hibiki } from "@/lib/hibiki";
import { useCachedTitleList } from "@/lib/cachedTitleList";
import { AnimeCard, SkeletonCard, animeTitle } from "@/components/AnimeCard";
import { ContinueWatchingFrameRow } from "@/components/ContinueWatchingRow";
import { ErrorBanner } from "@/components/ErrorBanner";
import { useContinueWatching } from "@/lib/continueWatching";
import { useUiStore } from "@/stores/uiStore";
import type { AnimeTitle } from "@shared/types";

const RECOMMENDED_COUNT = 20;
const POOL_WINDOW = 24;
// The pool window is fetched starting at a random offset into the source's "popular" ranking
// (0..MAX_POOL_OFFSET), so "you might like" pulls from a different slice of the catalog each
// visit instead of always reshuffling the same top N titles.
const MAX_POOL_OFFSET = 100;
const HERO_SLIDE_COUNT = 5;
const HERO_INTERVAL_MS = 7000;
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
  const sortMode = source?.supportedSorts.includes("RATING") ? "RATING" : undefined;
  const hero = useCachedTitleList({
    queryKey: ["hero", source?.id],
    cacheKey: source ? `hero:${source.id}` : null,
    enabled: !!source,
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
    enabled: !!source,
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
  const heroSlides = hero.data ?? []; const isNew = !hasHistory;
  const sourceById = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s])), [sources.data]);
  // Re-shuffled each time a fresh pool comes in (new source, new random offset, ...) so this
  // section doesn't always show the same titles in the same order.
  const recommended = useMemo(() => shuffled(pool.data ?? []).slice(0, RECOMMENDED_COUNT), [pool.data]);
  // Most common genre in the current pool, with at least MIN_GENRE_MATCHES titles sharing it -
  // gives a themed row using only data we already fetched, no extra request.
  const genreSection = useMemo(() => {
    const items = pool.data ?? [];
    const counts = new Map<string, number>();
    for (const item of items) for (const genre of item.genres ?? []) counts.set(genre, (counts.get(genre) ?? 0) + 1);
    let topGenre: string | null = null; let topCount = 0;
    for (const [genre, count] of counts) if (count > topCount) { topGenre = genre; topCount = count; }
    if (!topGenre || topCount < MIN_GENRE_MATCHES) return null;
    return { genre: topGenre, items: items.filter((item) => item.genres?.includes(topGenre!)) };
  }, [pool.data]);
  return <div className="min-h-full bg-app-bg pb-12">
    {sources.isLoading && <HeroSkeleton />}{sources.data?.length === 0 && <EmptySources />}{sources.isError && <ErrorBanner message={(sources.error as Error).message} className="m-8" />}
    {source && <>
      {heroSlides.length > 0 ? <HeroCarousel slides={heroSlides} sourceName={source.name} /> : hero.isLoading && <HeroSkeleton />}
      <div className="space-y-12 px-8 pt-10">
        {pool.isError && <ErrorBanner message={(pool.error as Error).message} />}
        {/* Always the frame row: swapping to poster cards below a threshold meant the section
            changed shape as history filled up, and a single captured frame still reads as "here's
            where you left off" better than a poster does. */}
        {!isNew && <Section title={t("catalog.continueWatching")} action={t("catalog.viewHistory")} to="/history">
          <ContinueWatchingFrameRow sourceById={sourceById} />
        </Section>}
        <Section title={isNew ? t("catalog.popularNow") : t("catalog.becauseYouWatched")} action={t("catalog.openCatalog")} to="/catalog">
          {pool.isLoading ? <GridSkeleton /> : <Grid>{recommended.map(item => <AnimeCard key={`${item.sourceId}:${item.id}`} anime={item} />)}</Grid>}
        </Section>
        {genreSection && <Section title={t("catalog.genreSection", { genre: genreSection.genre })} action={t("catalog.openCatalog")} to="/catalog">
          <Grid>{genreSection.items.map(item => <AnimeCard key={`${item.sourceId}:${item.id}`} anime={item} />)}</Grid>
        </Section>}
      </div>
    </>}
  </div>;
}
function HeroCarousel({ slides, sourceName }: { slides: AnimeTitle[]; sourceName: string }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const slideKey = slides.map((s) => `${s.sourceId}:${s.id}`).join(",");
  useEffect(() => { setIndex(0); }, [slideKey]);
  useEffect(() => {
    if (paused || slides.length <= 1) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % slides.length), HERO_INTERVAL_MS);
    return () => clearInterval(id);
  }, [paused, slides.length, slideKey]);
  const current = slides[Math.min(index, slides.length - 1)];
  if (!current) return null;
  return <div className="relative" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
    <AnimatePresence mode="wait">
      <motion.div key={`${current.sourceId}:${current.id}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}>
        <Hero anime={current} sourceName={sourceName} />
      </motion.div>
    </AnimatePresence>
    {slides.length > 1 && <div className="absolute bottom-8 right-8 z-10 flex items-center gap-2">
      {slides.map((slide, i) => (
        <button
          key={`${slide.sourceId}:${slide.id}`}
          onClick={() => setIndex(i)}
          aria-label={`${i + 1}`}
          className={`h-1.5 rounded-full transition-[width,background-color] duration-300 ${i === index ? "w-6 bg-white" : "w-1.5 bg-white/30 hover:bg-white/50"}`}
        />
      ))}
    </div>}
  </div>;
}
function Hero({ anime, sourceName }: { anime: AnimeTitle; sourceName: string }) {
  const { t } = useTranslation();
  const title = animeTitle(anime);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const description = anime.description || t("catalog.heroFallbackDescription");
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const [collapsedHeight] = useState(72); // ~3 lines at text-sm/leading-6
  const [maxHeight, setMaxHeight] = useState(collapsedHeight);
  useEffect(() => {
    const full = descriptionRef.current?.scrollHeight ?? collapsedHeight;
    setMaxHeight(descriptionOpen ? full : Math.min(collapsedHeight, full));
  }, [descriptionOpen, description, collapsedHeight]);
  return <section className="relative isolate min-h-[420px] overflow-hidden border-b border-white/[.04] px-8 py-16">
    <div className="absolute inset-0 -z-10 overflow-hidden opacity-75">
      {anime.posterUrl && (
        <motion.img
          src={anime.posterUrl}
          alt=""
          initial={{ scale: 1 }}
          animate={{ scale: 1.1 }}
          transition={{ duration: HERO_INTERVAL_MS / 1000 + 1, ease: "linear" }}
          className="h-full w-full object-cover object-[center_25%] blur-[2px]"
        />
      )}
      <div className="absolute inset-0" style={{ backgroundImage: [
        "linear-gradient(180deg, #17161b 0px, transparent 64px)",
        "linear-gradient(90deg, rgba(23,22,27,.82) 0%, rgba(23,22,27,.54) 42%, rgba(23,22,27,.08) 100%)",
        "linear-gradient(0deg, #17161b 0px, rgba(23,22,27,.82) 48px, transparent 58%)",
      ].join(", ") }} />
    </div>
    <div className="max-w-2xl">
      <p className="mb-4 text-xs font-bold uppercase tracking-[.18em] text-accent-text">{t("catalog.trendingOn", { source: sourceName })}</p>
      {/* The min-h wrapper reserves space for a full 2-line title regardless of how long this
          slide's title actually is - without it, switching from a 2-line to a 1-line title (or
          back) between carousel slides abruptly resizes this block and everything below it.
          min-height has to live on a wrapper, not the line-clamped element itself - combining
          -webkit-line-clamp with a min-height on the same element makes Chromium clip the text
          to nothing instead of just capping it at 2 lines. */}
      <div className="min-h-[2.1em]">
        <h1 className="line-clamp-2 max-w-xl select-text text-4xl font-bold leading-[1.05] tracking-[-.04em] text-white md:text-6xl">{title}</h1>
      </div>
      <div className="mt-5 max-w-lg overflow-hidden transition-[max-height] duration-300 ease-in-out" style={{ maxHeight }}>
        <p ref={descriptionRef} className="select-text text-sm leading-6 text-zinc-200">{description}</p>
      </div>
      {anime.description && <button onClick={() => setDescriptionOpen((value) => !value)} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-zinc-300 transition hover:text-white">{descriptionOpen ? t("common.hideDescription") : t("common.readDescription")}<ChevronDown className={`h-3.5 w-3.5 transition-transform duration-300 ${descriptionOpen ? "rotate-180" : ""}`} strokeWidth={2.5} /></button>}
      <div className="mt-5 flex items-center gap-3 text-xs font-medium text-zinc-200"><span className="rounded-md bg-white/15 px-2 py-1">{anime.type?.toUpperCase() || t("common.typeFallback")}</span>{anime.year && <span>{anime.year}</span>}{anime.availableEpisodeCount && <span>{t("common.episodesShort", { count: anime.availableEpisodeCount })}</span>}</div>
      <Link to="/anime/$sourceId/$animeId" params={{ sourceId: anime.sourceId, animeId: anime.id }} className="mt-8 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3 text-sm font-bold text-zinc-900 transition-transform hover:scale-[1.02] active:scale-[0.98]"><Play className="h-4 w-4 fill-current" strokeWidth={0} />{t("catalog.openTitle")}</Link>
    </div>
  </section>;
}
function Section({ title, action, to, children }: { title: string; action: string; to: "/catalog" | "/history"; children: React.ReactNode }) { return <section><div className="mb-5 flex items-center justify-between"><h2 className="text-2xl font-bold tracking-[-.02em] text-text">{title}</h2><Link to={to} className="text-sm font-semibold text-muted transition-colors hover:text-accent-text">{action} →</Link></div>{children}</section>; }
// Matches the anime detail page's own related-titles grid: 5 columns until the window is wide
// enough (xl, 1280px+ - roughly "maximized on a normal display") to comfortably fit a 6th without
// the cards getting cramped.
function Grid({ children }: { children: React.ReactNode }) { return <div className="grid grid-cols-5 gap-x-4 gap-y-6 xl:grid-cols-6">{children}</div>; }
function GridSkeleton() { return <Grid>{Array.from({ length: 15 }).map((_, i) => <SkeletonCard key={i} />)}</Grid>; }
function HeroSkeleton() { return <div className="min-h-[420px] animate-pulse border-b border-white/[.04] bg-white/[.03] px-8 py-16"><div className="h-3 w-40 rounded bg-white/[.08]" /><div className="mt-5 h-12 w-96 rounded bg-white/[.08]" /><div className="mt-5 h-3 w-full max-w-lg rounded bg-white/[.06]" /><div className="mt-2 h-3 w-4/5 max-w-lg rounded bg-white/[.06]" /></div>; }
function EmptySources() { const { t } = useTranslation(); return <div className="flex min-h-[calc(100vh-76px)] items-center justify-center p-8"><div className="max-w-sm text-center"><div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-text/[.06]"><Radio className="h-6 w-6 text-muted" strokeWidth={1.75} /></div><h1 className="text-xl font-bold text-text">{t("catalog.emptySourcesTitle")}</h1><p className="mt-3 text-sm leading-6 text-muted">{t("catalog.emptySourcesText")}</p><Link to="/sources" className="mt-6 inline-block rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-accent-fg">{t("catalog.openSources")}</Link></div></div>; }
