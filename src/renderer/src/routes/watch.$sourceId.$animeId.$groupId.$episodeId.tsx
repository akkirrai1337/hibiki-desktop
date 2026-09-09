import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Loader2, TriangleAlert } from "lucide-react";
import type { PlayerLink } from "@shared/types";
import { pickDefaultLink, pickPlaybackFallback, pickPreferredLink, pickResolvedLink } from "@/lib/playerLinks";
import { hibiki, downloadFileUrl } from "@/lib/hibiki";
import { log } from "@/lib/log";
import { usePlayerPrefsStore } from "@/stores/playerPrefsStore";
import { usePlayerSelectionStore } from "@/stores/playerSelectionStore";
import { VideoPlayer } from "@/features/player/VideoPlayer";
import { animeTitle } from "@/components/AnimeCard";
import { ACTIVITY_DAYS, buildActivitySeries, computeStreaks } from "@/components/StreakBadge";

// How long to hold the toast visible before clearing it back to null - matches StreakToast's own
// enter (480ms) + the 2s hold the user asked for. Clearing the state doesn't cut its exit
// animation short: AnimatePresence in VideoPlayer keeps it mounted through the exit variant on its
// own, so this only needs to cover enter+hold, not the full round trip.
const STREAK_TOAST_HOLD_MS = 2000;

export const Route = createFileRoute("/watch/$sourceId/$animeId/$groupId/$episodeId")({
  component: WatchPage,
});

const SAVE_INTERVAL_MS = 5000;
// Progress ticks arrive several times a second while playing, so anything past a couple of seconds
// is a jump rather than elapsed playback.
const PLAYED_TICK_MAX_MS = 2500;
// Matches Android's own DiscordRpcManager.MIN_PUBLISH_INTERVAL_MS - no need to hit the local
// Discord IPC socket every progress tick, timestamps already convey a moving playhead on their own.
const DISCORD_UPDATE_INTERVAL_MS = 16_000;

/** A downloaded HLS episode is saved as one raw MPEG-TS file (see main/ipc/downloads.ts's
 * downloadHls) - Chromium's <video> has no native demuxer for that container outside of Media
 * Source Extensions, so handing it to `video.src` directly fails immediately with
 * "FFmpegDemuxer: open context failed" (confirmed: the file itself is a perfectly valid H.264
 * stream, ffprobe reads it fine - this is purely about how a bare <video> element is willing to
 * open it). hls.js already solves exactly this for live HLS by transmuxing TS into fragmented MP4
 * for MSE - this just gives it a one-segment, single-file "playlist" (this app's downloads only
 * ever produce one output file per episode, so there's nothing to actually list) referencing the
 * local file through this app's own download-serving protocol, so hls.js's existing pipeline
 * handles a downloaded episode exactly the way it already handles a live stream's segments,
 * instead of a second parallel playback path needing its own testing/maintenance. A real
 * MP4 download (DIRECT_MP4 sources) skips all of this - Chromium plays that container natively,
 * so it's handed to `video.src` as-is, same as before.
 *
 * `durationSeconds` drives the playlist's own `#EXTINF`/`#EXT-X-TARGETDURATION` - it's the real
 * total, summed from the source playlist's own #EXTINF values while downloading (see
 * downloads.ts's downloadHls), not a placeholder: a made-up value here is exactly what showed up
 * on the timeline as a nonsense multi-hour duration before, since hls.js/the <video> element take
 * it at face value for the displayed duration and the 90%-watched threshold alike. An episode
 * downloaded before that was tracked falls back to a permissive placeholder (still wrong, but
 * only discovered as such once real data arrives - see the `ended` handling this leans on). */
function localFileLink(filePath: string, durationMs: number | null, quality: string | null): PlayerLink {
  if (!filePath.toLowerCase().endsWith(".ts")) return { url: downloadFileUrl(filePath), type: "DIRECT_MP4", quality };
  const durationSeconds = durationMs ? Math.ceil(durationMs / 1000) : 100_000;
  const playlist = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${durationSeconds}`,
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXTINF:${durationSeconds},`,
    downloadFileUrl(filePath),
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
  return { url: `data:application/vnd.apple.mpegurl;base64,${btoa(unescape(encodeURIComponent(playlist)))}`, type: "DIRECT_HLS", quality };
}

function WatchPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const router = useRouter();
  const { sourceId, animeId, groupId, episodeId } = Route.useParams();
  const lastSaveRef = useRef(0);
  const watchedSentRef = useRef(false);
  const lastDiscordUpdateRef = useRef(0);
  const lastPlaybackRef = useRef({ positionMs: 0, durationMs: 0 });
  // Time that actually played since the last save, and the position the previous progress tick
  // reported. A tick that moved further than PLAYED_TICK_MAX_MS is a seek, not playback, and adds
  // nothing - which is the whole point: skipping to the end of a film is not watching it.
  const playedMsRef = useRef(0);
  const lastTickPositionRef = useRef<number | null>(null);
  // The individual seconds of this episode that actually played, not yet reported to the source's
  // account. A count would not do: the account counts distinct seconds seen, so rewatching the
  // same minute twice is one minute there, and only the offsets themselves can say that.
  const unreportedSecondsRef = useRef(new Set<number>());
  const queryClient = useQueryClient();

  // Same query key as the profile page's own activity query - watching here and then checking the
  // profile page reads from (and refetches into) the same cache entry instead of two independent
  // copies drifting apart.
  const activityQuery = useQuery({ queryKey: ["dailyActivity", ACTIVITY_DAYS], queryFn: () => hibiki.progress.listDailyActivity(ACTIVITY_DAYS) });
  const streak = useMemo(() => computeStreaks(buildActivitySeries(activityQuery.data ?? [], ACTIVITY_DAYS)), [activityQuery.data]);

  // Announces the moment the streak count itself goes up while an episode is playing - not just
  // "you watched something", the actual day-over-day increment (today flipping from inactive to
  // active, extending the run). `prevStreakRef` starts unset so the very first successful load
  // (whatever the streak already was before this session) never fires the toast on its own; only a
  // later increase, caused by watching just now, does.
  const [streakToast, setStreakToast] = useState<{ current: number; best: number } | null>(null);
  const prevStreakRef = useRef<number | null>(null);
  useEffect(() => {
    if (!activityQuery.isSuccess) return;
    const prev = prevStreakRef.current;
    prevStreakRef.current = streak.current;
    if (prev === null || streak.current <= prev) return;
    setStreakToast({ current: streak.current, best: streak.best });
    const timer = setTimeout(() => setStreakToast(null), STREAK_TOAST_HOLD_MS);
    return () => clearTimeout(timer);
  }, [streak.current, streak.best, activityQuery.isSuccess]);

  // The detail page's episode chips / continue button read cached progress queries that would
  // otherwise sit stale (staleTime: 60s) until well after the user has already navigated back.
  useEffect(() => () => {
    queryClient.invalidateQueries({ queryKey: ["progress-all", sourceId, animeId] });
    queryClient.invalidateQueries({ queryKey: ["progress", sourceId, animeId, episodeId] });
  }, [queryClient, sourceId, animeId, episodeId]);

  // staleTime: Infinity + refetchOnWindowFocus: false - a resolved episode's links don't change
  // while you're actively watching it, but the global default (60s staleTime, refetch on focus)
  // would otherwise silently refetch this in the background on any window blur/refocus during a
  // watch session longer than a minute (alt-tab, opening DevTools, ...). That refetch returns a
  // fresh array *reference* even when the content is identical, which - through pickDefaultLink()
  // below and VideoPlayer's `link` prop - looked exactly like "the player randomly resets/reloads
  // itself mid-episode": the source-setup effect keys off `link`, so a new reference re-triggers
  // the whole hls.js (re)attach, snapping playback back near the last saved progress checkpoint.
  const linksQuery = useQuery({
    queryKey: ["playerLinks", sourceId, animeId, groupId, episodeId],
    queryFn: () => hibiki.sources.playerLinks(sourceId, animeId, groupId, episodeId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // A downloaded copy always wins over resolving a live link - there's no network dependency to
  // fail while offline, no ads/embed page, and no reason to re-download bandwidth you already
  // spent once. `staleTime: Infinity` since a file that's already on disk doesn't need re-checking
  // mid-episode any more than the queries above do.
  const downloadedQuery = useQuery({
    queryKey: ["downloadedEpisode", sourceId, animeId, episodeId],
    queryFn: () => hibiki.downloads.getForEpisode(sourceId, animeId, episodeId),
    staleTime: Infinity,
  });

  // A manual pick (from the in-player "Player"/"Quality" menu) only applies to the episode it was
  // made on - a new episode goes back to the auto-picked default rather than carrying forward a
  // choice that might not even exist for it.
  const [manualLink, setManualLink] = useState<PlayerLink | null>(null);
  const [sourceSwitching, setSourceSwitching] = useState(false);
  const selectionRequestRef = useRef(0);
  const failedPlaybackUrlsRef = useRef(new Set<string>());
  useEffect(() => {
    selectionRequestRef.current += 1;
    failedPlaybackUrlsRef.current.clear();
    setManualLink(null);
    setSourceSwitching(false);
    // The new episode starts wherever it starts; carrying the previous one's last tick over would
    // read the jump between them as either playback or a seek, and neither is true.
    playedMsRef.current = 0;
    lastTickPositionRef.current = null;
    unreportedSecondsRef.current = new Set();
  }, [episodeId]);

  const selectLink = useCallback(async (selected: PlayerLink) => {
    const requestId = ++selectionRequestRef.current;
    if (selected.type !== "EMBED") {
      setSourceSwitching(false);
      setManualLink(selected);
      return;
    }

    setSourceSwitching(true);
    const startedAt = Date.now();
    log.info("player", `resolving embed ${selected.playerName ?? "?"}/${selected.translation ?? "?"} ${selected.url}`);
    try {
      const resolved = await hibiki.sources.resolvePlayerLink(selected);
      log.info("player", `resolved ${selected.playerName ?? "?"} in ${Date.now() - startedAt}ms -> ${resolved.length} link(s)`);
      if (requestId !== selectionRequestRef.current) return;
      const playable = resolved.filter((candidate) => candidate.type !== "EMBED");
      // An EMBED link resolves into a whole set of renditions, so the pick that got us here has to
      // survive that expansion: taking pickDefaultLink()'s own default outright is what made an
      // explicit quality choice look like it silently snapped back to whatever the source lists
      // first. Keep the requested quality when the resolved set actually offers it.
      const next = pickResolvedLink(playable, selected);
      if (!next) {
        setManualLink(selected);
        return;
      }

      queryClient.setQueryData<PlayerLink[]>(
        ["playerLinks", sourceId, animeId, groupId, episodeId],
        (current) => current?.flatMap((candidate) =>
          candidate.url === selected.url &&
          candidate.playerName === selected.playerName &&
          candidate.translation === selected.translation
            ? playable
            : [candidate]
        ),
      );
      setManualLink(next);
    } catch (error) {
      if (requestId !== selectionRequestRef.current) return;
      log.warn("player", `failed to resolve ${selected.playerName ?? selected.url}:`, error);
      setManualLink(selected);
    } finally {
      if (requestId === selectionRequestRef.current) setSourceSwitching(false);
    }
  }, [queryClient, sourceId, animeId, groupId, episodeId]);

  // Only the *explicit* picks (the in-player settings menu) get remembered - selectLink itself is
  // also called by the resume logic below, and letting that write back would just re-save what it
  // had already read, turning a one-off fallback into a sticky preference.
  const rememberSelection = usePlayerSelectionStore((s) => s.remember);
  const selectLinkManually = useCallback((selected: PlayerLink) => {
    rememberSelection(sourceId, animeId, groupId, { playerName: selected.playerName ?? null, translation: selected.translation ?? null });
    void selectLink(selected);
  }, [rememberSelection, selectLink, sourceId, animeId, groupId]);

  const handlePlaybackFailure = useCallback((failed: PlayerLink, reason: string): boolean => {
    if (downloadedQuery.data) return false;
    failedPlaybackUrlsRef.current.add(failed.url);
    const candidates = queryClient.getQueryData<PlayerLink[]>(["playerLinks", sourceId, animeId, groupId, episodeId]) ?? [];
    const fallback = pickPlaybackFallback(candidates, failed, failedPlaybackUrlsRef.current);
    if (!fallback) return false;
    log.warn(
      "player",
      `stream failed (${reason}); falling back ${failed.playerName ?? "?"}/${failed.quality ?? "?"} -> ${fallback.playerName ?? "?"}/${fallback.quality ?? "?"}`,
    );
    void selectLink(fallback);
    return true;
  }, [downloadedQuery.data, queryClient, sourceId, animeId, groupId, episodeId, selectLink]);

  // Same reasoning as linksQuery above: this is only ever read once, for the initial resume-seek
  // (VideoPlayer's `startPositionMs`) - a background refetch pulling back the position *we
  // ourselves* just saved a moment ago (via onProgress below) would otherwise change that number
  // and, through the source-setup effect's dependency on it, reset/reload the player mid-episode.
  const progressQuery = useQuery({
    queryKey: ["progress", sourceId, animeId, episodeId],
    queryFn: () => hibiki.progress.get(sourceId, animeId, episodeId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  // Resuming a title should keep the dub/player you actually picked last time, not silently
  // revert to pickDefaultLink()'s own default ordering - once both the saved progress and the
  // live link list are in, look for a link matching what was last watched through and adopt it as
  // this episode's own starting pick (still a plain `manualLink`, so an explicit pick from the
  // settings menu during this session overrides it exactly the same way as always).
  //
  // This has to settle *before* anything starts playing: `link` below used to fall back to
  // pickDefaultLink()'s default the moment the link list arrived, so resuming an Alloha episode
  // visibly loaded Kodik first and only then swapped over once the saved preference was applied.
  // `preferencePending` keeps `link` undefined (plain loading spinner) until either the saved
  // pick has been adopted or there turns out to be nothing to adopt.
  const [preferencePending, setPreferencePending] = useState(true);
  useEffect(() => { setPreferencePending(true); }, [episodeId]);
  useEffect(() => {
    if (manualLink) { setPreferencePending(false); return; }
    // A downloaded copy wins over any link list anyway, so there's nothing to wait for.
    if (downloadedQuery.data) { setPreferencePending(false); return; }
    // Still loading: stay pending rather than reading "no saved pick" out of a query that simply
    // hasn't answered yet (progress legitimately resolves to null for a first watch).
    if (!progressQuery.isFetched || !linksQuery.data) return;
    // The saved per-title/dub pick wins over this episode's own watch_progress row: both describe
    // a deliberate choice, but the stored one is by definition the most recent (it's written on
    // every pick, while progress only records what an episode happened to be watched through).
    // Read imperatively - subscribing to the store here would re-run this effect on every pick.
    const remembered = usePlayerSelectionStore.getState().get(sourceId, animeId, groupId);
    const translation = remembered?.translation ?? progressQuery.data?.translation;
    const playerName = remembered?.playerName ?? progressQuery.data?.playerName;
    const preferred = pickPreferredLink(linksQuery.data, { translation, playerName });
    // Nothing saved at all, or no link matches it any more (source reshuffled its players, the dub
    // is gone) - release the gate and let the default pick play.
    if (!preferred) { setPreferencePending(false); return; }
    void selectLink(preferred);
  }, [manualLink, downloadedQuery.data, progressQuery.isFetched, progressQuery.data, linksQuery.data, selectLink, sourceId, animeId, groupId, episodeId]);

  // Reused from the title-detail page's own queries (same queryKeys) so these are normally cache
  // hits, not extra network calls. Same staleTime/refetchOnWindowFocus reasoning as linksQuery -
  // this feeds prevEpisode/nextEpisode below, and those flow into onPrevEpisode/onNextEpisode
  // props that VideoPlayer's own effects key off, so a background refetch here is just as capable
  // of resetting the player mid-episode as one on linksQuery/progressQuery was.
  const animeQuery = useQuery({ queryKey: ["anime", sourceId, animeId], queryFn: () => hibiki.sources.getById(sourceId, animeId), staleTime: Infinity, refetchOnWindowFocus: false });
  const groupsQuery = useQuery({
    queryKey: ["playbackGroups", sourceId, animeId],
    queryFn: () => hibiki.sources.playbackGroups(sourceId, animeId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const group = groupsQuery.data?.find((g) => g.id === groupId);
  const episodeIndex = group?.episodes.findIndex((e) => e.id === episodeId) ?? -1;
  const episode = episodeIndex >= 0 ? group!.episodes[episodeIndex] : undefined;
  const prevEpisode = episodeIndex > 0 ? group!.episodes[episodeIndex - 1] : undefined;
  const nextEpisode = episodeIndex >= 0 && episodeIndex < (group?.episodes.length ?? 0) - 1 ? group!.episodes[episodeIndex + 1] : undefined;
  const episodeNumber = episode?.number ?? 0;

  // Only checked at all while the *current* episode is itself a downloaded copy - if this episode
  // came from a live link, prev/next should behave exactly as they always have (no reason to
  // second-guess a source that's clearly reachable). Playing from a downloaded copy usually means
  // deliberately watching offline, so silently falling through to a live fetch for whichever
  // neighboring episode isn't downloaded too would just be a needless network attempt at best and
  // a dead-end error screen at worst - see localFileLink above for the matching player-side half
  // of downloaded playback.
  const neighborsDownloadedQuery = useQuery({
    queryKey: ["downloadedEpisode", "neighbors", sourceId, animeId, prevEpisode?.id, nextEpisode?.id],
    queryFn: () =>
      Promise.all([
        prevEpisode ? hibiki.downloads.getForEpisode(sourceId, animeId, prevEpisode.id) : null,
        nextEpisode ? hibiki.downloads.getForEpisode(sourceId, animeId, nextEpisode.id) : null,
      ]),
    enabled: !!downloadedQuery.data && (!!prevEpisode || !!nextEpisode),
  });
  const [prevDownloaded, nextDownloaded] = neighborsDownloadedQuery.data ?? [null, null];

  const goToEpisode = useCallback(
    (targetEpisodeId: string) => navigate({ to: "/watch/$sourceId/$animeId/$groupId/$episodeId", params: { sourceId, animeId, groupId, episodeId: targetEpisodeId } }),
    [navigate, sourceId, animeId, groupId],
  );
  // Switching dub means switching PlaybackGroup, and groups number their episodes independently
  // (different ids, sometimes a different count) - match on episode *number* first so "episode 7"
  // stays episode 7, fall back to the same position in the list, and finally to the first episode
  // for a dub that simply doesn't have this one yet.
  const selectDub = useCallback(
    (targetGroupId: string) => {
      const target = groupsQuery.data?.find((g) => g.id === targetGroupId);
      if (!target || target.episodes.length === 0) return;
      const targetEpisode =
        target.episodes.find((e) => e.number === episodeNumber)
        ?? target.episodes[episodeIndex]
        ?? target.episodes[0];
      navigate({ to: "/watch/$sourceId/$animeId/$groupId/$episodeId", params: { sourceId, animeId, groupId: targetGroupId, episodeId: targetEpisode.id } });
    },
    [navigate, groupsQuery.data, sourceId, animeId, episodeNumber, episodeIndex],
  );
  // A real history.back() (not a push to the detail route) so the titlebar's back/forward arrows
  // stay consistent with "Escape" - otherwise this would push a *new* detail-page entry, leaving
  // the actual previous page one back-click further away than pressing the titlebar's own arrow.
  const goBack = useCallback(() => router.history.back(), [router]);

  // Memoized, not recomputed inline - pickDefaultLink() builds a fresh array/object every call,
  // so without this `link` (and the onPrevEpisode/onNextEpisode callbacks below) got a new
  // identity on *every* WatchPage render regardless of whether the underlying data actually
  // changed, which - through VideoPlayer's effects keying off them - reset/reloaded the player on
  // basically any unrelated re-render, not just background refetches (see the queries above).
  const link = useMemo((): PlayerLink | undefined => {
    if (downloadedQuery.data) return localFileLink(downloadedQuery.data.filePath, downloadedQuery.data.durationMs, downloadedQuery.data.quality);
    if (manualLink) return manualLink;
    if (preferencePending) return undefined;
    return pickDefaultLink(linksQuery.data);
  }, [downloadedQuery.data, manualLink, preferencePending, linksQuery.data]);
  // Currently playing a downloaded copy, and this particular neighbor isn't one itself.
  const prevBlockedOffline = !!prevEpisode && !!downloadedQuery.data && !prevDownloaded;
  const nextBlockedOffline = !!nextEpisode && !!downloadedQuery.data && !nextDownloaded;
  const onPrevEpisode = useMemo(
    () => (prevEpisode && !prevBlockedOffline ? () => goToEpisode(prevEpisode.id) : undefined),
    [prevEpisode, goToEpisode, prevBlockedOffline],
  );
  const onNextEpisode = useMemo(
    () => (nextEpisode && !nextBlockedOffline ? () => goToEpisode(nextEpisode.id) : undefined),
    [nextEpisode, goToEpisode, nextBlockedOffline],
  );
  // A stable identity across renders (not an inline arrow prop) - VideoPlayer's own capture effect
  // has this in its dependency list, and a new identity every render would re-trigger that whole
  // effect (rebinding every <video> listener) on every unrelated render, the exact class of bug
  // this file's other memoized callbacks above were already written to avoid.
  const thumbnailCache = useMemo(() => ({ dataUrl: null as string | null }), [sourceId, animeId, episodeId]);
  const onCaptureThumbnail = useCallback(
    (dataUrl: string) => {
      thumbnailCache.dataUrl = dataUrl;
      // The history page's own query (["recent-progress", limit]) has a 60s staleTime (see
      // main.tsx's QueryClient) and, being one of PERSISTED_PAGES, never actually remounts on a
      // later visit to re-trigger a fetch on its own - without this, a thumbnail saved just now
      // wouldn't show up there until that 60s window happened to lapse on its own.
      hibiki.progress.saveThumbnail(sourceId, animeId, episodeId, dataUrl).then(() => {
        queryClient.invalidateQueries({ queryKey: ["recent-progress"] });
      }).catch((error) => log.warn("player", "thumbnail save failed:", error));
    },
    [sourceId, animeId, episodeId, queryClient, thumbnailCache],
  );
  const anime = animeQuery.data;
  const title = anime ? animeTitle(anime) : "";
  const episodeLabel = episode ? (episode.title || t("detail.episodeFallback", { number: episode.number })) : "";
  // A link's own `translation` (see runtime.ts's resolveEmbedLinks carrying it over from the
  // source EMBED link) is the actual dub playing right now, more precise than the playback
  // group's title where a source's groups don't map 1:1 to dub studios.
  const dubName = link?.translation || group?.title || null;

  // title/dubName/posterUrl each depend on their own async query (anime, playback groups) and can
  // legitimately still be loading - or arrive a beat late - right when the player first mounts.
  // Reading them through a ref (kept fresh by the effect below) rather than closing over them
  // directly keeps onProgress/onPlayStateChange's own identity stable regardless of when that data
  // shows up, so a poster loading in doesn't also re-trigger VideoPlayer's source-setup effect
  // (which keys off onProgress) - the same reset-on-unrelated-change class of bug fixed earlier for
  // `link`, just for these two callbacks instead.
  const discordMetaRef = useRef({ title: "", dubName: null as string | null, posterUrl: null as string | null });
  useEffect(() => {
    discordMetaRef.current = { title, dubName, posterUrl: anime?.posterUrl ?? null };
    // The very first update after an episode change (see the episodeId effect below) can easily
    // fire before this data has loaded at all - once it does load, correct the card right away
    // instead of leaving it poster-less/dub-less until the next throttled tick (up to 16s later).
    if (!title) return;
    lastDiscordUpdateRef.current = Date.now();
    hibiki.discord.updatePresence({
      animeTitle: title,
      translation: dubName,
      episodeNumber: episodeNumber || null,
      positionMs: lastPlaybackRef.current.positionMs,
      durationMs: lastPlaybackRef.current.durationMs,
      isPlaying: true,
      posterUrl: anime?.posterUrl ?? null,
    });
  }, [title, dubName, anime?.posterUrl, episodeNumber]);

  const watchedThreshold = usePlayerPrefsStore((s) => s.watchedThresholdPercent) / 100;
  // Plain primitives (not `link` itself) in onProgress's dependency list - same reasoning as
  // `link`/onPrevEpisode/onNextEpisode above: `link` gets a fresh object identity on effectively
  // every render once pickDefaultLink()/localFileLink() are involved, and this callback's own
  // identity feeds VideoPlayer's effects the exact same way theirs do.
  const linkTranslation = link?.translation ?? null;
  const linkPlayerName = link?.playerName ?? null;
  // The source's own id for this episode's video, which is how an account is told what was
  // watched. Absent for sources that do not report activity, and for links that never had one.
  const linkVideoId = link?.videoId ?? null;
  const onProgress = useCallback(
    (positionMs: number, durationMs: number) => {
      const previousTickPosition = lastTickPositionRef.current;
      lastTickPositionRef.current = positionMs;
      if (previousTickPosition !== null) {
        const tickMs = positionMs - previousTickPosition;
        if (tickMs > 0 && tickMs <= PLAYED_TICK_MAX_MS) {
          playedMsRef.current += tickMs;
          for (let second = Math.floor(previousTickPosition / 1000); second <= Math.floor(positionMs / 1000); second++) {
            unreportedSecondsRef.current.add(second);
          }
        }
      }
      lastPlaybackRef.current = { positionMs, durationMs };
      const watched = durationMs > 0 && positionMs / durationMs >= watchedThreshold;
      const justFinished = watched && !watchedSentRef.current;
      const now = Date.now();
      if (justFinished || now - lastSaveRef.current >= SAVE_INTERVAL_MS) {
        lastSaveRef.current = now;
        if (watched) watchedSentRef.current = true;
        const upserted = hibiki.progress.upsert({
          ...(thumbnailCache.dataUrl ? { thumbnailDataUrl: thumbnailCache.dataUrl } : {}),
          sourceId,
          titleId: animeId,
          episodeId,
          episodeNumber,
          groupId,
          translation: linkTranslation,
          playerName: linkPlayerName,
          positionMs,
          durationMs,
          watched,
          updatedAt: now,
          watchedDeltaMs: playedMsRef.current,
        });
        playedMsRef.current = 0;

        // The same seconds, told to the source's account: an episode counted and the minutes
        // really spent in it, which is what fills the day squares on a YummyAnime profile. Fire
        // and forget - a website being unreachable must not disturb playback, and the seconds are
        // only cleared once they are actually accepted, so the next save carries them again.
        const videoId = linkVideoId;
        const pending = [...unreportedSecondsRef.current];
        if (videoId && pending.length > 0) {
          unreportedSecondsRef.current = new Set();
          void hibiki.sources
            .reportPlayback(sourceId, {
              videoId,
              positionSeconds: Math.floor(positionMs / 1000),
              durationSeconds: Math.round(durationMs / 1000),
              watchedSeconds: pending,
            })
            .catch(() => {
              for (const second of pending) unreportedSecondsRef.current.add(second);
            });
        }
        // The streak-detection effect above reads straight from this same query's cache, so it
        // can't notice today's activity until this refetch actually lands. Every save, not just
        // the first one: on a resumed episode, the very first save's position can exactly match
        // what's already stored (no delta yet, so main's dailyActivity write is a no-op) - it's a
        // later save, once playback has actually moved past the resume point, that first writes
        // anything. Only invalidating once (on that possibly-empty first save) meant a real
        // increment later in the same session could go unnoticed for the rest of the episode.
        upserted.then(() => queryClient.invalidateQueries({ queryKey: ["dailyActivity", ACTIVITY_DAYS] }));
      }
      const meta = discordMetaRef.current;
      if (meta.title && now - lastDiscordUpdateRef.current >= DISCORD_UPDATE_INTERVAL_MS) {
        lastDiscordUpdateRef.current = now;
        hibiki.discord.updatePresence({
          animeTitle: meta.title,
          translation: meta.dubName,
          episodeNumber: episodeNumber || null,
          positionMs,
          durationMs,
          isPlaying: true,
          posterUrl: meta.posterUrl,
        });
      }
    },
    [sourceId, animeId, episodeId, episodeNumber, groupId, linkTranslation, linkPlayerName, linkVideoId, watchedThreshold, thumbnailCache],
  );

  // timeupdate (the only thing that drives onProgress above) simply stops firing while paused, so
  // without this a pause would leave Discord showing the last isPlaying:true timestamp, which
  // keeps counting up on its own even though nothing is actually playing - this reacts to the
  // play/pause edge directly instead of waiting for (or missing) the next throttled progress tick.
  const onPlayStateChange = useCallback(
    (playing: boolean) => {
      const meta = discordMetaRef.current;
      if (!meta.title) return;
      lastDiscordUpdateRef.current = Date.now();
      hibiki.discord.updatePresence({
        animeTitle: meta.title,
        translation: meta.dubName,
        episodeNumber: episodeNumber || null,
        positionMs: lastPlaybackRef.current.positionMs,
        durationMs: lastPlaybackRef.current.durationMs,
        isPlaying: playing,
        posterUrl: meta.posterUrl,
      });
    },
    [episodeNumber],
  );

  // A fresh episode should show up on the Discord card right away, not whenever the throttled
  // onProgress tick above next happens to fire.
  useEffect(() => {
    lastDiscordUpdateRef.current = 0;
  }, [episodeId]);

  // Leaving the player (back to the detail page, another episode, closing the app mid-watch) -
  // nothing should keep announcing an episode that's no longer playing.
  useEffect(() => () => { hibiki.discord.clearPresence(); }, []);

  return (
    <div className="relative h-full w-full bg-black">
      {/* Gated on `!link` too, not just the query's own state - once a downloaded copy makes `link`
          available, whatever linksQuery is doing (still loading, or failed because there's no
          network to resolve a live link with) no longer matters, since it isn't what's playing. */}
      {/* `preferencePending` covers the window where the links are in but the saved player/dub pick
          is still being applied (or its EMBED link resolved) - the spinner belongs there too. */}
      {!link && !linksQuery.data && !linksQuery.isError && (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-10 w-10 animate-spin text-white/70" strokeWidth={2} />
        </div>
      )}
      {!link && linksQuery.isError && (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
          <TriangleAlert className="h-8 w-8 text-rose-400" strokeWidth={2} />
          <p className="text-sm text-rose-300">{t("watch.linkError", { message: (linksQuery.error as Error).message })}</p>
          <button onClick={goBack} className="mt-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20">{t("detail.back")}</button>
        </div>
      )}
      {/* Mounted as soon as there is *something* to choose between, not only once a link has been
          settled on. While `preferencePending` is still resolving a remembered EMBED pick there is
          no `link` yet, and the player shows its own spinner over the normal chrome (see
          VideoPlayer's optional `link` prop) - which is the difference between "wait a moment" and
          "you are locked out": picking a player that resolves slowly, or never, used to leave a
          bare full-screen spinner with no settings menu to pick a different one from. */}
      {(link || linksQuery.data) && (
        <VideoPlayer
          link={link}
          availableLinks={linksQuery.data}
          offlinePlayback={!!downloadedQuery.data}
          dubOptions={groupsQuery.data}
          selectedDubId={groupId}
          onSelectDub={selectDub}
          sourceSwitching={sourceSwitching || (!link && preferencePending)}
          onSelectLink={selectLinkManually}
          onPlaybackFailure={handlePlaybackFailure}
          startPositionMs={progressQuery.data?.positionMs}
          onProgress={onProgress}
          onPlayStateChange={onPlayStateChange}
          onCaptureThumbnail={onCaptureThumbnail}
          title={title}
          episodeLabel={episodeLabel}
          onBack={goBack}
          onPrevEpisode={onPrevEpisode}
          onNextEpisode={onNextEpisode}
          streakToast={streakToast}
        />
      )}
    </div>
  );
}
