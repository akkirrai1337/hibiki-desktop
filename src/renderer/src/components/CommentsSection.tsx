import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { CornerDownRight, Heart, MessageSquare, UserRound } from "lucide-react";
import type { SourceComment, SourceInfo } from "@shared/types";
import { hibiki } from "@/lib/hibiki";
import { ErrorBanner } from "@/components/ErrorBanner";
import { cn } from "@/lib/cn";

/**
 * A title's comments, from the source itself.
 *
 * Everything below the network was already in place - the extension contract has listComments and
 * postComment, YummyAnime implements both, and main already forwards them - and nothing in the app
 * ever showed them. This is that screen.
 *
 * Reading needs no account and posting does, which is the source's rule, not this component's: it
 * asks for an account only where one is required, so a signed-out visitor still gets the thread.
 */
export function CommentsSection({ source, animeId }: { source: SourceInfo; animeId: string }) {
  const { t } = useTranslation();
  const sourceId = source.id;
  const hasComments = source.capabilities.includes("COMMENTS");

  // Same key the source settings dialog signs in and out under, so this section knows about it the
  // moment that happens rather than a refetch later.
  const account = useQuery({
    queryKey: ["sourceAccount", sourceId],
    queryFn: () => hibiki.sources.account.get(sourceId),
    enabled: hasComments && source.capabilities.includes("ACCOUNT"),
  });

  const thread = useInfiniteQuery({
    queryKey: ["comments", sourceId, animeId],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => hibiki.sources.comments.list(sourceId, { animeId, offset: pageParam }),
    // The source decides its own page size, and says it is done by answering with nothing - so the
    // next offset is however many have arrived, not a page count times a size this end guessed.
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === 0 ? undefined : allPages.reduce((count, page) => count + page.length, 0),
    enabled: hasComments,
  });

  if (!hasComments) return null;

  const comments = thread.data?.pages.flat() ?? [];

  return (
    <section className="px-8 pt-10">
      <h2 className="mb-4 flex items-center gap-2 text-xl font-bold tracking-[-.02em] text-text">
        <MessageSquare className="h-[18px] w-[18px] text-muted" strokeWidth={2} />
        {t("detail.comments.title")}
      </h2>

      {account.data ? (
        <Composer sourceId={sourceId} animeId={animeId} />
      ) : (
        source.capabilities.includes("ACCOUNT") && (
          <p className="mb-6 text-sm text-muted">
            {t("detail.comments.signInHint")}{" "}
            <Link to="/sources" className="font-semibold text-accent-text hover:underline">
              {t("nav.sources")}
            </Link>
          </p>
        )
      )}

      {thread.isError && <ErrorBanner message={(thread.error as Error).message} />}
      {thread.isPending && <CommentsSkeleton />}
      {!thread.isPending && comments.length === 0 && !thread.isError && (
        <p className="py-6 text-sm text-muted">{t("detail.comments.empty")}</p>
      )}

      <div className="flex flex-col gap-5">
        {comments.map((comment) => (
          <Comment key={comment.id} comment={comment} sourceId={sourceId} animeId={animeId} canReply={!!account.data} />
        ))}
      </div>

      {thread.hasNextPage && (
        <button
          onClick={() => thread.fetchNextPage()}
          disabled={thread.isFetchingNextPage}
          className="mt-6 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold text-text/80 transition-colors hover:bg-text/[.06] hover:text-text disabled:opacity-60"
        >
          {thread.isFetchingNextPage ? t("detail.comments.loading") : t("detail.comments.loadMore")}
        </button>
      )}
    </section>
  );
}

function Comment({
  comment,
  sourceId,
  animeId,
  canReply,
  isReply = false,
}: {
  comment: SourceComment;
  sourceId: string;
  animeId: string;
  canReply: boolean;
  isReply?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [repliesOpen, setRepliesOpen] = useState(false);
  const [replying, setReplying] = useState(false);

  // Replies are their own request, made only when someone asks for them: a thread page already
  // carries the count, and fetching every branch of every comment up front would be one request per
  // comment for branches most people never open.
  const replies = useQuery({
    queryKey: ["comments", sourceId, animeId, comment.id],
    queryFn: () => hibiki.sources.comments.list(sourceId, { animeId, parentId: comment.id }),
    enabled: repliesOpen,
  });

  return (
    <article className={cn("flex gap-3", isReply && "ml-6")}>
      <Avatar name={comment.authorName} url={comment.authorAvatarUrl} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-text">{comment.authorName}</span>
          <span className="shrink-0 text-xs text-muted">
            {new Date(comment.createdAt).toLocaleDateString(i18n.language, { day: "numeric", month: "short", year: "numeric" })}
          </span>
          {/* One number, because that is what the source reports: likes minus dislikes, with no way
              to vote from here - the contract has no call for it. */}
          {comment.likes != null && comment.likes !== 0 && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
              <Heart className="h-3 w-3" strokeWidth={2.5} />
              {comment.likes}
            </span>
          )}
        </div>
        <p className="mt-1 select-text whitespace-pre-wrap text-sm leading-relaxed text-text/90">{comment.text}</p>

        <div className="mt-1.5 flex items-center gap-4">
          {canReply && (
            <button
              onClick={() => setReplying((open) => !open)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-muted transition-colors hover:text-text"
            >
              <CornerDownRight className="h-3 w-3" strokeWidth={2.5} />
              {t("detail.comments.reply")}
            </button>
          )}
          {(comment.replyCount ?? 0) > 0 && (
            <button
              onClick={() => setRepliesOpen((open) => !open)}
              className="text-xs font-semibold text-muted transition-colors hover:text-text"
            >
              {repliesOpen
                ? t("detail.comments.hideReplies")
                : t("detail.comments.showReplies", { count: comment.replyCount ?? 0 })}
            </button>
          )}
        </div>

        {replying && (
          <Composer
            sourceId={sourceId}
            animeId={animeId}
            parentId={comment.id}
            compact
            onPosted={() => {
              setReplying(false);
              setRepliesOpen(true);
            }}
          />
        )}

        {repliesOpen && (
          <div className="mt-4 flex flex-col gap-4 border-l border-border pl-1">
            {replies.isPending && <p className="text-xs text-muted">{t("detail.comments.loading")}</p>}
            {replies.isError && <ErrorBanner message={(replies.error as Error).message} />}
            {(replies.data ?? []).map((reply) => (
              <Comment key={reply.id} comment={reply} sourceId={sourceId} animeId={animeId} canReply={canReply} isReply />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function Composer({
  sourceId,
  animeId,
  parentId,
  compact = false,
  onPosted,
}: {
  sourceId: string;
  animeId: string;
  parentId?: string;
  compact?: boolean;
  onPosted?: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");

  const post = useMutation({
    mutationFn: () => hibiki.sources.comments.post(sourceId, { animeId, text: text.trim(), parentId: parentId ?? null }),
    onSuccess: async () => {
      setText("");
      // Refetched rather than spliced in: the source assigns the id, the timestamp and the author
      // name, and a locally invented row would differ from the one everyone else sees.
      await queryClient.invalidateQueries({ queryKey: ["comments", sourceId, animeId] });
      onPosted?.();
    },
  });

  const canSubmit = text.trim().length > 0 && !post.isPending;

  return (
    <form
      className={cn("mb-6", compact && "mb-0 mt-3")}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) post.mutate();
      }}
    >
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={compact ? 2 : 3}
        placeholder={t(parentId ? "detail.comments.replyPlaceholder" : "detail.comments.placeholder")}
        className="w-full resize-y rounded-xl border border-border bg-text/[.03] px-3 py-2.5 text-sm text-text outline-none transition-colors placeholder:text-muted focus:border-accent/70"
      />
      {post.isError && <ErrorBanner className="mt-2" message={(post.error as Error).message} />}
      <div className="mt-2 flex justify-end">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-accent-fg transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
        >
          {post.isPending ? t("detail.comments.posting") : t("detail.comments.post")}
        </button>
      </div>
    </form>
  );
}

function Avatar({ name, url }: { name: string; url?: string | null }) {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-text/[.07]">
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : name ? (
        <span className="text-sm font-bold text-muted">{name.slice(0, 1).toUpperCase()}</span>
      ) : (
        <UserRound className="h-4 w-4 text-muted" strokeWidth={2} />
      )}
    </div>
  );
}

function CommentsSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex animate-pulse gap-3">
          <div className="h-9 w-9 shrink-0 rounded-full bg-text/[.06]" />
          <div className="flex-1">
            <div className="h-3.5 w-32 rounded bg-text/[.07]" />
            <div className="mt-2.5 h-3 w-full rounded bg-text/[.05]" />
            <div className="mt-1.5 h-3 w-3/5 rounded bg-text/[.05]" />
          </div>
        </div>
      ))}
    </div>
  );
}
