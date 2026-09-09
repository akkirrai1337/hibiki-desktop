import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import Hls from "hls.js";
import { MediaPlayer as DashMediaPlayer, type MediaPlayerClass } from "dashjs";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  FastForward,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  Settings,
  SkipBack,
  SkipForward,
  TriangleAlert,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { PlayerLink, VideoSegment } from "@shared/types";
import { pickLinkForDimension, pickLinkForQuality, playerOptions, qualityOptions, translationOptions } from "@/lib/playerLinks";
import { hibiki } from "@/lib/hibiki";
import { cn } from "@/lib/cn";
import { log } from "@/lib/log";
import { PLAYBACK_SPEEDS, usePlayerPrefsStore } from "@/stores/playerPrefsStore";
import { StreakBadge } from "@/components/StreakBadge";

interface VideoPlayerProps {
  // Optional, and that is the point: while the parent is still working out *which* link to play
  // (resolving a remembered EMBED pick - see the watch route's preferencePending) there is no link
  // yet, but the chrome around it must still be on screen. Rendering a bare full-screen spinner
  // there instead used to lock the user out completely: pick a player that resolves slowly or not
  // at all, and the settings menu needed to pick a different one was never mounted, so there was
  // no way back short of clearing the saved preference from outside the app.
  link?: PlayerLink;
  // The other links this episode could also play through - lets the in-player settings menu
  // offer a manual "Player"/"Quality" pick instead of always silently taking `link` as given.
  availableLinks?: PlayerLink[];
  // Playing a downloaded copy rather than a live stream - there's nothing to actually switch to
  // (the file on disk is the file on disk), so the settings menu's quality row shows what it is
  // but doesn't let you tap into a picker for it (see PlayerSettingsMenu's `qualityLocked`).
  offlinePlayback?: boolean;
  // The title's other dubs (its PlaybackGroups), so the settings menu can switch dub without
  // leaving the player - the per-link "translation" row below only ever covers the alternatives
  // *inside* the current group, and most sources put each dub in a group of its own, which left
  // the menu with no dub row at all.
  dubOptions?: { id: string; title: string }[];
  selectedDubId?: string;
  // Switches to the same episode under another dub - navigation, so the watch route owns it.
  onSelectDub?: (groupId: string) => void;
  sourceSwitching?: boolean;
  onSelectLink?: (link: PlayerLink) => void;
  onPlaybackFailure?: (link: PlayerLink, reason: string) => boolean;
  startPositionMs?: number;
  onProgress?: (positionMs: number, durationMs: number) => void;
  onPlayStateChange?: (playing: boolean) => void;
  // Fired with a JPEG data URL of the current frame whenever playback pauses, and once more right
  // as this episode is being left (episode switch or navigating away) - see the history page,
  // which shows it instead of a generic poster so each entry reads as "the moment you stopped".
  onCaptureThumbnail?: (dataUrl: string) => void;
  title: string;
  episodeLabel: string;
  onBack: () => void;
  onPrevEpisode?: () => void;
  onNextEpisode?: () => void;
  // Set for a few seconds right when the streak count just went up mid-episode - see StreakToast.
  streakToast?: { current: number; best: number } | null;
}

const CONTROLS_HIDE_DELAY_MS = 3000;

// A quick overshoot on the way in (it's an accomplishment, it should feel a little bouncy) and a
// plain ease-in on the way out (it's just tidying up, no reason to draw it out) - same shape as
// the one-off demo this was designed against, now the real thing.
const streakToastVariants = {
  hidden: { y: "-140%", opacity: 0 },
  visible: { y: 0, opacity: 1, transition: { duration: 0.48, ease: [0.16, 0.9, 0.3, 1.15] } },
  exit: { y: "-140%", opacity: 0, transition: { duration: 0.42, ease: [0.5, 0, 0.75, 0] } },
} as const;

function StreakToast({ streak }: { streak: { current: number; best: number } | null | undefined }) {
  return (
    <AnimatePresence>
      {streak && (
        <motion.div
          key={streak.current}
          variants={streakToastVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="pointer-events-none absolute inset-x-0 top-5 z-10 flex justify-center"
        >
          {/* `playOnMount` because this component only ever mounts as a reaction to the streak
              just changing - unlike the profile page's badge, there's no "just loading the page"
              case here to suppress the pop/burst/rotate animation for. */}
          <StreakBadge current={streak.current} best={streak.best} atRisk={false} playOnMount />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// Cheap drop-shadow (a black copy offset one pixel behind a white one) rather than a filter/
// text-shadow, matching how the Android app draws its own seek arrow.
function SeekArrowIcon({ direction }: { direction: "back" | "forward" }) {
  const Icon = direction === "back" ? ChevronLeft : ChevronRight;
  return (
    <span className="relative inline-flex h-7 w-7 items-center justify-center">
      <Icon className="absolute h-7 w-7 translate-x-px translate-y-px text-black/70" strokeWidth={2.5} />
      <Icon className="absolute h-7 w-7 text-white" strokeWidth={2.5} />
    </span>
  );
}

function segmentKey(segment: VideoSegment): string {
  return `${segment.type}-${segment.startMs}`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  // Same fix as Settings' own Switch (routes/settings.tsx) - a border on the track always (a
  // white or black custom accent color otherwise blends into this always-dark player UI just as
  // easily as it does the app's own light/dark surfaces), and bg-accent-fg (not a fixed bg-white)
  // on the knob once checked, since --color-accent-fg is already this app's "contrasts against
  // --color-accent" token - a white accent's track gets a dark knob, everything else keeps the
  // classic white one it always had.
  return <button onClick={onChange} className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/[.06]">
    <span className="text-sm text-zinc-200">{label}</span>
    {/* Flow layout + padding, not an absolutely-positioned knob: hand-placed `top`/`translate-x`
        offsets have to be re-derived every time the track's size changes, and the previous pair
        left the knob a pixel low and flush against the right edge when on. Sized to the track's
        content box (h-5 minus a 1px border and 2px padding a side = 14px) it lands centered and
        symmetric on its own - same approach as Settings' own Switch. */}
    <span className={cn("inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-white/[.15] p-0.5 transition-colors", checked ? "bg-accent" : "bg-white/[.15]")}>
      <span className={cn("h-[14px] w-[14px] rounded-full shadow ring-1 ring-black/10 transition-[transform,background-color]", checked ? "translate-x-4 bg-accent-fg" : "translate-x-0 bg-white")} />
    </span>
  </button>;
}

// `onClick` omitted entirely (not just disabled) renders this as a plain, non-interactive row -
// used for the quality row during offline playback, where there's nothing to actually switch to
// (see PlayerSettingsMenu's `qualityLocked`): shows what quality the file is without inviting a
// tap into a picker for it.
function MenuRow({ label, value, onClick }: { label: string; value: string; onClick?: () => void }) {
  if (!onClick) {
    return <div className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm text-zinc-500">
      <span>{label}</span>
      <span className="max-w-[7rem] truncate text-xs">{value}</span>
    </div>;
  }
  return <button onClick={onClick} className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-white/[.06]">
    <span>{label}</span>
    <span className="flex items-center gap-1 text-zinc-200">
      <span className="max-w-[7rem] truncate text-xs">{value}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" strokeWidth={2.5} />
    </span>
  </button>;
}

function ListPage({ title, options, selected, onSelect, onBack }: { title: string; options: string[]; selected: string | undefined; onSelect: (value: string) => void; onBack: () => void }) {
  return <div className="w-56 p-1.5">
    <button onClick={onBack} className="mb-1 flex w-full items-center gap-1 rounded-lg px-1.5 py-2 text-left text-sm font-semibold text-white transition-colors hover:bg-white/[.06]">
      <ChevronLeft className="h-4 w-4 shrink-0" strokeWidth={2.5} />
      {title}
    </button>
    <div className="max-h-64 overflow-y-auto">
      {options.map((option) => (
        <button
          key={option}
          onClick={() => onSelect(option)}
          className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-zinc-200 transition-colors hover:bg-white/[.06]"
        >
          <span className="truncate">{option}</span>
          {selected === option && <Check className="h-4 w-4 shrink-0 text-accent-text" strokeWidth={2.5} />}
        </button>
      ))}
    </div>
  </div>;
}

// A YouTube-style drill-down menu (main list -> tap "Speed" -> its own page with a back arrow)
// rather than dumping every control flat in one panel - the flat version read as a wall of options
// with no hierarchy even at just three settings, and this scales worse the more get added (as
// Player/Quality below just did). "Player"/"Quality" only appear at all once there's more than one
// value to actually choose between - most episodes only ever resolve to a single stream.
function PlayerSettingsMenu({
  playbackSpeed, onSelectSpeed,
  autoSkipSegments, onToggleAutoSkip,
  autoPlayNextEpisode, onToggleAutoPlay,
  dubOptions, selectedDubId, onSelectDub,
  translationOptions, selectedTranslation, onSelectTranslation,
  playerOptions, selectedPlayerName, onSelectPlayerName,
  qualityOptions, selectedQuality, onSelectQuality, qualityLocked,
  t,
}: {
  playbackSpeed: number;
  onSelectSpeed: (speed: (typeof PLAYBACK_SPEEDS)[number]) => void;
  autoSkipSegments: boolean;
  onToggleAutoSkip: () => void;
  autoPlayNextEpisode: boolean;
  onToggleAutoPlay: () => void;
  dubOptions: { id: string; title: string }[];
  selectedDubId: string | undefined;
  onSelectDub: (groupId: string) => void;
  translationOptions: string[];
  selectedTranslation: string | undefined;
  onSelectTranslation: (name: string) => void;
  playerOptions: string[];
  selectedPlayerName: string | undefined;
  onSelectPlayerName: (name: string) => void;
  qualityOptions: string[];
  selectedQuality: string | undefined;
  onSelectQuality: (quality: string) => void;
  // Playing a downloaded copy - see VideoPlayerProps.offlinePlayback. Shows the quality row as a
  // plain (non-clickable) label reading whatever quality it was downloaded in, instead of the
  // usual "> tap to pick from other resolutions" row, since there's nothing else to switch to.
  qualityLocked: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const [page, setPage] = useState<"main" | "speed" | "dub" | "translation" | "player" | "quality">("main");
  const selectedDub = dubOptions.find((d) => d.id === selectedDubId);

  if (page === "speed") {
    return <ListPage
      title={t("watch.settings.speed")}
      options={PLAYBACK_SPEEDS.map((speed) => `${speed}×`)}
      selected={`${playbackSpeed}×`}
      onSelect={(value) => { onSelectSpeed(Number.parseFloat(value) as (typeof PLAYBACK_SPEEDS)[number]); setPage("main"); }}
      onBack={() => setPage("main")}
    />;
  }
  if (page === "dub") {
    // Keyed by title, like every other ListPage - two groups sharing a title would be
    // indistinguishable in the list anyway, so picking the first match loses nothing.
    return <ListPage
      title={t("watch.settings.dub")}
      options={dubOptions.map((d) => d.title)}
      selected={selectedDub?.title}
      onSelect={(v) => { const picked = dubOptions.find((d) => d.title === v); if (picked) onSelectDub(picked.id); setPage("main"); }}
      onBack={() => setPage("main")}
    />;
  }
  if (page === "translation") {
    return <ListPage title={t("watch.settings.translation")} options={translationOptions} selected={selectedTranslation} onSelect={(v) => { onSelectTranslation(v); setPage("main"); }} onBack={() => setPage("main")} />;
  }
  if (page === "player") {
    return <ListPage title={t("watch.settings.player")} options={playerOptions} selected={selectedPlayerName} onSelect={(v) => { onSelectPlayerName(v); setPage("main"); }} onBack={() => setPage("main")} />;
  }
  if (page === "quality") {
    return <ListPage title={t("watch.settings.quality")} options={qualityOptions} selected={selectedQuality} onSelect={(v) => { onSelectQuality(v); setPage("main"); }} onBack={() => setPage("main")} />;
  }

  return <div className="w-56 p-1.5">
    {dubOptions.length > 0 && <MenuRow label={t("watch.settings.dub")} value={selectedDub?.title ?? "—"} onClick={dubOptions.length > 1 ? () => setPage("dub") : undefined} />}
    {translationOptions.length > 1 && <MenuRow label={t("watch.settings.translation")} value={selectedTranslation ?? "—"} onClick={() => setPage("translation")} />}
    {playerOptions.length > 0 && <MenuRow label={t("watch.settings.player")} value={selectedPlayerName ?? "—"} onClick={playerOptions.length > 1 ? () => setPage("player") : undefined} />}
    {qualityLocked
      ? selectedQuality && <MenuRow label={t("watch.settings.quality")} value={selectedQuality} />
      : qualityOptions.length > 1 && <MenuRow label={t("watch.settings.quality")} value={selectedQuality ?? "—"} onClick={() => setPage("quality")} />}
    <MenuRow label={t("watch.settings.speed")} value={`${playbackSpeed}×`} onClick={() => setPage("speed")} />
    <div className="my-1 border-t border-white/[.08]" />
    <ToggleRow label={t("watch.settings.autoSkipSegments")} checked={autoSkipSegments} onChange={onToggleAutoSkip} />
    <ToggleRow label={t("watch.settings.autoPlayNextEpisode")} checked={autoPlayNextEpisode} onChange={onToggleAutoPlay} />
  </div>;
}

export function VideoPlayer({ link, availableLinks, offlinePlayback, dubOptions, selectedDubId, onSelectDub, sourceSwitching, onSelectLink, onPlaybackFailure, startPositionMs, onProgress, onPlayStateChange, onCaptureThumbnail, title, episodeLabel, onBack, onPrevEpisode, onNextEpisode, streakToast }: VideoPlayerProps) {
  const { t } = useTranslation();
  // Held in a ref, deliberately not read as a prop from inside the effects below. Both the source
  // setup and the media-element wiring would otherwise have to list it as a dependency, and the
  // watch route rebuilds this callback whenever its own inputs change - which would tear down and
  // re-attach hls.js mid-episode, snapping playback back to the last saved checkpoint. Same
  // reasoning the comments on `link`, onProgress and onNextEpisode already spell out.
  const playbackFailureRef = useRef(onPlaybackFailure);
  playbackFailureRef.current = onPlaybackFailure;
  const reportPlaybackFailure = useCallback(
    (failedLink: PlayerLink, reason: string): boolean => playbackFailureRef.current?.(failedLink, reason) ?? false,
    [],
  );
  // Which of the three load paths below ends up owning the <video> element's source - read by the
  // element's own "error" handler, which must stay silent while a library is driving playback and
  // reporting its own (richer) errors.
  const elementOwnsSourceRef = useRef(false);
  const autoSkipSegments = usePlayerPrefsStore((s) => s.autoSkipSegments);
  const setAutoSkipSegments = usePlayerPrefsStore((s) => s.setAutoSkipSegments);
  const autoPlayNextEpisode = usePlayerPrefsStore((s) => s.autoPlayNextEpisode);
  const setAutoPlayNextEpisode = usePlayerPrefsStore((s) => s.setAutoPlayNextEpisode);
  const playbackSpeed = usePlayerPrefsStore((s) => s.playbackSpeed);
  const setPlaybackSpeed = usePlayerPrefsStore((s) => s.setPlaybackSpeed);
  const autoSkipDelaySeconds = usePlayerPrefsStore((s) => s.autoSkipDelaySeconds);
  const skipButtonTimeoutSeconds = usePlayerPrefsStore((s) => s.skipButtonTimeoutSeconds);
  const storedVolume = usePlayerPrefsStore((s) => s.volume);
  const storedMuted = usePlayerPrefsStore((s) => s.muted);
  const setStoredVolume = usePlayerPrefsStore((s) => s.setVolume);
  // Only one of the two is ever actually the countdown in play at a time - which one depends on
  // autoSkipSegments (see the effects below), not something the button itself chooses.
  const skipCountdownSeconds = autoSkipSegments ? autoSkipDelaySeconds : skipButtonTimeoutSeconds;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekBarRef = useRef<HTMLDivElement>(null);

  const [playing, setPlaying] = useState(true);
  const [buffering, setBuffering] = useState(true);
  // A source change is a deliberate loading transition, not ordinary buffering. Keep the old
  // frame paused under the loading veil while an EMBED resolver works, then carry both the exact
  // position and the user's play/pause intent over to the replacement stream.
  const [switchingSource, setSwitchingSource] = useState(false);
  const pendingSourceSwitchRef = useRef<{ fromUrl: string | null; position: number; resume: boolean } | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  // Seeded from the persisted preference rather than the element's own 1.0 default, so the very
  // first controls render already shows the volume this episode is about to play at.
  const [volume, setVolume] = useState(storedVolume);
  const [muted, setMuted] = useState(storedMuted);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [volumeHover, setVolumeHover] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  // Mirrors the Android app's hold-to-fast-forward chip (top-center, "2×" + a fast-forward icon
  // in a dark rounded pill) - shown for as long as space stays held past the threshold below.
  const [fastForwardActive, setFastForwardActive] = useState(false);
  // Set on pointerup when the press had become a hold; consumed (and cleared) by the click that
  // the browser fires immediately after - see onVideoPointerUp.
  const pointerHoldWasActiveRef = useRef(false);

  // YouTube-style momentary feedback for actions that otherwise happen invisibly (space/click
  // toggling play, arrow-key seeking) - a `key`'d id (not just the kind/direction) so triggering
  // the same one twice in a row restarts its fade-out animation instead of the second press being
  // a no-op against React's own state-diffing.
  const [centerFlash, setCenterFlash] = useState<{ id: number; icon: "play" | "pause" } | null>(null);
  // Mirrors Android's PlayerDoubleTapSeekController: rapid presses in the same direction accumulate
  // into ONE overlay showing the running total ("+15" after three +5 taps) instead of each press
  // spawning its own independent flash - stacking those (the earlier bug: spamming arrow keys piled
  // up overlapping "+5"/"+5"/"+5" instances, all fading out on their own schedule) reads as a smear,
  // not feedback. `streakId` keys the outer fade (stable for the whole accumulation streak, so it
  // doesn't refade on every press); `pulse` keys just the arrow icon's own slide-in "nudge" so *that*
  // still replays on every press within the streak, same as Android's separate `arrowPulse` counter.
  const [seekFlash, setSeekFlash] = useState<{ streakId: number; direction: "back" | "forward"; totalSeconds: number; pulse: number } | null>(null);
  const seekFlashRef = useRef<{ direction: "back" | "forward"; totalSeconds: number; pulse: number; lastAtMs: number; streakId: number } | null>(null);
  const flashIdRef = useRef(0);
  const flashCenterIcon = useCallback((icon: "play" | "pause") => {
    flashIdRef.current += 1;
    setCenterFlash({ id: flashIdRef.current, icon });
  }, []);
  const SEEK_ACCUMULATION_WINDOW_MS = 700;
  const flashSeek = useCallback((direction: "back" | "forward", stepSeconds: number) => {
    const now = Date.now();
    const prev = seekFlashRef.current;
    const accumulating = !!prev && prev.direction === direction && now - prev.lastAtMs <= SEEK_ACCUMULATION_WINDOW_MS;
    const next = {
      direction,
      totalSeconds: accumulating ? prev!.totalSeconds + stepSeconds : stepSeconds,
      pulse: accumulating ? prev!.pulse + 1 : 0,
      lastAtMs: now,
      streakId: accumulating ? prev!.streakId : ++flashIdRef.current,
    };
    seekFlashRef.current = next;
    setSeekFlash(next);
  }, []);
  const FLASH_DURATION_MS = 550;
  useEffect(() => {
    if (!centerFlash) return;
    const timer = setTimeout(() => setCenterFlash(null), FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [centerFlash]);
  useEffect(() => {
    if (!seekFlash) return;
    const timer = setTimeout(() => {
      setSeekFlash(null);
      seekFlashRef.current = null;
    }, FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [seekFlash]);

  // The skip button (see PlayerSkipSegmentOverlay below) - not the auto-skip toggle itself, which
  // only decides what happens once the countdown below reaches zero.
  const [activeSegment, setActiveSegment] = useState<VideoSegment | null>(null);
  const [skipCountdown, setSkipCountdown] = useState<number>(skipCountdownSeconds);
  const [dismissedSegmentKey, setDismissedSegmentKey] = useState<string | null>(null);
  const activeSegmentKeyRef = useRef<string | null>(null);

  // Mirrors the Android app's decision (PlayerScreen.kt): trust the resolved link's own `type`
  // outright rather than sniffing the URL - a source can (and Miruro does) hand back an HLS
  // stream at a URL with no ".m3u8" in sight. EMBED means the "link" is a third-party player page,
  // not a media file at all - feeding that straight to <video src> is exactly what threw
  // MEDIA_ERR_SRC_NOT_SUPPORTED here. Android resolves EMBED links to a real stream URL through
  // provider-specific WebView extractors first; short of reimplementing that whole per-provider
  // pipeline, showing the embed page itself (its own player UI, ads and all) is the same fallback
  // Android's resolver reaches for when it can't extract a direct URL either.
  const isEmbed = link?.type === "EMBED";

  // Translation/player/quality picking: distinct, non-empty values across every link this episode
  // could play through - PlayerSettingsMenu only shows a picker for whichever of these actually
  // has more than one option (some episodes only ever resolve to a single stream). A source can
  // vary any of the three independently per link (confirmed against yummy-anime.js: every link
  // carries its own `translation` - dub studio - *and* `playerName`, decoupled from each other).
  const [pendingSelection, setPendingSelection] = useState<Partial<Pick<PlayerLink, "translation" | "playerName" | "quality">> | null>(null);
  const links = availableLinks ?? (link ? [link] : []);
  // Which link each of these maps to lives in lib/playerLinks - see the note at the top of that
  // file. What stays here is only the UI's own concern: reflecting the pick immediately.
  const translationValues = translationOptions(links);
  const playerValues = playerOptions(links);
  const qualityValues = link ? qualityOptions(links, link) : [];
  const beginSourceSwitch = useCallback((target?: PlayerLink): boolean => {
    if (target && link && target.type === link.type && target.url === link.url) return false;

    const video = videoRef.current;
    pendingSourceSwitchRef.current = {
      fromUrl: link?.url ?? null,
      position: video && Number.isFinite(video.currentTime) ? video.currentTime : currentTime,
      resume: video ? !video.paused : playing,
    };
    video?.pause();
    setSettingsOpen(false);
    setBuffering(true);
    setSwitchingSource(true);
    return true;
  }, [currentTime, link, playing]);
  const selectDimension = (changed: Partial<Pick<PlayerLink, "translation" | "playerName" | "quality">>) => {
    // With no link resolved yet there is nothing to keep the other two dimensions *close* to, so
    // the pick is just "the first link carrying what was asked for" - which is exactly what this
    // menu is for in that state: getting off a player that isn't coming back.
    const next = link
      ? pickLinkForDimension(links, link, changed)
      : links.find((candidate) =>
          (Object.entries(changed) as [keyof typeof changed, string | null | undefined][])
            .every(([key, value]) => candidate[key] === value));
    if (next && beginSourceSwitch(next)) onSelectLink?.(next);
  };
  const selectTranslation = (translation: string) => { setPendingSelection({ translation }); selectDimension({ translation }); };
  const selectPlayerName = (playerName: string) => { setPendingSelection({ playerName }); selectDimension({ playerName }); };
  const selectQuality = (quality: string) => {
    const candidate = link ? pickLinkForQuality(links, link, quality) : undefined;
    if (candidate && beginSourceSwitch(candidate)) { setPendingSelection({ quality }); onSelectLink?.(candidate); }
  };
  // What the settings menu should *say* is selected. An EMBED pick isn't a `link` swap: the parent
  // has to resolve it over the network first (see the watch route's selectLink), so reading these
  // straight off `link` left the menu showing the old player/quality for as long as that took,
  // making the pick feel like it hadn't registered. Show the pick right away and let the real link
  // catch up - the effect below drops it again as soon as it does.
  const shownTranslation = pendingSelection?.translation ?? link?.translation ?? undefined;
  const shownPlayerName = pendingSelection?.playerName ?? link?.playerName ?? undefined;
  const shownQuality = pendingSelection?.quality ?? link?.quality ?? undefined;

  // Drop the optimistic pick once it can no longer differ from reality: either `link` itself
  // changed (a non-EMBED pick applies synchronously) or the parent finished resolving the EMBED
  // one. Both cases end with `link` being the source of truth again, including when resolution
  // failed and the pick simply didn't take.
  useEffect(() => {
    if (!sourceSwitching && !switchingSource) setPendingSelection(null);
  }, [link, sourceSwitching, switchingSource]);

  // --- source setup (hls.js / direct mp4) ---
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isEmbed || !link) return;

    let hls: Hls | null = null;
    let dash: MediaPlayerClass | null = null;
    let cancelled = false;
    let headerSessionId: string | null = null;
    let networkRetryTimer: number | null = null;
    const isHls = link.type === "DIRECT_HLS";
    // Aksor (and other resolvers - see extractors/*.js in hibiki-sources) sometimes only has a
    // DASH rendition available, not HLS/MP4 - Android's ExoPlayer handles this via its DASH
    // module (DashMediaSource, see PlayerScreen.kt), so this mirrors that with dash.js rather
    // than falling back to the EMBED iframe just because the direct stream happens to be DASH.
    const isDash = link.type === "DIRECT_DASH";
    setPlaybackError(null);
    // Nothing owns the element until one of the paths below claims it - an error arriving in
    // between belongs to the stream being torn down, not to this one.
    elementOwnsSourceRef.current = false;
    // This effect also runs when switching between two already-resolved qualities/providers. The
    // old stream may still have left `buffering` false, so reset it explicitly before loading the
    // replacement to provide immediate feedback and suppress controls tied to the previous media.
    setBuffering(true);

    // Referer/User-Agent can't be set from renderer JS (forbidden headers on XHR/fetch, and a
    // plain <video src> has no header hook at all) — register them with the main process, which
    // injects them at the session level for every request to this URL's origin (playlist +
    // segments alike), then start playback once that's in place.
    hibiki.player.registerHeaders(link.url, link.headers).then((sessionId) => {
      if (cancelled) {
        void hibiki.player.unregisterHeaders(sessionId);
        return;
      }
      headerSessionId = sessionId;
      elementOwnsSourceRef.current = !(isHls && Hls.isSupported()) && !isDash;
      if (isHls && Hls.isSupported()) {
        hls = new Hls();
        // Without this, a failed manifest/segment load (CORS, a dead CDN host, ...) just leaves
        // the "buffering" spinner turning forever with nothing in the console to explain why -
        // network/media errors are usually transient (hls.js's own recommended recovery), but a
        // fatal, unrecoverable one should at least surface instead of spinning silently.
        //
        // A bare hls?.startLoad() on every NETWORK_ERROR (hls.js's own suggested pattern) assumes
        // the failure is transient - fine for a blip, but a manifest URL that's just plain dead
        // (an expired token from a browser-runtime resolver, a 403/404) fails the exact same way
        // on every retry, forever: error → startLoad() → same error → startLoad() → ... with
        // nothing ever reaching the user but an eternal spinner (seen live: exactly this, on a
        // YummyAnime stream resolved through the Alloha browser-resolver). Capping retries and
        // giving up into the visible error overlay after a few tries fixes that without losing
        // the recovery behavior for genuinely transient blips.
        let networkRetries = 0;
        const MAX_NETWORK_RETRIES = 3;
        // recoverMediaError() was uncapped - a stream with a genuinely broken fragment (not a
        // transient decode hiccup) just re-throws the same fatal MEDIA_ERROR immediately after
        // every recovery attempt, forever: error → recover → same error → recover → ... which
        // looks exactly like a freeze/lag from the outside (seen live: repeated fragParsingError/
        // bufferStalledError/bufferAppendNoProgress with playback stuck). Capped the same way
        // NETWORK_ERROR already was, giving up into the visible error overlay after a few tries.
        let mediaRetries = 0;
        const MAX_MEDIA_RETRIES = 3;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          networkRetries = 0;
        });
        // A successful buffer append is the real signal that recovery actually worked - resetting
        // only on MANIFEST_PARSED (which fires once, near the very start) would let one recovered
        // error early in playback silently use up the whole retry budget for a later, unrelated one.
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          networkRetries = 0;
          mediaRetries = 0;
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          log.error("player", `hls.js ${data.fatal ? "fatal" : "non-fatal"} error:`, data.type, data.details, data.reason ?? "", data.response ? `http ${data.response.code}` : "");
          if (!data.fatal) return;
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              networkRetries += 1;
              if (networkRetries > MAX_NETWORK_RETRIES) {
                const reason = data.details || "playback failed";
                if (!reportPlaybackFailure(link, reason)) setPlaybackError(reason);
                hls?.destroy();
                break;
              }
              // startLoad() resumes fragment loading, but does not reliably recreate the loader
              // after the initial manifest itself failed. Reload that URL explicitly; later
              // fragment failures can resume from the current position. A short backoff prevents
              // a dead edge host from being hammered while still recovering quickly from a blip.
              if (networkRetryTimer !== null) window.clearTimeout(networkRetryTimer);
              networkRetryTimer = window.setTimeout(() => {
                networkRetryTimer = null;
                if (cancelled || !hls) return;
                const isManifestFailure = data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
                  data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT;
                log.info("player", `retrying ${isManifestFailure ? "manifest" : "stream"} load (${networkRetries}/${MAX_NETWORK_RETRIES})`);
                if (!isManifestFailure) {
                  hls.startLoad();
                  return;
                }
                // Retrying the *same* URL is a coin flip when what failed is the CDN's own
                // load-balancing redirect (Kodik hands out p14.solodcdn.com and 302s to p13 -
                // verified live). A redirected XHR has to pass the CORS check on the redirect hop
                // too, and these CDNs send no Access-Control-Allow-Origin of their own, so the
                // retry only started working once Chromium had cached the redirect and stopped
                // making one. Ask the main process where the URL actually lands (no CORS there)
                // and load that instead, so the retry has nothing left to redirect through.
                // Relative segment URLs resolve against it as well, keeping the rest of the
                // stream on the host that answered.
                void hibiki.player.resolveStreamUrl(link.url, link.headers).then((finalUrl) => {
                  if (cancelled || !hls) return;
                  if (finalUrl !== link.url) log.info("player", `retrying manifest at its redirect target ${finalUrl}`);
                  hls.loadSource(finalUrl);
                });
              }, 500 * (2 ** (networkRetries - 1)));
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              mediaRetries += 1;
              if (mediaRetries > MAX_MEDIA_RETRIES) {
                setPlaybackError(data.details || "playback failed");
                hls?.destroy();
                break;
              }
              hls?.recoverMediaError();
              break;
            default:
              setPlaybackError(data.details || "playback failed");
              hls?.destroy();
          }
        });
        hls.loadSource(link.url);
        hls.attachMedia(video);
      } else if (isDash) {
        dash = DashMediaPlayer().create();
        // Same reasoning as hls.js above: dash.js retries transient errors on its own, but a
        // manifest that's simply dead keeps re-erroring forever with nothing surfaced unless
        // this caps it and gives up into the visible error overlay.
        let dashErrors = 0;
        const MAX_DASH_RETRIES = 3;
        dash.on(DashMediaPlayer.events.STREAM_INITIALIZED, () => {
          dashErrors = 0;
        });
        dash.on(DashMediaPlayer.events.ERROR, (e) => {
          log.error("player", "dash.js error:", e);
          dashErrors += 1;
          if (dashErrors > MAX_DASH_RETRIES) {
            const detail = typeof e.error === "object" && e.error ? e.error.message : e.error;
            const reason = detail || "playback failed";
            if (!reportPlaybackFailure(link, reason)) setPlaybackError(reason);
            dash?.destroy();
          }
        });
        dash.initialize(video, link.url, true);
      } else {
        video.src = link.url;
      }
    }).catch((error) => {
      if (cancelled) return;
      log.error("player", "failed to establish playback header session:", error);
      setPlaybackError(error instanceof Error ? error.message : "playback setup failed");
    });

    return () => {
      cancelled = true;
      if (networkRetryTimer !== null) window.clearTimeout(networkRetryTimer);
      hls?.destroy();
      dash?.destroy();
      if (headerSessionId) void hibiki.player.unregisterHeaders(headerSessionId);
    };
  }, [link, isEmbed]);

  // --- media element event wiring ---
  const embedRef = useRef<HTMLIFrameElement>(null);
  // Capture while the playback surface still exists, never during unmount.
  // A late capture response must not save pixels from the destination page.
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let lastCapture = 0;
    const video = videoRef.current;
    const capture = async () => {
      const surface = isEmbed ? embedRef.current : video;
      if (cancelled || pending || !onCaptureThumbnail || !surface?.isConnected || document.hidden) return;
      if (!isEmbed && (!video || video.readyState < 2 || video.seeking)) return;
      if (Date.now() - lastCapture < 2000) return;
      const rect = surface.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      pending = true;
      lastCapture = Date.now();
      try {
        const dataUrl = await hibiki.player.captureFrame({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
        if (!cancelled && surface.isConnected && dataUrl) onCaptureThumbnail(dataUrl);
      } catch (error) {
        log.warn("player", "thumbnail capture failed:", error);
      } finally {
        pending = false;
      }
    };
    const timer = window.setInterval(capture, 5000);
    video?.addEventListener("playing", capture);
    video?.addEventListener("seeked", capture);
    video?.addEventListener("pause", capture);
    return () => {
      cancelled = true;
      clearInterval(timer);
      video?.removeEventListener("playing", capture);
      video?.removeEventListener("seeked", capture);
      video?.removeEventListener("pause", capture);
    };
  }, [link, isEmbed, onCaptureThumbnail]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || isEmbed) return;

    const onLoadedMetadata = () => {
      setDuration(video.duration);
      const pendingSwitch = pendingSourceSwitchRef.current;
      const isReplacementStream = !!pendingSwitch && pendingSwitch.fromUrl !== link?.url;
      if (isReplacementStream && video.duration) {
        video.currentTime = Math.min(pendingSwitch.position, Math.max(0, video.duration - 1));
        if (!pendingSwitch.resume) video.pause();
      } else if (startPositionMs && video.duration) {
        video.currentTime = Math.min(startPositionMs / 1000, video.duration - 1);
      }
      video.playbackRate = playbackSpeed;
    };
    // Mirrors Android's segment-skip (PlayerScreen.kt): a currentTime that lands inside an
    // OPENING/ENDING window surfaces the skip button/countdown effect below - checked every
    // timeupdate tick rather than scheduled up front, since seeking backward into a segment (or a
    // segment starting exactly at 0) needs to surface it too, not just the first crossing into it.
    // Only updates state on an actual change (entering/leaving a segment), not every tick.
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      if (onProgress && Number.isFinite(video.duration)) {
        onProgress(video.currentTime * 1000, video.duration * 1000);
      }
      const nowMs = video.currentTime * 1000;
      const segment = link?.segments?.find((s) => (s.type === "OPENING" || s.type === "ENDING") && nowMs >= s.startMs && nowMs < s.endMs) ?? null;
      const key = segment ? segmentKey(segment) : null;
      if (key !== activeSegmentKeyRef.current) {
        activeSegmentKeyRef.current = key;
        setActiveSegment(segment);
        setSkipCountdown(skipCountdownSeconds);
      }
    };
    const onEnded = () => {
      if (autoPlayNextEpisode) onNextEpisode?.();
    };
    const onProgressEvent = () => {
      if (video.buffered.length > 0) setBuffered(video.buffered.end(video.buffered.length - 1));
    };
    const onPlay = () => { setPlaying(true); onPlayStateChange?.(true); };
    const onPause = () => { setPlaying(false); onPlayStateChange?.(false); };
    const onWaiting = () => setBuffering(true);
    const onCanPlay = () => {
      setBuffering(false);
      const pendingSwitch = pendingSourceSwitchRef.current;
      if (!pendingSwitch || pendingSwitch.fromUrl === link?.url) return;

      if (pendingSwitch.resume) void video.play().catch(() => undefined);
      else video.pause();
      pendingSourceSwitchRef.current = null;
      setSwitchingSource(false);
    };
    const onVolumeChange = () => { setVolume(video.volume); setMuted(video.muted); setStoredVolume(video.volume, video.muted); };
    // Only meaningful for the direct-<video src> path (hls.js has its own error events, wired up
    // where the source is set up) - a dead/CORS-blocked direct MP4 link would otherwise leave the
    // buffering spinner turning forever with no console trace at all.
    // Only when the element itself is what loaded the stream: hls.js and dash.js attach to this
    // same <video>, report their own errors and recover from some of them, so letting this fire
    // alongside them would double-report and pre-empt their retries.
    //
    // Keying that on "the link is DIRECT_MP4" was close but not equivalent - a DIRECT_HLS link
    // falls through to `video.src` too whenever Hls.isSupported() is false, and that path would
    // then have had no error reporting at all: no overlay, no fallback, just a spinner forever.
    const onError = () => {
      if (!link || isEmbed || !elementOwnsSourceRef.current) return;
      log.error("player", "<video> element error:", `code ${video.error?.code}`, video.error?.message ?? "");
      const reason = video.error?.message || "playback failed";
      if (!reportPlaybackFailure(link, reason)) setPlaybackError(reason);
    };

    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("progress", onProgressEvent);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("playing", onCanPlay);
    video.addEventListener("volumechange", onVolumeChange);
    video.addEventListener("error", onError);
    video.addEventListener("ended", onEnded);

    return () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("progress", onProgressEvent);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("playing", onCanPlay);
      video.removeEventListener("volumechange", onVolumeChange);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
    };
  }, [link, isEmbed, startPositionMs, onProgress, onPlayStateChange, reportPlaybackFailure, autoPlayNextEpisode, playbackSpeed, onNextEpisode, setStoredVolume]);

  // Push the remembered volume onto the element itself. A fresh <video> (new episode, new stream
  // after a player switch) always comes up at 1.0 unmuted, so this has to re-run per `link`, not
  // just once on mount. Reading the live store instead of the `volume`/`muted` state keeps this
  // off the render loop: the element's own volumechange is what feeds those back.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isEmbed) return;
    const { volume: preferred, muted: preferredMuted } = usePlayerPrefsStore.getState();
    video.volume = preferred;
    video.muted = preferredMuted;
  }, [link, isEmbed]);

  // Applied separately (not just via loadedmetadata above) so changing the speed in the in-player
  // settings menu takes effect immediately on whatever's already playing, not just next episode.
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = playbackSpeed;
  }, [playbackSpeed]);

  // A new episode's segments start from a clean slate - a dismissed key from the previous episode
  // has no business suppressing this one's button, even in the unlikely case the keys collide.
  // Keyed on the URL, not the `link` object itself - selectPlayerLink() (WatchPage) rebuilds that
  // object on every render even for the same episode, which would otherwise reset this on every
  // unrelated re-render (a progress-query refetch, ...), not just on an actual episode change.
  useEffect(() => {
    activeSegmentKeyRef.current = null;
    setActiveSegment(null);
    setDismissedSegmentKey(null);
  }, [link?.url]);

  // Mirrors Android's PlayerSkipSegmentOverlay/SKIP_SEGMENT_COUNTDOWN_SECONDS: the button (and its
  // countdown) is shown for every OPENING/ENDING segment regardless of the auto-skip setting - that
  // setting only decides what happens once the countdown reaches zero (jump automatically vs. just
  // let the button quietly disappear), so a title with segment data but auto-skip turned off still
  // gets a clickable "Пропустить" button instead of nothing at all.
  useEffect(() => {
    if (!activeSegment) return;
    const key = segmentKey(activeSegment);
    if (dismissedSegmentKey === key) return;
    setSkipCountdown(skipCountdownSeconds);
    const interval = setInterval(() => {
      setSkipCountdown((seconds) => {
        if (seconds > 1) return seconds - 1;
        clearInterval(interval);
        if (autoSkipSegments) {
          const video = videoRef.current;
          if (video) video.currentTime = activeSegment.endMs / 1000;
        }
        setDismissedSegmentKey(key);
        return 0;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [activeSegment, dismissedSegmentKey, autoSkipSegments, skipCountdownSeconds]);

  const skipSegmentNow = useCallback(() => {
    if (!activeSegment) return;
    const video = videoRef.current;
    if (video) video.currentTime = activeSegment.endMs / 1000;
    setDismissedSegmentKey(segmentKey(activeSegment));
  }, [activeSegment]);

  const dismissSegmentPrompt = useCallback(() => {
    if (!activeSegment) return;
    setDismissedSegmentKey(segmentKey(activeSegment));
  }, [activeSegment]);

  // Closing on outside click (not just re-toggling the gear) matches every other dropdown in the
  // app; keeping controls from auto-hiding while it's open avoids the menu floating over faded-out
  // controls with no gear left to close it.
  useEffect(() => {
    if (!settingsOpen) return;
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && settingsRef.current?.contains(e.target)) return;
      setSettingsOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => window.removeEventListener("pointerdown", onPointerDown, { capture: true });
  }, [settingsOpen]);

  // --- fullscreen tracking ---
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // --- auto-hide controls while playing ---
  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_DELAY_MS);
  }, []);
  const wake = useCallback(() => {
    setControlsVisible(true);
    if (playing) scheduleHide();
  }, [playing, scheduleHide]);
  useEffect(() => {
    if (playing) scheduleHide();
    else if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    return () => { if (hideTimerRef.current) clearTimeout(hideTimerRef.current); };
  }, [playing, scheduleHide]);

  // Shared by the space-bar hold below and the mouse-hold handlers - same threshold and speed, so
  // holding the left button reads exactly like holding space.
  const HOLD_TO_FAST_FORWARD_MS = 350;
  const FAST_FORWARD_SPEED = 2;
  // A press that turned into a hold has to swallow the click the browser fires on release,
  // otherwise letting go would also pause the video through the container's own onClick.
  const pointerHoldRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; active: boolean }>({ timer: null, active: false });
  const endPointerHold = useCallback(() => {
    const hold = pointerHoldRef.current;
    if (hold.timer) { clearTimeout(hold.timer); hold.timer = null; }
    if (!hold.active) return;
    hold.active = false;
    setFastForwardActive(false);
    const video = videoRef.current;
    if (video) video.playbackRate = playbackSpeed;
  }, [playbackSpeed]);
  // Only a plain left-press on the video itself starts a hold - the controls sit on top of this
  // container, and a press that begins on the seek bar or a button is that control's business.
  const onVideoPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (e.target !== videoRef.current && e.target !== containerRef.current) return;
    const hold = pointerHoldRef.current;
    if (hold.timer) clearTimeout(hold.timer);
    hold.timer = setTimeout(() => {
      hold.active = true;
      const video = videoRef.current;
      if (video) video.playbackRate = FAST_FORWARD_SPEED;
      setFastForwardActive(true);
    }, HOLD_TO_FAST_FORWARD_MS);
  }, []);
  const onVideoPointerUp = useCallback(() => {
    // Read before endPointerHold() clears it - the click event that follows this release still has
    // to know whether it belonged to a hold.
    pointerHoldWasActiveRef.current = pointerHoldRef.current.active;
    endPointerHold();
  }, [endPointerHold]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
      flashCenterIcon("play");
    } else {
      video.pause();
      flashCenterIcon("pause");
    }
  }, [flashCenterIcon]);

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
  }, []);

  const toggleFullscreenNow = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen();
    else containerRef.current?.requestFullscreen();
  }, []);

  // --- keyboard shortcuts: space play/pause (hold to fast-forward at 2x, TikTok/YouTube-style),
  // f fullscreen, escape leaves, left/right seek ±5s, up/down volume, m mutes ---
  const SEEK_STEP_SECONDS = 5;
  const VOLUME_STEP = 0.05;
  useEffect(() => {
    // Refs, not state - this only ever needs to be read/written from key handlers, and re-running
    // the whole effect (which state would trigger) on every hold-start/hold-end would keep
    // tearing down and re-attaching both listeners for no reason.
    const spaceHold = { timer: null as ReturnType<typeof setTimeout> | null, active: false };
    const onKeyDown = (e: KeyboardEvent) => {
      const video = videoRef.current;
      switch (e.code) {
        case "Space":
          e.preventDefault();
          if (e.repeat) break; // the browser auto-repeats keydown while held - only the first matters
          wake();
          spaceHold.timer = setTimeout(() => {
            spaceHold.active = true;
            if (video) video.playbackRate = FAST_FORWARD_SPEED;
            setFastForwardActive(true);
          }, HOLD_TO_FAST_FORWARD_MS);
          break;
        case "KeyF":
          e.preventDefault();
          toggleFullscreenNow();
          wake();
          break;
        case "Escape":
          // If we're in fullscreen, let the browser's own Escape handling exit that first —
          // calling onBack() too would navigate away in the same keystroke as leaving fullscreen.
          if (!document.fullscreenElement) {
            e.preventDefault();
            onBack();
          }
          break;
        case "ArrowLeft":
          if (!video) break;
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - SEEK_STEP_SECONDS);
          flashSeek("back", SEEK_STEP_SECONDS);
          wake();
          break;
        case "ArrowRight":
          if (!video) break;
          e.preventDefault();
          video.currentTime = Math.min(video.duration || Infinity, video.currentTime + SEEK_STEP_SECONDS);
          flashSeek("forward", SEEK_STEP_SECONDS);
          wake();
          break;
        case "ArrowUp":
          if (!video) break;
          e.preventDefault();
          video.volume = Math.min(1, video.volume + VOLUME_STEP);
          video.muted = false;
          wake();
          break;
        case "ArrowDown":
          if (!video) break;
          e.preventDefault();
          video.volume = Math.max(0, video.volume - VOLUME_STEP);
          wake();
          break;
        case "KeyM":
          e.preventDefault();
          toggleMute();
          wake();
          break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      if (spaceHold.timer) {
        clearTimeout(spaceHold.timer);
        spaceHold.timer = null;
      }
      if (spaceHold.active) {
        // Was a hold, not a tap - playback was never paused, just sped up, so release just
        // restores the normal speed rather than also toggling play.
        spaceHold.active = false;
        setFastForwardActive(false);
        const video = videoRef.current;
        if (video) video.playbackRate = playbackSpeed;
      } else {
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      if (spaceHold.timer) clearTimeout(spaceHold.timer);
    };
  }, [togglePlay, toggleMute, toggleFullscreenNow, onBack, wake, playbackSpeed, flashSeek]);

  const ratioFromClientX = useCallback((clientX: number) => {
    const bar = seekBarRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  const seekToClientX = useCallback((clientX: number) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const ratio = ratioFromClientX(clientX);
    video.currentTime = ratio * duration;
    setCurrentTime(ratio * duration);
    setHoverRatio(ratio);
  }, [duration, ratioFromClientX]);

  const onSeekPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    setSeeking(true);
    seekToClientX(e.clientX);
  };
  useEffect(() => {
    if (!seeking) return;
    const onMove = (e: PointerEvent) => seekToClientX(e.clientX);
    const onUp = () => setSeeking(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [seeking, seekToClientX]);

  const onSeekAreaMouseMove = (e: React.MouseEvent) => setHoverRatio(ratioFromClientX(e.clientX));
  const onSeekAreaMouseLeave = () => { if (!seeking) setHoverRatio(null); };

  const toggleFullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleFullscreenNow();
  };

  const onMuteButtonClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleMute();
  };

  const onVolumeInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;
    const next = Number(e.target.value);
    video.volume = next;
    video.muted = next === 0;
  };

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  const finishEmbedSourceSwitch = () => {
    if (!switchingSource) return;
    pendingSourceSwitchRef.current = null;
    setSwitchingSource(false);
    setBuffering(false);
  };

  // No custom controls here on purpose - this is the third-party site's own player UI running in
  // an iframe, not a media element we control (no seek bar/volume/etc. to wire up, same as
  // Android's BrowserPlaybackSurface fallback).
  if (isEmbed) {
    return (
      <div ref={containerRef} className="relative h-full w-full bg-black">
        <iframe ref={embedRef} src={link.url} onLoad={finishEmbedSourceSwitch} allow="autoplay; fullscreen" allowFullScreen className="h-full w-full border-0" />
        {(sourceSwitching || switchingSource) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-[1px]">
            <Loader2 className="h-12 w-12 animate-spin text-white/80" strokeWidth={2} />
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-4 bg-gradient-to-b from-black/80 to-transparent px-6 pb-10 pt-5">
          <button onClick={onBack} className="pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20">
            <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={2} />
          </button>
          <div className="min-w-0">
            <p className="select-text truncate text-base font-bold text-white">{title}</p>
            <p className="select-text truncate text-xs text-zinc-300">{episodeLabel}</p>
          </div>
        </div>
        <StreakToast streak={streakToast} />
      </div>
    );
  }

  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const playedPercent = duration ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration ? (buffered / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      className="group/player relative h-full w-full select-none overflow-hidden bg-black"
      onMouseMove={wake}
      onPointerDown={onVideoPointerDown}
      onPointerUp={onVideoPointerUp}
      // A pointer that leaves the player (or gets cancelled by the OS) never sends pointerup here,
      // which would otherwise strand playback at 2x with the chip still showing.
      onPointerLeave={endPointerHold}
      onPointerCancel={endPointerHold}
      onClick={() => {
        if (pointerHoldWasActiveRef.current) { pointerHoldWasActiveRef.current = false; return; }
        togglePlay();
      }}
    >
      <video ref={videoRef} crossOrigin="anonymous" autoPlay className="h-full w-full object-contain">
        {link?.subtitles?.map((track) => (
          <track key={track.url} kind="subtitles" src={track.url} srcLang={track.language ?? undefined} label={track.label ?? track.language ?? "sub"} />
        ))}
      </video>

      {/* Sits outside the controlsVisible-gated top bar below on purpose - a streak update is a
          one-off announcement, not part of the persistent chrome, so it shows up (and fades back
          out on its own) whether or not the controls happen to be visible right now. */}
      <StreakToast streak={streakToast} />

      {/* Mirrors the Android app's hold-to-fast-forward chip exactly: top-center, a dark rounded
          pill with "2×" then a fast-forward icon, fade+scale in/out. */}
      <AnimatePresence>
        {fastForwardActive && (
          <motion.div
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="pointer-events-none absolute inset-x-0 top-7 z-10 flex justify-center"
          >
            <div className="flex items-center gap-[3px] rounded-2xl bg-black/70 py-[7px] pl-3 pr-2.5">
              <span className="text-base font-medium text-white">2×</span>
              <FastForward className="h-[19px] w-[19px] fill-white text-white" strokeWidth={0} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {centerFlash && (
          <motion.div
            key={centerFlash.id}
            initial={{ opacity: 0.9, scale: 0.7 }}
            animate={{ opacity: 0, scale: 1.35 }}
            transition={{ duration: FLASH_DURATION_MS / 1000, ease: "easeOut" }}
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
          >
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-black/60">
              {centerFlash.icon === "play" ? (
                <Play className="ml-1 h-9 w-9 fill-white text-white" strokeWidth={0} />
              ) : (
                <Pause className="h-9 w-9 fill-white text-white" strokeWidth={0} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Matches the Android app's double-tap seek overlay: a plain arrow (drawn twice, offset
          black copy behind a white one for a cheap drop-shadow) next to a signed "+5"/"-5", no
          pill background. The arrow sits in its own fixed-size, absolutely-positioned slot with
          its own nested AnimatePresence keyed by `pulse` - each additional press within the
          accumulation window swaps in a fresh arrow that slides in from center as the previous
          one slides out to the edge, all in that same slot, which is what makes spamming the key
          read as one continuously "nudged" arrow instead of a pile of separately-timed icons each
          fading out on their own (the previous bug). The outer fade is keyed by `streakId`
          instead, which only changes when a new streak starts - it stays mounted (and its own
          auto-hide timer keeps getting pushed back, see the effect above) across every pulse in
          the same streak. */}
      <AnimatePresence>
        {seekFlash && (
          <motion.div
            key={seekFlash.streakId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className={cn(
              "pointer-events-none absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-1",
              seekFlash.direction === "back" ? "left-14" : "right-14",
            )}
          >
            {seekFlash.direction === "back" && (
              <span className="relative h-7 w-7">
                <AnimatePresence initial={false}>
                  <motion.span
                    key={seekFlash.pulse}
                    className="absolute inset-0"
                    initial={{ opacity: 0, x: 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -16 }}
                    transition={{ duration: 0.18, ease: "easeOut" }}
                  >
                    <SeekArrowIcon direction="back" />
                  </motion.span>
                </AnimatePresence>
              </span>
            )}
            {/* Measured directly against the real rendered lucide icon (React DevTools-mounted in
                a live copy of this page, not a hand-copied SVG approximation): the digit's ink
                sits lower than the arrow's, box-centering notwithstanding - font metrics, not
                something line-height/leading fixes. The exact offset shifts slightly with the
                window's device pixel ratio (font hinting snaps to the device grid, SVG doesn't),
                so this errs a little past the 1x measurement rather than under-correcting again. */}
            <span className="[transform:translateY(-4px)] text-2xl leading-none font-bold tabular-nums text-white [text-shadow:2px_2px_10px_rgba(0,0,0,0.7)]">
              {seekFlash.direction === "back" ? "−" : "+"}
              {seekFlash.totalSeconds}
            </span>
            {seekFlash.direction === "forward" && (
              <span className="relative h-7 w-7">
                <AnimatePresence initial={false}>
                  <motion.span
                    key={seekFlash.pulse}
                    className="absolute inset-0"
                    initial={{ opacity: 0, x: -16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 16 }}
                    transition={{ duration: 0.18, ease: "easeOut" }}
                  >
                    <SeekArrowIcon direction="forward" />
                  </motion.span>
                </AnimatePresence>
              </span>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {playbackError ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 px-8 text-center">
          <TriangleAlert className="h-10 w-10 text-rose-400" strokeWidth={1.75} />
          <p className="select-text text-sm text-zinc-300">{t("common.loadFailed", { message: playbackError })}</p>
        </div>
      ) : (sourceSwitching || switchingSource || buffering || !link) && (
        // `!link` is the "still deciding what to play" case - the spinner sits over the chrome
        // rather than replacing it, so the settings menu stays reachable throughout.
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-[1px]">
          <Loader2 className="h-12 w-12 animate-spin text-white/80" strokeWidth={2} />
        </div>
      )}

      {link && !sourceSwitching && !switchingSource && !buffering && activeSegment && dismissedSegmentKey !== segmentKey(activeSegment) && (
        <div
          onClick={stop}
          className={cn("absolute right-6 z-10 flex items-center gap-2 transition-[bottom] duration-300", controlsVisible ? "bottom-[136px]" : "bottom-8")}
        >
          {autoSkipSegments && (
            <button onClick={dismissSegmentPrompt} className="rounded-full bg-black/60 px-4 py-2.5 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-black/75">
              {t("watch.player.watch")}
            </button>
          )}
          <button onClick={skipSegmentNow} className="rounded-full bg-white/[.92] px-4 py-2.5 text-sm font-semibold text-zinc-900 shadow-lg transition-colors hover:bg-white">
            {t("watch.player.skip")} ({skipCountdown})
          </button>
        </div>
      )}

      {/* Top bar: back + title */}
      <div className={cn("absolute inset-x-0 top-0 flex items-center gap-4 bg-gradient-to-b from-black/80 to-transparent px-6 pb-10 pt-5 transition-opacity duration-300", controlsVisible ? "opacity-100" : "pointer-events-none opacity-0")} onClick={stop}>
        <button onClick={(e) => { stop(e); onBack(); }} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20">
          <ArrowLeft className="h-[18px] w-[18px]" strokeWidth={2} />
        </button>
        <div className="min-w-0">
          <p className="select-text truncate text-base font-bold text-white">{title}</p>
          <p className="select-text truncate text-xs text-zinc-300">{episodeLabel}</p>
        </div>
      </div>

      {/* Bottom control cluster */}
      <div className={cn("absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-6 pb-4 pt-10 transition-opacity duration-300", controlsVisible ? "opacity-100" : "pointer-events-none opacity-0")} onClick={stop}>
        {/* Seek bar: transparent track, white = buffered, red = played */}
        <div className="relative" onMouseMove={onSeekAreaMouseMove} onMouseLeave={onSeekAreaMouseLeave}>
          {hoverRatio !== null && duration > 0 && (
            <div
              className="absolute bottom-full mb-2.5 -translate-x-1/2 select-text rounded-md bg-red-600 px-2 py-1 text-xs font-bold tabular-nums text-white shadow-lg"
              style={{ left: `${hoverRatio * 100}%` }}
              onClick={stop}
            >
              {formatTime(hoverRatio * duration)}
            </div>
          )}
          <div
            ref={seekBarRef}
            onPointerDown={onSeekPointerDown}
            className="group/seek relative flex h-4 cursor-pointer items-center"
          >
            <div className="relative h-[3px] w-full overflow-hidden rounded-full bg-white/15 transition-[height] group-hover/seek:h-[5px]">
              <div className="absolute inset-y-0 left-0 bg-white/40" style={{ width: `${bufferedPercent}%` }} />
              <div className="absolute inset-y-0 left-0 bg-red-600" style={{ width: `${playedPercent}%` }} />
            </div>
            <div
              className="absolute h-3 w-3 -translate-x-1/2 rounded-full bg-red-600 opacity-0 shadow transition-opacity group-hover/seek:opacity-100"
              style={{ left: `${playedPercent}%` }}
            />
          </div>
        </div>

        <div className="mt-1 flex items-center">
          <div className="flex flex-1 items-center">
            <span className="shrink-0 text-xs font-medium tabular-nums text-zinc-300">{formatTime(currentTime)} / {formatTime(duration)}</span>
          </div>

          <div className="flex items-center justify-center gap-3">
            <button
              onClick={(e) => { stop(e); onPrevEpisode?.(); }}
              disabled={!onPrevEpisode}
              className={cn("flex h-10 w-10 items-center justify-center rounded-full transition-colors", onPrevEpisode ? "text-white/80 hover:bg-white/10 hover:text-white" : "cursor-default text-white/20")}
            >
              <SkipBack className="h-5 w-5" strokeWidth={2} />
            </button>
            <button onClick={(e) => { stop(e); togglePlay(); }} className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20">
              {playing ? <Pause className="h-6 w-6 fill-current" strokeWidth={0} /> : <Play className="ml-0.5 h-6 w-6 fill-current" strokeWidth={0} />}
            </button>
            <button
              onClick={(e) => { stop(e); onNextEpisode?.(); }}
              disabled={!onNextEpisode}
              className={cn("flex h-10 w-10 items-center justify-center rounded-full transition-colors", onNextEpisode ? "text-white/80 hover:bg-white/10 hover:text-white" : "cursor-default text-white/20")}
            >
              <SkipForward className="h-5 w-5" strokeWidth={2} />
            </button>
          </div>

          <div className="flex flex-1 items-center justify-end gap-1">
            {/* Fixed-size box so the slider expands via absolute positioning — hovering it must
                never reflow the mute button or the settings/fullscreen buttons next to it. */}
            <div
              className="relative flex h-8 w-8 shrink-0 items-center justify-center"
              onMouseEnter={() => setVolumeHover(true)}
              onMouseLeave={() => setVolumeHover(false)}
            >
              <div className={cn("absolute right-full top-1/2 mr-1 flex -translate-y-1/2 items-center overflow-hidden transition-[width] duration-200 ease-out", volumeHover ? "w-20" : "w-0")}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={muted ? 0 : volume}
                  onChange={onVolumeInput}
                  onClick={stop}
                  className="w-20 shrink-0 cursor-pointer accent-red-600"
                />
              </div>
              <button onClick={onMuteButtonClick} className="relative z-10 flex h-8 w-8 items-center justify-center text-white/80 transition-colors hover:text-white">
                <VolumeIcon className="h-[18px] w-[18px]" strokeWidth={2} />
              </button>
            </div>
            <div ref={settingsRef} className="relative">
              <button
                onClick={(e) => { stop(e); setSettingsOpen((v) => !v); }}
                className={cn("flex h-8 w-8 shrink-0 items-center justify-center transition-colors", settingsOpen ? "text-white" : "text-white/80 hover:text-white")}
              >
                <Settings className="h-[18px] w-[18px]" strokeWidth={2} />
              </button>
              {settingsOpen && (
                <div onClick={stop} className="absolute bottom-full right-0 z-20 mb-3 overflow-hidden rounded-xl border border-white/10 bg-[#1d1c22] shadow-2xl">
                  <PlayerSettingsMenu
                    playbackSpeed={playbackSpeed}
                    onSelectSpeed={setPlaybackSpeed}
                    autoSkipSegments={autoSkipSegments}
                    onToggleAutoSkip={() => setAutoSkipSegments(!autoSkipSegments)}
                    autoPlayNextEpisode={autoPlayNextEpisode}
                    onToggleAutoPlay={() => setAutoPlayNextEpisode(!autoPlayNextEpisode)}
                    dubOptions={dubOptions ?? []}
                    selectedDubId={selectedDubId}
                    onSelectDub={(id) => {
                      setSettingsOpen(false);
                      if (id === selectedDubId) return;
                      beginSourceSwitch();
                      onSelectDub?.(id);
                    }}
                    translationOptions={translationValues}
                    selectedTranslation={shownTranslation}
                    onSelectTranslation={selectTranslation}
                    playerOptions={playerValues}
                    selectedPlayerName={shownPlayerName}
                    onSelectPlayerName={selectPlayerName}
                    qualityOptions={qualityValues}
                    selectedQuality={shownQuality}
                    onSelectQuality={selectQuality}
                    qualityLocked={!!offlinePlayback}
                    t={t}
                  />
                </div>
              )}
            </div>
            <button onClick={toggleFullscreen} className="flex h-8 w-8 shrink-0 items-center justify-center text-white/80 transition-colors hover:text-white">
              {isFullscreen ? <Minimize className="h-[18px] w-[18px]" strokeWidth={2} /> : <Maximize className="h-[18px] w-[18px]" strokeWidth={2} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
