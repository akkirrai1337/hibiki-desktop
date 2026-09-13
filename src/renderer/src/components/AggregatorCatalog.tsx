import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AnimatePresence } from "motion/react";
import { SlidersHorizontal } from "lucide-react";
import {
  ANILIST_GENRES,
  FILTERABLE_CATALOG_PROVIDERS,
  PROVIDER_RATING_SOURCE,
  type ExternalCatalogRequest,
  type ExternalMetadata,
  type MetadataProviderId,
} from "@shared/externalMetadata";
import type { SearchFilterCatalog, SearchFilterKind, SourceInfo } from "@shared/types";
import { hibiki } from "@/lib/hibiki";
import { useMetadataProviderKey } from "@/lib/aggregatorBrowsing";
import { EMPTY_SEARCH_FILTERS, activeFilterCount, type SearchFilters } from "@/lib/searchFilters";
import { ErrorBanner } from "@/components/ErrorBanner";
import { PosterCard, PosterGrid, PosterGridSkeleton } from "@/components/AnimeCard";
import { CatalogModeMenu } from "@/components/CatalogModeMenu";
import { SearchFiltersPanel } from "@/components/SearchFiltersPanel";

const PAGE_SIZE = 24;
// Half of SearchFiltersPanel's w-96, plus a margin: the panel centers itself on the anchor, so an
// anchor closer to the window edge than this would push it off screen.
const PANEL_HALF_WIDTH_WITH_MARGIN = 192 + 12;

type Mode = ExternalCatalogRequest["mode"];
const MODES: Mode[] = ["trending", "season", "popular"];

const AGGREGATOR_FILTER_KINDS: SearchFilterKind[] = ["TYPE", "STATUS", "INCLUDED_GENRES", "EXCLUDED_GENRES", "YEAR_RANGE"];

function toCatalogFilters(filters: SearchFilters): Partial<ExternalCatalogRequest> {
  return {
    genres: filters.includedGenres,
    excludedGenres: filters.excludedGenres,
    types: filters.includedTypes,
    excludedTypes: filters.excludedTypes,
    statuses: filters.includedStatuses,
    excludedStatuses: filters.excludedStatuses,
    yearFrom: filters.yearFrom,
    yearTo: filters.yearTo,
  };
}

/**
 * The catalog, browsed from the aggregator instead of from the source (see
 * docs/aggregator-first-catalog.md).
 *
 * A card here names a provider entry, not a title of a source, so it links to the resolution screen
 * rather than straight to a title page - that screen finds the source's own title and gets out of
 * the way. Nothing is resolved while browsing: a resolution is a search against the source, and
 * doing one per visible card would spend two dozen requests to answer a question about the one card
 * that gets clicked.
 */
export function AggregatorCatalog({ source }: { source: SourceInfo }) {
  const { t } = useTranslation();
  const sourceId = source.id;
  // Part of every key below: which provider answers is decided in the main process, so a change of
  // provider has to read as a different question here or the old provider's cards stay put.
  const providerKey = useMetadataProviderKey(source);
  // Filters are AniList's vocabulary, and only AniList can apply them (see FILTERABLE_CATALOG_PROVIDERS)
  // - with it switched off for this source there is nothing that could honour them.
  const filterable = providerKey.split(",").some((provider) => FILTERABLE_CATALOG_PROVIDERS.includes(provider as MetadataProviderId));
  const [mode, setMode] = useState<Mode>("trending");
  const [filters, setFilters] = useState<SearchFilters>(EMPTY_SEARCH_FILTERS);
  const activeFilters = filterable ? filters : EMPTY_SEARCH_FILTERS;
  const filtered = activeFilterCount(activeFilters) > 0;
  const [panelAnchor, setPanelAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const filterCatalog = useMemo<SearchFilterCatalog>(
    () => ({
      sortOptions: [],
      // id === title on purpose: the panel translates the fixed type/status vocabulary by id.
      typeOptions: ["tv", "movie", "ova", "ona", "special"].map((id) => ({ id, title: id })),
      statusOptions: ["ongoing", "released", "announced"].map((id) => ({ id, title: id })),
      genreOptions: ANILIST_GENRES.map((id) => ({ id, title: t(`catalogPage.aggregator.genres.${id}`, { defaultValue: id }) })),
    }),
    [t],
  );

  const catalog = useInfiniteQuery({
    queryKey: ["aggregatorCatalog", sourceId, providerKey, mode, activeFilters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      hibiki.metadata.browse(sourceId, { mode, offset: pageParam, limit: PAGE_SIZE, ...toCatalogFilters(activeFilters) }),
    // An empty page means the end - which for "trending" is after the first one, since that is a
    // fixed list on both providers rather than something to page through.
    getNextPageParam: (lastPage, allPages) =>
      lastPage.results.length < PAGE_SIZE ? undefined : allPages.reduce((offset, page) => offset + page.results.length, 0),
  });

  const pages = catalog.data?.pages ?? [];
  const entries = pages.flatMap((page) => page.results);
  const provider = pages.find((page) => page.provider)?.provider ?? null;
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = catalog;

  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting && hasNextPage && !isFetchingNextPage) fetchNextPage(); },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, entries.length]);

  const togglePanel = () => {
    const rect = filterButtonRef.current?.getBoundingClientRect();
    if (panelAnchor || !rect) {
      setPanelAnchor(null);
      return;
    }
    const center = rect.left + rect.width / 2;
    setPanelAnchor({
      left: Math.max(PANEL_HALF_WIDTH_WITH_MARGIN, Math.min(center, window.innerWidth - PANEL_HALF_WIDTH_WITH_MARGIN)),
      bottom: rect.bottom,
    });
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-end gap-3">
        {/* Which provider answered, because it is not always the preferred one - they go down
            independently and the catalog falls through to whichever is up. */}
        {provider && <span className="text-xs text-muted">{PROVIDER_RATING_SOURCE[provider]}</span>}
        {filterable && (
          <button
            ref={filterButtonRef}
            onClick={togglePanel}
            aria-label={t("search.filters.button")}
            title={t("search.filters.button")}
            className="relative flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-semibold text-muted transition-colors hover:bg-text/[.06] hover:text-text"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={2.25} />
            {t("search.filters.button")}
            {filtered && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent" />}
          </button>
        )}
        <CatalogModeMenu
          value={mode}
          options={MODES.map((value) => ({ value, label: t(`catalogPage.aggregator.${value}`) }))}
          onChange={setMode}
        />
      </div>

      <AnimatePresence>
        {filterable && panelAnchor && (
          <SearchFiltersPanel
            anchor={panelAnchor}
            supportedFilters={AGGREGATOR_FILTER_KINDS}
            catalog={filterCatalog}
            loading={false}
            filters={filters}
            onApply={(next) => { setFilters(next); setPanelAnchor(null); }}
            onClose={() => setPanelAnchor(null)}
          />
        )}
      </AnimatePresence>

      {catalog.isError && <ErrorBanner message={(catalog.error as Error).message} />}
      {catalog.isPending ? (
        <PosterGridSkeleton count={18} />
      ) : entries.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted">
          {/* A provider that answered with nothing, under filters, is "nothing matches" - not an outage. */}
          {filtered && provider ? t("catalogPage.aggregator.noMatches") : t("catalogPage.aggregator.unavailable")}
        </p>
      ) : (
        <>
          <PosterGrid>
            {entries.map((entry) => <EntryCard key={`${entry.provider}:${entry.externalId}`} entry={entry} />)}
          </PosterGrid>
          {hasNextPage && (
            <div ref={loadMoreRef} className="mt-8 flex justify-center">
              {isFetchingNextPage && <div className="h-7 w-7 animate-spin rounded-full border-2 border-border border-t-accent" />}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function EntryCard({ entry }: { entry: ExternalMetadata }) {
  const title = entry.englishName ?? entry.romajiName ?? entry.nativeName ?? `#${entry.externalId}`;
  return (
    <Link
      to="/entry/$provider/$externalId"
      params={{ provider: entry.provider, externalId: String(entry.externalId) }}
      className="group block w-full [contain-intrinsic-size:auto_440px] [content-visibility:auto]"
    >
      <PosterCard
        title={title}
        posterUrl={entry.posterUrl}
        type={entry.type}
        year={entry.year}
        episodeCount={entry.episodeCount}
        rating={entry.score}
        genres={entry.genres}
        description={entry.description}
      />
    </Link>
  );
}
