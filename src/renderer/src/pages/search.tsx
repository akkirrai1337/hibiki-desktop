import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { hibiki, searchSource } from "@/lib/hibiki";
import { AnimeCard, PosterGrid, PosterGridSkeleton } from "@/components/AnimeCard";
import { AggregatorSearch } from "@/components/AggregatorSearch";
import { ErrorBanner } from "@/components/ErrorBanner";
import { useUiStore } from "@/stores/uiStore";
import { useDescribedTitles } from "@/lib/describedTitles";
import { useSearchFiltersStore } from "@/stores/searchFiltersStore";
import { toSearchRequestFilters } from "@/lib/searchFilters";
import { useAggregatorBrowsing } from "@/lib/aggregatorBrowsing";

function parseSearchSearch(search: Record<string, unknown>): { q: string; sourceOnly: boolean } {
  return {
    q: typeof search.q === "string" ? search.q : "",
    sourceOnly: search.source === true || search.source === "true",
  };
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
  const navigate = useNavigate();
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const { q, sourceOnly } = parseSearchSearch(search);
  const trimmedQuery = q.trim();

  const sources = useQuery({ queryKey: ["sources"], queryFn: () => hibiki.sources.list() });
  const activeSourceId = useUiStore((s) => s.activeSourceId);
  const source = sources.data?.find((s) => s.id === activeSourceId) ?? sources.data?.[0];
  const aggregatorAvailable = useAggregatorBrowsing(source);
  const useAggregator = aggregatorAvailable && !sourceOnly;

  const filters = useSearchFiltersStore((s) => s.filters);
  const filterCatalog = useQuery({
    queryKey: ["filterCatalog", source?.id],
    enabled: !!source && !useAggregator && source.supportedFilters.length > 0,
    queryFn: () => hibiki.sources.filterCatalog(source!.id),
  });

  const results = useQuery({
    queryKey: ["search", source?.id, trimmedQuery, filters],
    enabled: !!source && !useAggregator && trimmedQuery.length > 0,
    queryFn: ({ signal }) => searchSource(source!.id, { query: trimmedQuery, limit: 30, ...toSearchRequestFilters(filters, filterCatalog.data) }, signal),
  });

  // A source search already in React Query's cache stays in `data` after its query is disabled.
  // Do not let switching back to the aggregator describe that now-hidden list in the background.
  const { titles: items, describing } = useDescribedTitles(source?.id, useAggregator ? undefined : results.data);

  return <div className="min-h-full bg-app-bg px-8 py-8 pb-12">
    {!trimmedQuery && <EmptyState text={t("search.prompt")} />}
    {trimmedQuery && <>
      <div className="mb-5 flex items-center justify-between gap-4">
        <h1 className="select-text text-lg font-bold text-text">{t("search.resultsFor", { query: trimmedQuery })}</h1>
        {aggregatorAvailable && source && (
          <button
            onClick={() => navigate({
              to: "/search",
              search: { q: trimmedQuery, source: useAggregator ? true : undefined },
              replace: true,
            })}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-text/80 transition-colors hover:bg-text/[.06] hover:text-text"
          >
            <Search className="h-3.5 w-3.5" strokeWidth={2.25} />
            {useAggregator
              ? t("search.aggregator.searchSource", { source: source.name })
              : t("search.aggregator.searchAggregators")}
          </button>
        )}
      </div>
      {useAggregator && source ? (
        <AggregatorSearch sourceId={source.id} query={trimmedQuery} />
      ) : (
        <>
          {(results.isLoading || describing) && <ResultsSkeleton />}
          {results.isError && <ErrorBanner message={(results.error as Error).message} />}
          {results.data && results.data.length === 0 && !describing && <EmptyState text={t("search.empty", { query: trimmedQuery })} />}
          {items.length > 0 && !describing && <PosterGrid>
            {items.map((item) => <AnimeCard key={`${item.sourceId}:${item.id}`} anime={item} />)}
          </PosterGrid>}
        </>
      )}
    </>}
  </div>;
}

function ResultsSkeleton() {
  return <PosterGridSkeleton count={12} />;
}
function EmptyState({ text }: { text: string }) { return <div className="py-16 text-center text-sm text-muted">{text}</div>; }
