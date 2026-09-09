import { useEffect } from "react";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { hibiki } from "@/lib/hibiki";
import type { AnimeTitle } from "@shared/types";

interface Options {
  /** React Query's own key, unchanged from what the screen used before this hook. */
  queryKey: QueryKey;
  /** Stable across visits even when the request is not - see offlineCache.cacheSourceQuery. */
  cacheKey: string | null;
  enabled?: boolean;
  queryFn: () => Promise<AnimeTitle[]>;
}

/**
 * A source title list that paints from disk on the way to painting from the source.
 *
 * The screens this serves (the home hero and its "popular" pool) previously had nothing at all to
 * show until the source answered, so every launch opened on skeletons for as long as the network
 * took. The cached list stands in meanwhile and is replaced the moment the real one lands - it is
 * never a substitute for the request, only something to look at while it runs.
 */
export function useCachedTitleList({ queryKey, cacheKey, enabled = true, queryFn }: Options) {
  const cached = useQuery({
    queryKey: ["cached-query", cacheKey],
    queryFn: () => hibiki.sources.cachedQuery(cacheKey!),
    enabled: cacheKey !== null,
    staleTime: Infinity,
  });

  const live = useQuery({ queryKey, enabled, queryFn, placeholderData: cached.data?.titles });

  // Written from the renderer rather than inside the IPC handler, because only the screen knows
  // which of its requests is the one worth painting from next time - a typed search is not.
  useEffect(() => {
    if (!cacheKey || live.isPlaceholderData || !live.data?.length) return;
    hibiki.sources.cacheQuery(cacheKey, live.data);
  }, [cacheKey, live.data, live.isPlaceholderData]);

  return live;
}
