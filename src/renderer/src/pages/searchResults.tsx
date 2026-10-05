import { useEffect, useRef } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { hibiki, searchSource } from "@/lib/hibiki";
import { AnimeCard, PosterGrid, PosterGridSkeleton } from "@/components/AnimeCard";
import { ErrorBanner } from "@/components/ErrorBanner";
import { useUiStore } from "@/stores/uiStore";
import { useSearchFiltersStore } from "@/stores/searchFiltersStore";
import { activeFilterCount, toSearchRequestFilters } from "@/lib/searchFilters";

const PAGE_SIZE = 30;
const MIN_QUERY_LENGTH = 3;

/** Every result of a search - the panel shows the first few, this shows them all, paged in as it is scrolled. */
export function SearchResultsPage() {
  const { t } = useTranslation();
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const query = (typeof search.q === "string" ? search.q : "").trim();
  const longEnough = query.length >= MIN_QUERY_LENGTH;

  const sources = useQuery({ queryKey: ["sources"], queryFn: () => hibiki.sources.list() });
  const activeSourceId = useUiStore((s) => s.activeSourceId);
  const source = sources.data?.find((s) => s.id === activeSourceId) ?? sources.data?.[0];
  const filters = useSearchFiltersStore((s) => s.filters);
  const hasFilters = activeFilterCount(filters) > 0;

  const results = useInfiniteQuery({
    queryKey: ["searchResults", source?.id, longEnough ? query : "", filters],
    enabled: !!source && (longEnough || hasFilters),
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      searchSource(source!.id, { query: longEnough ? query : undefined, offset: pageParam, limit: PAGE_SIZE, ...toSearchRequestFilters(filters) }, signal),
    getNextPageParam: (lastPage, allPages) => (lastPage.length < PAGE_SIZE ? undefined : allPages.reduce((offset, page) => offset + page.length, 0)),
  });
  const items = results.data?.pages.flat() ?? [];

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = results;
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting && !isFetchingNextPage) void fetchNextPage(); }, { rootMargin: "400px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, items.length]);

  return (
    <div className="min-h-full bg-app-bg px-8 py-8 pb-16 mobile:px-4 mobile:pb-6 mobile:pt-4">
      <h1 className="mb-5 select-text text-lg font-bold text-text mobile:mb-4 mobile:text-[17px]">{longEnough ? t("search.resultsFor", { query }) : t("search.filteredResults")}</h1>
      {results.isLoading && <PosterGridSkeleton count={12} />}
      {results.isError && <ErrorBanner message={t("search.errorGeneric", { source: source?.name ?? t("search.source") })} />}
      {results.isSuccess && items.length === 0 && <div className="py-16 text-center text-sm text-muted">{longEnough ? t("search.empty", { query }) : t("search.filteredEmpty")}</div>}
      {items.length > 0 && <PosterGrid>{items.map((item) => <AnimeCard key={`${item.sourceId}:${item.id}`} anime={item} />)}</PosterGrid>}
      {hasNextPage && (
        <div ref={sentinel} className="mt-8 flex justify-center">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-border border-t-accent" />
        </div>
      )}
    </div>
  );
}
