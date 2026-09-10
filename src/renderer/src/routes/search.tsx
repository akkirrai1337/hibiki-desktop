import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/search")({
  validateSearch: (search: Record<string, unknown>): { q: string; source?: true } => ({
    q: typeof search.q === "string" ? search.q : "",
    source: search.source === true || search.source === "true" ? true : undefined,
  }),
  component: () => null,
});
