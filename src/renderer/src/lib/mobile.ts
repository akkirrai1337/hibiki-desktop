import { useEffect, useLayoutEffect, useRef } from "react";
import { hibiki } from "@/lib/hibiki";

/**
 * The phone layout: the Android build marks <html> with `mobile` before the first paint (see
 * vite.android.config.ts). Never true on desktop, however narrow the window - the desktop layout
 * stays exactly as it is.
 */
export const isMobile = document.documentElement.classList.contains("mobile");

/** The phone's search tab remembers what it last searched, so coming back to the tab shows it again. */
export const mobileSearchMemory = { query: "" };

// --- the system Back key ------------------------------------------------------------------------
// Whatever is on top answers first: an open sheet or menu registers a handler while it is open and
// closes itself; with none open, Back steps back through the app's history, and on the first screen
// it leaves to the launcher, as other apps do.

const backHandlers: Array<{ current: () => void }> = [];

/** While `active`, Back calls `onBack` instead of navigating - for sheets, menus and overlays. */
export function useBackHandler(active: boolean, onBack: () => void): void {
  const handler = useRef(onBack);
  handler.current = onBack;
  useEffect(() => {
    if (!active || !isMobile) return;
    const entry = { current: () => handler.current() };
    backHandlers.push(entry);
    return () => {
      const index = backHandlers.indexOf(entry);
      if (index >= 0) backHandlers.splice(index, 1);
    };
  }, [active]);
}

/**
 * Wires the Back key once, for the whole session. `goBack` steps the router's history; `goUp` is
 * for a screen with nothing behind it (opened from a link, or the app restored onto it) - it moves
 * to the screen above it and answers true, or answers false on the first screen, which leaves.
 */
export function installBackButton(goBack: () => void, goUp: () => boolean): () => void {
  const device = hibiki.device;
  if (!device) return () => {};
  return device.onBack(() => {
    const top = backHandlers[backHandlers.length - 1];
    if (top) {
      top.current();
      return;
    }
    // TanStack's history numbers its entries; 0 is where this session started.
    const index = (window.history.state as { __TSR_index?: number } | null)?.__TSR_index ?? 0;
    if (index > 0) goBack();
    else if (!goUp()) device.minimize();
  });
}

// --- page transitions ---------------------------------------------------------------------------
// Only the incoming page moves - the outgoing one is already gone (hidden or unmounted) by the
// time the route resolves. Switching tabs is a short fade in place; going
// to a title slides in from the right, coming back from the left. Nothing for the player: the screen
// turns on the way in and out, and a slide on top of that only reads as a stutter.
// Never from fully transparent: the WebView does not draw a layer at opacity 0, so the new page
// stayed blank for the whole animation and only popped in after it - a flash on every switch.

// Tabs, and the screens that are part of one (the library's views; settings and sources under the
// profile): moving between them fades in place rather than sliding.
const TOP_LEVEL = new Set(["/", "/catalog", "/search", "/library", "/history", "/downloads", "/profile", "/settings", "/sources"]);
// The library's three views share one switch at their top: picking one only slides that switch's
// highlight (see LibrarySegments) - the page itself doesn't move.
const LIBRARY_VIEWS = new Set(["/library", "/history", "/downloads"]);

function historyIndex(): number {
  return (window.history.state as { __TSR_index?: number } | null)?.__TSR_index ?? 0;
}

/** Animates the page box that `pathname` shows, each time it changes (phone only). */
export function usePageTransition(pathname: string): void {
  const previous = useRef<{ pathname: string; index: number } | null>(null);
  useLayoutEffect(() => {
    if (!isMobile) return;
    const from = previous.current;
    const index = historyIndex();
    previous.current = { pathname, index };
    if (!from || from.pathname === pathname) return;
    if (pathname.startsWith("/watch/") || from.pathname.startsWith("/watch/")) return;
    if (LIBRARY_VIEWS.has(pathname) && LIBRARY_VIEWS.has(from.pathname)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const box = document.querySelector<HTMLElement>(`[data-page-scroll="${CSS.escape(pathname)}"]`)
      ?? document.querySelector<HTMLElement>('[data-scroll-restoration-id="app-main"]');
    if (!box) return;
    if (TOP_LEVEL.has(pathname) && TOP_LEVEL.has(from.pathname)) {
      box.animate(
        // A plain fade, in place: a tab is a place of its own, not something arriving from below.
        [{ opacity: 0.4 }, { opacity: 1 }],
        { duration: 160, easing: "ease-out" },
      );
      return;
    }
    const back = index < from.index;
    box.animate(
      [{ opacity: 0.5, transform: `translateX(${back ? -32 : 32}px)` }, { opacity: 1, transform: "none" }],
      { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
  }, [pathname]);
}
