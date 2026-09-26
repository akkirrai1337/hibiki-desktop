// Older scripts (most of hibiki-sources today) describe their filters through the fixed vocabulary
// of getSettings() { typeOptions, statusOptions, genreOptions } + manifest.supportedFilters, and
// read them from search() as typeAliases / statusAliases / includedGenreAliases /
// excludedGenreAliases / yearFrom / yearTo.
//
// The host itself no longer knows any of that: it deals only in SearchFilterDef / FilterValues.
// This module is the single place where the old contract is translated to and from the new one, so
// it can be deleted the day the last script declares `filters` itself.
import type { FilterValue, FilterValues, SearchFilterDef, SearchFilterOption } from "@shared/types";

export interface LegacySettings {
  typeOptions?: SearchFilterOption[];
  statusOptions?: SearchFilterOption[];
  genreOptions?: SearchFilterOption[];
}

// Some sources' getSettings() falls back to a hardcoded type list when their live schema fetch
// fails, and that list can include ids the source's own search() rejects (seen in practice:
// YummyAnime's "short_movie"/"short_serial" 400 against its real API).
const UNSUPPORTED_TYPE_IDS = new Set(["short_movie", "short_serial", "short_series"]);

export const LEGACY_FILTER_IDS = { type: "type", status: "status", genres: "genres", year: "year" } as const;
const YEAR_MIN = 1940;

export function legacyOptions(settings: LegacySettings) {
  return {
    type: (settings.typeOptions ?? []).filter((o) => !UNSUPPORTED_TYPE_IDS.has(o.id.toLowerCase())),
    status: settings.statusOptions ?? [],
    genres: settings.genreOptions ?? [],
  };
}

export function legacyToFilterDefs(settings: LegacySettings, supported: string[]): SearchFilterDef[] {
  const options = legacyOptions(settings);
  const defs: SearchFilterDef[] = [];
  if (supported.includes("TYPE") && options.type.length > 0) defs.push({ id: LEGACY_FILTER_IDS.type, title: "type", type: "tristate", options: options.type });
  if (supported.includes("STATUS") && options.status.length > 0) defs.push({ id: LEGACY_FILTER_IDS.status, title: "status", type: "tristate", options: options.status });
  if (supported.includes("INCLUDED_GENRES") && options.genres.length > 0) {
    defs.push({
      id: LEGACY_FILTER_IDS.genres,
      title: "genres",
      type: supported.includes("EXCLUDED_GENRES") ? "tristate" : "multi",
      options: options.genres,
    });
  }
  if (supported.includes("YEAR_RANGE")) {
    defs.push({ id: LEGACY_FILTER_IDS.year, title: "year", type: "range", min: YEAR_MIN, max: new Date().getFullYear() + 1 });
  }
  return defs;
}

function asTristate(value: FilterValue | undefined): { include: string[]; exclude: string[] } {
  if (Array.isArray(value)) return { include: value, exclude: [] };
  if (value && typeof value === "object" && "include" in value) return value;
  return { include: [], exclude: [] };
}

// Type/status never had an "exclude" in the old contract - excluding one meant "include every other
// option", which needs the full option list.
function includeList(all: SearchFilterOption[], value: FilterValue | undefined): string[] | undefined {
  const { include, exclude } = asTristate(value);
  if (include.length > 0) return include;
  if (exclude.length > 0) return all.filter((o) => !exclude.includes(o.id)).map((o) => o.id);
  return undefined;
}

export function filterValuesToLegacy(filters: FilterValues | undefined, settings: LegacySettings): Record<string, unknown> {
  if (!filters) return {};
  const options = legacyOptions(settings);
  const genres = asTristate(filters[LEGACY_FILTER_IDS.genres]);
  const year = filters[LEGACY_FILTER_IDS.year];
  const range = year && typeof year === "object" && !Array.isArray(year) ? (year as { from?: number; to?: number }) : {};
  return {
    typeAliases: includeList(options.type, filters[LEGACY_FILTER_IDS.type]),
    statusAliases: includeList(options.status, filters[LEGACY_FILTER_IDS.status]),
    includedGenreAliases: genres.include.length > 0 ? genres.include : undefined,
    excludedGenreAliases: genres.exclude.length > 0 ? genres.exclude : undefined,
    yearFrom: range.from,
    yearTo: range.to,
  };
}

/** Excluding a type/status has to be turned into "include the others", which needs the option list. */
export function needsOptionList(filters: FilterValues | undefined): boolean {
  if (!filters) return false;
  return [LEGACY_FILTER_IDS.type, LEGACY_FILTER_IDS.status].some((id) => asTristate(filters[id]).exclude.length > 0 && asTristate(filters[id]).include.length === 0);
}
