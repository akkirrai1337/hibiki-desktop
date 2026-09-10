import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AnimatePresence, motion } from "motion/react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Play, Bookmark, Check, ChevronDown, Clock, Download, Eraser, Eye, Heart, Pause, Trash2, TriangleAlert, X } from "lucide-react";
import { metadataProviderOrder } from "@shared/externalMetadata";
import { CommentsSection } from "@/components/CommentsSection";
import { RatingButton, SourceRatings } from "@/components/RatingButton";
import { MetadataBinding } from "@/components/MetadataBinding";
import { hibiki } from "@/lib/hibiki";
import { findListedTitle } from "@/lib/listedTitles";
import { usePlaybackGroups } from "@/lib/playbackGroups";
import { animeTitle } from "@/components/AnimeCard";
import { GroupDropdown } from "@/components/GroupDropdown";
import { HorizontalScrollRow } from "@/components/HorizontalScrollRow";
import { SmoothImage } from "@/components/SmoothImage";
import { cn } from "@/lib/cn";
import { ASSIGNABLE_LIBRARY_CATEGORIES, LIBRARY_CATEGORY_ICONS, LIBRARY_CATEGORY_LABEL_KEYS } from "@/lib/libraryCategories";
import { STATUS_ID_ALIASES } from "@/lib/searchFilters";
import { episodeFavoriteKey, useEpisodeFavoritesStore } from "@/stores/episodeFavoritesStore";
import { useUiStore } from "@/stores/uiStore";
import type { AnimeTitle, DownloadProgress, Episode, LibraryCategory, PlaybackGroup, PlayerLink, RelatedAnimeTitle, WatchProgress } from "@shared/types";

// How long a terminal download state (done/error/unsupported) stays shown on the chip before it
// reverts back to the normal play affordance - long enough to actually read, short enough not to
// linger as stale-looking state on a chip you've since moved on from.
const DOWNLOAD_RESULT_DISPLAY_MS = 4000;

export const Route = createFileRoute("/anime/$sourceId/$animeId")({
  // Kept in the URL (like /catalog's `sort`) rather than component state - so the chosen
  // dubbing/translation group survives leaving for an episode and coming back, instead of
  // quietly resetting to the first group on remount.
  validateSearch: (search: Record<string, unknown>): { group?: string | null } => ({
    group: typeof search.group === "string" ? search.group : null,
  }),
  component: AnimeDetailPage,
});

interface ContinueTarget {
  episode: Episode;
  label: string;
}

/** Picks what the "Watch"/"Continue" button should point to, given saved progress. */
function resolveContinue(group: PlaybackGroup | undefined, progressByEpisode: Map<string, WatchProgress>, t: TFunction): ContinueTarget | null {
  if (!group || group.episodes.length === 0) return null;
  const withProgress = group.episodes.map((ep) => ({ ep, progress: progressByEpisode.get(ep.id) }));

  const inProgress = withProgress
    .filter((x) => x.progress && !x.progress.watched)
    .sort((a, b) => b.progress!.updatedAt - a.progress!.updatedAt)[0];
  if (inProgress) {
    const remainingMs = Math.max(0, inProgress.progress!.durationMs - inProgress.progress!.positionMs);
    const minutes = Math.round(remainingMs / 60000);
    return { episode: inProgress.ep, label: minutes > 0 ? t("detail.continueRemaining", { minutes }) : t("detail.continueLessThanMinute") };
  }

  const anyWatched = withProgress.some((x) => x.progress?.watched);
  const nextUnwatched = withProgress.find((x) => !x.progress?.watched);
  if (nextUnwatched) return { episode: nextUnwatched.ep, label: anyWatched ? t("detail.continueNext", { number: nextUnwatched.ep.number }) : t("detail.watch") };

  return { episode: withProgress[0].ep, label: t("detail.rewatch") };
}

/** Mirrors Android's next-episode countdown on the title page: today/tomorrow/"in N days"/a date. */
function formatNextEpisode(epochMs: number, t: TFunction, locale: string): string {
  // Calendar-day difference, not a raw ms/86400000 divide - a source only ever knows the *day* an
  // episode airs (not the hour), so comparing actual calendar dates is what keeps "today" reading
  // as "today" all day long instead of flipping to "tomorrow" once less than 24h of wall-clock
  // time happens to remain, or dropping out of the "future" check entirely once its clock ticks
  // past midnight on the day itself.
  const target = new Date(epochMs);
  const now = new Date();
  const days = Math.round(
    (Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000,
  );
  if (days <= 0) return t("detail.nextEpisodeToday");
  if (days === 1) return t("detail.nextEpisodeTomorrow");
  if (days < 7) return t("detail.nextEpisodeInDays", { count: days });
  return t("detail.nextEpisodeOn", { date: target.toLocaleDateString(locale, { day: "numeric", month: "short" }) });
}

/** True unless `epochMs` is a calendar day strictly before today - i.e. "still worth showing". */
function isUpcomingDay(epochMs: number): boolean {
  const target = new Date(epochMs);
  const now = new Date();
  return Date.UTC(target.getFullYear(), target.getMonth(), target.getDate()) >= Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

// Same "6 full + a peek of the 7th" ratio the old hand-rolled version used (60px = 6 gaps of
// gap-2.5/0.625rem, for a row that shows 7 cards' worth of width) - just expressed as a plain
// Tailwind width class, like HorizontalScrollRow's other callers, instead of a CSS custom property.
const RELATED_CARD_WIDTH_CLASSES = "w-[calc((100%-6*0.625rem)/6.2)]";

// Both "other titles" sections of this page: "Связанные тайтлы" (franchiseAnime/relatedAnime, a
// compact strip next to the watch/library actions) and "Похожие тайтлы" (similarAnime, under the
// episode list). They used to be a strip and a full AnimeCard grid, which made a page that says the
// same kind of thing twice look like it says two different kinds of thing; one arrow-scrolled row
// each reads as one page. Only the heading and the surrounding spacing differ, and the current
// title is marked in place, which only the related strip ever contains.
function TitleStrip({ items, sourceId, currentAnimeId, heading }: { items: RelatedAnimeTitle[]; sourceId: string; currentAnimeId?: string; heading: React.ReactNode }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;

  return <div>
    {heading}
    <HorizontalScrollRow
      items={items}
      getKey={(item) => item.id}
      cardWidthClassName={RELATED_CARD_WIDTH_CLASSES}
      renderItem={(item) => {
        const isCurrent = item.id === currentAnimeId;
        // Not a checkmark - that reads as "watched", which this isn't saying. This is just "you
        // are here": a plain eye badge + a desaturated, slightly dimmed cover (not an accent
        // highlight, since it isn't a call to action - the rest of the row is what's clickable).
        // The cover frame itself stays put and the poster zooms inside it, matching AnimeCard's own
        // hover (see AnimeCard) - scaling the whole frame instead made this strip read as a
        // different kind of card than every other poster in the app.
        const cover = <div className="relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-surface ring-1 ring-border">
          {item.posterUrl ? <SmoothImage src={item.posterUrl} alt={item.title} className={cn("h-full w-full transition-transform duration-500 ease-out", isCurrent ? "opacity-50 grayscale" : "group-hover:scale-[1.035] group-hover:will-change-transform")} /> : null}
          {isCurrent && <div className="absolute bottom-1 left-1 flex items-center gap-0.5 rounded bg-black/75 px-1 py-0.5">
            <Eye className="h-2.5 w-2.5 text-white/80" strokeWidth={2.5} />
          </div>}
          {/* The same hover reveal AnimeCard uses in every poster grid: the cover darkens
              under a bottom-up gradient and the title rises into it. Skipped on the current title -
              nothing there is a link, so a hover affordance would be promising an action that
              doesn't exist. Kept off the label below too, which stays clipped to two lines: this
              overlay is where a long title actually gets read. */}
          {!isCurrent && <>
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 translate-y-1.5 p-2 opacity-0 transition-[opacity,transform] duration-300 group-hover:translate-y-0 group-hover:opacity-100">
              <p className="line-clamp-3 text-xs font-semibold leading-snug text-white">{item.title}</p>
            </div>
          </>}
        </div>;
        const label = <p className={cn("mt-1.5 line-clamp-2 w-full text-xs leading-snug", isCurrent ? "text-muted" : "text-muted group-hover:text-text")}>{item.title}</p>;
        return isCurrent
          ? <div className="min-w-0" title={t("detail.relatedCurrentTitle")}>{cover}{label}</div>
          : <Link to="/anime/$sourceId/$animeId" params={{ sourceId, animeId: item.id }} className="group block min-w-0">{cover}{label}</Link>;
      }}
    />
  </div>;
}

function AnimeDetailPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sourceId, animeId } = Route.useParams();
  const { group: requestedGroupId } = Route.useSearch();
  // A gradient "app background" theme (see lib/theme.ts) and this page's own blurred-poster
  // backdrop below both want to own the same real estate - showing both at once just looks like
  // clutter, one fighting the other for attention instead of either reading clearly. Once a theme
  // is active, this page falls back to the same translucent bg-app-bg every other page already
  // uses, letting the app-wide gradient bleed through consistently instead.
  const backgroundTheme = useUiStore((s) => s.backgroundTheme);
  const [downloadEpisode, setDownloadEpisode] = useState<Episode | null>(null);
  const queryClient = useQueryClient();
  // Arriving here almost always means a card was clicked, and that card's list already carried
  // this title - the same AnimeTitle shape getById returns, with fewer fields filled in and none
  // contradicting it (see lib/listedTitles). Drawing it while getById is in flight replaces a
  // skeleton with the real poster, name, description and genres immediately.
  //
  // placeholderData, not setQueryData: a placeholder is never mistaken for fetched data, so
  // getById still runs and fills in the episode list, studios and related titles. Seeding the
  // cache instead would leave the page permanently missing the very things it exists to show.
  const animeQuery = useQuery({
    queryKey: ["anime", sourceId, animeId],
    queryFn: () => hibiki.sources.getById(sourceId, animeId),
    placeholderData: () =>
      findListedTitle(
        queryClient.getQueryCache().getAll().map((entry) => entry.state.data),
        sourceId,
        animeId,
      ),
  });
  // Whether this page's title is going to be described by a metadata provider - which decides
  // whether the placeholder above is worth showing at all. When it is, the placeholder is the
  // source's own poster and name, and the real fetch replaces both a moment later; a skeleton until
  // then is steadier than watching the page rewrite itself. The same three inputs the main process
  // uses, so the two never disagree about it.
  const sourcesQuery = useQuery({ queryKey: ["sources"], queryFn: () => hibiki.sources.list() });
  // This page's own source, for the two things that are about the site rather than the title:
  // whether a provider describes it, and whether it has comments.
  const source = sourcesQuery.data?.find((candidate) => candidate.id === sourceId);
  const externalMetadataEnabled = useUiStore((s) => s.externalMetadataEnabled);
  const externalMetadataOverrides = useUiStore((s) => s.externalMetadataOverrides);
  const externalMetadataProvider = useUiStore((s) => s.externalMetadataProvider);
  const externalMetadataFallback = useUiStore((s) => s.externalMetadataFallback);
  const describesTitles = metadataProviderOrder(
    { enabled: externalMetadataEnabled, overrides: externalMetadataOverrides, provider: externalMetadataProvider, fallbackEnabled: externalMetadataFallback },
    sourceId,
    source?.useExternalMetadata === true,
  ).length > 0;
  // dataUpdatedAt stays 0 for placeholder data, so this is "the real fetch has not landed yet".
  const describing = describesTitles && animeQuery.dataUpdatedAt === 0 && !animeQuery.isError;

  const groupsQuery = usePlaybackGroups(sourceId, animeId);
  const libraryQuery = useQuery({ queryKey: ["library"], queryFn: () => hibiki.library.list() });
  const progressQuery = useQuery({ queryKey: ["progress-all", sourceId, animeId], queryFn: () => hibiki.progress.listForAnime(sourceId, animeId) });

  // Same query key as the "Downloaded episodes" screen's own list - so this page's own view of
  // what's already downloaded and that screen's are always the same cache entry, not two
  // independent copies that can drift (delete something there, and this page would otherwise keep
  // showing it as downloaded until some unrelated refetch happened to catch up).
  const downloadedEpisodesQuery = useQuery({ queryKey: ["downloadedEpisodes"], queryFn: () => hibiki.downloads.list() });
  const downloadedEpisodeIds = useMemo(
    () => new Set((downloadedEpisodesQuery.data ?? []).filter((e) => e.sourceId === sourceId && e.animeId === animeId).map((e) => e.episodeId)),
    [downloadedEpisodesQuery.data, sourceId, animeId],
  );

  // Keyed by episodeId, not a single "current download" - more than one episode's context menu
  // can kick off a download independently, and each chip only cares about its own entry here.
  const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({});
  useEffect(() => {
    return hibiki.downloads.onProgress((progress) => {
      setDownloads((prev) => ({ ...prev, [progress.episodeId]: progress }));
      // A finished (or deleted-out-from-under-us) download changes the *persisted* set this page
      // checks against for "already downloaded" - not just the transient per-episode status above.
      if (progress.status === "done" || progress.status === "cancelled") {
        queryClient.invalidateQueries({ queryKey: ["downloadedEpisodes"] });
      }
      // "paused"/"queued" aren't terminal results to auto-clear after a few seconds like the
      // others below - they need to keep showing (and stay cancellable, or pausable/resumable for
      // "paused") until the user actually does one of those, or the queue actually gets to it.
      if (progress.status !== "downloading" && progress.status !== "paused" && progress.status !== "queued") {
        setTimeout(() => {
          setDownloads((prev) => {
            // Only clear it if this is still the *same* terminal result - a fresh download of the
            // same episode started (and possibly already progressing) in the meantime shouldn't
            // have its own in-flight state wiped out by this now-stale timeout.
            if (prev[progress.episodeId] !== progress) return prev;
            const next = { ...prev };
            delete next[progress.episodeId];
            return next;
          });
        }, DOWNLOAD_RESULT_DISPLAY_MS);
      }
    });
  }, [queryClient]);

  const anime = animeQuery.data;
  const groups = groupsQuery.data ?? [];
  const activeGroup = groups.find((g) => g.id === requestedGroupId) ?? groups[0];
  const setActiveGroupId = (id: string) => navigate({ to: "/anime/$sourceId/$animeId", params: { sourceId, animeId }, search: { group: id }, replace: true });
  const progressByEpisode = new Map((progressQuery.data ?? []).map((p) => [p.episodeId, p]));
  // Every screen that reads this episode's progress: this page's own grid, the watch route's
  // resume position, and the "continue watching" rows the home and profile pages share.
  const invalidateProgress = (episodeId: string) => {
    queryClient.invalidateQueries({ queryKey: ["progress-all", sourceId, animeId] });
    queryClient.invalidateQueries({ queryKey: ["progress", sourceId, animeId, episodeId] });
    queryClient.invalidateQueries({ queryKey: ["recent-progress"] });
  };
  const continueTarget = resolveContinue(activeGroup, progressByEpisode, t);

  // Mirrors Android's DetailsUiModel: franchiseAnime (a source's own "Season 1, Season 2, Movie,
  // ..." sequence) and relatedAnime (prequels/sequels/side-stories) render as one merged section
  // rather than two, with the currently-viewed title spliced in at the front if the source didn't
  // already include a self-reference - similarAnime is a separate "you might also like" section
  // that excludes anything already shown as related (and the title itself).
  const related = anime
    ? (() => {
        const merged = dedupeById([...(anime.franchiseAnime ?? []), ...(anime.relatedAnime ?? [])]);
        if (merged.length === 0 || merged.some((r) => r.id === animeId)) return merged;
        return [{ id: animeId, title: animeTitle(anime), posterUrl: anime.posterUrl, type: anime.type, year: anime.year, episodeCount: anime.availableEpisodeCount, status: anime.status }, ...merged];
      })()
    : [];
  const relatedIds = new Set(related.map((r) => r.id));
  const similar = anime ? dedupeById(anime.similarAnime ?? []).filter((r) => r.id !== animeId && !relatedIds.has(r.id)) : [];

  const libraryEntry = libraryQuery.data?.find((e) => e.sourceId === sourceId && e.animeId === animeId);
  const setLibraryCategory = async (category: LibraryCategory) => {
    if (!anime) return;
    await hibiki.library.upsert({ sourceId, animeId, category, addedAt: libraryEntry?.addedAt ?? Date.now(), anime });
    queryClient.invalidateQueries({ queryKey: ["library"] });
  };
  const removeFromLibrary = async () => {
    await hibiki.library.remove(sourceId, animeId);
    queryClient.invalidateQueries({ queryKey: ["library"] });
  };

  // `isolate` forces this page to establish its own CSS stacking context - without it,
  // `position: relative` alone does NOT create one (only position+z-index, opacity<1, transform,
  // isolation, etc. do), so the backdrop's `-z-10` below would fall through to the nearest
  // ancestor that DOES establish one instead, letting an opaque wrapper further up paint over it
  // entirely regardless of DOM nesting or its own opacity (this bit the Overview-only backdrop
  // this replaces - see the fix history). `fixed` (rather than sizing to the page's own scroll
  // height) keeps it pinned to the viewport as the page scrolls, the same "always-there" backdrop
  // treatment as Netflix/Steam-style detail pages, instead of just being the top hero banner.
  //
  // `top-10` (not `inset-0`) keeps it clear of the custom title bar (see TitleBar.tsx, h-10) -
  // `filter: blur()` promotes an element to its own GPU compositing layer, which this app has
  // already hit once before (see TitleBar.tsx's own comment on why its filter panel is portaled):
  // such a layer can end up compositing above content with a nominally higher z-index regardless
  // of what CSS z-index/isolation say it should do, so covering the title bar's own screen area at
  // all - even nominally "behind" it - reliably blanked out its icon/home/back/forward/search.
  // Not `bg-app-bg` (unlike every other page's own root) - this page's text (Overview's title,
  // genres, the episode grid, ...) is all hardcoded light-on-dark rather than the usual bg/text
  // tokens, a deliberate holdover from when the blurred-poster backdrop below made it permanently
  // dark regardless of the app's own light/dark toggle. bg-app-bg's color follows that toggle, so
  // swapping to it here while keeping the hardcoded text would silently break light mode's
  // contrast the moment a background theme also happens to be on. A flat, theme-independent dark
  // tint keeps that existing contrast intact while still letting the gradient show through it.
  return <div className={cn("relative isolate min-h-full pb-16", backgroundTheme && "bg-black/70 backdrop-blur-2xl")}>
    {/* Skipped entirely once a background theme is active (see the comment on `backgroundTheme`
        above) - the flat tint above takes over instead. */}
    {!backgroundTheme && (
      // `left: var(--sidebar-width)`, not `inset-x-0` - this used to run full window width behind
      // the sidebar too, which didn't matter while the sidebar was always fully opaque, but once it
      // can go translucent (the "app background" theme, see lib/theme.ts) this poster-tinted
      // backdrop started visibly bleeding through it - a per-page effect discoloring the nav
      // differently depending on which page happened to be open. Stopping exactly at the sidebar's
      // own current (possibly user-resized) width, kept in sync via that CSS var (see Sidebar.tsx),
      // keeps this confined to the content area it's actually painted behind.
      <div className="fixed bottom-0 right-0 top-10 -z-10 overflow-hidden bg-bg" style={{ left: "var(--sidebar-width, 236px)" }}>
        {/* Held back with the rest of the page: this backdrop is the poster, blurred, so painting
            the source's while a skeleton stands in front of it would change the whole page's tint
            the moment the real one arrives. */}
        {anime?.posterUrl && !describing && <>
          <img src={anime.posterUrl} alt="" className="h-full w-full scale-110 object-cover opacity-20 blur-2xl dark:opacity-40" />
          {/* Reads --color-bg straight off the root element (see globals.css) rather than a
              hardcoded hex, same trick as ContinueWatchingRow's own PAGE_BG - so this scrim keeps
              matching the page's real background through the light/dark toggle instead of staying
              permanently dark underneath text that's now theme-aware too. */}
          <div className="absolute inset-0" style={{ backgroundImage: [
            "linear-gradient(180deg, rgb(var(--color-bg)) 0px, transparent 96px)",
            "linear-gradient(0deg, rgb(var(--color-bg)) 0px, transparent 160px)",
            "linear-gradient(90deg, rgb(var(--color-bg)) 0%, rgb(var(--color-bg) / .4) 45%, rgb(var(--color-bg) / .75) 100%)",
          ].join(", ") }} />
        </>}
      </div>
    )}
    {(animeQuery.isLoading || describing) && <DetailSkeleton />}
    {animeQuery.isError && <div className="p-8"><ErrorBanner message={(animeQuery.error as Error).message} /></div>}
    {anime && !describing && <>
      <Overview anime={anime} libraryCategory={libraryEntry?.category ?? null} onSetLibraryCategory={setLibraryCategory} onRemoveFromLibrary={removeFromLibrary} continueTarget={continueTarget ? { groupId: activeGroup!.id, episodeId: continueTarget.episode.id, label: continueTarget.label } : undefined} sourceId={sourceId} animeId={animeId} related={related} titleLoadedAt={animeQuery.dataUpdatedAt} />
      <div className="px-8 pt-6">
        <h2 className="mb-4 text-xl font-bold tracking-[-.02em] text-text">{t("detail.episodes")}</h2>
        {groupsQuery.isLoading && <div className="text-sm text-muted">{t("detail.loadingEpisodes")}</div>}
        {groupsQuery.isError && <ErrorBanner message={(groupsQuery.error as Error).message} />}
        {groups.length === 0 && !groupsQuery.isLoading && !groupsQuery.isError && <div className="text-sm text-muted">{t("detail.noEpisodesYet")}</div>}
        {groups.length > 1 && <div className="mb-5">
          <GroupDropdown groups={groups} activeGroupId={activeGroup?.id} onSelect={setActiveGroupId} />
        </div>}
        {activeGroup && <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {activeGroup.episodes.map((ep) => (
            <EpisodeChip
              key={ep.id}
              sourceId={sourceId}
              animeId={animeId}
              groupId={activeGroup.id}
              episode={ep}
              progress={progressByEpisode.get(ep.id)}
              download={downloads[ep.id]}
              isDownloaded={downloadedEpisodeIds.has(ep.id)}
              onRemoveDownload={async () => {
                await hibiki.downloads.remove(sourceId, animeId, ep.id);
                queryClient.invalidateQueries({ queryKey: ["downloadedEpisodes"] });
              }}
              onDownload={() => setDownloadEpisode(ep)}
              onMarkWatched={async () => {
                const existing = progressByEpisode.get(ep.id);
                await hibiki.progress.upsert({
                  ...existing,
                  sourceId,
                  titleId: animeId,
                  episodeId: ep.id,
                  episodeNumber: ep.number,
                  groupId: activeGroup.id,
                  positionMs: existing?.positionMs ?? 0,
                  durationMs: existing?.durationMs ?? 0,
                  watched: true,
                  updatedAt: Date.now(),
                  // Nothing was played to get here. The episode counts as completed, which the
                  // upsert books on its own, but the time never happened and must not be invented.
                  watchedDeltaMs: 0,
                });
                invalidateProgress(ep.id);
              }}
              onClearProgress={async () => {
                await hibiki.progress.removeEpisode(sourceId, animeId, ep.id);
                invalidateProgress(ep.id);
              }}
            />
          ))}
        </div>}
      </div>
      <div className="px-8 pt-10">
        <TitleStrip
          items={similar}
          sourceId={sourceId}
          heading={<h2 className="mb-4 text-xl font-bold tracking-[-.02em] text-text">{t("detail.similarTitles")}</h2>}
        />
      </div>
      {/* Last on the page, and only for a source that has them: comments are the one section here
          that is about the site rather than about the title. */}
      {source && <CommentsSection source={source} animeId={animeId} />}
      <AnimatePresence>
        {downloadEpisode && (
          <DownloadDialog
            key={downloadEpisode.id}
            sourceId={sourceId}
            animeId={animeId}
            animeTitle={animeTitle(anime)}
            episode={downloadEpisode}
            groups={groups}
            defaultGroupId={activeGroup?.id ?? groups[0]?.id ?? ""}
            onClose={() => setDownloadEpisode(null)}
          />
        )}
      </AnimatePresence>
    </>}
  </div>;
}

function EpisodeChip({
  sourceId,
  animeId,
  groupId,
  episode,
  progress,
  download,
  isDownloaded,
  onDownload,
  onRemoveDownload,
  onMarkWatched,
  onClearProgress,
}: {
  sourceId: string;
  animeId: string;
  groupId: string;
  episode: Episode;
  progress?: WatchProgress;
  download?: DownloadProgress;
  // Persisted (survives a reload, a re-visit, this component never having mounted before) -
  // distinct from `download`, which only ever reflects an in-flight or just-now-finished transfer
  // this browsing session actually saw happen. Without this, the context menu had no way to know
  // an episode was already downloaded and just kept offering "Download" for it every time.
  isDownloaded: boolean;
  onDownload: () => void;
  onRemoveDownload: () => void;
  onMarkWatched: () => void;
  onClearProgress: () => void;
}) {
  const { t } = useTranslation();
  const watched = progress?.watched ?? false;
  const percent = !watched && progress && progress.durationMs > 0 ? Math.min(100, (progress.positionMs / progress.durationMs) * 100) : 0;

  const favoriteKey = episodeFavoriteKey(sourceId, animeId, episode.id);
  const isFavorite = useEpisodeFavoritesStore((s) => !!s.favorites[favoriteKey]);
  const toggleFavorite = useEpisodeFavoritesStore((s) => s.toggleFavorite);

  const downloading = download?.status === "downloading";
  const paused = download?.status === "paused";
  const queued = download?.status === "queued";
  const downloadPercent = download?.percent ?? 0;
  const [menuOpen, setMenuOpen] = useState(false);

  // Both the pause button (below) and the context menu's "cancel" item are nested inside the
  // whole-card <Link> - without stopping the click here it'd also fire the Link's own navigation
  // to the watch page underneath whatever was actually clicked.
  const onTogglePause = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (downloading) hibiki.downloads.pause(episode.id);
    else hibiki.downloads.resume(episode.id);
  };

  return (
    <ContextMenu.Root onOpenChange={setMenuOpen}>
      <ContextMenu.Trigger asChild>
        <Link
          to="/watch/$sourceId/$animeId/$groupId/$episodeId"
          params={{ sourceId, animeId, groupId, episodeId: episode.id }}
          className={cn("group relative flex items-center gap-3 overflow-hidden rounded-xl border px-3 py-2.5 transition-colors", watched ? "border-border bg-text/[.02] opacity-60 hover:opacity-100" : "border-border bg-text/[.03] hover:border-accent/40 hover:bg-text/[.06]")}
        >
          <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold transition-colors", watched ? "bg-text/[.05] text-muted" : percent > 0 ? "bg-accent/20 text-accent-text" : "bg-text/[.06] text-muted group-hover:bg-accent/20 group-hover:text-accent-text")}>
            {watched ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : episode.number}
          </span>
          <span className={cn("line-clamp-1 flex-1 select-text text-sm transition-colors", watched ? "text-muted" : "text-muted group-hover:text-text")}>{episode.title || t("detail.episodeFallback", { number: episode.number })}</span>
          {isFavorite && <Heart className="h-3.5 w-3.5 shrink-0 fill-rose-400 text-rose-400" strokeWidth={0} />}
          {(download?.status === "error" || download?.status === "unsupported") && (
            <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-rose-400" strokeWidth={2.5} />
          )}
          {queued && (
            <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-muted">
              <Clock className="h-3 w-3" strokeWidth={2} />
              {t("detail.episodeMenu.queued")}
            </span>
          )}
          {(downloading || paused) && (
            <>
              <span className="shrink-0 text-[11px] font-semibold tabular-nums text-accent-text">{downloadPercent}%</span>
              <button
                type="button"
                onClick={onTogglePause}
                aria-label={downloading ? t("detail.episodeMenu.pauseDownload") : t("detail.episodeMenu.resumeDownload")}
                title={downloading ? t("detail.episodeMenu.pauseDownload") : t("detail.episodeMenu.resumeDownload")}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent-text transition-colors hover:bg-accent/25"
              >
                {downloading ? <Pause className="h-3 w-3 fill-current" strokeWidth={0} /> : <Play className="h-3 w-3 fill-current" strokeWidth={0} />}
              </button>
            </>
          )}
          {!downloading && !paused && (
            (isDownloaded || download?.status === "done") ? (
              // Same slot, not two side-by-side icons - the downloaded checkmark sits where the
              // hover-play affordance normally would, and hovering swaps one for the other in
              // place (slide + fade) instead of just permanently crowding both in at once.
              <span className="relative h-3.5 w-3.5 shrink-0">
                <Download className="absolute inset-0 h-3.5 w-3.5 text-emerald-400 transition-all duration-200 group-hover:-translate-x-1 group-hover:opacity-0" strokeWidth={2.5} />
                <Play className="absolute inset-0 h-3.5 w-3.5 translate-x-1 fill-current text-accent-text opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-100" strokeWidth={0} />
              </span>
            ) : (
              (!download || download.status === "cancelled") && <Play className="h-3.5 w-3.5 shrink-0 fill-current text-accent-text opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={0} />
            )
          )}
          {(downloading || paused) ? (
            <div className="absolute inset-x-0 bottom-0 h-[3px] bg-text/10"><div className={cn("h-full bg-accent transition-[width]", paused && "opacity-50")} style={{ width: `${downloadPercent}%` }} /></div>
          ) : percent > 0 ? (
            <div className="absolute inset-x-0 bottom-0 h-[3px] bg-text/10"><div className="h-full bg-accent" style={{ width: `${percent}%` }} /></div>
          ) : null}
        </Link>
      </ContextMenu.Trigger>
      <ContextMenu.Portal forceMount>
        {/* `forceMount` on both Portal and Content hands the actual mount/unmount timing to our
            own AnimatePresence instead of Radix's default (instant show/hide) - same "no `scale`"
            reasoning as the LibraryButton dropdown above (Chromium re-rasterizes scaled text at a
            slightly different subpixel size every frame), just a plain fade+slide instead. */}
        <AnimatePresence>
          {menuOpen && (
            <ContextMenu.Content asChild forceMount>
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ type: "spring", stiffness: 500, damping: 45 }}
                className="z-50 w-56 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
              >
                {(downloading || paused || queued) ? (
                  <>
                    {!queued && (
                      <ContextMenu.Item
                        onSelect={() => (downloading ? hibiki.downloads.pause(episode.id) : hibiki.downloads.resume(episode.id))}
                        className="flex cursor-default items-center gap-2.5 px-3.5 py-2.5 text-sm text-text outline-none transition-colors data-[highlighted]:bg-text/[.06]"
                      >
                        {downloading ? <Pause className="h-4 w-4 shrink-0 text-muted" strokeWidth={2} /> : <Play className="h-4 w-4 shrink-0 text-muted" strokeWidth={2} />}
                        {(downloading ? t("detail.episodeMenu.pauseDownload") : t("detail.episodeMenu.resumeDownload"))} · {downloadPercent}%
                      </ContextMenu.Item>
                    )}
                    <ContextMenu.Item
                      onSelect={() => hibiki.downloads.cancel(episode.id)}
                      className="flex cursor-default items-center gap-2.5 px-3.5 py-2.5 text-sm text-rose-300 outline-none transition-colors data-[highlighted]:bg-text/[.06]"
                    >
                      <X className="h-4 w-4 shrink-0" strokeWidth={2} />
                      {t("detail.episodeMenu.cancelDownload")}
                    </ContextMenu.Item>
                  </>
                ) : isDownloaded ? (
                  <ContextMenu.Item
                    onSelect={onRemoveDownload}
                    className="flex cursor-default items-center gap-2.5 px-3.5 py-2.5 text-sm text-rose-300 outline-none transition-colors data-[highlighted]:bg-text/[.06]"
                  >
                    <Trash2 className="h-4 w-4 shrink-0" strokeWidth={2} />
                    {t("detail.episodeMenu.removeDownload")}
                  </ContextMenu.Item>
                ) : (
                  <ContextMenu.Item
                    onSelect={onDownload}
                    className="flex cursor-default items-center gap-2.5 px-3.5 py-2.5 text-sm text-text outline-none transition-colors data-[highlighted]:bg-text/[.06]"
                  >
                    <Download className="h-4 w-4 shrink-0 text-muted" strokeWidth={2} />
                    {t("detail.episodeMenu.download")}
                  </ContextMenu.Item>
                )}
                <ContextMenu.Item
                  onSelect={() => toggleFavorite(favoriteKey)}
                  className="flex cursor-default items-center gap-2.5 px-3.5 py-2.5 text-sm text-text outline-none transition-colors data-[highlighted]:bg-text/[.06]"
                >
                  <Heart className={cn("h-4 w-4 shrink-0", isFavorite ? "fill-rose-400 text-rose-400" : "text-muted")} strokeWidth={2} />
                  {isFavorite ? t("detail.episodeMenu.favoriteRemove") : t("detail.episodeMenu.favoriteAdd")}
                </ContextMenu.Item>
                {/* Marking is offered only while the episode isn't already marked, and clearing
                    only while there is something to clear - an item that does nothing is worse
                    than an item that isn't there. */}
                {!watched && (
                  <ContextMenu.Item
                    onSelect={onMarkWatched}
                    className="flex cursor-default items-center gap-2.5 px-3.5 py-2.5 text-sm text-text outline-none transition-colors data-[highlighted]:bg-text/[.06]"
                  >
                    <Eye className="h-4 w-4 shrink-0 text-muted" strokeWidth={2} />
                    {t("detail.episodeMenu.markWatched")}
                  </ContextMenu.Item>
                )}
                {progress && (
                  <ContextMenu.Item
                    onSelect={onClearProgress}
                    className="flex cursor-default items-center gap-2.5 px-3.5 py-2.5 text-sm text-rose-300 outline-none transition-colors data-[highlighted]:bg-text/[.06]"
                  >
                    <Eraser className="h-4 w-4 shrink-0" strokeWidth={2} />
                    {t("detail.episodeMenu.clearProgress")}
                  </ContextMenu.Item>
                )}
              </motion.div>
            </ContextMenu.Content>
          )}
        </AnimatePresence>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function Overview({ anime, libraryCategory, onSetLibraryCategory, onRemoveFromLibrary, continueTarget, sourceId, animeId, related, titleLoadedAt }: { anime: AnimeTitle; libraryCategory: LibraryCategory | null; onSetLibraryCategory: (category: LibraryCategory) => void; onRemoveFromLibrary: () => void; continueTarget?: { groupId: string; episodeId: string; label: string }; sourceId: string; animeId: string; related: RelatedAnimeTitle[]; titleLoadedAt: number }) {
  const { t, i18n } = useTranslation();
  const title = animeTitle(anime);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const [collapsedHeight] = useState(72);
  const [maxHeight, setMaxHeight] = useState(collapsedHeight);
  useEffect(() => {
    const full = descriptionRef.current?.scrollHeight ?? collapsedHeight;
    setMaxHeight(descriptionOpen ? full : Math.min(collapsedHeight, full));
  }, [descriptionOpen, anime.description, collapsedHeight]);

  // "announcement" and "announced" both show up across sources for the same status - see
  // searchFilters.ts's own STATUS_ID_ALIASES, which this reuses so both pages agree.
  const normalizedStatus = anime.status ? (STATUS_ID_ALIASES[anime.status] ?? anime.status) : null;
  const statusLabel = normalizedStatus ? t(`detail.status.${normalizedStatus}`, { defaultValue: normalizedStatus }) : null;
  // An unreleased title has no episode count worth showing yet - "0 эп." next to "Анонс" reads as
  // a real (missing) fact about the show rather than the show simply not existing yet.
  const episodesLabel = normalizedStatus !== "announced" && anime.availableEpisodeCount != null
    ? t("common.episodesShort", { count: anime.episodeCount ? `${anime.availableEpisodeCount} / ${anime.episodeCount}` : anime.availableEpisodeCount })
    : null;
  // Only worth showing while there's actually still something to wait for - a stale nextEpisodeAt
  // left over from a source that never updated it after the show finished would otherwise print a
  // (past-due, nonsensical) countdown on a title that already has every episode.
  const nextEpisodeLabel = normalizedStatus === "ongoing" && anime.nextEpisodeAt && isUpcomingDay(anime.nextEpisodeAt)
    ? formatNextEpisode(anime.nextEpisodeAt, t, i18n.language)
    : null;

  // The blurred backdrop now lives once at the page level (see AnimeDetailPage) so it covers the
  // whole scrollable page, not just this section - this just needs its own border to separate it
  // from the episode list below.
  return <section className="border-b border-border px-8 pb-8 pt-8">
    <div className="flex gap-7">
      <div className="w-44 shrink-0 sm:w-52">
        <div className="aspect-[2/3] overflow-hidden rounded-2xl bg-surface shadow-[0_20px_50px_rgba(0,0,0,.5)] ring-1 ring-border">
          {anime.posterUrl ? <img src={anime.posterUrl} alt={title} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted">{t("common.noPoster")}</div>}
        </div>
      </div>
      <div className="min-w-0 flex-1 pt-1">
        <h1 className="max-w-2xl select-text text-3xl font-bold leading-[1.1] tracking-[-.03em] text-text md:text-4xl">{title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-medium text-muted">
          {anime.year && <span>{anime.year}</span>}
          {anime.type && <><Dot /><span className="uppercase">{anime.type}</span></>}
          {statusLabel && <><Dot /><span className={cn("rounded-md px-1.5 py-0.5 font-semibold", anime.status === "ongoing" ? "bg-accent/15 text-accent-text" : "bg-text/10 text-muted")}>{statusLabel}</span></>}
          {episodesLabel && <><Dot /><span>{episodesLabel}</span></>}
          {/* Fixed emerald, not the app's own accent color - mirrors Android's "next episode"
              pill, which is deliberately always green regardless of the current theme. */}
          {nextEpisodeLabel && <><Dot /><span className="flex items-center gap-1 rounded-md bg-emerald-400/15 px-1.5 py-0.5 font-semibold text-emerald-500 dark:text-emerald-400"><Clock className="h-3 w-3" strokeWidth={2.5} />{nextEpisodeLabel}</span></>}
          {/* The scores a card in any list already shows - the page that a card leads to was the
              one place they were missing. */}
          {(anime.ratings?.length ?? 0) > 0 && <><Dot /><SourceRatings ratings={anime.ratings ?? []} /></>}
        </div>
        {anime.genres && anime.genres.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{anime.genres.map((g) => <span key={g} className="rounded-md bg-text/[.07] px-2 py-1 text-xs text-muted">{g}</span>)}</div>}
        {anime.description && <div className="mt-4 max-w-2xl overflow-hidden transition-[max-height] duration-300 ease-in-out" style={{ maxHeight }}>
          <p ref={descriptionRef} className="select-text text-sm leading-6 text-muted">{anime.description}</p>
        </div>}
        {anime.description && <button onClick={() => setDescriptionOpen((v) => !v)} className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-muted transition hover:text-text">{descriptionOpen ? t("common.hideDescription") : t("common.readDescription")}<ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-300", descriptionOpen && "rotate-180")} strokeWidth={2.5} /></button>}
        {/* Where the description came from, and the way to correct a wrong match - below the
            description it explains, above the actions, since it is a note about this page rather
            than something to do on it. */}
        <MetadataBinding sourceId={sourceId} animeId={animeId} titleLoadedAt={titleLoadedAt} />
        <div className="mt-6 flex items-center gap-3">
          {continueTarget ? <Link to="/watch/$sourceId/$animeId/$groupId/$episodeId" params={{ sourceId, animeId, groupId: continueTarget.groupId, episodeId: continueTarget.episodeId }} className="inline-flex items-center gap-2 rounded-xl bg-text px-5 py-3 text-sm font-bold text-bg transition-transform hover:scale-[1.02] active:scale-[0.98]"><Play className="h-4 w-4 fill-current" strokeWidth={0} />{continueTarget.label}</Link>
            : <span className="inline-flex items-center gap-2 rounded-xl bg-text/10 px-5 py-3 text-sm font-bold text-muted">{t("detail.noEpisodes")}</span>}
          <LibraryButton category={libraryCategory} onSelect={onSetLibraryCategory} onRemove={onRemoveFromLibrary} />
          <RatingButton sourceId={sourceId} animeId={animeId} />
        </div>
      </div>
    </div>
    {/* A sibling of the poster+text row above, not nested inside the text column with it - now
        that its own cards are full-size (see RELATED_CARD_WIDTH_CLASSES), squeezing the strip into
        that narrower column left it awkwardly indented under the metadata rather than reading as
        its own section. Full section width instead lines its left edge up with the poster's own,
        directly below it, the way the user actually asked for this to look. */}
    <div className="mt-6">
      <TitleStrip
        items={related}
        sourceId={sourceId}
        currentAnimeId={animeId}
        heading={<p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t("detail.relatedTitles")}</p>}
      />
    </div>
  </section>;
}

function LibraryButton({ category, onSelect, onRemove }: { category: LibraryCategory | null; onSelect: (category: LibraryCategory) => void; onRemove: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const Icon = category ? LIBRARY_CATEGORY_ICONS[category] : Bookmark;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn("inline-flex h-[46px] w-[46px] items-center justify-center rounded-xl border transition-colors", category ? "border-accent/40 bg-accent/15 text-accent-text" : "border-border bg-text/[.05] text-muted hover:bg-text/[.09]")}
        aria-label={category ? t("detail.removeFromLibrary") : t("detail.addToLibrary")}
      >
        <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            {/* No `scale` here - animating a transform:scale() on a block full of small bold text
                makes Chromium re-rasterize the glyphs at a slightly different subpixel size every
                frame, which reads as the text (and icons next to it) faintly shimmering/shifting
                while the panel is still settling in. A plain fade + slide has no such effect since
                nothing's actually changing size, just position. */}
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ type: "spring", stiffness: 500, damping: 45 }}
              className="absolute left-0 top-[52px] z-50 w-56 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
            >
              {ASSIGNABLE_LIBRARY_CATEGORIES.map((option) => {
                const OptionIcon = LIBRARY_CATEGORY_ICONS[option];
                return (
                  <button
                    key={option}
                    onClick={() => { onSelect(option); setOpen(false); }}
                    className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm text-text transition-colors hover:bg-text/[.06]"
                  >
                    <OptionIcon className="h-4 w-4 shrink-0 text-muted" strokeWidth={2} />
                    <span className="flex-1">{t(LIBRARY_CATEGORY_LABEL_KEYS[option])}</span>
                    {option === category && <Check className="h-4 w-4 shrink-0 text-accent-text" strokeWidth={2.5} />}
                  </button>
                );
              })}
              {category && (
                <button
                  onClick={() => { onRemove(); setOpen(false); }}
                  className="flex w-full items-center gap-3 border-t border-border px-3.5 py-2.5 text-left text-sm text-rose-400 transition-colors hover:bg-text/[.06]"
                >
                  <X className="h-4 w-4 shrink-0" strokeWidth={2} />
                  {t("detail.removeFromLibrary")}
                </button>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

// Lets the user pick a translation/dub and quality before a download actually starts, instead of
// silently grabbing whatever selectPlayerLink (see main/ipc/downloads.ts) would've picked on its
// own - which was always "the best available", with no way to deliberately ask for something
// smaller/cheaper on a slow connection or limited disk space.
function DownloadDialog({
  sourceId, animeId, animeTitle, episode, groups, defaultGroupId, onClose,
}: {
  sourceId: string; animeId: string; animeTitle: string; episode: Episode; groups: PlaybackGroup[]; defaultGroupId: string; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [groupId, setGroupId] = useState(defaultGroupId);
  const [quality, setQuality] = useState<string | null>(null);

  const linksQuery = useQuery({
    queryKey: ["playerLinks", sourceId, animeId, groupId, episode.id],
    queryFn: () => hibiki.sources.playerLinks(sourceId, animeId, groupId, episode.id),
  });

  // Same "can this actually be saved to disk" rule as resolveAndRunDownload's own check - an embed
  // page, a DASH manifest, or a link with a separate audio track can't be fetched and written out
  // by this app, so offering their qualities here would just be a picker for downloads that are
  // guaranteed to fail with "unsupported" the moment they're started.
  const downloadableLinks = (linksQuery.data ?? []).filter((l: PlayerLink) => (l.type === "DIRECT_HLS" || l.type === "DIRECT_MP4") && !l.audioUrl);
  const qualities = Array.from(new Set(downloadableLinks.map((l) => l.quality).filter((q): q is string => !!q)));
  const selectedQuality = quality && qualities.includes(quality) ? quality : (qualities[0] ?? null);
  const unsupported = linksQuery.isSuccess && downloadableLinks.length === 0;
  const episodeLabel = episode.title || t("detail.episodeFallback", { number: episode.number });

  const onConfirm = () => {
    hibiki.downloads.start({
      sourceId, animeId, groupId, episodeId: episode.id, episodeNumber: episode.number,
      animeTitle, episodeLabel, quality: selectedQuality,
    });
    onClose();
  };

  return (
    <Modal onDismiss={onClose}>
      <h2 className="text-base font-bold text-text">{t("detail.downloadDialog.title")}</h2>
      <p className="mt-1 truncate text-sm text-muted">{episodeLabel}</p>

      {groups.length > 1 && (
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{t("detail.downloadDialog.translation")}</p>
          <GroupDropdown groups={groups} activeGroupId={groupId} onSelect={(id) => { setGroupId(id); setQuality(null); }} />
        </div>
      )}

      <div className="mt-4">
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{t("detail.downloadDialog.quality")}</p>
        {linksQuery.isLoading ? (
          <p className="text-sm text-muted">{t("detail.downloadDialog.loadingQualities")}</p>
        ) : linksQuery.isError ? (
          <p className="text-sm text-rose-400">{t("common.loadFailed", { message: (linksQuery.error as Error).message })}</p>
        ) : unsupported ? (
          <p className="text-sm text-rose-400">{t("detail.episodeMenu.downloadUnsupported")}</p>
        ) : qualities.length === 0 ? (
          <p className="text-sm text-muted">{t("detail.downloadDialog.qualityUnknown")}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {qualities.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQuality(q)}
                className={cn("rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors", q === selectedQuality ? "bg-accent/20 text-accent-text" : "bg-text/[.06] text-muted hover:bg-text/[.1]")}
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg px-3.5 py-2 text-sm font-semibold text-muted transition-colors hover:bg-text/[.06]">{t("common.cancel")}</button>
        <button
          onClick={onConfirm}
          disabled={!linksQuery.isSuccess || unsupported}
          className="rounded-lg bg-text px-3.5 py-2 text-sm font-bold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {t("detail.episodeMenu.download")}
        </button>
      </div>
    </Modal>
  );
}

// Same click-outside-to-dismiss + spring-in card as sources.tsx's own Modal (AddRepositoryDialog/
// RemoveRepositoryDialog) - not shared between the two files since it's a handful of lines and each
// route otherwise has zero coupling to the other. Portaled to document.body, unlike that one -
// this page's own root div picks up `backdrop-blur-2xl` while a background theme is active (see
// AnimeDetailPage above), and `backdrop-filter` (like `filter`/`transform`) makes its element a
// containing block for `position: fixed` descendants - so this dialog was centering itself against
// the whole scrollable page instead of the actual window, landing wherever that happened to put
// its midpoint rather than in front of the user. Same fix as SearchFiltersPanel's own portal.
function Modal({ onDismiss, children }: { onDismiss: () => void; children: React.ReactNode }) {
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onDismiss}
    >
      {/* No `scale` - see LibraryButton above for why. */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 6 }}
        transition={{ type: "spring", stiffness: 420, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-2xl"
      >
        <button onClick={onDismiss} className="float-right -mr-1 -mt-1 flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-text/[.06] hover:text-text">
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
        {children}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

function Dot() { return <span className="h-0.5 w-0.5 rounded-full bg-muted" />; }
function ErrorBanner({ message }: { message: string }) { const { t } = useTranslation(); return <div className="flex items-start gap-3 rounded-2xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/5 dark:text-rose-200"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} /><span>{t("common.loadFailed", { message })}</span></div>; }
function DetailSkeleton() { return <div className="animate-pulse px-8 pb-12 pt-8"><div className="flex gap-7"><div className="aspect-[2/3] w-44 shrink-0 rounded-2xl bg-text/[.06] sm:w-52" /><div className="flex-1 pt-1"><div className="h-9 w-2/3 max-w-md rounded bg-text/[.08]" /><div className="mt-4 h-3 w-40 rounded bg-text/[.06]" /><div className="mt-5 h-3 w-full max-w-xl rounded bg-text/[.06]" /><div className="mt-2 h-3 w-4/5 max-w-xl rounded bg-text/[.06]" /><div className="mt-6 h-12 w-40 rounded-xl bg-text/[.08]" /></div></div></div>; }
