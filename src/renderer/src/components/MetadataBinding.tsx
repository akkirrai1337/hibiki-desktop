import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Globe, RotateCcw, Search, X } from "lucide-react";
import {
  metadataEntryUrl,
  parseMetadataReference,
  PROVIDER_RATING_SOURCE,
  type ExternalMetadata,
  type MetadataProviderId,
} from "@shared/externalMetadata";
import { hibiki } from "@/lib/hibiki";
import { useUiStore } from "@/stores/uiStore";
import { cn } from "@/lib/cn";

/**
 * The title page's own line about where its description came from, and the way to fix it when the
 * matcher got it wrong.
 *
 * It gets one because the matcher guesses: names, years and types are all a source and an
 * aggregator can be compared on, and sequels, recaps and specials share all three often enough
 * that some titles land on the wrong entry. Without a way to correct that, the only recourse is
 * turning the whole feature off.
 */
export function MetadataBinding({ sourceId, animeId }: { sourceId: string; animeId: string }) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const binding = useQuery({
    queryKey: ["metadataMatch", sourceId, animeId],
    queryFn: () => hibiki.metadata.match(sourceId, animeId),
  });

  // No provider may describe this title at all: either the source does not use external metadata,
  // or the user turned it off. That is the only case with nothing to say - an *unmatched* title
  // still needs its line, since a missing match usually means the provider's search could not
  // answer and the manual picker is the way through.
  if (!binding.data || binding.data.providers.length === 0) return null;
  const match = binding.data.match;

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted">
        <Globe className="h-3.5 w-3.5" strokeWidth={2} />
        {match ? (
          <>
            <span>
              {t("detail.metadata.describedBy", { provider: PROVIDER_RATING_SOURCE[match.provider] })}
              {match.manual
                ? ` · ${t("detail.metadata.manual")}`
                : match.confidence != null
                  ? ` · ${t("detail.metadata.confidence", { percent: match.confidence })}`
                  : ""}
            </span>
            <a
              href={metadataEntryUrl(match.provider, match.externalId)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-semibold transition-colors hover:text-text"
            >
              #{match.externalId}
              <ExternalLink className="h-3 w-3" strokeWidth={2.5} />
            </a>
          </>
        ) : (
          <span>{t("detail.metadata.notMatched")}</span>
        )}
        <button onClick={() => setPicking(true)} className="font-semibold transition-colors hover:text-text">
          {t("detail.metadata.change")}
        </button>
      </div>
      <AnimatePresence>
        {picking && <MetadataPicker sourceId={sourceId} animeId={animeId} onClose={() => setPicking(false)} />}
      </AnimatePresence>
    </>
  );
}

function MetadataPicker({ sourceId, animeId, onClose }: { sourceId: string; animeId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const preferredProvider = useUiStore((s) => s.externalMetadataProvider);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A pasted AniList/MAL link (or a bare id) is resolved by id instead of searched for. That is not
  // a shortcut: it is the only path that works while a provider's search endpoint is down, which
  // is the state both were in when this was written.
  const reference = parseMetadataReference(query, preferredProvider);
  const pasted = useQuery({
    queryKey: ["metadataEntry", reference?.provider, reference?.externalId],
    queryFn: () => hibiki.metadata.entry(reference!.provider, reference!.externalId),
    enabled: reference != null,
  });
  const searched = useQuery({
    queryKey: ["metadataSearch", sourceId, submitted],
    queryFn: () => hibiki.metadata.search(sourceId, submitted),
    enabled: submitted.length > 0 && reference == null,
  });

  const bind = useMutation({
    mutationFn: (entry: ExternalMetadata) => hibiki.metadata.setMatch(sourceId, animeId, entry.provider, entry.externalId),
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });
  const reset = useMutation({
    mutationFn: () => hibiki.metadata.clearMatch(sourceId, animeId),
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });

  // The title itself is what changes here, so its own query has to refetch - the binding line is
  // only the label on top of it.
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["metadataMatch", sourceId, animeId] }),
      queryClient.invalidateQueries({ queryKey: ["anime", sourceId, animeId] }),
    ]);
  };

  const results = reference != null ? (pasted.data ? [pasted.data] : []) : (searched.data?.results ?? []);
  const busy = pasted.isFetching || searched.isFetching || bind.isPending || reset.isPending;
  const searchUnavailable = reference == null && searched.data != null && searched.data.searchedProvider == null;
  const noneFound = reference != null ? pasted.isFetched && !pasted.data : searched.data != null && searched.data.searchedProvider != null && results.length === 0;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60] bg-black/50" onClick={onClose} />
      <div className="pointer-events-none fixed inset-0 z-[61] flex items-center justify-center p-6">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ type: "spring", stiffness: 500, damping: 45 }}
          className="pointer-events-auto flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
        >
          <div className="flex items-center gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-text">{t("detail.metadata.pickerTitle")}</p>
              <p className="truncate text-xs text-muted">{t("detail.metadata.pickerHint")}</p>
            </div>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-text/[.06] hover:text-text"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>

          <form
            className="flex items-center gap-2 border-b border-border px-5 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (reference != null) return;
              if (query.trim().length === 0) return;
              setSubmitted(query.trim());
            }}
          >
            <Search className="h-4 w-4 shrink-0 text-muted" strokeWidth={2} />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("detail.metadata.searchPlaceholder")}
              className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-muted"
            />
            {busy && <span className="shrink-0 text-xs text-muted">{t("detail.metadata.searching")}</span>}
          </form>

          <div className="flex flex-col gap-2 overflow-y-auto p-4">
            {searchUnavailable && <p className="py-3 text-center text-xs text-muted">{t("detail.metadata.searchUnavailable")}</p>}
            {noneFound && !searchUnavailable && <p className="py-3 text-center text-xs text-muted">{t("detail.metadata.noneFound")}</p>}
            {results.map((entry) => (
              <button
                key={`${entry.provider}:${entry.externalId}`}
                onClick={() => bind.mutate(entry)}
                disabled={busy}
                className="flex items-center gap-3 rounded-xl border border-border bg-text/[.03] p-2 text-left transition-colors hover:bg-text/[.07] disabled:opacity-60"
              >
                <div className="h-16 w-11 shrink-0 overflow-hidden rounded-md bg-text/[.06]">
                  {entry.posterUrl && <img src={entry.posterUrl} alt="" className="h-full w-full object-cover" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-text">
                    {entry.englishName ?? entry.romajiName ?? entry.nativeName ?? `#${entry.externalId}`}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {[
                      PROVIDER_RATING_SOURCE[entry.provider],
                      entry.year,
                      entry.type,
                      entry.episodeCount ? t("common.episodesShort", { count: entry.episodeCount }) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {entry.romajiName && entry.englishName && entry.romajiName !== entry.englishName && (
                    <p className="truncate text-xs text-muted/70">{entry.romajiName}</p>
                  )}
                </div>
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
            <button
              onClick={() => reset.mutate()}
              disabled={busy}
              className={cn(
                "inline-flex items-center gap-1.5 text-xs font-semibold text-muted transition-colors hover:text-text",
                busy && "opacity-60",
              )}
            >
              <RotateCcw className="h-3.5 w-3.5" strokeWidth={2.5} />
              {t("detail.metadata.reset")}
            </button>
            <ProviderHint provider={preferredProvider} />
          </div>
        </motion.div>
      </div>
    </>,
    document.body,
  );
}

/** Says which provider a bare id would be read as, since the two number spaces are unrelated and
 * pasting a MAL id while AniList is selected would bind a completely different show. */
function ProviderHint({ provider }: { provider: MetadataProviderId }) {
  const { t } = useTranslation();
  return <span className="text-xs text-muted">{t("detail.metadata.idsRead", { provider: PROVIDER_RATING_SOURCE[provider] })}</span>;
}
