import { useEffect, useRef } from "react";
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
