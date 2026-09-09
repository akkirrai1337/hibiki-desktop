import { createFileRoute } from "@tanstack/react-router";

const SORT_MODES = ["popularity", "alphabetical", "recent"] as const;

export const Route = createFileRoute("/catalog")({
  validateSearch: (search: Record<string, unknown>) => ({
    sort: SORT_MODES.includes(search.sort as (typeof SORT_MODES)[number]) ? search.sort as (typeof SORT_MODES)[number] : "popularity",
  }),
  component: () => null,
});
