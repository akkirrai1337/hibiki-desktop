import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AnimatePresence } from "motion/react";
import { ExternalLink, Link2, Loader2, Search, Unlink } from "lucide-react";
import type { TrackerLink, TrackerMedia } from "@shared/types";
import { hibiki } from "@/lib/hibiki";
import { isMobile } from "@/lib/mobile";
import { TRACKING_KEY, isTracking, useTrackerAccount } from "@/lib/tracking";
import { BottomSheet } from "@/components/BottomSheet";
import { Modal } from "@/components/Modal";
import { cn } from "@/lib/cn";

/**
 * Where this title stands on AniList, next to the rating: its status and progress there, or a way
 * to link it. Shown only while signed in - a button for a sync that cannot run would only be noise.
 *
 * The link itself is made in the background (core/tracking) for anything in the library; this is
 * where a person sees what it was matched to, and picks it by hand when the match was not sure
 * enough to make, or was wrong.
 */
export function TrackerLinkButton({ sourceId, animeId, searchName }: { sourceId: string; animeId: string; searchName: string }) {
  const { t } = useTranslation();
  const account = useTrackerAccount();
  const [open, setOpen] = useState(false);
  const tracking = isTracking(account.data);
  const link = useQuery({
    queryKey: [TRACKING_KEY, "anilist", "link", sourceId, animeId],
    queryFn: () => hibiki.tracking.getLink("anilist", sourceId, animeId),
    enabled: tracking,
    staleTime: 30_000,
  });
  if (!tracking || link.isPending) return null;
  const data = link.data ?? null;

  const label = data ? entryLabel(data, t) : t("tracking.link.chipUnlinked");

  const panel = <TrackerLinkPanel link={data} sourceId={sourceId} animeId={animeId} searchName={searchName} onDone={() => setOpen(false)} />;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn(
          "inline-flex h-[46px] items-center gap-2 rounded-xl border px-4 text-sm font-bold transition-colors",
          "mobile:h-7 mobile:gap-1.5 mobile:rounded-full mobile:px-2.5 mobile:text-xs",
          data?.entry
            ? "border-text/20 bg-text/[.08] text-text mobile:border-text/25 mobile:bg-text/[.12]"
            : "border-border bg-text/[.05] text-muted hover:bg-text/[.09] mobile:border-text/15 mobile:bg-text/[.09] mobile:text-text/85",
        )}
      >
        {data ? <span className="text-[11px] font-black tracking-tight mobile:text-[10px]">AL</span> : <Link2 className="h-[18px] w-[18px] mobile:h-3.5 mobile:w-3.5" strokeWidth={2} />}
        <span className="max-w-[16rem] truncate">{label}</span>
      </button>
      {isMobile ? (
        <BottomSheet open={open} onClose={() => setOpen(false)} title={t("tracking.link.dialogTitle")}>
          <div className="px-5 pb-4">{open && panel}</div>
        </BottomSheet>
      ) : (
        <AnimatePresence>
          {open && (
            <Modal onDismiss={() => setOpen(false)}>
              <h2 className="mb-4 text-base font-bold text-text">{t("tracking.link.dialogTitle")}</h2>
              {panel}
            </Modal>
          )}
        </AnimatePresence>
      )}
    </>
  );
}

/** What the account has for it: the status and progress, a favourite (with or without a status),
 * or nothing at all. A favourite on no list is still very much "on" AniList. */
function entryLabel(link: TrackerLink, t: (key: string) => string): string {
  const parts = link.entry?.status ? [t(`tracking.status.${link.entry.status}`), progressLabel(link)] : [];
  if (link.entry?.favourite) parts.push(t("tracking.link.favourite"));
  const label = parts.filter(Boolean).join(" · ");
  return label || t("tracking.link.notOnList");
}

function progressLabel(link: TrackerLink): string | null {
  const progress = link.entry?.progress ?? 0;
  if (progress <= 0 && !link.media.episodes) return null;
  return link.media.episodes ? `${progress}/${link.media.episodes}` : String(progress);
}

function TrackerLinkPanel({ link, sourceId, animeId, searchName, onDone }: {
  link: TrackerLink | null;
  sourceId: string;
  animeId: string;
  searchName: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [choosing, setChoosing] = useState(!link);
  const linkKey = [TRACKING_KEY, "anilist", "link", sourceId, animeId];
  const save = useMutation({
    mutationFn: (mediaId: number | null) => hibiki.tracking.setLink("anilist", sourceId, animeId, mediaId),
    onSuccess: (result, mediaId) => {
      queryClient.setQueryData(linkKey, result);
      if (mediaId == null) onDone();
      else setChoosing(false);
    },
  });

  return (
    <div>
      {link && !choosing && (
        <>
          <MediaCard media={link.media} caption={link.linkedBy === "user" ? t("tracking.link.linkedUser") : t("tracking.link.linkedAuto")} />
          <p className="mt-3 text-sm font-semibold text-text">
            {entryLabel(link, t)}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <a href={link.media.url} target="_blank" rel="noreferrer" className={SECONDARY_BUTTON}>
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={2} />
              {t("tracking.link.open")}
            </a>
            <button onClick={() => setChoosing(true)} className={SECONDARY_BUTTON}>
              <Search className="h-3.5 w-3.5" strokeWidth={2} />
              {t("tracking.link.change")}
            </button>
            <button onClick={() => save.mutate(null)} disabled={save.isPending} className={cn(SECONDARY_BUTTON, "text-rose-500 hover:text-rose-500")}>
              <Unlink className="h-3.5 w-3.5" strokeWidth={2} />
              {t("tracking.link.unlink")}
            </button>
          </div>
        </>
      )}
      {choosing && (
        <>
          {!link && <p className="mb-3 text-xs leading-relaxed text-muted">{t("tracking.link.none")}</p>}
          <MediaSearch
            initialQuery={searchName}
            currentId={link?.media.id ?? null}
            busy={save.isPending}
            onPick={(media) => save.mutate(media.id)}
          />
        </>
      )}
      {save.error && <p className="mt-3 select-text text-xs text-rose-500">{save.error instanceof Error ? save.error.message : String(save.error)}</p>}
    </div>
  );
}

const SECONDARY_BUTTON = "inline-flex items-center gap-1.5 rounded-lg bg-text/[.07] px-3 py-1.5 text-xs font-semibold text-text transition-colors hover:bg-text/[.12] disabled:opacity-50 mobile:rounded-full mobile:px-3.5 mobile:py-2";

function MediaCard({ media, caption }: { media: TrackerMedia; caption?: string }) {
  const { t } = useTranslation();
  const facts = [media.year, media.format?.replace("_", " "), media.episodes ? t("tracking.link.episodes", { count: media.episodes }) : null].filter(Boolean);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="aspect-[2/3] w-11 shrink-0 overflow-hidden rounded-md bg-text/10">
        {media.coverUrl && <img src={media.coverUrl} alt="" className="h-full w-full object-cover" />}
      </div>
      <div className="min-w-0">
        <p className="line-clamp-2 text-sm font-semibold leading-snug text-text">{media.title}</p>
        {media.altTitle && <p className="truncate text-xs text-muted">{media.altTitle}</p>}
        <p className="mt-0.5 truncate text-xs text-muted">{[...facts, caption].filter(Boolean).join(" · ")}</p>
      </div>
    </div>
  );
}

function MediaSearch({ initialQuery, currentId, busy, onPick }: { initialQuery: string; currentId: number | null; busy: boolean; onPick: (media: TrackerMedia) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery.trim());
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [text]);
  const results = useQuery({
    queryKey: [TRACKING_KEY, "anilist", "search", query],
    queryFn: () => hibiki.tracking.search("anilist", query),
    enabled: query.length >= 2,
    staleTime: 5 * 60_000,
  });

  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" strokeWidth={2} />
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("tracking.link.search")}
          className="select-text h-9 w-full rounded-lg bg-text/[.06] pl-9 pr-9 text-sm text-text outline-none ring-1 ring-transparent placeholder:text-muted focus:ring-accent/50 mobile:h-10 mobile:rounded-xl"
        />
        {(results.isFetching || busy) && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted" strokeWidth={2} />}
      </div>
      <div className="mt-2 max-h-[22rem] space-y-0.5 overflow-y-auto mobile:max-h-none">
        {results.data?.map((media) => (
          <button
            key={media.id}
            onClick={() => onPick(media)}
            disabled={busy}
            className={cn("w-full rounded-lg p-2 text-left transition-colors hover:bg-text/[.06] active:bg-text/[.08] disabled:opacity-50", media.id === currentId && "bg-text/[.06]")}
          >
            <MediaCard media={media} />
          </button>
        ))}
        {results.data?.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted">{t("tracking.link.noResults")}</p>}
      </div>
    </div>
  );
}
