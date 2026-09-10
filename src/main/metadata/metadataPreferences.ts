// The user's half of the external-metadata decision, mirrored into the main process, which is where
// the merge happens.
//
// The preference itself lives in the renderer's persisted UI store, like every other app setting,
// and is pushed here on boot and on change - the same arrangement the Discord RPC toggle uses (see
// __root.tsx). Main keeps only this mirror, so nothing is persisted twice. The rule for reading it
// is pure and shared with the renderer (see shared/externalMetadata.ts).
import { metadataProviderOrder, type MetadataProviderId } from "@shared/externalMetadata";
import type { ExternalMetadataPreferences } from "@shared/types";

// Defaults to enabled, AniList first, fallback on: a source only asks for external metadata because
// its own is thin, and someone who never opens Settings should get the better page. This default
// also covers the window between app start and the renderer's first push.
let preferences: ExternalMetadataPreferences = {
  enabled: true,
  overrides: {},
  provider: "anilist",
  fallbackEnabled: true,
};

export function setExternalMetadataPreferences(next: ExternalMetadataPreferences): void {
  preferences = { ...next, overrides: { ...next.overrides } };
}

/** Which providers to ask for this source's titles, in order - empty when the title should be
 * described from its source alone. */
export function providerOrderFor(sourceId: string, sourceDeclaresIt: boolean): MetadataProviderId[] {
  return metadataProviderOrder(preferences, sourceId, sourceDeclaresIt);
}
