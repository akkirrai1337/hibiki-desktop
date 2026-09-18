import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { hibiki, searchSource } from "@/lib/hibiki";
import { AnimeCard, PosterGrid, PosterGridSkeleton } from "@/components/AnimeCard";
import { ErrorBanner } from "@/components/ErrorBanner";
import { useUiStore } from "@/stores/uiStore";
import { useDescribedTitles } from "@/lib/describedTitles";
import { useSearchFiltersStore } from "@/stores/searchFiltersStore";
import { activeFilterCount, toSearchRequestFilters } from "@/lib/searchFilters";
import { useMetadataProviderKey } from "@/lib/aggregatorBrowsing";

function parseSearchSearch(search: Record<string, unknown>): { q: string } {
  return {
    q: typeof search.q === "string" ? search.q : "",
  };
}

const MIN_SEARCH_QUERY_LENGTH = 3;

function searchErrorMessage(error: unknown, sourceName: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/minimum|at least|too short|min.{0,12}(?:character|symbol)|3\s*(?:character|symbol|букв|символ)/i.test(message)) {
    return t("search.errorTooShort", { count: MIN_SEARCH_QUERY_LENGTH });
  }
  if (/network|fetch|econn|enotfound|timeout|timed out|offline/i.test(message)) {
    return t("search.errorUnavailable", { source: sourceName });
  }
  return t("search.errorGeneric", { source: sourceName });
}

// The search box - and its filters button - live in the TitleBar (shown on every route except
// settings/profile) and drive this page purely through the `q` URL param and the shared filters
// store; this just runs the query and renders results.
//
// A plain `Route.useSearch()` throws once this stays mounted while some other route is active (it
// requires an active match for this exact route) - reading straight off the location instead keeps
// working no matter which route is actually current.
export function SearchPage() {
  const { t } = useTranslation();
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const { q } = parseSearchSearch(search);
  const trimmedQuery = q.trim();

  const sources = useQuery({ queryKey: ["sources"], queryFn: () => hibiki.sources.list() });
  const activeSourceId = useUiStore((s) => s.activeSourceId);
  const source = sources.data?.find((s) => s.id === activeSourceId) ?? sources.data?.[0];
  const providerKey = useMetadataProviderKey(source);

  const filters = useSearchFiltersStore((s) => s.filters);
  const hasFilters = activeFilterCount(filters) > 0;
  const queryIsLongEnough = trimmedQuery.length >= MIN_SEARCH_QUERY_LENGTH;
  // A selected filter is an explicit browse request and does not need text. A one- or two-letter
  // fragment, however, is deliberately omitted from that request: YummyAnime rejects it and
  // other sources often return noisy, expensive results for it.
  const shouldSearch = queryIsLongEnough || hasFilters;
  const filterCatalog = useQuery({
    queryKey: ["filterCatalog", source?.id],
    enabled: !!source && source.supportedFilters.length > 0,
    queryFn: () => hibiki.sources.filterCatalog(source!.id),
  });

  const results = useQuery({
    queryKey: ["search", source?.id, queryIsLongEnough ? trimmedQuery : "", filters],
    enabled: !!source && shouldSearch,
    queryFn: ({ signal }) => searchSource(source!.id, { query: queryIsLongEnough ? trimmedQuery : undefined, limit: 30, ...toSearchRequestFilters(filters, filterCatalog.data) }, signal),
  });

  const { titles: items, loadingIds } = useDescribedTitles(source?.id, results.data, providerKey);

  return <div className="min-h-full bg-app-bg px-8 py-8 pb-12">
    {!trimmedQuery && !hasFilters && <EmptyState text={t("search.prompt")} />}
    {!!trimmedQuery && !queryIsLongEnough && !hasFilters && <EmptyState text={t("search.minChars", { count: MIN_SEARCH_QUERY_LENGTH })} />}
    {shouldSearch && <>
      <div className="mb-5 flex items-center justify-between gap-4">
        <h1 className="select-text text-lg font-bold text-text">{queryIsLongEnough ? t("search.resultsFor", { query: trimmedQuery }) : t("search.filteredResults")}</h1>
      </div>
      <>
          {results.isLoading && <ResultsSkeleton />}
          {results.isError && <ErrorBanner message={searchErrorMessage(results.error, source?.name ?? t("search.source"), t)} />}
          {results.data && results.data.length === 0 && <EmptyState text={queryIsLongEnough ? t("search.empty", { query: trimmedQuery }) : t("search.filteredEmpty")} />}
          {items.length > 0 && <PosterGrid>
            {items.map((item) => <AnimeCard key={`${item.sourceId}:${item.id}`} anime={item} metadataLoading={loadingIds.has(item.id)} />)}
          </PosterGrid>}
      </>
    </>}
  </div>;
}

function ResultsSkeleton() {
  return <PosterGridSkeleton count={12} />;
}
function EmptyState({ text }: { text: string }) { return <div className="py-16 text-center text-sm text-muted">{text}</div>; }
