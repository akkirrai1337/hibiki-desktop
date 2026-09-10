import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PROVIDER_RATING_SOURCE, type ExternalCatalogRequest, type ExternalMetadata } from "@shared/externalMetadata";
import type { SourceInfo } from "@shared/types";
import { hibiki } from "@/lib/hibiki";
import { useMetadataProviderKey } from "@/lib/aggregatorBrowsing";
import { ErrorBanner } from "@/components/ErrorBanner";
import { PosterCard, PosterGrid, PosterGridSkeleton } from "@/components/AnimeCard";
import { CatalogModeMenu } from "@/components/CatalogModeMenu";

const PAGE_SIZE = 24;

type Mode = ExternalCatalogRequest["mode"];
const MODES: Mode[] = ["trending", "season", "popular"];

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
  const [mode, setMode] = useState<Mode>("trending");
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const catalog = useInfiniteQuery({
    queryKey: ["aggregatorCatalog", sourceId, providerKey, mode],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => hibiki.metadata.browse(sourceId, { mode, offset: pageParam, limit: PAGE_SIZE }),
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

  return (
    <div>
      <div className="mb-6 flex items-center justify-end gap-3">
        {/* Which provider answered, because it is not always the preferred one - they go down
            independently and the catalog falls through to whichever is up. */}
        {provider && <span className="text-xs text-muted">{PROVIDER_RATING_SOURCE[provider]}</span>}
        <CatalogModeMenu
          value={mode}
          options={MODES.map((value) => ({ value, label: t(`catalogPage.aggregator.${value}`) }))}
          onChange={setMode}
        />
      </div>

      {catalog.isError && <ErrorBanner message={(catalog.error as Error).message} />}
      {catalog.isPending ? (
        <PosterGridSkeleton count={18} />
      ) : entries.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted">{t("catalogPage.aggregator.unavailable")}</p>
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
