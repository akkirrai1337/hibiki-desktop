import { useQuery } from "@tanstack/react-query";
import { hibiki } from "@/lib/hibiki";

const PLAYBACK_GROUPS_CACHE_FRESH_MS = 15 * 60_000;

/**
 * Paints an episode list from SQLite immediately when one is available, while preserving the
 * normal live source request for an absent or older cache entry. The public query key stays the
 * same as before, so detail and watch screens still share one result.
 */
export function usePlaybackGroups(sourceId: string, animeId: string, staleTime?: number) {
  const cached = useQuery({
    queryKey: ["cached-playbackGroups", sourceId, animeId],
    queryFn: () => hibiki.sources.cachedPlaybackGroups(sourceId, animeId),
    staleTime: Infinity,
  });

  return useQuery({
    queryKey: ["playbackGroups", sourceId, animeId],
    enabled: cached.isFetched,
    placeholderData: cached.data?.groups,
    staleTime,
    queryFn: () => {
      const entry = cached.data;
      if (entry && Date.now() - entry.cachedAt < PLAYBACK_GROUPS_CACHE_FRESH_MS) return entry.groups;
      return hibiki.sources.playbackGroups(sourceId, animeId);
    },
  });
}
