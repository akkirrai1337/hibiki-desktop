import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { usePopoverTheme } from "@/lib/usePopoverTheme";
import {
  EMPTY_SEARCH_FILTERS as EMPTY_DRAFT,
  FILTER_YEAR_MAX,
  FILTER_YEAR_MIN,
  chipState,
  cycleChip,
  filterTypeOptions,
  prettifyStatusLabel,
  prettifyTypeLabel,
  type SearchFilters,
} from "@/lib/searchFilters";
import type { SearchFilterCatalog, SearchFilterKind, SearchFilterOption } from "@shared/types";

// Same grouping the Android app uses for its genre picker - a long flat chip wall is unscannable,
// alphabetical letter headers make it a lot easier to find one genre in a list of 50+.
const COLLAPSED_GENRE_GROUPS = 3;

function groupGenresByLetter(options: SearchFilterOption[]): { letter: string; options: SearchFilterOption[] }[] {
  const byLetter = new Map<string, SearchFilterOption[]>();
  for (const option of options) {
    const letter = (option.title.trim()[0] ?? "#").toUpperCase();
    (byLetter.get(letter) ?? byLetter.set(letter, []).get(letter)!).push(option);
  }
  return [...byLetter.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "ru"))
    .map(([letter, groupOptions]) => ({ letter, options: [...groupOptions].sort((a, b) => a.title.localeCompare(b.title, "ru")) }));
}

export function SearchFiltersPanel({
  anchor,
  supportedFilters,
  catalog,
  loading,
  filters,
  onApply,
  onClose,
}: {
  // Screen coordinates (from getBoundingClientRect) of the search box this panel hangs off of.
  anchor: { left: number; bottom: number };
  supportedFilters: SearchFilterKind[];
  catalog: SearchFilterCatalog | undefined;
  loading: boolean;
  filters: SearchFilters;
  onApply: (filters: SearchFilters) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(filters);
  const popoverTheme = usePopoverTheme();
  useEffect(() => setDraft(filters), [filters]);
  const [genresExpanded, setGenresExpanded] = useState(false);

  const supports = (kind: SearchFilterKind) => supportedFilters.includes(kind);
  const typeOptions = filterTypeOptions(catalog?.typeOptions ?? []);
  const showType = supports("TYPE") && typeOptions.length > 0;
  const showStatus = supports("STATUS") && (catalog?.statusOptions.length ?? 0) > 0;
  const showGenres = supports("INCLUDED_GENRES") && (catalog?.genreOptions.length ?? 0) > 0;
  const showYear = supports("YEAR_RANGE");
  const genreGroups = useMemo(() => groupGenresByLetter(catalog?.genreOptions ?? []), [catalog?.genreOptions]);
  const visibleGenreGroups = genresExpanded ? genreGroups : genreGroups.slice(0, COLLAPSED_GENRE_GROUPS);

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      {/* Framer-motion writes the whole `transform` property inline for its own animation (scale/y),
          which would clobber a translate-based centering transform on the same element - so the
          static horizontal centering lives on this plain wrapper instead, one level up. Portaled
          to document.body (see the anchor prop) rather than positioned relative to the search box
          in the titlebar - a blurred poster background elsewhere in the app can otherwise paint
          over this panel despite a lower z-index, a GPU-compositing quirk with filter: blur()
          that ordinary z-index/isolation can't reliably override. */}
      <div className="fixed z-50 mt-2 w-96 max-w-[calc(100vw-24px)] -translate-x-1/2" style={{ left: anchor.left, top: anchor.bottom }}>
      {/* No `scale` - animating transform:scale() on a panel full of text makes Chromium
          re-rasterize the glyphs at a slightly different subpixel size every frame, reading as
          the text shimmering/shifting while the panel settles in. */}
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ type: "spring", stiffness: 500, damping: 45 }}
        // Paint the selected theme independently of the content behind the popup.
        className="overflow-hidden rounded-2xl border border-border bg-app-popover shadow-2xl"
        style={popoverTheme}
      >
        <div className="no-scrollbar max-h-[60vh] overflow-y-auto p-4">
          {loading ? (
            <p className="py-6 text-center text-sm text-muted">…</p>
          ) : (
            <div className="flex flex-col gap-5">
              {showType && (
                <FilterSection title={t("search.filters.type")}>
                  <ChipRow>
                    {typeOptions.map((opt) => (
                      <FilterChip
                        key={opt.id}
                        state={chipState(draft, opt.id, "includedTypes", "excludedTypes")}
                        onClick={() => setDraft((f) => cycleChip(f, opt.id, "includedTypes", "excludedTypes"))}
                      >
                        {prettifyTypeLabel(opt.id, opt.title, t)}
                      </FilterChip>
                    ))}
                  </ChipRow>
                </FilterSection>
              )}
              {showStatus && (
                <FilterSection title={t("search.filters.status")}>
                  <ChipRow>
                    {catalog!.statusOptions.map((opt) => (
                      <FilterChip
                        key={opt.id}
                        state={chipState(draft, opt.id, "includedStatuses", "excludedStatuses")}
                        onClick={() => setDraft((f) => cycleChip(f, opt.id, "includedStatuses", "excludedStatuses"))}
                      >
                        {prettifyStatusLabel(opt.id, opt.title, t)}
                      </FilterChip>
                    ))}
                  </ChipRow>
                </FilterSection>
              )}
              {showYear && (
                <FilterSection title={t("search.filters.year")}>
                  <YearRangeSlider
                    from={draft.yearFrom}
                    to={draft.yearTo}
                    onChange={(yearFrom, yearTo) => setDraft((f) => ({ ...f, yearFrom, yearTo }))}
                  />
                </FilterSection>
              )}
              {showGenres && (
                <FilterSection title={t("search.filters.genres")}>
                  <div className="flex flex-col gap-3">
                    {visibleGenreGroups.map((group) => (
                      <div key={group.letter}>
                        <p className="mb-1.5 text-xs font-bold text-muted">{group.letter}</p>
                        <ChipRow>
                          {group.options.map((opt) => (
                            <FilterChip
                              key={opt.id}
                              state={chipState(draft, opt.id, "includedGenres", "excludedGenres")}
                              onClick={() => setDraft((f) => cycleChip(f, opt.id, "includedGenres", "excludedGenres"))}
                            >
                              {opt.title}
                            </FilterChip>
                          ))}
                        </ChipRow>
                      </div>
                    ))}
                    {genreGroups.length > COLLAPSED_GENRE_GROUPS && (
                      <button
                        onClick={() => setGenresExpanded((v) => !v)}
                        aria-label={genresExpanded ? t("search.filters.genresCollapse") : t("search.filters.genresExpand")}
                        className="flex items-center justify-center rounded-lg py-1 text-muted transition-colors hover:bg-text/[.06] hover:text-text"
                      >
                        <ChevronDown className={cn("h-4 w-4 transition-transform", genresExpanded && "rotate-180")} strokeWidth={2.25} />
                      </button>
                    )}
                  </div>
                </FilterSection>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border p-3">
          <button onClick={() => setDraft(EMPTY_DRAFT)} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-muted transition-colors hover:bg-text/[.06] hover:text-text">
            {t("search.filters.reset")}
          </button>
          <button onClick={() => onApply(draft)} className="rounded-lg bg-text px-4 py-1.5 text-sm font-bold text-bg transition-opacity hover:opacity-90">
            {t("search.filters.apply")}
          </button>
        </div>
      </motion.div>
      </div>
    </>,
    document.body,
  );
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">{title}</h3>{children}</div>;
}
function ChipRow({ children }: { children: React.ReactNode }) { return <div className="flex flex-wrap gap-1.5">{children}</div>; }

function FilterChip({ state, onClick, children }: { state: "none" | "include" | "exclude"; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        state === "include" && "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/50 dark:bg-emerald-400/10 dark:text-emerald-300",
        state === "exclude" && "border-rose-500/50 bg-rose-500/10 text-rose-700 line-through dark:border-rose-400/50 dark:bg-rose-400/10 dark:text-rose-300",
        state === "none" && "border-border text-muted hover:bg-text/[.06]",
      )}
    >
      {state === "include" && <Plus className="mr-0.5 inline h-2.5 w-2.5 align-[-1px]" strokeWidth={3} />}
      {state === "exclude" && <X className="mr-0.5 inline h-2.5 w-2.5 align-[-1px]" strokeWidth={3} />}
      {children}
    </button>
  );
}

function YearRangeSlider({ from, to, onChange }: { from: number | null; to: number | null; onChange: (from: number | null, to: number | null) => void }) {
  const min = FILTER_YEAR_MIN;
  const max = FILTER_YEAR_MAX;
  const fromValue = from ?? min;
  const toValue = to ?? max;

  return (
    <div className="flex items-center gap-2">
      <YearNumberInput value={from} base={min} onChange={(v) => onChange(v === null ? null : Math.min(v, toValue), to)} />
      <div className="relative h-4 flex-1">
        <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-text/10" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent"
          style={{ left: `${((fromValue - min) / (max - min)) * 100}%`, right: `${100 - ((toValue - min) / (max - min)) * 100}%` }}
        />
        <input
          type="range"
          className="range-thumb-only absolute inset-0 w-full"
          min={min}
          max={max}
          value={fromValue}
          onChange={(e) => onChange(Math.min(Number(e.target.value), toValue), to)}
        />
        <input
          type="range"
          className="range-thumb-only absolute inset-0 w-full"
          min={min}
          max={max}
          value={toValue}
          onChange={(e) => onChange(from, Math.max(Number(e.target.value), fromValue))}
        />
      </div>
      <YearNumberInput value={to} base={max} onChange={(v) => onChange(from, v === null ? null : Math.max(v, fromValue))} />
    </div>
  );
}

function YearNumberInput({ value, base, onChange }: { value: number | null; base: number; onChange: (value: number | null) => void }) {
  function step(delta: number) {
    onChange(Math.min(FILTER_YEAR_MAX, Math.max(FILTER_YEAR_MIN, (value ?? base) + delta)));
  }
  return (
    <div className="flex h-8 w-16 shrink-0 items-stretch overflow-hidden rounded-lg border border-border bg-text/[.04] focus-within:border-accent/70">
      <input
        type="number"
        value={value ?? ""}
        placeholder={String(base)}
        min={FILTER_YEAR_MIN}
        max={FILTER_YEAR_MAX}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") return onChange(null);
          const parsed = Number(raw);
          onChange(Number.isFinite(parsed) ? Math.min(FILTER_YEAR_MAX, Math.max(FILTER_YEAR_MIN, parsed)) : null);
        }}
        className="no-spinner min-w-0 flex-1 bg-transparent pl-1.5 text-center text-xs text-text outline-none"
      />
      <div className="flex w-4 shrink-0 flex-col border-l border-border">
        <button type="button" onClick={() => step(1)} aria-label="+1" className="flex flex-1 items-center justify-center text-muted transition-colors hover:bg-text/[.06] hover:text-text">
          <ChevronUp className="h-2.5 w-2.5" strokeWidth={3} />
        </button>
        <button type="button" onClick={() => step(-1)} aria-label="-1" className="flex flex-1 items-center justify-center border-t border-border text-muted transition-colors hover:bg-text/[.06] hover:text-text">
          <ChevronDown className="h-2.5 w-2.5" strokeWidth={3} />
        </button>
      </div>
    </div>
  );
}
