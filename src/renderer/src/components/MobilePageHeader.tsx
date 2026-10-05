import { useEffect } from "react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Phone only: the top of a screen one level inside a tab (settings and sources under the profile) -
 * its name, with the way back to the tab beside it.
 */
export function MobilePageHeader({ title, parent }: { title: string; parent: "/library" | "/profile" | "/settings" }) {
  const { t } = useTranslation();
  const router = useRouter();
  const navigate = useNavigate();
  return (
    <div className="-ml-2 mb-4 flex items-center gap-1">
      <button
        type="button"
        aria-label={t("detail.back")}
        onClick={() => {
          // Reached some other way than from its tab (a link, the app restored onto it): to the tab.
          const index = (window.history.state as { __TSR_index?: number } | null)?.__TSR_index ?? 0;
          if (index > 0) router.history.back();
          else void navigate({ to: parent });
        }}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-text active:bg-text/[.08]"
      >
        <ArrowLeft className="h-[22px] w-[22px]" strokeWidth={2.25} />
      </button>
      <h1 className="truncate text-[20px] font-bold tracking-[-.02em] text-text">{title}</h1>
    </div>
  );
}

const LIBRARY_SEGMENTS = [
  { to: "/library", labelKey: "library.segments.saved" },
  { to: "/history", labelKey: "library.segments.history" },
  { to: "/downloads", labelKey: "library.segments.downloads" },
] as const;

/**
 * Phone only: the top of the library tab - a switch between what it holds: saved
 * titles, watch history and downloads, as three views of one place rather than screens to visit.
 * Switching replaces the entry, so Back leaves the tab instead of stepping through the switches.
 */
export function LibrarySegments({ active }: { active: (typeof LIBRARY_SEGMENTS)[number]["to"] }) {
  const { t } = useTranslation();
  // The other two views' code, fetched while this one is on screen, so switching to them is instant.
  useEffect(() => {
    void import("@/pages/history");
    void import("@/pages/downloads");
  }, []);
  return (
    <div className="mb-4">
      <div className="grid grid-cols-3 rounded-full bg-text/[.06] p-1">
        {LIBRARY_SEGMENTS.map((segment) => (
          <Link
            key={segment.to}
            to={segment.to}
            replace
            className={cn(
              "truncate rounded-full px-2 py-2 text-center text-[13px] font-semibold transition-colors",
              segment.to === active ? "bg-app-popover text-text shadow-[0_1px_4px_rgba(0,0,0,0.35)]" : "text-muted",
            )}
          >
            {t(segment.labelKey)}
          </Link>
        ))}
      </div>
    </div>
  );
}
