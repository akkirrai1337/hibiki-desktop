import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Radio, Search } from "lucide-react";
import { metadataProviderOrder, PROVIDER_RATING_SOURCE, type ExternalMetadata, type MetadataProviderId } from "@shared/externalMetadata";
import type { AnimeTitle, SourceInfo } from "@shared/types";
import { hibiki } from "@/lib/hibiki";
import { useUiStore } from "@/stores/uiStore";
import { ErrorBanner } from "@/components/ErrorBanner";
import { cn } from "@/lib/cn";

/**
 * One provider entry, on its way to something playable.
 *
 * This is the hinge of the aggregator-first catalog (see docs/aggregator-first-catalog.md): a card
 * there names an entry, not a title of a source, so opening one has to find the source's own title
 * before the normal title page can take over. When it does, this screen is never seen - it
 * redirects. When it does not, it is the whole answer to "why can I not watch this", which is why
 * it shows the entry itself rather than an error, and offers the other installed sources and a
 * manual pick instead of a dead end.
 */
export const Route = createFileRoute("/entry/$provider/$externalId")({ component: EntryRoute });

function EntryRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { provider, externalId } = Route.useParams();
  const activeSourceId = useUiStore((s) => s.activeSourceId);
  const sourcesQuery = useQuery({ queryKey: ["sources"], queryFn: () => hibiki.sources.list() });
  const sources = sourcesQuery.data ?? [];
  // Only sources an aggregator is actually allowed to describe take part - the source's own flag
  // *and* the user's answer for it, the same rule the main process applies. Checking the flag alone
  // offered a source the user had switched this off for, and then wrote a match for it.
  // Selected field by field, not as one object: a selector that builds a fresh object every call
  // has no stable snapshot for React to compare, which is a re-render on every unrelated store
  // change at best and a warning at worst.
  const enabled = useUiStore((state) => state.externalMetadataEnabled);
  const overrides = useUiStore((state) => state.externalMetadataOverrides);
  const preferredProvider = useUiStore((state) => state.externalMetadataProvider);
  const fallbackEnabled = useUiStore((state) => state.externalMetadataFallback);
  const preferences = useMemo(
    () => ({ enabled, overrides, provider: preferredProvider, fallbackEnabled }),
    [enabled, overrides, preferredProvider, fallbackEnabled],
  );
  const describedSources = sources.filter(
    (candidate) => metadataProviderOrder(preferences, candidate.id, candidate.useExternalMetadata === true).length > 0,
  );
  const source = describedSources.find((candidate) => candidate.id === activeSourceId) ?? describedSources[0];

  const entryQuery = useQuery({
    queryKey: ["metadataEntry", provider, Number(externalId)],
    queryFn: () => hibiki.metadata.entry(provider as MetadataProviderId, { externalId: Number(externalId) }),
  });
  const entry = entryQuery.data ?? null;

  const resolution = useQuery({
    queryKey: ["resolveSource", source?.id, provider, externalId],
    queryFn: () => hibiki.metadata.resolveSource(source!.id, entry!),
    enabled: !!source && !!entry,
  });

  // A resolved entry never shows this screen: it is a step on the way, not a destination, and
  // `replace` keeps it out of the back stack so leaving the title page goes back to the catalog.
  //
  // In an effect, not in the render body where this started: navigating is a side effect, React
  // runs a component's body speculatively (twice over, in development), and a router asked to
  // navigate from inside a render it is itself driving is a re-entrancy waiting to happen.
  const resolvedSourceId = source?.id;
  const resolvedAnimeId = resolution.data?.animeId;
  useEffect(() => {
    if (!resolvedSourceId || !resolvedAnimeId) return;
    void navigate({
      to: "/anime/$sourceId/$animeId",
      params: { sourceId: resolvedSourceId, animeId: resolvedAnimeId },
      replace: true,
    });
  }, [navigate, resolvedSourceId, resolvedAnimeId]);

  // Still the skeleton while that effect runs, so the screen it is leaving never flashes.
  if (resolvedSourceId && resolvedAnimeId) return <EntrySkeleton />;
  if (entryQuery.isLoading || resolution.isLoading) return <EntrySkeleton />;
  if (entryQuery.isError) return <div className="p-8"><ErrorBanner message={(entryQuery.error as Error).message} /></div>;
  if (!entry) return <div className="p-8"><ErrorBanner message={t("entry.notFound")} /></div>;

  return (
    <div className="min-h-full bg-app-bg px-8 py-8 pb-16">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <EntryHeader entry={entry} />
        <div>
          <h2 className="text-sm font-bold text-text">
            {source ? t("entry.notOnSource", { source: source.name }) : t("entry.noDescribedSources")}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">{t("entry.notOnSourceHint")}</p>
          {describedSources.length > 1 && (
            <div className="mt-4 flex flex-col gap-2">
              {describedSources
                .filter((candidate) => candidate.id !== source?.id)
                .map((candidate) => <OtherSourceRow key={candidate.id} source={candidate} entry={entry} />)}
            </div>
          )}
        </div>
        {source && <ManualPick source={source} entry={entry} />}
      </div>
    </div>
  );
}

function EntryHeader({ entry }: { entry: ExternalMetadata }) {
  const { t } = useTranslation();
  const title = entry.englishName ?? entry.romajiName ?? entry.nativeName ?? `#${entry.externalId}`;
  return (
    <div className="flex gap-6">
      <div className="aspect-[2/3] w-36 shrink-0 overflow-hidden rounded-2xl bg-surface ring-1 ring-border">
        {entry.posterUrl && <img src={entry.posterUrl} alt="" className="h-full w-full object-cover" />}
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-bold tracking-[-.02em] text-text">{title}</h1>
        <p className="mt-1 text-xs text-muted">
          {[PROVIDER_RATING_SOURCE[entry.provider], entry.year, entry.type, entry.episodeCount ? t("common.episodesShort", { count: entry.episodeCount }) : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {entry.description && <p className="mt-4 line-clamp-6 select-text text-sm leading-6 text-muted">{entry.description}</p>}
      </div>
    </div>
  );
}

/** Another installed source, resolved only when asked - a resolution is a search against that
 * source, and doing it for every installed source on arrival would spend several of them to answer
 * a question most people will not ask. */
function OtherSourceRow({ source, entry }: { source: SourceInfo; entry: ExternalMetadata }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tried, setTried] = useState(false);
  const resolve = useMutation({
    mutationFn: () => hibiki.metadata.resolveSource(source.id, entry),
    onSuccess: (resolved) => {
      setTried(true);
      if (resolved) {
        void navigate({ to: "/anime/$sourceId/$animeId", params: { sourceId: source.id, animeId: resolved.animeId }, replace: true });
      }
    },
  });
  return (
    <button
      onClick={() => resolve.mutate()}
      disabled={resolve.isPending}
      className="flex items-center gap-3 rounded-xl border border-border bg-text/[.03] p-3 text-left transition-colors hover:bg-text/[.07] disabled:opacity-60"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-text/[.06]">
        {source.iconUrl ? <img src={source.iconUrl} alt="" className="h-full w-full object-cover" /> : <Radio className="h-3.5 w-3.5 text-muted" strokeWidth={2} />}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{source.name}</span>
      <span className="shrink-0 text-xs text-muted">
        {resolve.isPending ? t("entry.looking") : tried && !resolve.data ? t("entry.notHereEither") : t("entry.tryHere")}
      </span>
    </button>
  );
}

/** The fourth tier of resolution, and not an error path: a source's search results carry a name and
 * often nothing else, so the matcher genuinely cannot decide some of these and the person looking
 * at both lists can. */
function ManualPick({ source, entry }: { source: SourceInfo; entry: ExternalMetadata }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState(entry.romajiName ?? entry.englishName ?? "");
  const [submitted, setSubmitted] = useState("");
  const results = useQuery({
    queryKey: ["sourceSearch", source.id, submitted],
    queryFn: () => hibiki.sources.search(source.id, { query: submitted, limit: 20 }),
    enabled: submitted.length > 0,
  });
  const bind = useMutation({
    mutationFn: async (title: AnimeTitle) => {
      await hibiki.metadata.setSourceTitle(source.id, title.id, entry);
      return title;
    },
    onSuccess: (title) => {
      void navigate({ to: "/anime/$sourceId/$animeId", params: { sourceId: source.id, animeId: title.id }, replace: true });
    },
  });

  return (
    <div>
      <h2 className="text-sm font-bold text-text">{t("entry.pickTitle", { source: source.name })}</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">{t("entry.pickTitleHint")}</p>
      <form
        className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-text/[.03] px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (query.trim().length > 0) setSubmitted(query.trim());
        }}
      >
        <Search className="h-4 w-4 shrink-0 text-muted" strokeWidth={2} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("entry.searchPlaceholder", { source: source.name })}
          className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-muted"
        />
        {results.isFetching && <span className="shrink-0 text-xs text-muted">{t("entry.looking")}</span>}
      </form>
      {results.isError && <ErrorBanner className="mt-3" message={(results.error as Error).message} />}
      {results.data?.length === 0 && <p className="mt-3 text-xs text-muted">{t("entry.nothingFound")}</p>}
      <div className="mt-3 flex flex-col gap-2">
        {(results.data ?? []).map((title) => (
          <button
            key={title.id}
            onClick={() => bind.mutate(title)}
            disabled={bind.isPending}
            className={cn(
              "flex items-center gap-3 rounded-xl border border-border bg-text/[.03] p-2 text-left transition-colors hover:bg-text/[.07]",
              bind.isPending && "opacity-60",
            )}
          >
            <span className="h-14 w-10 shrink-0 overflow-hidden rounded-md bg-text/[.06]">
              {title.posterUrl && <img src={title.posterUrl} alt="" className="h-full w-full object-cover" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-text">
                {title.russianName || title.englishName || title.originalName || title.id}
              </span>
              <span className="block truncate text-xs text-muted">{[title.year, title.type].filter(Boolean).join(" · ")}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function EntrySkeleton() {
  return (
    <div className="min-h-full animate-pulse bg-app-bg px-8 py-8">
      <div className="flex gap-6">
        <div className="aspect-[2/3] w-36 shrink-0 rounded-2xl bg-text/[.06]" />
        <div className="flex-1 pt-1">
          <div className="h-8 w-2/3 rounded bg-text/[.08]" />
          <div className="mt-4 h-3 w-40 rounded bg-text/[.06]" />
          <div className="mt-5 h-3 w-full rounded bg-text/[.06]" />
          <div className="mt-2 h-3 w-4/5 rounded bg-text/[.06]" />
        </div>
      </div>
    </div>
  );
}
