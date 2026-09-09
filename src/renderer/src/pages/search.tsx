import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { hibiki, searchSource } from "@/lib/hibiki";
import { animeTitle } from "@/components/AnimeCard";
import { ErrorBanner } from "@/components/ErrorBanner";
import { useUiStore } from "@/stores/uiStore";
import { useSearchFiltersStore } from "@/stores/searchFiltersStore";
import { toSearchRequestFilters } from "@/lib/searchFilters";
import type { AnimeTitle } from "@shared/types";

function parseSearchSearch(search: Record<string, unknown>): { q: string } {
  return { q: typeof search.q === "string" ? search.q : "" };
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

  const filters = useSearchFiltersStore((s) => s.filters);
  const filterCatalog = useQuery({
    queryKey: ["filterCatalog", source?.id],
    enabled: !!source && source.supportedFilters.length > 0,
    queryFn: () => hibiki.sources.filterCatalog(source!.id),
  });

  const results = useQuery({
    queryKey: ["search", source?.id, trimmedQuery, filters],
    enabled: !!source && trimmedQuery.length > 0,
    queryFn: ({ signal }) => searchSource(source!.id, { query: trimmedQuery, limit: 30, ...toSearchRequestFilters(filters, filterCatalog.data) }, signal),
  });

  return <div className="min-h-full bg-app-bg px-8 py-8 pb-12">
    {!trimmedQuery && <EmptyState text={t("search.prompt")} />}
    {trimmedQuery && <>
      <h1 className="mb-5 select-text text-lg font-bold text-text">{t("search.resultsFor", { query: trimmedQuery })}</h1>
      {results.isLoading && <ResultsSkeleton />}
      {results.isError && <ErrorBanner message={(results.error as Error).message} />}
      {results.data && results.data.length === 0 && <EmptyState text={t("search.empty", { query: trimmedQuery })} />}
      {results.data && results.data.length > 0 && <div className="grid grid-cols-[repeat(auto-fit,minmax(460px,1fr))] gap-x-4 gap-y-1">
        {results.data.map((item) => <ResultRow key={`${item.sourceId}:${item.id}`} anime={item} />)}
      </div>}
    </>}
  </div>;
}

function ResultRow({ anime }: { anime: AnimeTitle }) {
  const title = animeTitle(anime);
  const meta = [anime.type?.toUpperCase(), anime.year].filter(Boolean).join(" · ");
  return <Link to="/anime/$sourceId/$animeId" params={{ sourceId: anime.sourceId, animeId: anime.id }} className="group flex gap-4 rounded-2xl p-3 transition-colors hover:bg-text/[.05]">
    <div className="aspect-[2/3] h-32 w-24 shrink-0 overflow-hidden rounded-xl bg-surface ring-1 ring-border">
      {anime.posterUrl && <img src={anime.posterUrl} alt={title} loading="lazy" className="h-full w-full object-cover" />}
    </div>
    <div className="min-w-0 flex-1 py-1">
      <div className="flex items-start justify-between gap-2">
        <h3 className="select-text line-clamp-1 text-base font-bold text-text">{title}</h3>
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted/70 transition-colors group-hover:text-muted" strokeWidth={2} />
      </div>
      {meta && <p className="mt-1 text-xs font-medium text-muted">{meta}</p>}
      {anime.description && <p className="mt-2 line-clamp-3 select-text text-sm leading-relaxed text-muted">{anime.description}</p>}
    </div>
  </Link>;
}

function ResultsSkeleton() { return <div className="grid grid-cols-[repeat(auto-fit,minmax(460px,1fr))] gap-x-4 gap-y-1">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="flex gap-4 p-3"><div className="h-32 w-24 shrink-0 animate-pulse rounded-xl bg-text/[.06]" /><div className="flex-1 py-1"><div className="h-4 w-2/3 animate-pulse rounded bg-text/[.08]" /><div className="mt-2 h-3 w-1/4 animate-pulse rounded bg-text/[.06]" /><div className="mt-3 h-3 w-full animate-pulse rounded bg-text/[.05]" /><div className="mt-1.5 h-3 w-4/5 animate-pulse rounded bg-text/[.05]" /></div></div>)}</div>; }
function EmptyState({ text }: { text: string }) { return <div className="py-16 text-center text-sm text-muted">{text}</div>; }
