import { create } from "zustand";
import { persist } from "zustand/middleware";
import { normalizeZoom } from "@/lib/zoom";
import type { MetadataProviderId } from "@shared/externalMetadata";

interface UiState {
  theme: "light" | "dark";
  activeSourceId: string | null;
  sidebarWidth: number;
  // Defaults to on, so a fresh install shows what you're watching in Discord without having to
  // find the switch first - Settings is where you turn it *off*. Only affects new installs: an
  // existing one keeps whatever its persisted "hibiki-ui" value already says.
  discordRpcEnabled: boolean;
  // False only until the first-launch onboarding flow (see Onboarding.tsx) is finished once -
  // persisted so it never shows again after that, same as the rest of this store.
  onboardingCompleted: boolean;
  // The streak count the profile page's badge has already played its pop/burst animation for -
  // independent of the watch player's own toast (that one only ever needs a same-session ref,
  // since it only reacts to a change happening while it's already open). This one is separate and
  // persisted because the profile page is the "home" of this stat: arriving there sometime after
  // an increment that happened elsewhere (in the player) should still get to show the animation
  // once, not silently show the new number as if nothing happened. -1 is a sentinel for "never
  // recorded yet" (distinct from a real streak, which is always >= 0) - without it, a pre-existing
  // streak from before this field existed would read as one giant uncelebrated jump the first time
  // the updated app opens the profile page, and celebrate progress that isn't actually new.
  profileCelebratedStreak: number;
  // A user-picked accent color (hex, e.g. "#ec4899"), applied on top of --color-accent - see
  // applyAccentColor in lib/theme.ts. null means "use the app's default pink" rather than storing
  // that pink literally, so a future default change isn't silently masked by everyone's persisted
  // "custom" value happening to match today's default.
  accentColor: string | null;
  // A picked preset id from lib/theme.ts's BACKGROUND_THEME_PRESETS, or null for the plain
  // (opaque, no gradient) look the app always had before this existed - see applyBackgroundTheme.
  backgroundTheme: string | null;
  // Whether the catalog page fetches its next page itself once the "load more" sentinel scrolls
  // into view (see catalog.tsx), instead of waiting for an explicit button click. Defaults to on -
  // Settings just gives a way back to the manual button for anyone who'd rather not have pages
  // load automatically as they scroll.
  catalogAutoLoad: boolean;
  // Window zoom as a plain factor (1 = 100%), stepped with Ctrl +/- and reset with Ctrl+0 - see
  // lib/zoom.ts. Stored as the factor rather than Chromium's logarithmic zoom *level* because it
  // is the number a person would recognise, and because the ladder in lib/zoom.ts is defined in
  // those terms.
  zoomFactor: number;
  // Whether a source that declares `useExternalMetadata` gets its titles described from a metadata
  // aggregator instead of from its own pages (see shared/externalMetadata.ts). Defaults to on: a
  // source only asks for this because its own descriptions are the weak half of what it returns, so
  // the better page is the right default and Settings is where it is turned *off*. Mirrored into
  // the main process, which owns the merge, the same way discordRpcEnabled is.
  externalMetadataEnabled: boolean;
  // Per-source answers that win over externalMetadataEnabled in both directions - someone whose
  // favourite source has good Russian descriptions can keep them without turning AniList off
  // everywhere, and the reverse works too. Absent means "follow the global switch", which is why
  // this is a sparse map rather than a value per installed source.
  externalMetadataOverrides: Record<string, boolean>;
  // Whether the title page prints the line naming which provider entry describes it. Off by
  // default: it answers a question most people never ask, and the page reads cleaner without it.
  // Turning it on is also what makes the manual rebind reachable, since the line is what opens it.
  externalMetadataShowBinding: boolean;
  // Whether the catalog page browses the aggregator's own catalog instead of the source's (see
  // docs/aggregator-first-catalog.md). Off by default while the resolution it depends on - turning
  // an aggregator entry back into something the source can play - is still new: the source's
  // catalog is the way back if that turns out worse than expected.
  aggregatorCatalog: boolean;
  // Which aggregator to prefer. AniList is the default for the fuller entry: it carries banner
  // artwork and a next-episode timestamp, neither of which MAL publishes.
  externalMetadataProvider: MetadataProviderId;
  // Whether the other aggregator is tried when the preferred one has nothing or cannot be reached.
  // On by default, and not a decorative setting: AniList disabled its public API outright while
  // this was written, and a page that quietly fell back to MAL still looked right.
  externalMetadataFallback: boolean;
  // Off by default: downloading a hundred-plus megabytes and restarting the app is not something
  // to start doing to someone who never asked for it. Settings is where you turn it *on*.
  autoUpdate: boolean;
  setTheme: (theme: "light" | "dark") => void;
  setActiveSourceId: (id: string | null) => void;
  setSidebarWidth: (width: number) => void;
  setDiscordRpcEnabled: (enabled: boolean) => void;
  setOnboardingCompleted: (completed: boolean) => void;
  setProfileCelebratedStreak: (streak: number) => void;
  setAccentColor: (color: string | null) => void;
  setBackgroundTheme: (id: string | null) => void;
  setCatalogAutoLoad: (enabled: boolean) => void;
  setZoomFactor: (factor: number) => void;
  setAutoUpdate: (enabled: boolean) => void;
  setExternalMetadataEnabled: (enabled: boolean) => void;
  setExternalMetadataShowBinding: (show: boolean) => void;
  setAggregatorCatalog: (enabled: boolean) => void;
  setExternalMetadataProvider: (provider: MetadataProviderId) => void;
  setExternalMetadataFallback: (enabled: boolean) => void;
  /** null clears the override, handing the source back to the global switch. */
  setExternalMetadataOverride: (sourceId: string, enabled: boolean | null) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: "dark",
      activeSourceId: null,
      sidebarWidth: 236,
      discordRpcEnabled: true,
      onboardingCompleted: false,
      profileCelebratedStreak: -1,
      accentColor: null,
      backgroundTheme: null,
      catalogAutoLoad: true,
      zoomFactor: 1,
      autoUpdate: false,
      externalMetadataEnabled: true,
      externalMetadataOverrides: {},
      externalMetadataShowBinding: false,
      aggregatorCatalog: false,
      externalMetadataProvider: "anilist",
      externalMetadataFallback: true,
      setTheme: (theme) => set({ theme }),
      setActiveSourceId: (activeSourceId) => set({ activeSourceId }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      setDiscordRpcEnabled: (discordRpcEnabled) => set({ discordRpcEnabled }),
      setOnboardingCompleted: (onboardingCompleted) => set({ onboardingCompleted }),
      setProfileCelebratedStreak: (profileCelebratedStreak) => set({ profileCelebratedStreak }),
      setAccentColor: (accentColor) => set({ accentColor }),
      setBackgroundTheme: (backgroundTheme) => set({ backgroundTheme }),
      setCatalogAutoLoad: (catalogAutoLoad) => set({ catalogAutoLoad }),
      setZoomFactor: (zoomFactor) => set({ zoomFactor: normalizeZoom(zoomFactor) }),
      setAutoUpdate: (autoUpdate) => set({ autoUpdate }),
      setExternalMetadataEnabled: (externalMetadataEnabled) => set({ externalMetadataEnabled }),
      setExternalMetadataShowBinding: (externalMetadataShowBinding) => set({ externalMetadataShowBinding }),
      setAggregatorCatalog: (aggregatorCatalog) => set({ aggregatorCatalog }),
      setExternalMetadataProvider: (externalMetadataProvider) => set({ externalMetadataProvider }),
      setExternalMetadataFallback: (externalMetadataFallback) => set({ externalMetadataFallback }),
      setExternalMetadataOverride: (sourceId, enabled) =>
        set((state) => {
          const overrides = { ...state.externalMetadataOverrides };
          if (enabled === null) delete overrides[sourceId];
          else overrides[sourceId] = enabled;
          return { externalMetadataOverrides: overrides };
        }),
    }),
    { name: "hibiki-ui" },
  ),
);
