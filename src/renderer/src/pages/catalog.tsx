import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { Radio } from "lucide-react";
import { hibiki } from "@/lib/hibiki";
import { AnimeCard, PosterGrid, PosterGridSkeleton } from "@/components/AnimeCard";
import { ErrorBanner } from "@/components/ErrorBanner";
import { useUiStore } from "@/stores/uiStore";
import { useDescribedTitles } from "@/lib/describedTitles";
import { AggregatorCatalog } from "@/components/AggregatorCatalog";
import { CatalogModeMenu } from "@/components/CatalogModeMenu";
import { useAggregatorBrowsing, useMetadataProviderKey } from "@/lib/aggregatorBrowsing";
import type { AnimeTitle, SourceInfo } from "@shared/types";

// Only three ways to browse make sense to expose: by relevance, alphabetically, or the source's
// dedicated "latest releases" feed. The manifest can declare finer-grained sorts (rating, votes,
// views, comments...) but those overlap in meaning and most sources don't even implement them
// consistently, so surfacing all of them was more noise than signal.
type SortMode = "popularity" | "alphabetical" | "recent";
const SORT_MODES: SortMode[] = ["popularity", "alphabetical", "recent"];

function parseCatalogSearch(search: Record<string, unknown>): { sort: SortMode } {
  return { sort: SORT_MODES.includes(search.sort as SortMode) ? (search.sort as SortMode) : "popularity" };
}

// Three rows at the widest six-column layout. Smaller batches spread image decoding and DOM work
// over time instead of producing a visible frame spike whenever 30 posters arrive together.
const PAGE_SIZE = 18;
const RECENT_LIMIT = 30;

const SORT_LABEL_KEYS: Record<SortMode, string> = {
  popularity: "catalogPage.sort.popularity",
  alphabetical: "catalogPage.sort.alphabetical",
  recent: "catalogPage.sort.recent",
};

function availableSortModes(source: SourceInfo): SortMode[] {
  const modes: SortMode[] = ["popularity"];
  if (source.supportedSorts.includes("TITLE")) modes.push("alphabetical");
  if (source.capabilities.includes("LATEST_RELEASES")) modes.push("recent");
  return modes;
}

// A plain `Route.useSearch()` throws once this stays mounted while some other route is active (it
// requires an active match for this exact route) - reading straight off the location instead keeps
// working no matter which route is actually current.
export function CatalogBrowsePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const { sort: requestedMode } = parseCatalogSearch(search);
  const sources = useQuery({ queryKey: ["sources"], queryFn: () => hibiki.sources.list() });
  const activeSourceId = useUiStore((s) => s.activeSourceId);
  const source = sources.data?.find((s) => s.id === activeSourceId) ?? sources.data?.[0];
  const aggregatorBrowsing = useAggregatorBrowsing(source);
  const providerKey = useMetadataProviderKey(source);
  const setRequestedMode = (next: SortMode) => navigate({ to: "/catalog", search: { sort: next }, replace: true });

  const modes = useMemo(() => (source ? availableSortModes(source) : []), [source]);
  const mode = modes.includes(requestedMode) ? requestedMode : "popularity";

  const browse = useInfiniteQuery({
    queryKey: ["catalog", source?.id, mode === "alphabetical" ? "TITLE" : "RELEVANCE"],
    enabled: !!source && !aggregatorBrowsing && mode !== "recent",
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      hibiki.sources.search(source!.id, { offset: pageParam, limit: PAGE_SIZE, sort: mode === "alphabetical" ? "TITLE" : "RELEVANCE" }),
    getNextPageParam: (lastPage, allPages) => (
      lastPage.length < PAGE_SIZE ? undefined : allPages.reduce((offset, page) => offset + page.length, 0)
    ),
  });
  // The "recent" feed is a completely different endpoint (latest releases), not a search sort —
  // it has no offset param, so there's no "load more" for it.
  const recent = useQuery({
    queryKey: ["catalog-recent", source?.id],
    enabled: !!source && !aggregatorBrowsing && mode === "recent",
    queryFn: () => hibiki.sources.latest(source!.id, RECENT_LIMIT),
  });

  const sourceItems = mode === "recent" ? (recent.data ?? []) : (browse.data?.pages.flat() ?? []);
  // Described as a whole, including every page loaded so far: a newly appended page that named its
  // titles differently from the ones above it would be the same mixed-list problem, one scroll
  // further down.
  const { titles: items, describing, refreshing: describingMore } = useDescribedTitles(
    source?.id,
    aggregatorBrowsing ? undefined : sourceItems,
    providerKey,
  );
  const isLoading = mode === "recent" ? recent.isLoading : browse.isLoading;
  const isError = mode === "recent" ? recent.isError : browse.isError;
  const error = mode === "recent" ? recent.error : browse.error;

  const catalogAutoLoad = useUiStore((s) => s.catalogAutoLoad);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = browse;
  const loadMoreRef = useRef<HTMLDivElement>(null);
  // Fires fetchNextPage itself once the sentinel below the grid scrolls into view, instead of
  // waiting for a click on the manual button - see the Settings toggle this is gated behind.
  // rootMargin gives it a head start (starts loading a bit before the sentinel is actually on
  // screen) so the next page is usually already there by the time scrolling reaches the bottom.
  useEffect(() => {
    if (!catalogAutoLoad || mode === "recent") return;
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      // Not while the page just added is still being described: `items` has not grown yet, so the
      // sentinel is still on screen and would ask for page after page in a loop.
      ([entry]) => { if (entry.isIntersecting && hasNextPage && !isFetchingNextPage && !describingMore) fetchNextPage(); },
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [catalogAutoLoad, mode, hasNextPage, isFetchingNextPage, describingMore, fetchNextPage, items.length]);

  // The aggregator's catalog replaces this one wholesale rather than sitting beside it: the two
  // list different things (entries against this source's titles), and a screen that mixed them
  // would be back to the problem whole-screen description exists to avoid.
  if (aggregatorBrowsing && source) {
    return (
      <div className="min-h-full bg-app-bg px-8 py-8 pb-16">
        <AggregatorCatalog source={source} />
      </div>
    );
  }

  return (
    <div className="min-h-full bg-app-bg px-8 py-8 pb-16">
      {sources.isLoading && <PosterGridSkeleton count={15} />}
      {sources.isError && <ErrorBanner message={(sources.error as Error).message} />}
      {sources.data?.length === 0 && <EmptySources />}
      {source && (
        <>
          {modes.length > 1 && (
            <div className="mb-6 flex justify-end">
              <SortMenu mode={mode} modes={modes} onChange={setRequestedMode} />
            </div>
          )}

          {isLoading || describing ? (
            <PosterGridSkeleton count={15} />
          ) : items.length === 0 ? (
            <EmptyState text={t("catalogPage.empty")} />
          ) : (
            <>
              <VirtualGrid items={items} />
              {mode !== "recent" && hasNextPage && (
                <div ref={loadMoreRef} className="mt-8 flex justify-center">
                  {catalogAutoLoad ? (
                    isFetchingNextPage && <div className="h-7 w-7 animate-spin rounded-full border-2 border-border border-t-accent" />
                  ) : (
                    <button
                      onClick={() => fetchNextPage()}
                      disabled={isFetchingNextPage}
                      className="rounded-xl border border-border px-5 py-2.5 text-sm font-semibold text-text/80 transition-colors hover:bg-text/[.06] disabled:opacity-50"
                    >
                      {t("catalogPage.loadMore")}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
          {isError && <ErrorBanner message={(error as Error).message} className="mt-6" />}
        </>
      )}
    </div>
  );
}

function SortMenu({ mode, modes, onChange }: { mode: SortMode; modes: SortMode[]; onChange: (mode: SortMode) => void }) {
  const { t } = useTranslation();
  return <CatalogModeMenu value={mode} options={modes.map((value) => ({ value, label: t(SORT_LABEL_KEYS[value]) }))} onChange={onChange} />;
}

const GRID_COLUMNS_DEFAULT = 5;
const GRID_COLUMNS_XL = 6;
const GRID_XL_QUERY = "(min-width: 1280px)";
const GRID_GAP_Y = 24; // px, matches PosterGrid's own `gap-y-6`

/** Same column-count rule as PosterGrid (grid-cols-5, xl:grid-cols-6) - kept in sync
 * manually since VirtualGrid needs the count as a number (to group items into rows) rather than
 * just a CSS class. */
function useGridColumnCount(): number {
  const [columns, setColumns] = useState(() => (typeof window !== "undefined" && window.matchMedia(GRID_XL_QUERY).matches ? GRID_COLUMNS_XL : GRID_COLUMNS_DEFAULT));
  useEffect(() => {
    const mql = window.matchMedia(GRID_XL_QUERY);
    const onChange = () => setColumns(mql.matches ? GRID_COLUMNS_XL : GRID_COLUMNS_DEFAULT);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return columns;
}

// Row-virtualized version of PosterGrid, for the actual (potentially hundreds-of-cards-deep, once
// enough pages have loaded) catalog list - `content-visibility: auto` on each AnimeCard (see that
// component) already skips paint/layout for off-screen cards, but every one of them still exists
// as a real, permanently-mounted DOM subtree the whole time. Scrolling fast enough crosses many
// cards' visibility threshold within the same frame or two, forcing content-visibility's "catch
// up" layout+paint cost for all of them practically at once - a stutter content-visibility alone
// can reduce but not eliminate, since the DOM nodes (and the browser's per-element bookkeeping for
// each) are all still there regardless of whether any given one is currently painted. Rendering
// only the rows actually near the viewport (plus a small overscan) keeps the real DOM node count
// bounded no matter how many pages have been paged through.
function VirtualGrid({ items }: { items: AnimeTitle[] }) {
  const columns = useGridColumnCount();
  const rows = useMemo(() => {
    const out: AnimeTitle[][] = [];
    for (let i = 0; i < items.length; i += columns) out.push(items.slice(i, i + columns));
    return out;
  }, [items, columns]);

  // The virtualizer needs the actual scrolling element, but this page doesn't own one itself -
  // it's rendered straight inside __root.tsx's own per-page `overflow-y-auto` wrapper (see that
  // file), which is also what remembers scroll position across a page revisit by simply never
  // unmounting. Reaching up to `parentElement` piggybacks on that existing scroll container
  // instead of introducing a second, nested one (which would need its own scroll-position story).
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const containerRef = useCallback((node: HTMLDivElement | null) => setScrollElement(node?.parentElement ?? null), []);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElement,
    // A rough guess (poster + two-line title + meta row, at a typical card width) - corrected per
    // row against its real rendered height via `measureElement` below, so this only matters for
    // the very first estimate before anything's actually been measured.
    estimateSize: () => 380,
    overscan: 4,
    gap: GRID_GAP_Y,
  });

  // `containerRef` has to be attached in both branches below (it's what resolves `scrollElement`
  // in the first place, via the callback ref above) - a version that only attached it once
  // `scrollElement` was already known would never get the chance to become known at all.
  return (
    <div ref={containerRef} style={scrollElement ? { position: "relative", height: rowVirtualizer.getTotalSize(), width: "100%" } : undefined}>
      {!scrollElement ? (
        // Before the ref callback above has resolved the scroll container (only ever the very
        // first render) - the real grid, unvirtualized, so there's an actual mounted node for that
        // callback to fire against; the resulting state update switches to the virtualized branch
        // immediately after, and this one never shows again.
        <PosterGrid>{items.map((item) => <AnimeCard key={`${item.sourceId}:${item.id}`} anime={item} />)}</PosterGrid>
      ) : (
        rowVirtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            ref={rowVirtualizer.measureElement}
            data-index={virtualRow.index}
            style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
          >
            <div className="grid gap-x-4" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {rows[virtualRow.index].map((item) => <AnimeCard key={`${item.sourceId}:${item.id}`} anime={item} />)}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
function EmptyState({ text }: { text: string }) { return <div className="py-16 text-center text-sm text-muted">{text}</div>; }
function EmptySources() { const { t } = useTranslation(); return <div className="flex min-h-[calc(100vh-76px)] items-center justify-center"><div className="max-w-sm text-center"><div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-text/[.06]"><Radio className="h-6 w-6 text-muted" strokeWidth={1.75} /></div><h1 className="text-xl font-bold text-text">{t("catalog.emptySourcesTitle")}</h1><p className="mt-3 text-sm leading-6 text-muted">{t("catalog.emptySourcesText")}</p><Link to="/sources" className="mt-6 inline-block rounded-xl bg-accent px-4 py-2.5 text-sm font-bold text-accent-fg">{t("catalog.openSources")}</Link></div></div>; }
