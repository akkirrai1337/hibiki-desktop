import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { Star } from "lucide-react";
import type { RatingSyncResult } from "@shared/types";
import { hibiki } from "@/lib/hibiki";
import { cn } from "@/lib/cn";

// Every source here scores out of ten, and so does every aggregator once its own scale is
// normalized (see shared/externalMetadata.ts) - so this is the app's scale too, not a per-source
// one to be discovered at runtime.
const MAX_RATING = 10;

/**
 * The user's own score for a title, next to the library button.
 *
 * Kept apart from the library on purpose, down to its own table: rating something is not a reason
 * to file it under a status, and dropping it from a list is not a reason to forget the score. It is
 * pushed to the source's account when that source syncs libraries and the title's place in them is
 * known - main decides that, since only it can see both sides (see ipc/library.ts).
 */
export function RatingButton({ sourceId, animeId }: { sourceId: string; animeId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);

  const rating = useQuery({
    queryKey: ["rating", sourceId, animeId],
    queryFn: () => hibiki.ratings.get(sourceId, animeId),
  });

  // What became of the last score sent - a rating always lands locally, and whether it reached the
  // account is the part worth saying out loud.
  const [sync, setSync] = useState<RatingSyncResult | null>(null);

  const save = useMutation({
    mutationFn: (value: number | null) => hibiki.ratings.set(sourceId, animeId, value),
    // Written before the source is told, and shown before either finishes: the score is this app's
    // own record, and a slow or signed-out account is no reason to make someone wait to see it.
    onMutate: (value) => {
      queryClient.setQueryData(["rating", sourceId, animeId], value);
      setOpen(false);
      setHovered(null);
    },
    onSuccess: (result, value) => setSync(value == null ? null : result),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["rating", sourceId, animeId] }),
  });

  const current = rating.data ?? null;
  // What the panel is currently talking about: the star under the pointer, or the saved score.
  const shown = hovered ?? current;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex h-[46px] items-center gap-2 rounded-xl border px-4 text-sm font-bold transition-colors",
          current != null
            ? "border-amber-400/40 bg-amber-400/15 text-amber-500 dark:text-amber-300"
            : "border-border bg-text/[.05] text-muted hover:bg-text/[.09]",
        )}
        aria-label={t("detail.rating.rate")}
      >
        <Star className={cn("h-[18px] w-[18px]", current != null && "fill-current")} strokeWidth={2} />
        {current != null ? current : t("detail.rating.rate")}
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
              className="absolute left-0 top-[52px] z-50 w-max rounded-2xl border border-border bg-surface p-3 shadow-2xl"
              onMouseLeave={() => setHovered(null)}
            >
              {/* The number being considered, said out loud. Ten bare buttons gave no answer to
                  "what does a 7 mean here", and the row below reads as a scale only once something
                  names its ends. */}
              <div className="mb-2 flex items-baseline gap-2 px-1">
                <span className={cn("text-2xl font-bold leading-none tabular-nums", shown == null ? "text-muted/50" : toneText(shown))}>
                  {shown ?? "–"}
                </span>
                <span className="text-xs font-semibold text-muted">
                  {shown == null ? t("detail.rating.pick") : t(`detail.rating.labels.${shown}`)}
                </span>
              </div>

              <div className="flex gap-0.5">
                {Array.from({ length: MAX_RATING }, (_, index) => index + 1).map((value) => {
                  // Filled up to whatever is being considered - the hovered value while a pointer is
                  // in the row, the saved one otherwise. A rating scale that only lights the single
                  // number under the cursor reads as ten separate choices rather than one scale.
                  const filled = shown != null && value <= shown;
                  return (
                    <button
                      key={value}
                      onMouseEnter={() => setHovered(value)}
                      onFocus={() => setHovered(value)}
                      onClick={() => save.mutate(value)}
                      aria-label={String(value)}
                      className="group/star flex h-9 w-7 items-end justify-center rounded-md pb-1 transition-colors hover:bg-text/[.06]"
                    >
                      <Star
                        className={cn(
                          "h-[18px] w-[18px] transition-[color,transform] duration-150",
                          filled ? cn(toneText(shown!), "fill-current") : "text-muted/40",
                          "group-hover/star:scale-110",
                        )}
                        strokeWidth={2}
                      />
                    </button>
                  );
                })}
              </div>

              <div className="mt-2 flex items-center justify-between gap-4 border-t border-border pt-2">
                <span className="px-1 text-[11px] text-muted">
                  {current == null
                    ? t("detail.rating.notRated")
                    : sync && !sync.synced
                      ? t(`detail.rating.localOnly.${sync.reason ?? "failed"}`)
                      : t("detail.rating.yours", { rating: current })}
                </span>
                {current != null && (
                  <button
                    onClick={() => save.mutate(null)}
                    className="rounded-lg px-2 py-1 text-[11px] font-semibold text-muted transition-colors hover:bg-rose-500/10 hover:text-rose-400"
                  >
                    {t("detail.rating.clear")}
                  </button>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A score's own colour: the same three-band reading every ratings site uses, so the row says
 * roughly what it thinks before the label is read. */
function toneText(value: number): string {
  if (value <= 3) return "text-rose-400";
  if (value <= 6) return "text-amber-400";
  return "text-emerald-400";
}

/** The scores a source reports for a title - its own, and whichever other sites it republishes.
 * Read-only: they are the crowd's answer, not this viewer's, which is what the button above is. */
export function SourceRatings({ ratings }: { ratings: { source: string; value: number; votes?: number | null }[] }) {
  const { t } = useTranslation();
  if (ratings.length === 0) return null;
  return (
    <>
      {ratings.slice(0, 3).map((rating) => (
        <span key={rating.source} className="flex items-center gap-1" title={rating.votes ? t("detail.rating.votes", { count: rating.votes }) : undefined}>
          <Star className="h-3 w-3 fill-current text-amber-400" strokeWidth={0} />
          <span className="font-semibold text-text/80">{formatRating(rating.value)}</span>
          <span>{rating.source}</span>
        </span>
      ))}
    </>
  );
}

function formatRating(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
}
