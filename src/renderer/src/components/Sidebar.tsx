import { useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Home, LayoutGrid, Bookmark, Download, Radio, User, Settings } from "lucide-react";
import { useUiStore } from "@/stores/uiStore";
import { cn } from "@/lib/cn";

// 236px is the ceiling (the original full design). Below MIN_FULL_WIDTH there isn't room to keep
// labels legible, so instead of shrinking/truncating text we snap straight to an icon-only strip
// at COMPACT_WIDTH — that's the floor, not a continuum down to zero.
const MAX_WIDTH = 236;
const MIN_FULL_WIDTH = 160;
const COMPACT_WIDTH = 68;
const SNAP_POINT = (MIN_FULL_WIDTH + COMPACT_WIDTH) / 2;

const navigation = [
  { to: "/", labelKey: "nav.home", icon: Home },
  { to: "/catalog", labelKey: "nav.catalog", icon: LayoutGrid },
  { to: "/library", labelKey: "library.title", icon: Bookmark },
  { to: "/downloads", labelKey: "downloads.title", icon: Download },
  { to: "/sources", labelKey: "nav.sources", icon: Radio },
] as const;

export function Sidebar() {
  const { t } = useTranslation();
  const width = useUiStore((s) => s.sidebarWidth);
  const setWidth = useUiStore((s) => s.setSidebarWidth);
  const compact = width <= COMPACT_WIDTH;
  const draggingRef = useRef(false);

  // Exposed as a CSS var (not just this element's own inline `width` below) so pages that paint a
  // full-viewport-width fixed background of their own - the anime detail page's blurred-poster
  // backdrop is the one that actually needs this, see anime.$sourceId.$animeId.tsx - can stop
  // short of the sidebar's real, current (possibly user-resized) width instead of running full
  // bleed underneath it. That only started mattering once the sidebar itself could become
  // translucent (the "app background" theme, see lib/theme.ts): a per-page backdrop sitting behind
  // an opaque sidebar was invisible regardless of how far it extended, but behind a translucent one
  // it would otherwise visibly tint the nav differently on whichever page happened to have its own
  // backdrop going, which is exactly the "why does the sidebar change color here" bug this fixes.
  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-width", `${compact ? COMPACT_WIDTH : width}px`);
  }, [width, compact]);

  const onHandlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startWidth = compact ? COMPACT_WIDTH : width;

    const onMove = (ev: PointerEvent) => {
      const raw = startWidth + (ev.clientX - startX);
      setWidth(raw < SNAP_POINT ? COMPACT_WIDTH : Math.min(MAX_WIDTH, Math.max(MIN_FULL_WIDTH, raw)));
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <aside className="relative flex shrink-0 flex-col border-r border-border bg-app-surface px-3 pb-5 pt-4" style={{ width }}>
      <nav className="flex flex-col gap-0.5">{navigation.map((item) => <NavLink key={item.to} to={item.to} label={t(item.labelKey)} icon={item.icon} compact={compact} />)}</nav>
      <div className="mt-auto flex flex-col gap-0.5 border-t border-border pt-3">
        <NavLink to="/settings" label={t("nav.settings")} icon={Settings} compact={compact} />
        <NavLink to="/profile" label={t("nav.profile")} icon={User} compact={compact} />
      </div>
      <div
        onPointerDown={onHandlePointerDown}
        className="app-no-drag group absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
      >
        <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-accent/50" />
      </div>
    </aside>
  );
}

function NavLink({ to, label, icon: Icon, compact }: { to: "/" | "/catalog" | "/library" | "/downloads" | "/sources" | "/settings" | "/profile"; label: string; icon: typeof Home; compact: boolean }) {
  return <Link to={to} title={compact ? label : undefined} className={cn("app-no-drag group relative flex items-center rounded-lg py-2 text-[13px] font-medium text-muted transition-colors hover:bg-text/[.05] hover:text-text", compact ? "justify-center px-0" : "gap-3 px-3")} activeProps={{ className: "!text-text" }}>
    {({ isActive }: { isActive: boolean }) => <>
      <span className={cn("absolute -left-3 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-accent transition-opacity", isActive ? "opacity-100" : "opacity-0")} />
      {isActive && <span className="absolute inset-0 rounded-lg bg-text/[.08]" />}
      <Icon className="relative z-10 h-[17px] w-[17px] shrink-0" strokeWidth={2} />
      {!compact && <span className="relative z-10 truncate">{label}</span>}
    </>}
  </Link>;
}
