import { create } from "zustand";
import { persist } from "zustand/middleware";

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
  setTheme: (theme: "light" | "dark") => void;
  setActiveSourceId: (id: string | null) => void;
  setSidebarWidth: (width: number) => void;
  setDiscordRpcEnabled: (enabled: boolean) => void;
  setOnboardingCompleted: (completed: boolean) => void;
  setProfileCelebratedStreak: (streak: number) => void;
  setAccentColor: (color: string | null) => void;
  setBackgroundTheme: (id: string | null) => void;
  setCatalogAutoLoad: (enabled: boolean) => void;
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
      setTheme: (theme) => set({ theme }),
      setActiveSourceId: (activeSourceId) => set({ activeSourceId }),
      setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
      setDiscordRpcEnabled: (discordRpcEnabled) => set({ discordRpcEnabled }),
      setOnboardingCompleted: (onboardingCompleted) => set({ onboardingCompleted }),
      setProfileCelebratedStreak: (profileCelebratedStreak) => set({ profileCelebratedStreak }),
      setAccentColor: (accentColor) => set({ accentColor }),
      setBackgroundTheme: (backgroundTheme) => set({ backgroundTheme }),
      setCatalogAutoLoad: (catalogAutoLoad) => set({ catalogAutoLoad }),
    }),
    { name: "hibiki-ui" },
  ),
);
