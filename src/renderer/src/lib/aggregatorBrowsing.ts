import { metadataProviderOrder, type MetadataProviderId } from "@shared/externalMetadata";
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
 * A query-key fragment that changes whenever the answer to "who describes this" would change.
 *
 * Results are cached per screen, and the provider is chosen in the main process - so without this
 * in the key, switching provider in Settings left the previous provider's cards, and its name in
 * the corner, on screen until the cache went stale a minute later.
 */
export function useMetadataProviderKey(source: SourceInfo | undefined): string {
  return useProviderOrder(source).join(",");
}
