import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";

// Shared by Home/Catalog/Search (previously three near-identical copies) - `navigator.onLine` is
// a coarse signal (it only reflects whether the OS thinks it has *a* network connection, not
// whether the specific source that just failed is reachable), but a query failing while it reads
// false is a good enough proxy for "you're offline" to point at something actually useful (already
// downloaded episodes) instead of just leaving a bare error message with nothing to do about it.
export function ErrorBanner({ message, className }: { message: string; className?: string }) {
  const { t } = useTranslation();
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  return (
    <div className={cn("flex items-start gap-3 rounded-2xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/5 dark:text-rose-200", className)}>
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
      <div className="min-w-0">
        <p>{t("common.loadFailed", { message })}</p>
        {offline && (
          <p className="mt-1.5 text-rose-700/80 dark:text-rose-300/80">
            {t("common.offlineHint")}{" "}
            <Link to="/downloads" className="font-semibold text-rose-800 underline underline-offset-2 hover:text-rose-950 dark:text-rose-100 dark:hover:text-white">
              {t("common.openDownloads")}
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
