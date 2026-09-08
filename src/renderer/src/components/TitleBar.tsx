import { useEffect, useRef, useState } from "react";
import { useRouter, useRouterState, useNavigate, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence } from "motion/react";
import { ChevronLeft, ChevronRight, Search, Home, SlidersHorizontal, Minus, Square, Copy, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { hibiki } from "@/lib/hibiki";
import { useUiStore } from "@/stores/uiStore";
import { useSearchFiltersStore } from "@/stores/searchFiltersStore";
import { activeFilterCount } from "@/lib/searchFilters";
import { SearchFiltersPanel } from "@/components/SearchFiltersPanel";
import { cn } from "@/lib/cn";
import appIcon from "@/assets/app-icon.png";

const SEARCH_HIDDEN_ON = ["/settings", "/profile", "/sources"];

// Windows/Linux: the native title bar is hidden entirely (see main/index.ts's titleBarStyle:
// "hidden") and this draws everything, minimize/maximize/close included (see WindowControls below)
// - not Electron's titleBarOverlay (Window Controls Overlay), which technically also works but
// always paints a solid, opaque rectangle behind the OS-drawn buttons that a gradient "background
// theme" (see lib/theme.ts) couldn't follow. Plain page content follows app theming exactly like
// everything else. macOS keeps its native hiddenInset traffic lights (see createWindow in
// main/index.ts) - WindowControls only renders on other platforms.
export function TitleBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const navigate = useNavigate();
  const [canGoBack, setCanGoBack] = useState(router.history.canGoBack());

  useEffect(() => router.history.subscribe(() => setCanGoBack(router.history.canGoBack())), [router]);

  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const searchQuery = useRouterState({ select: (s) => (s.location.search as { q?: string }).q ?? "" });
  const isSearchPage = pathname === "/search";
  // There's nothing yet to search, and nowhere else to jump "home" to, while onboarding still owns
  // the whole screen (see __root.tsx) - both would just be dead chrome floating over it.
  const onboardingCompleted = useUiStore((s) => s.onboardingCompleted);
  const searchHidden = SEARCH_HIDDEN_ON.includes(pathname) || !onboardingCompleted;

  const [value, setValue] = useState(isSearchPage ? searchQuery : "");

  // Reflect the URL's own query when it changes from elsewhere (landing on /search, browser
  // back/forward); reset to empty once we leave /search so stale text doesn't linger.
  useEffect(() => setValue(isSearchPage ? searchQuery : ""), [isSearchPage, searchQuery]);

  // While already on the results page, live-update as you type (debounced, replacing the URL
  // rather than pushing a new history entry per keystroke).
  useEffect(() => {
    if (!isSearchPage) return;
    const trimmed = value.trim();
    if (trimmed === searchQuery) return;
    const timer = setTimeout(() => navigate({ to: "/search", search: { q: trimmed }, replace: true }), 400);
    return () => clearTimeout(timer);
  }, [value, isSearchPage, searchQuery, navigate]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && value.trim() && !isSearchPage) {
      navigate({ to: "/search", search: { q: value.trim() } });
    }
  };

  const activeSourceId = useUiStore((s) => s.activeSourceId);
  const sources = useQuery({ queryKey: ["sources"], queryFn: () => hibiki.sources.list() });
  const source = sources.data?.find((s) => s.id === activeSourceId) ?? sources.data?.[0];
  const showFilterButton = !searchHidden && !!source && source.supportedFilters.length > 0;

  const filters = useSearchFiltersStore((s) => s.filters);
  const setFilters = useSearchFiltersStore((s) => s.setFilters);
  const resetFilters = useSearchFiltersStore((s) => s.resetFilters);
  // A different source has its own type/status/genre id space - stale aliases from the previous
  // one wouldn't mean anything to it.
  useEffect(() => resetFilters(), [source?.id, resetFilters]);

  const [filtersPanelOpen, setFiltersPanelOpen] = useState(false);
  const filterCatalog = useQuery({
    queryKey: ["filterCatalog", source?.id],
    enabled: showFilterButton,
    queryFn: () => hibiki.sources.filterCatalog(source!.id),
  });
  const filterCount = activeFilterCount(filters);

  // The panel is portaled to document.body (see SearchFiltersPanel) instead of living inside this
  // absolutely-positioned search box - a blurred poster background elsewhere in the app (Hero,
  // anime detail) can otherwise paint over it despite a lower z-index, a GPU-compositing quirk
  // with filter: blur() that ordinary z-index/isolation can't reliably override. Portaling to the
  // end of <body> sidesteps it entirely, so we track the anchor's screen position by hand instead
  // of relying on CSS to position the panel relative to it.
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState<{ left: number; bottom: number } | null>(null);
  useEffect(() => {
    if (!filtersPanelOpen) return;
    const update = () => {
      const rect = searchBoxRef.current?.getBoundingClientRect();
      if (rect) setAnchorRect({ left: rect.left + rect.width / 2, bottom: rect.bottom });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [filtersPanelOpen]);

  // `-webkit-app-region: drag` correctly detects the drag region even while maximized, but Windows
  // never actually engages the "unmaximize and follow the cursor" behavior a real titlebar gives
  // for free - nothing happens at all. Unmaximizing ourselves first (synchronously, before
  // Chromium's own drag-intent handling for this same mousedown can decide "maximized, nothing to
  // do") fixes that specific case; a genuinely empty click on the bar itself is the only thing that
  // should trigger it, not a click that landed on the search box or a button (those already work
  // fine and shouldn't unmaximize as a side effect).
  const onBarMouseDown = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) hibiki.window.unmaximizeForDrag(e.screenX);
  };
  // A real OS title bar toggles maximize/restore on a double-click anywhere on the bar itself -
  // free with a native frame, but a fully custom one (see the comment up top for why this isn't
  // titleBarOverlay) gets none of that automatically, so it's wired up by hand here. Same
  // `e.target === e.currentTarget` guard as the drag handler above, so double-clicking the search
  // box or a nav button doesn't also toggle the window.
  const onBarDoubleClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) hibiki.window.toggleMaximize();
  };

  return (
    <div className="app-drag relative flex h-10 shrink-0 items-center bg-app-surface pl-3" onMouseDown={onBarMouseDown} onDoubleClick={onBarDoubleClick}>
      <div className="flex shrink-0 items-center gap-1">
        <img src={appIcon} alt="" className="mr-1.5 h-6 w-6 rounded-[7px]" />
        {onboardingCompleted && (
          <Link to="/" aria-label="Home" className="flex h-6 w-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-text/10 hover:text-text" activeProps={{ className: "!text-accent-text" }}>
            <Home className="h-[15px] w-[15px]" strokeWidth={2.25} />
          </Link>
        )}
        <button
          onClick={() => router.history.back()}
          disabled={!canGoBack}
          aria-label="Back"
          className={cn("app-no-drag flex h-6 w-6 items-center justify-center rounded-full transition-colors", canGoBack ? "text-muted hover:bg-text/10 hover:text-text" : "cursor-default text-muted/50")}
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={2.5} />
        </button>
        <button
          onClick={() => router.history.forward()}
          aria-label="Forward"
          className="app-no-drag flex h-6 w-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-text/10 hover:text-text"
        >
          <ChevronRight className="h-4 w-4" strokeWidth={2.5} />
        </button>
      </div>

      {!searchHidden && (
        <div ref={searchBoxRef} className="wco-centered-search app-no-drag w-[360px] max-w-[calc(100vw-280px)]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" strokeWidth={2} />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label={t("catalog.searchPlaceholder")}
            placeholder={t("catalog.searchPlaceholder")}
            className={cn(
              "h-7 w-full rounded-lg border border-border bg-text/[.06] pl-8 text-[13px] text-text outline-none transition-colors placeholder:text-muted focus:border-accent/70 focus:bg-text/[.09]",
              showFilterButton ? "pr-8" : "pr-3",
            )}
          />
          {showFilterButton && (
            <button
              onClick={() => setFiltersPanelOpen((v) => !v)}
              aria-label={t("search.filters.button")}
              title={t("search.filters.button")}
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted transition-colors hover:text-text"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={2.25} />
              {filterCount > 0 && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-accent" />}
            </button>
          )}
          {showFilterButton && (
            <AnimatePresence>
              {filtersPanelOpen && anchorRect && (
                <SearchFiltersPanel
                  anchor={anchorRect}
                  supportedFilters={source!.supportedFilters}
                  catalog={filterCatalog.data}
                  loading={filterCatalog.isLoading}
                  filters={filters}
                  onApply={(next) => { setFilters(next); setFiltersPanelOpen(false); }}
                  onClose={() => setFiltersPanelOpen(false)}
                />
              )}
            </AnimatePresence>
          )}
        </div>
      )}
      <WindowControls />
    </div>
  );
}

// Custom minimize/maximize/close - see the comment at the top of this file for why these exist
// instead of Electron's own titleBarOverlay buttons. `ml-auto` (not relying on `justify-between`
// on the parent) so this sits flush against the right edge regardless of whether the search box
// next to it is hidden (it's absolutely positioned and centers on the whole window either way, so
// it never actually pushes this over via normal flex layout).
function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    hibiki.window.isMaximized().then(setMaximized);
    return hibiki.window.onMaximizedChanged(setMaximized);
  }, []);

  // Only Windows/Linux - macOS keeps its native hiddenInset traffic lights (see createWindow in
  // main/index.ts), which already sit top-left and would collide with a second set drawn here.
  if (hibiki.platform === "darwin") return null;

  return (
    <div className="app-no-drag ml-auto flex h-full shrink-0 items-stretch">
      <button
        onClick={() => hibiki.window.minimize()}
        aria-label="Minimize"
        className="flex w-11 items-center justify-center text-muted transition-colors hover:bg-text/[.08] hover:text-text"
      >
        <Minus className="h-4 w-4" strokeWidth={2} />
      </button>
      <button
        onClick={() => hibiki.window.toggleMaximize()}
        aria-label={maximized ? "Restore" : "Maximize"}
        className="flex w-11 items-center justify-center text-muted transition-colors hover:bg-text/[.08] hover:text-text"
      >
        {maximized ? <Copy className="h-[13px] w-[13px] -scale-x-100" strokeWidth={2} /> : <Square className="h-[13px] w-[13px]" strokeWidth={2} />}
      </button>
      <button
        onClick={() => hibiki.window.close()}
        aria-label="Close"
        className="flex w-11 items-center justify-center text-muted transition-colors hover:bg-rose-500 hover:text-white"
      >
        <X className="h-[18px] w-[18px]" strokeWidth={2} />
      </button>
    </div>
  );
}
