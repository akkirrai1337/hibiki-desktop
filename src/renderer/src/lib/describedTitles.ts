import { useQuery } from "@tanstack/react-query";
import type { AnimeTitle } from "@shared/types";
import { hibiki } from "@/lib/hibiki";

/**
 * A list screen's titles, described by whichever metadata provider is in charge, once the whole
 * screen has been described.
 *
 * The screen paints immediately from what the source returned and swaps over as a unit when the
 * background pass finishes. All at once matters: a grid where some cards carry the provider's name
 * and poster while their neighbours carry the source's reads as a broken list - two cards for what
 * looks like the same show, one of them opening something else - even when every entry in it is
 * correct.
 *
 * A title the provider has never heard of keeps its source's own description, which is the one
 * unavoidable mixture and the honest one: there is nothing else to show it as.
 *
 * The first pass over a screenful of never-seen titles costs a request each (a few seconds at the
 * providers' pace, in the background); every visit after that is answered from disk. Returns the
 * input untouched for a source that does not use external metadata, or when the user has it off -
 * the main process decides that, not this hook.
 *
 * `describing` is what a screen shows a skeleton for. Watching posters and names change under the
 * cursor is what read as unfinished, so a screen waits behind its own loading state instead - the
 * same thing the Android title page does while its banner resolves.
 */
export function useDescribedTitles(
  sourceId: string | null | undefined,
  titles: AnimeTitle[] | undefined,
): { titles: AnimeTitle[]; describing: boolean; refreshing: boolean } {
  const ids = (titles ?? []).map((title) => title.id).join(",");
  const described = useQuery({
    // Keyed by the exact set of titles on screen: a different slice is a different question, and
    // reusing a previous answer would put the wrong names on the new cards.
    queryKey: ["describedTitles", sourceId, ids],
    queryFn: () => hibiki.metadata.describeList(sourceId!, titles!),
    enabled: !!sourceId && (titles?.length ?? 0) > 0,
    // The answer is as durable as the cache behind it, and re-asking on every remount would put
    // this screen back at the start of the provider's queue for nothing.
    staleTime: 5 * 60_000,
    // Held only for the one case it exists for: a catalog page appended to the bottom, which is a
    // longer version of the list already on screen. Recognised by the previous ids being a prefix
    // of the current ones - anything else (a different source, a different search) is a different
    // list, and holding the old answer left the previous query's results sitting under the new
    // query's heading.
    placeholderData: (previous, previousQuery) => {
      const key = previousQuery?.queryKey as [string, string | null | undefined, string] | undefined;
      if (!key || key[1] !== sourceId) return undefined;
      return ids.startsWith(key[2]) ? previous : undefined;
    },
  });
  // Raised the moment the pass starts and dropped when it finishes, with no grace period: the
  // point is that nothing on screen is final until it does, so showing the source's version first
  // and swapping is exactly what this is meant to prevent, however brief the swap.
  return {
    titles: described.data ?? titles ?? [],
    describing: described.isPending && described.fetchStatus !== "idle",
    refreshing: described.isFetching,
  };
}
