import { useQueries } from "@tanstack/react-query";
import type { AnimeTitle } from "@shared/types";
import { hibiki } from "@/lib/hibiki";

/**
 * Source cards paint at once and are enriched independently in the background. A query stores
 * each completed overlay under its source ID, so pagination and virtualization cannot lose a late
 * result. The caller uses `loadingIds` to show a loader on just the cards still being enriched.
 */
export function useDescribedTitles(
  sourceId: string | null | undefined,
  titles: AnimeTitle[] | undefined,
  /** Which providers may answer, from useMetadataProviderKey - a change of provider is a change of
   * answer, and without it in the key the previous provider's names and posters stayed on screen
   * until the cache went stale. */
  providerKey = "",
): { titles: AnimeTitle[]; loadingIds: Set<string> } {
  const sourceTitles = titles ?? [];
  const described = useQueries({
    queries: sourceTitles.map((title) => ({
      queryKey: ["describedTitle", sourceId, providerKey, title.id],
      queryFn: async () => (await hibiki.metadata.describeList(sourceId!, [title]))[0] ?? title,
      enabled: !!sourceId && providerKey.length > 0,
      staleTime: 5 * 60_000,
    })),
  });
  const metadataById = new Map(
    described.flatMap((query, index) => query.data ? [[sourceTitles[index].id, query.data] as const] : []),
  );
  const loadingIds = new Set(
    described.flatMap((query, index) => query.isPending && query.fetchStatus !== "idle" ? [sourceTitles[index].id] : []),
  );
  return {
    // The source title remains the basis of the card. The main process merges only descriptive
    // fields, but restoring these names here protects cards cached by an older desktop build.
    titles: sourceTitles.map((title) => {
      const metadata = metadataById.get(title.id);
      return metadata ? { ...metadata, englishName: title.englishName, originalName: title.originalName, synonyms: title.synonyms } : title;
    }),
    loadingIds,
  };
}
