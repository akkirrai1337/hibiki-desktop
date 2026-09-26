import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { usePopoverTheme } from "@/lib/usePopoverTheme";
import { FilterControl, FilterSection, LongList, inWindowOrder, isLongList } from "@/components/SearchFiltersPanel";
import { isFilterSet, withFilterValue, type SearchFilters } from "@/lib/searchFilters";
import { withoutUnknown } from "@/lib/filterVisuals";
import type { FilterValue, SearchFilterDef } from "@shared/types";

// Picking a filter reloads the catalog under the panel, so changes are sent on once the user pauses
// rather than on every click.
const APPLY_DELAY_MS = 400;

/**
 * The catalog's filters: a toolbar row (the Filters button with a ✕ that clears them, and
 * whatever else goes at the right - the sort menu) and a drawer that slides in from the right over the
 * catalog. Changes apply on their own after a short pause.
 */
export function CatalogFilters({
  defs,
  filters,
  onChange,
  loading,
  lead,
  layer = 50,
  children,
}: {
  defs: SearchFilterDef[];
  filters: SearchFilters;
  onChange: (filters: SearchFilters) => void;
  loading: boolean;
  /** What fills the left of the row: the catalog's heading. */
  /** What fills the left of the row. A function gets the filters control (button and clear) and lays the
   * whole row out itself - the search page seats it inside its field. */
  lead?: React.ReactNode | ((filtersControl: React.ReactNode) => React.ReactNode);
  /** z-index of the drawer, for when it opens over another overlay (the search panel). */
  layer?: number;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(filters);
  const popoverTheme = usePopoverTheme();
  const ordered = useMemo(() => inWindowOrder(withoutUnknown(defs)), [defs]);

  // Whatever changed the filters from outside (a chip's ✕, a source switch) is the new draft.
  useEffect(() => setDraft(filters), [filters]);
  useEffect(() => {
    if (draft === filters) return;
    const timer = setTimeout(() => onChange(draft), APPLY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, filters, onChange]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const count = ordered.filter((d) => isFilterSet(filters[d.id])).length;
  const change = (def: SearchFilterDef, value: FilterValue) => setDraft((current) => withFilterValue(current, def.id, value));

  const filtersControl = (
        defs.length > 0 ? <div className="flex gap-0.5">
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className={cn(
              "flex items-center gap-2 rounded-l-lg px-3.5 py-2 text-sm font-semibold transition-[background-color,border-radius] duration-200",
              count > 0 ? "rounded-r" : "rounded-r-lg",
              open ? "bg-text/[.12] text-text" : "bg-text/[.06] text-text/80 hover:bg-text/[.1]",
            )}
          >
            <SlidersHorizontal className="h-4 w-4" strokeWidth={2} />
            {t("search.filters.button")}
            {count > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-bold text-accent-fg">{count}</span>}
          </button>
          <AnimatePresence initial={false}>
            {count > 0 && (
              <motion.button
                key="clear"
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 36 }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: 0.18 }}
                onClick={() => onChange({})}
                aria-label={t("search.filters.reset")}
                title={t("search.filters.reset")}
                className="flex items-center justify-center overflow-hidden rounded-l rounded-r-lg bg-text/[.06] text-text/80 transition-colors hover:bg-text/[.1] hover:text-text"
              >
                <X className="h-4 w-4 shrink-0" strokeWidth={2.25} />
              </motion.button>
            )}
          </AnimatePresence>
        </div> : null
  );

  return (
    <div className={typeof lead === "function" ? "" : "mb-6"}>
      {typeof lead === "function" ? (
        lead(filtersControl)
      ) : (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">{lead}</div>
          <div className="flex shrink-0 items-center gap-2">
            {filtersControl}
            {children}
          </div>
        </div>
      )}

      {/* A drawer over the catalog, not part of it: portaled to <body> below the title bar. Its scrim
          dims the catalog (which reloads live behind it as filters are picked) and closes it. */}
      {createPortal(
        <AnimatePresence>
          {open && (
            <div className="fixed inset-x-0 bottom-0 top-10" style={{ zIndex: layer }}>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                onClick={() => setOpen(false)}
                className="absolute inset-0 bg-black/45"
              />
              <motion.aside
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={{ type: "spring", stiffness: 420, damping: 42 }}
                style={popoverTheme}
                className="absolute inset-y-0 right-0 flex w-[420px] max-w-[92vw] flex-col border-l border-border bg-app-popover shadow-2xl"
              >
                <div className="flex items-center justify-between px-5 pb-2 pt-4">
                  <h2 className="text-base font-bold text-text">{t("search.filters.button")}</h2>
                  <button onClick={() => setOpen(false)} aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-text/[.08] hover:text-text">
                    <X className="h-4 w-4" strokeWidth={2.25} />
                  </button>
                </div>
                <div className="no-scrollbar flex-1 overflow-y-auto px-5 py-3">
                  {loading ? (
                    <p className="py-6 text-center text-sm text-muted">…</p>
                  ) : (
                    <div className="flex flex-col gap-6">
                      {ordered.map((def) =>
                        isLongList(def) ? (
                          <LongList key={def.id} def={def} value={draft[def.id]} onChange={(value) => change(def, value)} />
                        ) : (
                          <FilterSection key={def.id} title={t(`search.filters.${def.id}`, { defaultValue: def.title })}>
                            <FilterControl def={def} value={draft[def.id]} onChange={(value) => change(def, value)} />
                          </FilterSection>
                        ),
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 border-t border-border p-3">
                  <button
                    onClick={() => onChange({})}
                    disabled={count === 0}
                    className="rounded-lg px-3 py-1.5 text-sm font-semibold text-muted transition-colors hover:bg-text/[.06] hover:text-text disabled:opacity-40"
                  >
                    {t("search.filters.reset")}
                  </button>
                  <button onClick={() => setOpen(false)} className="rounded-lg bg-text px-5 py-1.5 text-sm font-bold text-bg transition-opacity hover:opacity-90">
                    {t("search.filters.done")}
                  </button>
                </div>
              </motion.aside>
            </div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}
