import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { Star } from "lucide-react";
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

  const rating = useQuery({
    queryKey: ["rating", sourceId, animeId],
    queryFn: () => hibiki.ratings.get(sourceId, animeId),
  });

  const save = useMutation({
    mutationFn: (value: number | null) => hibiki.ratings.set(sourceId, animeId, value),
    // Written before the source is told, and shown before either finishes: the score is this app's
    // own record, and a slow or signed-out account is no reason to make someone wait to see it.
    onMutate: (value) => {
      queryClient.setQueryData(["rating", sourceId, animeId], value);
      setOpen(false);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["rating", sourceId, animeId] }),
  });

  const current = rating.data ?? null;

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
              className="absolute left-0 top-[52px] z-50 w-max rounded-2xl border border-border bg-surface p-2 shadow-2xl"
            >
              <div className="flex gap-1">
                {Array.from({ length: MAX_RATING }, (_, index) => index + 1).map((value) => (
                  <button
                    key={value}
                    onClick={() => save.mutate(value)}
                    className={cn(
                      "h-9 w-9 rounded-lg text-sm font-bold transition-colors",
                      value === current ? "bg-amber-400/20 text-amber-500 dark:text-amber-300" : "text-muted hover:bg-text/[.08] hover:text-text",
                    )}
                  >
                    {value}
                  </button>
                ))}
              </div>
              {current != null && (
                <button
                  onClick={() => save.mutate(null)}
                  className="mt-1 w-full rounded-lg px-3 py-2 text-xs font-semibold text-muted transition-colors hover:bg-text/[.06] hover:text-text"
                >
                  {t("detail.rating.clear")}
                </button>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
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
