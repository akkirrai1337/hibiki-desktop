import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Phone only: the top of a screen one level inside a tab (history and downloads under the library,
 * settings and sources under the profile) - its name, with the way back to the tab beside it.
 */
export function MobilePageHeader({ title, parent }: { title: string; parent: "/library" | "/profile" }) {
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

export interface MobileShortcut {
  to: "/history" | "/downloads" | "/settings" | "/sources";
  label: string;
  icon: LucideIcon;
  badge?: number;
}

/** Phone only: the screens a tab holds besides its own, as a row of wide buttons at its top. */
export function MobileShortcutRow({ items }: { items: MobileShortcut[] }) {
  return (
    <div className="mb-5 grid grid-cols-2 gap-2.5">
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className="relative flex min-h-[3.75rem] items-center gap-2.5 rounded-2xl border border-border bg-text/[.04] px-3 py-2.5 active:bg-text/[.08]"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent-text">
            <item.icon className="h-[18px] w-[18px]" strokeWidth={2} />
          </span>
          {/* Two lines rather than an ellipsis: half a phone's width is not much for "Watch history". */}
          <span className="line-clamp-2 min-w-0 flex-1 text-[13px] font-semibold leading-tight text-text">{item.label}</span>
          {item.badge ? <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-rose-500 px-1.5 text-[11px] font-bold text-white">{item.badge > 9 ? "9+" : item.badge}</span> : null}
        </Link>
      ))}
    </div>
  );
}
