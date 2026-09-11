import { lazy, Suspense, useEffect, useLayoutEffect, useState } from "react";
import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useUiStore } from "@/stores/uiStore";
import { useKnownSourcesStore } from "@/stores/knownSourcesStore";
import { applyAccentColor, applyBackgroundTheme, BACKGROUND_THEME_PRESETS } from "@/lib/theme";
import { TitleBar } from "@/components/TitleBar";
import { Sidebar } from "@/components/Sidebar";
import { AchievementToast } from "@/components/AchievementToast";
import { useAchievementUnlocks } from "@/lib/achievementUnlocks";
import { hibiki } from "@/lib/hibiki";
import { installGlobalErrorLogging } from "@/lib/log";
import { useAppZoom } from "@/lib/useAppZoom";
import { cn } from "@/lib/cn";
import { Onboarding } from "@/features/onboarding/Onboarding";

// Every static (paramless) route's own route component is a no-op (see index.tsx) - its real
// content is one of these, kept alive here instead once first visited (see `visited` below). Lazy
// imports keep every unvisited screen out of the startup bundle without changing that persistence.
const PERSISTED_PAGES: Record<string, React.LazyExoticComponent<React.ComponentType>> = {
  "/": lazy(() => import("@/pages/home").then((module) => ({ default: module.CatalogPage }))),
  "/catalog": lazy(() => import("@/pages/catalog").then((module) => ({ default: module.CatalogBrowsePage }))),
  "/library": lazy(() => import("@/pages/library").then((module) => ({ default: module.LibraryPage }))),
  "/history": lazy(() => import("@/pages/history").then((module) => ({ default: module.HistoryPage }))),
  "/downloads": lazy(() => import("@/pages/downloads").then((module) => ({ default: module.DownloadsPage }))),
  "/profile": lazy(() => import("@/pages/profile").then((module) => ({ default: module.ProfilePage }))),
  "/settings": lazy(() => import("@/pages/settings").then((module) => ({ default: module.SettingsPage }))),
  "/sources": lazy(() => import("@/pages/sources").then((module) => ({ default: module.SourcesPage }))),
  "/search": lazy(() => import("@/pages/search").then((module) => ({ default: module.SearchPage }))),
};

// A lazy page has no DOM of its own until its chunk arrives. Keep the same page background in
// place for that brief interval so the app-wide theme gradient never flashes through before the
// page's `bg-app-bg` root mounts.
function PageShellFallback() {
  return <div className="min-h-full bg-app-bg" aria-busy="true" />;
}

// Development StrictMode intentionally remounts effects once. This is a real account write, not
// a disposable subscription, so keep it once-per-renderer-session in both dev and production.
let activityPingStarted = false;

export const Route = createRootRoute({ component: RootLayout });

function RootLayout() {
  const theme = useUiStore((s) => s.theme);
  // useLayoutEffect (not useEffect) - a passive effect only runs after the browser has already
  // painted the frame, which left one extra frame where the page was still showing the old theme;
  // a layout effect runs synchronously right after the DOM update but before that paint.
  useLayoutEffect(() => { document.documentElement.classList.toggle("dark", theme === "dark"); }, [theme]);
  const accentColor = useUiStore((s) => s.accentColor);
  // Depends on `theme` too, not just `accentColor` - see applyAccentColor's own comment for why
  // (--color-accent-text's white/black-vs-theme contrast fallback needs to know which theme is
  // active, not just which accent is picked).
  // Once per app start, not per render - see lib/log.ts.
  useEffect(() => { installGlobalErrorLogging(); }, []);
  // Once a launch, tell every source that reports activity that its account is online today -
  // that is what a site's "day streak" counts, and it should not depend on whether an episode
  // happened to be watched. Sources that report nothing, or are signed out, answer false and cost
  // one cheap check in the main process.
  useEffect(() => {
    if (activityPingStarted) return;
    // Account streak maintenance is background work. Starting it alongside the home catalog made
    // both compete for workers/network on the only load where first paint matters most.
    const timer = window.setTimeout(() => {
      if (activityPingStarted) return;
      activityPingStarted = true;
      void hibiki.sources
        .list()
        .then((sources) => Promise.all(sources.map((source) => hibiki.sources.pingOnline(source.id).catch(() => false))))
        .catch(() => undefined);
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, []);

  // Ctrl/Cmd +/-/0, and re-applying the saved factor on launch.
  useAppZoom();

  useEffect(() => { applyAccentColor(accentColor, theme); }, [accentColor, theme]);
  const backgroundTheme = useUiStore((s) => s.backgroundTheme);
  useEffect(() => { applyBackgroundTheme(backgroundTheme); }, [backgroundTheme, applyBackgroundTheme]);
  // Painted as this element's own `background-image`, sitting on top of its `bg-app-bg` background
  // -color (see globals.css) - not a separate fixed layer, since the Sidebar/TitleBar/page
  // backgrounds are just later DOM siblings within this same box: as long as their own backgrounds
  // are translucent (which applyBackgroundTheme's CSS variables make them, only while a theme is
  // actually selected), the gradient painted here already shows through them exactly where it
  // should, `backdrop-filter: blur` and all, with no z-index/stacking of its own to manage.
  const backgroundGradient = BACKGROUND_THEME_PRESETS.find((p) => p.id === backgroundTheme)?.gradient;
  const onboardingCompleted = useUiStore((s) => s.onboardingCompleted);
  const setOnboardingCompleted = useUiStore((s) => s.setOnboardingCompleted);
  // The main process owns the actual RPC connection - this just keeps it in sync with the
  // persisted setting, both on boot and whenever the Settings toggle changes.
  const discordRpcEnabled = useUiStore((s) => s.discordRpcEnabled);
  useEffect(() => { hibiki.discord.setEnabled(discordRpcEnabled); }, [discordRpcEnabled]);
  // Same arrangement for the external-metadata settings: the main process does the merging, this
  // only keeps it told what the persisted settings say.
  const externalMetadataEnabled = useUiStore((s) => s.externalMetadataEnabled);
  const externalMetadataOverrides = useUiStore((s) => s.externalMetadataOverrides);
  const externalMetadataProvider = useUiStore((s) => s.externalMetadataProvider);
  const externalMetadataFallback = useUiStore((s) => s.externalMetadataFallback);
  useEffect(() => {
    void hibiki.metadata
      .setPreferences({
        enabled: externalMetadataEnabled,
        overrides: externalMetadataOverrides,
        provider: externalMetadataProvider,
        fallbackEnabled: externalMetadataFallback,
      })
      .catch(() => undefined);
  }, [externalMetadataEnabled, externalMetadataOverrides, externalMetadataProvider, externalMetadataFallback]);
  // The player replaces the sidebar/nav chrome with the video itself, but keeps the same TitleBar
  // — it already matches the app's look and gives back/forward navigation + a home for the OS
  // window buttons, so there's no need for the player to grow its own copy of that backdrop.
  // The *resolved* location, not the pending one. `location` flips the moment a navigation starts,
  // while the player is a code-split chunk that still has to load - so the chrome tore down first
  // and the sidebar visibly vanished into an empty black frame before the player appeared. Reading
  // the resolved location keeps the page you are leaving on screen, sidebar and all, until the
  // player is actually ready to be shown, and the swap then happens in one frame.
  const isWatching = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).pathname.startsWith("/watch/") });
  // Resolved as well, and for the same reason: this decides which persisted page is the visible
  // one, so reading the pending location hid the page being left the instant a navigation started,
  // leaving an empty frame under the chrome until the next route's chunk arrived.
  const pathname = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).pathname });
  // Each of PERSISTED_PAGES only ever joins this set, never leaves it - the first visit mounts it
  // (paying its own load/query cost, same as before) and every visit after that just toggles
  // `hidden` on an already-live component instead of tearing it down and rebuilding its state from
  // scratch. Pages never visited this session (e.g. Settings, for someone who never opens it) never
  // mount at all, so this doesn't front-load every route's queries on app boot.
  const [visited, setVisited] = useState<string[]>(() => (pathname in PERSISTED_PAGES ? [pathname] : []));
  useEffect(() => {
    if (pathname in PERSISTED_PAGES) setVisited((prev) => (prev.includes(pathname) ? prev : [...prev, pathname]));
  }, [pathname]);
  // Discord presence outside the player: a single steady "using hibiki" line, not per-page text
  // (catalog/profile/settings/...) - that was tried and just read as noise. The watch page sets
  // its own detailed presence on mount and this effect only fires again once it's left (isWatching
  // flips back to false), so the two never fight over which one is showing.
  useEffect(() => {
    if (discordRpcEnabled && !isWatching) hibiki.discord.setIdlePresence();
  }, [discordRpcEnabled, isWatching]);
  // Kept mounted for the whole session (not just while the profile page is open) - an episode
  // finishing (the most common trigger, via the "finisher" family) happens on the watch page, not
  // profile, so the tier-crossing check this owns has to keep running regardless of where the user
  // actually is when it happens. See its own comment for why profile.tsx no longer computes this
  // itself.
  useAchievementUnlocks();
  // Remembers every currently-installed source's name/icon (see knownSourcesStore) - shared with
  // whichever page happens to fetch ["sources"] first (React Query dedupes the actual request), so
  // a continue-watching/library card whose source later gets uninstalled can still show its real
  // name instead of a bare id in AnimeCard's "source removed" badge.
  const sourcesQuery = useQuery({ queryKey: ["sources"], queryFn: () => hibiki.sources.list() });
  const rememberSources = useKnownSourcesStore((s) => s.remember);
  useEffect(() => {
    if (sourcesQuery.data) rememberSources(sourcesQuery.data.map((s) => ({ id: s.id, name: s.name, iconUrl: s.iconUrl })));
  }, [sourcesQuery.data, rememberSources]);

  // Gated ahead of everything else below (including isWatching, though there's nothing to watch
  // yet at this point anyway) - nothing in the real app is usable without at least one source
  // installed, so this fully replaces the normal chrome instead of layering on top of it.
  if (!onboardingCompleted) return <div className="flex h-screen w-screen flex-col overflow-hidden bg-app-bg text-text" style={{ backgroundImage: backgroundGradient }}>
    <TitleBar />
    <div className="min-h-0 flex-1"><Onboarding onComplete={() => setOnboardingCompleted(true)} /></div>
  </div>;

  if (isWatching) return <div className="flex h-screen w-screen flex-col overflow-hidden bg-black" style={{ backgroundImage: backgroundGradient }}>
    <TitleBar />
    <AchievementToast />
    <div className="min-h-0 flex-1"><Outlet /></div>
  </div>;

  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-app-bg text-text" style={{ backgroundImage: backgroundGradient }}>
    <TitleBar />
    <AchievementToast />
    <div className="flex min-h-0 flex-1">
      <Sidebar />
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The router destroys a route's whole component tree on navigating away, which was silently
            resetting anything living in its component state one piece at a time (a carousel's slide,
            a scroll position, a random pool re-rolling on every visit) - patching each of those
            individually was a losing game, so instead the entire category of bug is sidestepped by
            just never letting a visited page unmount in the first place. Routes with a param in the
            URL (anime details, the player) don't get this treatment - there can be unboundedly many
            of them over a session, so they keep the normal mount/unmount-per-visit behavior via
            Outlet below and rely on React Query's cache instead. */}
        {visited.map((path) => {
          const Page = PERSISTED_PAGES[path];
          const isActive = pathname === path;
          // This wrapper only needs to be a flex ITEM of `main` (`flex-1 min-h-0`, so it claims its
          // share of main's height instead of growing to fit content) - it does NOT need to be a
          // flex CONTAINER itself for its one single child (the page). Making it one anyway (via
          // `flex flex-col`) was the actual bug behind the "gray background gets cut off, content
          // keeps going" reports: the page's own root div (`min-h-full bg-[#17161b]`) became a flex
          // item of THIS wrapper too, and setting an explicit min-height (rather than leaving the
          // default `auto`) switches off a flex item's usual protection against shrinking below its
          // own content size - so with content taller than the viewport, the flexbox algorithm
          // happily shrank the page's own box down to exactly `min-h-full`'s value (the viewport
          // height) and let the overflow render past it with no background of its own underneath.
          // A plain block wrapper has no such mechanic: `min-h-full` on a normal block child is just
          // a floor, and it grows with taller content the ordinary way, same as it always looks like
          // it should.
          // It's also its own independent scroll container (`overflow-y-auto`), not a shared one -
          // every persisted page used to scroll inside `main` itself, which is one single DOM
          // element with one single scrollTop: scrolling one page and switching to another showed
          // that same scrollTop applied to different content, since as far as the browser's
          // concerned it's the same scrollable region the whole time. Because a persisted page's own
          // div never unmounts, giving it its own scroll box instead means its scroll position is
          // remembered for free just by staying in the DOM, with no explicit save/restore needed and
          // no way for it to leak into any other page's.
          // Keep the React tree mounted so component state and the element's scrollTop survive page
          // changes, but remove inactive pages from layout and painting. Keeping every visited page
          // as an invisible, composited viewport permanently spent GPU memory on all of their cards
          // and artwork, which then made the active catalog less smooth to scroll.
          return <div
            key={path}
            aria-hidden={!isActive}
            className={cn(
              "no-scrollbar min-h-0 overflow-y-auto",
              isActive ? "flex-1" : "hidden",
            )}
          >
            <Suspense fallback={<PageShellFallback />}><Page /></Suspense>
          </div>;
        })}
        {/* Param routes (anime details, the player) aren't persisted above - a fresh mount every
            visit, so there's no long-lived DOM box to remember a scroll position in on its own the
            way the persisted pages now do. `data-scroll-restoration-id` hands that one case back to
            the router's own scroll restoration (keyed per full path), same as it always was for
            every route before the persisted pages started sharing `main`'s scroll with it. Only
            rendered while actually on such a route - otherwise this would sit alongside a persisted
            page's own div as a second, empty `flex-1` box silently claiming half of `main`'s height
            for content (Outlet renders nothing for a persisted route) that was never going to use it. */}
        {!(pathname in PERSISTED_PAGES) && (
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto" data-scroll-restoration-id="app-main">
            <Outlet />
          </div>
        )}
      </main>
    </div>
  </div>;
}
