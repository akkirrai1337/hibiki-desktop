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
  // The transition waiting for its first frame, so a newer navigation can call it off.
  const pending = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (!isMobile) return;
    pending.current?.();
    pending.current = null;
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

    const fade = TOP_LEVEL.has(pathname) && TOP_LEVEL.has(from.pathname);
    // A tab fades in place - a place of its own, not something arriving from anywhere.
    const start: Keyframe = fade
      ? { opacity: 0.4 }
      : { opacity: 0.5, transform: `translateX(${index < from.index ? -32 : 32}px)` };
    const options: KeyframeAnimationOptions = fade
      ? { duration: 160, easing: "ease-out" }
      : { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };

    // A page shown for the first time can take longer to lay out and draw than the whole animation,
    // which then ran out before anything was on screen - no transition at all. So the page is first
    // drawn as the animation's first frame, and the animation starts once that frame is up. A page
    // whose code is still loading shows its empty stand-in (aria-busy, see PageShellFallback) - the
    // animation waits for the real page, or it would play on the stand-in and the page pop in after.
    box.style.opacity = String(start.opacity);
    if (start.transform) box.style.transform = String(start.transform);
    const reset = () => {
      box.style.opacity = "";
      box.style.transform = "";
    };
    let frame = 0;
    let observer: MutationObserver | null = null;
    let giveUp = 0;
    const play = () => {
      observer?.disconnect();
      clearTimeout(giveUp);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          pending.current = null;
          reset();
          box.animate([start, { opacity: 1, transform: "none" }], options);
        });
      });
    };
    const loading = () => box.querySelector(':scope > [aria-busy="true"]') !== null;
    if (loading()) {
      observer = new MutationObserver(() => { if (!loading()) play(); });
      observer.observe(box, { childList: true });
      // Never left half-faded if the page takes unusually long.
      giveUp = window.setTimeout(play, 1500);
    } else {
      play();
    }
    pending.current = () => {
      observer?.disconnect();
      clearTimeout(giveUp);
      cancelAnimationFrame(frame);
      reset();
    };
  }, [pathname]);
}
