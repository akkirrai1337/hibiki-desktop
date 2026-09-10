import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PROVIDER_RATING_SOURCE } from "@shared/externalMetadata";
import type { SourceInfo } from "@shared/types";
import { hibiki } from "@/lib/hibiki";
import { useMetadataProviderKey } from "@/lib/aggregatorBrowsing";
import { EntryCard } from "@/components/AggregatorCatalog";
import { PosterGrid, PosterGridSkeleton } from "@/components/AnimeCard";
import { ErrorBanner } from "@/components/ErrorBanner";

/**
 * Search results from the metadata aggregator. Like the aggregator catalog, these cards are kept
 * provider-native and resolve against the active source only after one is opened.
 */
export function AggregatorSearch({ source, query }: { source: SourceInfo; query: string }) {
  const { t } = useTranslation();
  const sourceId = source.id;
  const providerKey = useMetadataProviderKey(source);
  const search = useQuery({
    queryKey: ["aggregatorSearch", sourceId, providerKey, query],
    queryFn: () => hibiki.metadata.search(sourceId, query),
    enabled: query.length > 0,
  });

  if (search.isPending) return <PosterGridSkeleton count={12} />;
  if (search.isError) return <ErrorBanner message={(search.error as Error).message} />;

  const results = search.data?.results ?? [];
  if (search.data?.searchedProvider == null) {
    return <p className="py-12 text-center text-sm text-muted">{t("search.aggregator.unavailable")}</p>;
  }
  if (results.length === 0) {
    return <p className="py-12 text-center text-sm text-muted">{t("search.empty", { query })}</p>;
  }

  return (
    <>
      <p className="mb-4 text-right text-xs text-muted">
        {PROVIDER_RATING_SOURCE[search.data.searchedProvider]}
      </p>
      <PosterGrid>
        {results.map((entry) => <EntryCard key={`${entry.provider}:${entry.externalId}`} entry={entry} />)}
      </PosterGrid>
    </>
  );
}
