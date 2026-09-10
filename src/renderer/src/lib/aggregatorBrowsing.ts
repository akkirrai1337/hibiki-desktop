import { canBrowseProviders, metadataProviderOrder, type MetadataProviderId } from "@shared/externalMetadata";
import type { SourceInfo } from "@shared/types";
import { useUiStore } from "@/stores/uiStore";

/** The providers allowed to describe this source's titles, in order - the renderer's copy of the
 * rule the main process applies (see metadataPreferences.ts), so the two cannot disagree about
 * whether a screen has anyone to ask. */
function useProviderOrder(source: SourceInfo | undefined): MetadataProviderId[] {
  const enabled = useUiStore((state) => state.externalMetadataEnabled);
  const overrides = useUiStore((state) => state.externalMetadataOverrides);
  const provider = useUiStore((state) => state.externalMetadataProvider);
  const fallbackEnabled = useUiStore((state) => state.externalMetadataFallback);
  if (!source) return [];
  return metadataProviderOrder(
    { enabled, overrides, provider, fallbackEnabled },
    source.id,
    source.useExternalMetadata === true,
  );
}

/**
 * One gate for every aggregator-driven browsing surface. The source must opt in, the user must
 * still allow external metadata for this particular source, the browsing preference itself must be
 * on - and at least one of the allowed providers must be one that can actually be browsed.
 *
 * That last part is the difference between this and describing: MAL can describe a title but has no
 * catalog worth the name, so preferring it with the fallback off used to switch Home, Catalog and
 * Search over to an aggregator and then report that none answered.
 */
export function useAggregatorBrowsing(source: SourceInfo | undefined): boolean {
  const browsingEnabled = useUiStore((state) => state.aggregatorCatalog);
  return browsingEnabled && canBrowseProviders(useProviderOrder(source));
}

/**
 * A query-key fragment that changes whenever the answer to "who describes this" would change.
 *
 * Results are cached per screen, and the provider is chosen in the main process - so without this
 * in the key, switching provider in Settings left the previous provider's cards, and its name in
 * the corner, on screen until the cache went stale a minute later.
 */
export function useMetadataProviderKey(source: SourceInfo | undefined): string {
  return useProviderOrder(source).join(",");
}
