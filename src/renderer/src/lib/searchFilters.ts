import type { TFunction } from "i18next";
import type { SearchFilterOption } from "@shared/types";

// Every axis (type/status/genre) is a uniform 3-state chip: none -> include -> exclude -> none.
// Genres map straight onto includedGenreAliases/excludedGenreAliases (the extension API already
// supports excluding a genre). Type/status have no "excluded" field in SearchRequest at all - so
// "excluding" one there is resolved client-side in toSearchRequestFilters() below, by sending
// every *other* known option as the include list instead.
export interface SearchFilters {
  includedTypes: string[];
  excludedTypes: string[];
  includedStatuses: string[];
  excludedStatuses: string[];
  includedGenres: string[];
  excludedGenres: string[];
  yearFrom: number | null;
  yearTo: number | null;
}

export const EMPTY_SEARCH_FILTERS: SearchFilters = {
  includedTypes: [],
  excludedTypes: [],
  includedStatuses: [],
  excludedStatuses: [],
  includedGenres: [],
  excludedGenres: [],
  yearFrom: null,
  yearTo: null,
};

export function activeFilterCount(f: SearchFilters): number {
  return (
    f.includedTypes.length +
    f.excludedTypes.length +
    f.includedStatuses.length +
    f.excludedStatuses.length +
    f.includedGenres.length +
    f.excludedGenres.length +
    (f.yearFrom !== null || f.yearTo !== null ? 1 : 0)
  );
}

type ChipState = "none" | "include" | "exclude";
type ListKey = "includedTypes" | "excludedTypes" | "includedStatuses" | "excludedStatuses" | "includedGenres" | "excludedGenres";

export function chipState(filters: SearchFilters, id: string, includeKey: ListKey, excludeKey: ListKey): ChipState {
  if (filters[includeKey].includes(id)) return "include";
  if (filters[excludeKey].includes(id)) return "exclude";
  return "none";
}

export function cycleChip(filters: SearchFilters, id: string, includeKey: ListKey, excludeKey: ListKey): SearchFilters {
  const included = filters[includeKey];
  const excluded = filters[excludeKey];
  if (included.includes(id)) return { ...filters, [includeKey]: included.filter((x) => x !== id), [excludeKey]: [...excluded, id] };
  if (excluded.includes(id)) return { ...filters, [excludeKey]: excluded.filter((x) => x !== id) };
  return { ...filters, [includeKey]: [...included, id] };
}

// Type/status have no "excluded" concept in the extension API - an exclusion is turned into
// "include every other known option" before the request goes out.
function resolveAliases(all: SearchFilterOption[], included: string[], excluded: string[]): string[] | undefined {
  if (included.length > 0) return included;
  if (excluded.length > 0) return all.filter((o) => !excluded.includes(o.id)).map((o) => o.id);
  return undefined;
}

export function toSearchRequestFilters(
  filters: SearchFilters,
  catalog: { typeOptions: SearchFilterOption[]; statusOptions: SearchFilterOption[] } | undefined,
) {
  return {
    typeAliases: resolveAliases(filterTypeOptions(catalog?.typeOptions ?? []), filters.includedTypes, filters.excludedTypes),
    statusAliases: resolveAliases(catalog?.statusOptions ?? [], filters.includedStatuses, filters.excludedStatuses),
    includedGenreAliases: filters.includedGenres.length ? filters.includedGenres : undefined,
    excludedGenreAliases: filters.excludedGenres.length ? filters.excludedGenres : undefined,
    yearFrom: filters.yearFrom ?? undefined,
    yearTo: filters.yearTo ?? undefined,
  };
}

export const FILTER_YEAR_MIN = 1940;
export const FILTER_YEAR_MAX = new Date().getFullYear() + 1;

// A lot of sources report id===title for type/status (raw technical aliases like "short_movie"),
// unlike genres which usually come through with real human titles already. These are the same
// short fixed vocabulary across (almost) every source, so they get a translated display label
// (search.filters.typeLabels.* / statusLabels.*) instead of whatever the source titled them -
// "announcement" is normalized to the same key as "announced" since both ids show up in the wild.
export const STATUS_ID_ALIASES: Record<string, string> = { announcement: "announced" };

// Some sources' getSettings() falls back to a hardcoded type list when their live schema fetch
// fails, and that fallback list can include ids the source's own search() doesn't actually accept
// (seen in practice: YummyAnime's "short_movie"/"short_serial" 400 against its real API) - drop
// them from the picker entirely rather than offering a filter that breaks the search.
const UNSUPPORTED_TYPE_IDS = new Set(["short_movie", "short_serial", "short_series"]);

export function filterTypeOptions(options: SearchFilterOption[]): SearchFilterOption[] {
  return options.filter((o) => !UNSUPPORTED_TYPE_IDS.has(o.id.toLowerCase()));
}

function humanize(raw: string): string {
  return raw.split(/[_-]/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

// Falls back to humanizing a raw technical id (snake_case, all lowercase) only - anything that
// already looks like a real display string from the source (mixed case, spaces) is left as-is.
function fallbackLabel(title: string): string {
  if (title === title.toLowerCase() && /^[a-z0-9]+([_-][a-z0-9]+)*$/.test(title)) return humanize(title);
  return title;
}

function prettifyLabel(id: string, title: string, t: TFunction, i18nPrefix: string, idAliases: Record<string, string>): string {
  const normalizedId = idAliases[id.toLowerCase()] ?? id.toLowerCase();
  return t(`${i18nPrefix}.${normalizedId}`, { defaultValue: fallbackLabel(title) });
}

export const prettifyTypeLabel = (id: string, title: string, t: TFunction) => prettifyLabel(id, title, t, "search.filters.typeLabels", {});
export const prettifyStatusLabel = (id: string, title: string, t: TFunction) => prettifyLabel(id, title, t, "search.filters.statusLabels", STATUS_ID_ALIASES);
