import { useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Bookmark, Home, LayoutGrid, Search, User } from "lucide-react";
import { useSpotlightStore } from "@/stores/spotlightStore";
import { cn } from "@/lib/cn";

// The phone's whole navigation: five places, each owning the screens reached from it. History and
// downloads live under the library, settings and sources under the profile - the desktop sidebar's
// other entries, one level down. Search opens the search panel (full screen on the phone) rather
// than a page; its full results page belongs to it.
const tabs = [
  { to: "/", labelKey: "nav.home", icon: Home, owns: ["/"] },
  { to: "/catalog", labelKey: "nav.catalog", icon: LayoutGrid, owns: ["/catalog"] },
  { to: "/search", labelKey: "nav.search", icon: Search, owns: ["/search"] },
  { to: "/library", labelKey: "library.title", icon: Bookmark, owns: ["/library", "/history", "/downloads"] },
  { to: "/profile", labelKey: "nav.profile", icon: User, owns: ["/profile", "/settings", "/sources"] },
] as const;

type TabPath = (typeof tabs)[number]["to"];

function tabFor(pathname: string): TabPath | null {
  return tabs.find((tab) => (tab.owns as readonly string[]).includes(pathname))?.to ?? null;
}

/**
 * The page colour behind the status bar once content scrolls under it, so the clock and icons stay
 * readable. It fades in over the first stretch of scrolling: at the top a page either has its own
 * background there or, like the home hero, artwork meant to run under the bar.
 */
export function MobileStatusScrim() {
  const scrim = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // scroll does not bubble, but capturing on the document sees every page's own scroll box.
    const onScroll = (event: Event) => {
      const target = event.target;
      // Only a page's own vertical scroll box - not a poster row scrolled sideways.
      if (!(target instanceof HTMLElement) || !scrim.current || !target.matches("[data-page-scroll], [data-scroll-restoration-id]")) return;
      scrim.current.style.opacity = String(Math.min(1, target.scrollTop / 160));
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);
  // A page switch shows another scroll box, possibly scrolled elsewhere: start from its position.
  const pathname = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).pathname });
  useEffect(() => {
    const box = document.querySelector<HTMLElement>(`[data-page-scroll="${pathname}"], [data-scroll-restoration-id="app-main"]`);
    if (scrim.current) scrim.current.style.opacity = String(Math.min(1, (box?.scrollTop ?? 0) / 160));
  }, [pathname]);
  return <div ref={scrim} aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-30 h-[var(--safe-top)] bg-app-bg opacity-0" />;
}

/** Floating bar at the bottom of every screen except the player and a title page (it pins its watch button there). */
export function MobileTabBar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).pathname });
  // A title page belongs to whichever tab it was opened from, so that tab stays lit under it.
  const lastTab = useRef<TabPath>("/");
  const owner = tabFor(pathname);
  if (owner) lastTab.current = owner;
  const active = owner ?? lastTab.current;

  return (
    <nav
      className="fixed inset-x-3 z-40 flex h-14 items-stretch rounded-[1.75rem] border border-border bg-app-popover shadow-[0_8px_28px_rgba(0,0,0,0.45)]"
      style={{ bottom: "calc(0.625rem + var(--safe-bottom))" }}
    >
      {tabs.map((tab) => {
        const isActive = tab.to === active;
        return (
          <button
            key={tab.to}
            type="button"
            aria-current={isActive ? "page" : undefined}
            onClick={() => {
              if (tab.to === "/search") {
                useSpotlightStore.getState().setOpen(true);
                return;
              }
              if (pathname === tab.to) {
                // Already there: back to the top, the way a tab bar does it.
                document.querySelector<HTMLElement>(`[data-page-scroll="${tab.to}"]`)?.scrollTo({ top: 0, behavior: "smooth" });
                return;
              }
              void navigate({ to: tab.to });
            }}
            className={cn("flex flex-1 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium transition-colors", isActive ? "text-accent-text" : "text-muted active:text-text")}
          >
            <tab.icon className="h-[21px] w-[21px]" strokeWidth={isActive ? 2.3 : 1.9} />
            <span className="leading-none">{t(tab.labelKey)}</span>
          </button>
        );
      })}
    </nav>
  );
}
