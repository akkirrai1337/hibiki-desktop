import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AnimatePresence, motion } from "motion/react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { ArrowUpDown, ChevronRight, LayoutGrid, List, Mic, Play, Bookmark, Check, ChevronDown, Clock, Download, Eraser, ExternalLink, Eye, Heart, Pause, Trash2, TriangleAlert, X } from "lucide-react";
import { CommentsSection } from "@/components/CommentsSection";
import { RatingButton, SourceRatings } from "@/components/RatingButton";
import { hibiki } from "@/lib/hibiki";
import { findListedTitle } from "@/lib/listedTitles";
import { usePlaybackGroups } from "@/lib/playbackGroups";
import { isGenericDubTitle } from "@/lib/dubTitle";
import { animeTitle } from "@/components/AnimeCard";
import { GenreChip } from "@/components/GenreChip";
import { GroupDropdown } from "@/components/GroupDropdown";
import { HorizontalScrollRow } from "@/components/HorizontalScrollRow";
import { SmoothImage } from "@/components/SmoothImage";
import { cn } from "@/lib/cn";
import { ASSIGNABLE_LIBRARY_CATEGORIES, LIBRARY_CATEGORY_ICONS, LIBRARY_CATEGORY_LABEL_KEYS } from "@/lib/libraryCategories";
import { STATUS_ID_ALIASES } from "@/lib/searchFilters";
import { episodeFavoriteKey, useEpisodeFavoritesStore } from "@/stores/episodeFavoritesStore";
import { useUiStore } from "@/stores/uiStore";
import type { AnimeTitle, DownloadProgress, Episode, LibraryCategory, PlaybackGroup, PlayerLink, RelatedAnimeTitle, SourceInfo, WatchProgress } from "@shared/types";

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
        const status = item.status ? (STATUS_ID_ALIASES[item.status] ?? item.status) : null;
        const meta = [
          item.type ? item.type.toUpperCase() : null,
          item.year ? String(item.year) : null,
          status ? t(`detail.status.${status}`, { defaultValue: status }) : null,
        ].filter(Boolean).join(" · ");
        // The name lives on the poster itself, over a gradient that is always there - not repeated
        // under it, and not something that only shows on hover; the line below it says what kind of
        // title it is, when it came out and how it stands.
        const cover = <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-surface ring-1 ring-border">
          {item.posterUrl ? <SmoothImage src={item.posterUrl} alt={item.title} className={cn("h-full w-full transition-transform duration-500 ease-out", isCurrent ? "opacity-50 grayscale" : "group-hover:scale-[1.05] group-hover:will-change-transform")} /> : <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted">{t("common.noPoster")}</div>}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/90 via-black/55 to-transparent transition-opacity duration-300" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3">
            <p className="line-clamp-3 text-[13px] font-semibold leading-snug text-white drop-shadow">{item.title}</p>
            {meta && <p className="mt-1 line-clamp-1 text-[11px] font-medium text-white/65">{meta}</p>}
          </div>
          {/* The hover frame is its own layer inside the clip, not a ring on the outside of it: drawn
              by the same box on all four sides, so it is even all the way round. */}
          <div className="pointer-events-none absolute inset-0 rounded-xl border-[1.7px] border-transparent transition-colors duration-200 group-hover:border-accent" />
          {isCurrent && <div className="absolute left-2 top-2 flex items-center gap-1 rounded-md bg-black/75 px-1.5 py-1 text-[10px] font-semibold text-white/85">
            <Eye className="h-3 w-3" strokeWidth={2.5} />
            {t("detail.relatedHere")}
          </div>}
        </div>;
        return isCurrent
          ? <div className="min-w-0" title={t("detail.relatedCurrentTitle")}>{cover}</div>
          : <Link to="/anime/$sourceId/$animeId" params={{ sourceId, animeId: item.id }} className="group block min-w-0">{cover}</Link>;
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
  const [posterPreviewOpen, setPosterPreviewOpen] = useState(false);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // The preview belongs to this exact title. A parameter-only route change can keep the detail
  // component mounted, so do not let a poster from the previous title linger above the new page.
  useEffect(() => {
    setPosterPreviewOpen(false);
    setScreenshotPreview(null);
  }, [sourceId, animeId]);
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
  const sourcesQuery = useQuery({ queryKey: ["sources"], queryFn: () => hibiki.sources.list() });
  // This page's own source, for the things that are about the site rather than the title: its
  // comments and its rating.
  const source = sourcesQuery.data?.find((candidate) => candidate.id === sourceId);

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
  const episodesNewestFirst = useUiStore((s) => s.episodesNewestFirst);
  const setEpisodesNewestFirst = useUiStore((s) => s.setEpisodesNewestFirst);
  // A view that no longer exists (a saved "compact") reads as the default.
  const episodesView = useUiStore((s) => (s.episodesView === "list" ? "list" : "tiles"));
  const setEpisodesView = useUiStore((s) => s.setEpisodesView);

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
  const screenshots = useMemo(() => [...new Set((anime?.screenshots ?? []).filter((url) => typeof url === "string" && url))], [anime?.screenshots]);
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
        {anime?.posterUrl && <>
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
    {animeQuery.isLoading && <DetailSkeleton />}
    {animeQuery.isError && <div className="p-8"><ErrorBanner message={(animeQuery.error as Error).message} /></div>}
    {anime && <>
      <Overview anime={anime} libraryCategory={libraryEntry?.category ?? null} onSetLibraryCategory={setLibraryCategory} onRemoveFromLibrary={removeFromLibrary} onPosterClick={() => setPosterPreviewOpen(true)} continueTarget={continueTarget ? { groupId: activeGroup!.id, episodeId: continueTarget.episode.id, label: continueTarget.label } : undefined} sourceId={sourceId} animeId={animeId} source={source} related={related} />
      <div className="px-8 pt-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-baseline gap-2 text-xl font-bold tracking-[-.02em] text-text">
            {t("detail.episodes")}
            {activeGroup && <span className="text-sm font-semibold tabular-nums text-muted">{activeGroup.episodes.length}</span>}
          </h2>
          <div className="flex items-center gap-2">
            {groups.length > 1 && <GroupDropdown groups={groups} activeGroupId={activeGroup?.id} onSelect={setActiveGroupId} align="right" />}
            {/* One dub is not a choice: named, but not something to press. */}
            {groups.length === 1 && !isGenericDubTitle(groups[0].title) && (
              <span className="flex items-center gap-2 rounded-lg bg-text/[.06] px-3.5 py-2 text-sm font-semibold text-muted">
                <Mic className="h-4 w-4" strokeWidth={2} />
                {groups[0].title}{groups[0].qualityLabel ? ` · ${groups[0].qualityLabel}` : ""}
              </span>
            )}
            {activeGroup && activeGroup.episodes.length > 1 && (
              <div className="flex rounded-lg bg-text/[.06] p-0.5">
                {([["tiles", LayoutGrid], ["list", List]] as const).map(([view, Icon]) => (
                  <button
                    key={view}
                    onClick={() => setEpisodesView(view)}
                    aria-label={t(`detail.episodesView.${view}`)}
                    title={t(`detail.episodesView.${view}`)}
                    className={cn("flex h-8 w-9 items-center justify-center rounded-md transition-colors", episodesView === view ? "bg-text/[.12] text-text" : "text-muted hover:text-text")}
                  >
                    <Icon className="h-4 w-4" strokeWidth={2} />
                  </button>
                ))}
              </div>
            )}
            {activeGroup && activeGroup.episodes.length > 1 && (
              <button
                onClick={() => setEpisodesNewestFirst(!episodesNewestFirst)}
                className="flex items-center gap-2 rounded-lg bg-text/[.06] px-3.5 py-2 text-sm font-semibold text-muted transition-colors hover:bg-text/[.1] hover:text-text"
              >
                <ArrowUpDown className="h-4 w-4" strokeWidth={2} />
                {episodesNewestFirst ? t("detail.episodesNewestFirst") : t("detail.episodesOldestFirst")}
              </button>
            )}
          </div>
        </div>
        {groupsQuery.isLoading && <div className="text-sm text-muted">{t("detail.loadingEpisodes")}</div>}
        {groupsQuery.isError && <ErrorBanner message={(groupsQuery.error as Error).message} />}
        {groups.length === 0 && !groupsQuery.isLoading && !groupsQuery.isError && <div className="text-sm text-muted">{t("detail.noEpisodesYet")}</div>}
        {activeGroup && <div className={cn("grid gap-2.5", episodesView === "tiles" ? "grid-cols-[repeat(auto-fill,minmax(112px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(300px,1fr))]")}>
          {(episodesNewestFirst ? [...activeGroup.episodes].reverse() : activeGroup.episodes).map((ep) => (
            <EpisodeChip
              key={ep.id}
              sourceId={sourceId}
              animeId={animeId}
              groupId={activeGroup.id}
              episode={ep}
              isNext={continueTarget?.episode.id === ep.id}
              view={episodesView}
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
      {screenshots.length > 0 && (
        <div className="px-8 pt-10">
          <h2 className="mb-4 text-xl font-bold tracking-[-.02em] text-text">{t("detail.screenshots")}</h2>
          <HorizontalScrollRow
            items={screenshots}
            getKey={(url) => url}
            cardWidthClassName="w-[calc((100%-3*0.625rem)/3.3)]"
            arrowAspectClassName="aspect-video"
            renderItem={(url) => (
              <button onClick={() => setScreenshotPreview(url)} className="group block w-full overflow-hidden rounded-xl bg-surface ring-1 ring-border">
                <div className="aspect-video w-full">
                  <SmoothImage src={url} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.035]" />
                </div>
              </button>
            )}
          />
        </div>
      )}
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
      <AnimatePresence>
        {screenshotPreview && <PosterPreview key={screenshotPreview} posterUrl={screenshotPreview} title={animeTitle(anime)} onClose={() => setScreenshotPreview(null)} />}
        {posterPreviewOpen && anime.posterUrl && <PosterPreview key={`${sourceId}:${animeId}`} posterUrl={anime.posterUrl} title={animeTitle(anime)} onClose={() => setPosterPreviewOpen(false)} />}
      </AnimatePresence>
    </>}
  </div>;
}

const GENERIC_EPISODE_TITLE = /^(эпизод|серия|серія|episode|ep\.?)\s*\d+$/i;

function EpisodeChip({
  sourceId,
  animeId,
  groupId,
  episode,
  isNext,
  view,
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
  // The episode "continue" leads to: where the viewer left off.
  isNext: boolean;
  view: "tiles" | "list";
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
  // The big number already says "episode N", so a title that only repeats it is not worth a line.
  const subtitle = episode.title && !GENERIC_EPISODE_TITLE.test(episode.title.trim()) ? episode.title : null;

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
          className={cn(
            "group relative flex overflow-hidden rounded-xl border transition-colors",
            view === "tiles" ? "h-[76px] flex-col items-center justify-center px-2 text-center" : "h-[62px] items-center gap-3.5 px-3.5",
            isNext ? "border-accent/70 bg-accent/[.09]" : watched ? "border-border bg-text/[.02] opacity-60 hover:opacity-100" : "border-border bg-text/[.04] hover:border-accent/40 hover:bg-text/[.07]",
          )}
        >
          {view === "list" ? (
            <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-base font-bold tabular-nums transition-colors", isNext || percent > 0 ? "bg-accent/20 text-accent-text" : "bg-text/[.07] text-text/80 group-hover:bg-accent/15 group-hover:text-accent-text")}>{episode.number}</span>
          ) : (
            // The number gives way to a play button under the pointer, in the same spot.
            <span className="relative flex h-9 w-full items-center justify-center">
              <span className={cn("text-xl font-bold leading-none tabular-nums transition-[opacity,transform] duration-200 group-hover:scale-75 group-hover:opacity-0", isNext || percent > 0 ? "text-accent-text" : watched ? "text-muted" : "text-text")}>{episode.number}</span>
              <span className="absolute flex h-9 w-9 scale-75 items-center justify-center rounded-full bg-accent text-accent-fg opacity-0 shadow-lg transition-[opacity,transform] duration-200 group-hover:scale-100 group-hover:opacity-100">
                <Play className="ml-0.5 h-4 w-4 fill-current" strokeWidth={0} />
              </span>
            </span>
          )}
          {view === "tiles" && subtitle && <span className="mt-1.5 line-clamp-1 w-full select-text text-[11px] text-muted">{subtitle}</span>}
          {view === "list" && (
            <span className="flex min-w-0 flex-1 flex-col text-left">
              <span className="line-clamp-1 select-text text-sm font-semibold text-text/90">{subtitle ?? t("detail.episodeFallback", { number: episode.number })}</span>
              {/* What became of it, in words: the row has room for one short line and this is the one worth having. */}
              {(watched || percent > 0 || isNext || isDownloaded || download?.status === "done") && (
                <span className="mt-0.5 line-clamp-1 text-[11px] text-muted">
                  {watched ? t("detail.episodeStatus.watched") : percent > 0 ? t("detail.episodeStatus.progress", { percent: Math.round(percent) }) : isNext ? t("detail.episodeStatus.next") : t("detail.episodeStatus.downloaded")}
                </span>
              )}
            </span>
          )}
          {/* In tiles, its own corner badge; in list, folded into the icon group below instead of
              sitting here as its own flex child - this row's gap is meant for its two or three
              real sections (number, title, icon group), not one icon on its own, which is what
              was leaving it looking oddly far from the rest. */}
          {isFavorite && view === "tiles" && <Heart className="absolute left-1.5 top-1.5 h-3 w-3 shrink-0 fill-rose-400 text-rose-400" strokeWidth={0} />}
          <span
            className={cn(
              "flex items-center gap-1.5 transition-transform duration-200",
              view === "tiles" ? "absolute right-1.5 top-1.5 gap-1" : "shrink-0",
              // Pinned to the row's right edge same as always; on hover they just make room for
              // the play button rather than it landing on top of them or them vanishing outright.
              view === "list" && !downloading && !paused && "group-hover:-translate-x-8",
            )}
          >
            {isFavorite && view === "list" && <Heart className="h-3 w-3 shrink-0 fill-rose-400 text-rose-400" strokeWidth={0} />}
            {queued && <Clock className="h-3 w-3 text-muted" strokeWidth={2.25} />}
            {(download?.status === "error" || download?.status === "unsupported") && <TriangleAlert className="h-3 w-3 text-rose-400" strokeWidth={2.5} />}
            {(downloading || paused) && (
              <>
                <span className="text-[10px] font-semibold tabular-nums text-accent-text">{downloadPercent}%</span>
                <button
                  type="button"
                  onClick={onTogglePause}
                  aria-label={downloading ? t("detail.episodeMenu.pauseDownload") : t("detail.episodeMenu.resumeDownload")}
                  title={downloading ? t("detail.episodeMenu.pauseDownload") : t("detail.episodeMenu.resumeDownload")}
                  className="flex h-4 w-4 items-center justify-center rounded-full bg-accent/15 text-accent-text transition-colors hover:bg-accent/25"
                >
                  {downloading ? <Pause className="h-2.5 w-2.5 fill-current" strokeWidth={0} /> : <Play className="h-2.5 w-2.5 fill-current" strokeWidth={0} />}
                </button>
              </>
            )}
            {!downloading && !paused && (isDownloaded || download?.status === "done") && <Download className="h-3 w-3 text-emerald-400" strokeWidth={2.5} />}
            {watched && <Check className="h-3 w-3 text-muted" strokeWidth={2.5} />}
          </span>
          {/* The list's own affordance: takes the spot the icons above just made room for by
              sliding left, rather than covering them or a spot of its own further out. */}
          {view === "list" && !downloading && !paused && (
            <span className="absolute right-3.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-accent-fg opacity-0 transition-opacity duration-200 group-hover:opacity-100">
              <Play className="h-3 w-3 fill-current" strokeWidth={0} />
            </span>
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

function Overview({ anime, libraryCategory, onSetLibraryCategory, onRemoveFromLibrary, onPosterClick, continueTarget, sourceId, animeId, source, related }: { anime: AnimeTitle; libraryCategory: LibraryCategory | null; onSetLibraryCategory: (category: LibraryCategory) => void; onRemoveFromLibrary: () => void; onPosterClick: () => void; continueTarget?: { groupId: string; episodeId: string; label: string }; sourceId: string; animeId: string; source: SourceInfo | undefined; related: RelatedAnimeTitle[] }) {
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
        <button
          type="button"
          onClick={onPosterClick}
          disabled={!anime.posterUrl}
          className="group block aspect-[2/3] w-full overflow-hidden rounded-2xl bg-surface text-left shadow-[0_20px_50px_rgba(0,0,0,.5)] ring-1 ring-border transition-[transform,box-shadow] hover:scale-[1.015] hover:shadow-[0_24px_56px_rgba(0,0,0,.58)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:hover:scale-100"
        >
          {anime.posterUrl ? <img src={anime.posterUrl} alt={title} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted">{t("common.noPoster")}</div>}
        </button>
      </div>
      <div className="min-w-0 flex-1 pt-1">
        <h1 className="max-w-2xl select-text text-3xl font-bold leading-[1.1] tracking-[-.03em] text-text md:text-4xl">{title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-medium text-muted">
          {anime.year ? <span>{anime.year}</span> : null}
          {anime.type && <>{anime.year ? <Dot /> : null}<span className="uppercase">{anime.type}</span></>}
          {statusLabel && <><Dot /><span className={cn("rounded-md px-1.5 py-0.5 font-semibold", anime.status === "ongoing" ? "bg-accent/15 text-accent-text" : "bg-text/10 text-muted")}>{statusLabel}</span></>}
          {episodesLabel && <><Dot /><span>{episodesLabel}</span></>}
          {/* Fixed emerald, not the app's own accent color - mirrors Android's "next episode"
              pill, which is deliberately always green regardless of the current theme. */}
          {nextEpisodeLabel && <><Dot /><span className="flex items-center gap-1 rounded-md bg-emerald-400/15 px-1.5 py-0.5 font-semibold text-emerald-500 dark:text-emerald-400"><Clock className="h-3 w-3" strokeWidth={2.5} />{nextEpisodeLabel}</span></>}
          {/* The scores a card in any list already shows - the page that a card leads to was the
              one place they were missing. */}
          {(anime.ratings?.length ?? 0) > 0 && <><Dot /><SourceRatings ratings={anime.ratings ?? []} /></>}
        </div>
        {anime.genres && anime.genres.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{anime.genres.map((g) => <GenreChip key={g} genre={g} sourceId={sourceId} className={GENRE_CHIP_CLASS} />)}</div>}
        {anime.description && <div className="mt-4 max-w-2xl overflow-hidden transition-[max-height] duration-300 ease-in-out" style={{ maxHeight }}>
          <p ref={descriptionRef} className="select-text text-sm leading-6 text-muted">{anime.description}</p>
        </div>}
        {anime.description && <button onClick={() => setDescriptionOpen((v) => !v)} className="mt-1.5 inline-flex items-center gap-1 text-xs font-semibold text-muted transition hover:text-text">{descriptionOpen ? t("common.hideDescription") : t("common.readDescription")}<ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-300", descriptionOpen && "rotate-180")} strokeWidth={2.5} /></button>}
        <div className="mt-6 flex items-center gap-3">
          {continueTarget ? <Link to="/watch/$sourceId/$animeId/$groupId/$episodeId" params={{ sourceId, animeId, groupId: continueTarget.groupId, episodeId: continueTarget.episodeId }} className="inline-flex items-center gap-2 rounded-xl bg-text px-5 py-3 text-sm font-bold text-bg transition-transform hover:scale-[1.02] active:scale-[0.98]"><Play className="h-4 w-4 fill-current" strokeWidth={0} />{continueTarget.label}</Link>
            : <span className="inline-flex items-center gap-2 rounded-xl bg-text/10 px-5 py-3 text-sm font-bold text-muted">{t("detail.noEpisodes")}</span>}
          <LibraryButton category={libraryCategory} onSelect={onSetLibraryCategory} onRemove={onRemoveFromLibrary} />
          {source && <RatingButton source={source} animeId={animeId} />}
          {/* Only when the source supplied one: an id here is whatever that site identifies titles
              by, which is often not what its URLs use, so nothing outside the source can build this.
              Opens in the browser - see the window-open handler in main/index.ts. */}
          {anime.pageUrl && (
            <a
              href={anime.pageUrl}
              target="_blank"
              rel="noreferrer"
              title={t("detail.openOnSite")}
              aria-label={t("detail.openOnSite")}
              className="inline-flex h-[46px] w-[46px] items-center justify-center rounded-xl border border-border bg-text/[.05] text-muted transition-colors hover:bg-text/[.09] hover:text-text"
            >
              <ExternalLink className="h-[18px] w-[18px]" strokeWidth={2} />
            </a>
          )}
        </div>
      </div>
    </div>
    {related.length > 0 && <div className="mt-8">
      <RelatedList items={related} sourceId={sourceId} currentAnimeId={animeId} />
    </div>}
  </section>;
}

// Kept in a portal because this page can itself apply backdrop-filter for background themes.
// That CSS property turns fixed descendants into page-relative elements, which makes an image
// viewer drift away from the viewport after the details page has been scrolled.
function PosterPreview({ posterUrl, title, onClose }: { posterUrl: string; title: string; onClose: () => void }) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-x-0 bottom-0 top-10 z-[100] flex items-center justify-center bg-black/[.78] p-8 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.94 }}
        transition={{ type: "spring", stiffness: 360, damping: 30 }}
        // Click-through: only the image and the button take clicks, so the empty space around them
        // reaches the overlay and closes the preview.
        className="pointer-events-none relative flex h-full w-full items-center justify-center"
      >
        <SmoothImage src={posterUrl} alt={title} className="pointer-events-auto max-h-full max-w-full rounded-xl object-contain shadow-2xl" />
        <button
          type="button"
          onClick={onClose}
          aria-label={t("detail.back")}
          title={t("detail.back")}
          className="pointer-events-auto absolute right-0 top-0 flex h-10 w-10 items-center justify-center rounded-xl bg-black/45 text-white/80 shadow-lg backdrop-blur-sm transition-colors hover:bg-black/65 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X className="h-5 w-5" strokeWidth={2.5} />
        </button>
      </motion.div>
    </motion.div>,
    document.body,
  );
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

// The title page's own look for a genre chip - see GenreChip for the shared open-the-catalog logic.
const GENRE_CHIP_CLASS = "rounded-full border border-border bg-text/[.03] px-3 py-1 text-xs font-medium text-text/75 hover:border-accent/50 hover:bg-accent/[.06] hover:text-text";

// Six fill two rows of the widest layout (three columns) and three of the usual two.
const RELATED_COLLAPSED_COUNT = 6;

// The franchise around this title (seasons, films, spin-offs) as a short list of continuations, not a
// second row of posters: what tells them apart is their type, year and status, which a poster with a
// near-identical name under it does not say. The current title stays in place - it shows where in the
// order you are - marked, and not a link.
function RelatedList({ items, sourceId, currentAnimeId }: { items: RelatedAnimeTitle[]; sourceId: string; currentAnimeId: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, RELATED_COLLAPSED_COUNT);
  // The current title never hides behind the fold: cut off, the list would not say where you are.
  const currentIndex = items.findIndex((item) => item.id === currentAnimeId);
  const visible = !expanded && currentIndex >= RELATED_COLLAPSED_COUNT ? [...shown.slice(0, RELATED_COLLAPSED_COUNT - 1), items[currentIndex]] : shown;
  return (
    <div>
      <h2 className="mb-3 flex items-baseline gap-2 text-xl font-bold tracking-[-.02em] text-text">
        {t("detail.relatedTitles")}
        <span className="text-sm font-semibold tabular-nums text-muted">{items.length}</span>
      </h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-2">
        {visible.map((item) => {
          const isCurrent = item.id === currentAnimeId;
          const status = item.status ? (STATUS_ID_ALIASES[item.status] ?? item.status) : null;
          const meta = [
            item.type ? item.type.toUpperCase() : null,
            item.year ? String(item.year) : null,
            status ? t(`detail.status.${status}`, { defaultValue: status }) : null,
          ].filter(Boolean).join(" · ");
          const body = (
            <>
              {isCurrent && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-accent" />}
              <div className="h-[72px] w-12 shrink-0 overflow-hidden rounded-md bg-surface ring-1 ring-border">
                {item.posterUrl && <SmoothImage src={item.posterUrl} alt={item.title} className="h-full w-full object-cover" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className={cn("line-clamp-2 text-sm font-semibold leading-snug", isCurrent ? "text-text" : "text-text/90 group-hover:text-text")}>{item.title}</p>
                {meta && <p className="mt-1 line-clamp-1 text-xs text-muted">{meta}</p>}
              </div>
              {isCurrent ? (
                <span className="shrink-0 rounded-md bg-accent/15 px-2 py-1 text-[11px] font-semibold text-accent-text">{t("detail.relatedHere")}</span>
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-text" strokeWidth={2.25} />
              )}
            </>
          );
          const rowClass = "group relative flex items-center gap-3.5 rounded-xl border p-2.5 pl-3.5 transition-colors";
          return isCurrent ? (
            <div key={item.id} title={t("detail.relatedCurrentTitle")} className={cn(rowClass, "border-accent/30 bg-accent/[.06]")}>{body}</div>
          ) : (
            <Link key={item.id} to="/anime/$sourceId/$animeId" params={{ sourceId, animeId: item.id }} className={cn(rowClass, "border-border bg-text/[.03] hover:border-accent/40 hover:bg-text/[.06]")}>{body}</Link>
          );
        })}
      </div>
      {items.length > RELATED_COLLAPSED_COUNT && (
        <button
          onClick={() => setExpanded((open) => !open)}
          className="mt-2 flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-muted transition-colors hover:text-text"
        >
          {expanded ? t("detail.relatedShowLess") : t("detail.relatedShowMore", { count: items.length - visible.length })}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}
