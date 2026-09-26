import { describe, expect, it } from "vitest";
import { filterValuesToLegacy, legacyToFilterDefs } from "./legacyFilters";

const settings = {
  typeOptions: [{ id: "tv", title: "TV" }, { id: "movie", title: "Movie" }, { id: "short_movie", title: "Short" }],
  statusOptions: [{ id: "ongoing", title: "Ongoing" }, { id: "released", title: "Released" }],
  genreOptions: [{ id: "a", title: "A" }, { id: "b", title: "B" }],
};

describe("legacy filter adapter", () => {
  it("offers only what the manifest declares and has options for, minus known-bad type ids", () => {
    const defs = legacyToFilterDefs(settings, ["TYPE", "INCLUDED_GENRES", "YEAR_RANGE"]);
    expect(defs.map((d) => [d.id, d.type])).toEqual([["type", "tristate"], ["genres", "multi"], ["year", "range"]]);
    expect(defs[0].options!.map((o) => o.id)).toEqual(["tv", "movie"]);
  });

  it("makes genres tristate only when the source can exclude them", () => {
    expect(legacyToFilterDefs(settings, ["INCLUDED_GENRES", "EXCLUDED_GENRES"])[0].type).toBe("tristate");
  });

  it("translates values back to the old aliases", () => {
    const request = filterValuesToLegacy(
      { genres: { include: ["a"], exclude: ["b"] }, year: { from: 2015, to: 2016 }, status: { include: ["ongoing"], exclude: [] } },
      settings,
    );
    expect(request).toMatchObject({ includedGenreAliases: ["a"], excludedGenreAliases: ["b"], yearFrom: 2015, yearTo: 2016, statusAliases: ["ongoing"] });
  });

  it("turns a type exclusion into 'every other option'", () => {
    expect(filterValuesToLegacy({ type: { include: [], exclude: ["tv"] } }, settings).typeAliases).toEqual(["movie"]);
  });

  it("sends nothing for an unset filter", () => {
    expect(filterValuesToLegacy(undefined, settings)).toEqual({});
  });
});
