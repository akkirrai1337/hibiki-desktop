import { metadataProviderOrder } from "@shared/externalMetadata";
import type { SourceInfo } from "@shared/types";
import { useUiStore } from "@/stores/uiStore";

/**
 * One gate for every aggregator-driven browsing surface. The source must opt in, the user must
 * still allow external metadata for this particular source, and the browsing preference itself
 * must be on. Keeping that rule here prevents Home, Catalog, Search, and the main-process provider
 * order from disagreeing and leaving an enabled-looking screen with no provider allowed to answer.
 */
export function useAggregatorBrowsing(source: SourceInfo | undefined): boolean {
  const browsingEnabled = useUiStore((state) => state.aggregatorCatalog);
  const providersAvailable = useUiStore((state) => source ? metadataProviderOrder(
    {
      enabled: state.externalMetadataEnabled,
      overrides: state.externalMetadataOverrides,
      provider: state.externalMetadataProvider,
      fallbackEnabled: state.externalMetadataFallback,
    },
    source.id,
    source.useExternalMetadata === true,
  ).length > 0 : false);
  return browsingEnabled && providersAvailable;
}
