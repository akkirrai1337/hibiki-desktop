import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PROVIDER_RATING_SOURCE, type ExternalCatalogRequest, type ExternalMetadata } from "@shared/externalMetadata";
import { hibiki } from "@/lib/hibiki";
import { ErrorBanner } from "@/components/ErrorBanner";
import { cn } from "@/lib/cn";

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
export function AggregatorCatalog({ sourceId }: { sourceId: string }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("trending");
  const loadMoreRef = useRef<HTMLDivElement>(null);

  const catalog = useInfiniteQuery({
    queryKey: ["aggregatorCatalog", sourceId, mode],
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
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex rounded-lg bg-text/[.05] p-0.5">
          {MODES.map((candidate) => (
            <button
              key={candidate}
              onClick={() => setMode(candidate)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                candidate === mode ? "bg-accent text-accent-fg" : "text-muted hover:text-text",
              )}
            >
              {t(`catalogPage.aggregator.${candidate}`)}
            </button>
          ))}
        </div>
        {/* Which provider answered, because it is not always the preferred one - they go down
            independently and the catalog falls through to whichever is up. */}
        {provider && <span className="text-xs text-muted">{PROVIDER_RATING_SOURCE[provider]}</span>}
      </div>

      {catalog.isError && <ErrorBanner message={(catalog.error as Error).message} />}
      {catalog.isPending ? (
        <EntryGridSkeleton />
      ) : entries.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted">{t("catalogPage.aggregator.unavailable")}</p>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-4 gap-y-6">
            {entries.map((entry) => <EntryCard key={`${entry.provider}:${entry.externalId}`} entry={entry} />)}
          </div>
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

function EntryCard({ entry }: { entry: ExternalMetadata }) {
  const title = entry.englishName ?? entry.romajiName ?? entry.nativeName ?? `#${entry.externalId}`;
  return (
    <Link
      to="/entry/$provider/$externalId"
      params={{ provider: entry.provider, externalId: String(entry.externalId) }}
      className="group block"
    >
      <div className="aspect-[2/3] overflow-hidden rounded-xl bg-surface ring-1 ring-border transition-transform duration-200 group-hover:scale-[1.02]">
        {entry.posterUrl && <img src={entry.posterUrl} alt="" loading="lazy" className="h-full w-full object-cover" />}
      </div>
      <p className="mt-2.5 line-clamp-2 text-sm font-semibold leading-tight text-text">{title}</p>
      <p className="mt-1 truncate text-xs text-muted">{[entry.year, entry.type].filter(Boolean).join(" · ")}</p>
    </Link>
  );
}

function EntryGridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-4 gap-y-6">
      {Array.from({ length: 18 }).map((_, index) => (
        <div key={index}>
          <div className="aspect-[2/3] animate-pulse rounded-xl bg-text/[.06]" />
          <div className="mt-2.5 h-3.5 w-4/5 animate-pulse rounded bg-text/[.06]" />
          <div className="mt-1.5 h-3 w-2/5 animate-pulse rounded bg-text/[.05]" />
        </div>
      ))}
    </div>
  );
}
