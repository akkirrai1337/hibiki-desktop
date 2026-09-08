import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { motion } from "motion/react";
import { Pencil, User, Check, Film, Library, Clock, CheckCircle2, Gauge, Sparkles } from "lucide-react";
import { hibiki } from "@/lib/hibiki";
import { animeTitle } from "@/components/AnimeCard";
import { ContinueWatchingRow } from "@/components/ContinueWatchingRow";
import { useContinueWatching } from "@/lib/continueWatching";
import { useProfileStore } from "@/stores/profileStore";
import { useUiStore } from "@/stores/uiStore";
import { useAchievementsStore } from "@/stores/achievementsStore";
import { cn } from "@/lib/cn";
import { LIBRARY_CATEGORY_ICONS, LIBRARY_CATEGORY_LABEL_KEYS } from "@/lib/libraryCategories";
import { ACHIEVEMENT_TIER_BY_ID, type Achievement } from "@/lib/achievements";
import { computeLevelProgress, totalXpEarned, type LevelProgress } from "@/lib/levelProgress";
import { ACTIVITY_DAYS, buildActivitySeries, computeStreaks, StreakBadge, type StreakInfo } from "@/components/StreakBadge";
import type { DailyActivity, LibraryEntry, XpEvent } from "@shared/types";

// Rendered persistently from __root.tsx instead - see index.tsx for why.
export const Route = createFileRoute("/profile")({ component: () => null });

const RECENT_LIMIT = 5;
const CONTINUE_LIMIT = 4;
// Just needs to be well past any realistic account age - listDailyActivity's own "days" param is
// a plain cutoff (now - days), not a page size, so this is a cheap way to ask for "everything"
// without a dedicated lifetime-totals endpoint. Matches useAchievementUnlocks's own copy of this
// constant - same query key, so react-query serves both from one shared cache entry rather than
// fetching it twice.
const LIFETIME_ACTIVITY_DAYS = 3650;
const DEFAULT_NAME = "Hibiki";

function shortDayLabel(dateKey: string, locale: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale, { day: "numeric", month: "short" });
}

function relativeDate(epochMs: number, t: TFunction, locale: string): string {
  const days = Math.floor((Date.now() - epochMs) / 86_400_000);
  if (days <= 0) return t("profile.today");
  if (days === 1) return t("profile.yesterday");
  if (days < 7) return t("profile.daysAgo", { count: days });
  return new Date(epochMs).toLocaleDateString(locale, { day: "numeric", month: "short" });
}

export function ProfilePage() {
  const { t, i18n } = useTranslation();
  const name = useProfileStore((s) => s.name);
  const setName = useProfileStore((s) => s.setName);
  const avatarDataUrl = useProfileStore((s) => s.avatarDataUrl);
  const setAvatarDataUrl = useProfileStore((s) => s.setAvatarDataUrl);

  const libraryQuery = useQuery({ queryKey: ["library"], queryFn: () => hibiki.library.list() });
  // Same ["sources"] key index.tsx/library.tsx already query - without this, ContinueWatchingRow
  // below had no installed-source map to check a card's source against, so every card here always
  // fell back to the "source removed" badge (see knownSourcesStore), installed or not.
  const sourcesQuery = useQuery({ queryKey: ["sources"], queryFn: () => hibiki.sources.list() });
  const sourceById = useMemo(() => new Map((sourcesQuery.data ?? []).map((s) => [s.id, s])), [sourcesQuery.data]);
  const activityQuery = useQuery({ queryKey: ["dailyActivity", ACTIVITY_DAYS], queryFn: () => hibiki.progress.listDailyActivity(ACTIVITY_DAYS) });
  // Separate from the 30-day one above - the level bar's "XP from watching hours" component (see
  // levelProgress.ts) needs a real lifetime total, not just what the visible activity chart
  // covers. Same query key useAchievementUnlocks() itself fetches, in __root.tsx - one shared
  // cache entry, not a second live request just because this page also wants a piece of it.
  const lifetimeActivityQuery = useQuery({ queryKey: ["dailyActivity", LIFETIME_ACTIVITY_DAYS], queryFn: () => hibiki.progress.listDailyActivity(LIFETIME_ACTIVITY_DAYS) });

  const entries = libraryQuery.data ?? [];
  const completedTitlesCount = useMemo(() => entries.filter((e) => e.category === "completed").length, [entries]);

  const activitySeries = useMemo(() => buildActivitySeries(activityQuery.data ?? [], ACTIVITY_DAYS), [activityQuery.data]);
  const totalWatchedMs = useMemo(() => activitySeries.reduce((sum, d) => sum + d.watchedMs, 0), [activitySeries]);
  const totalCompleted = useMemo(() => activitySeries.reduce((sum, d) => sum + d.completedCount, 0), [activitySeries]);
  // Episodes/week over the same 30-day window the other cards already use - distinct from the raw
  // "episodes watched" total next to it (a rate vs. a count), and from the streak badge (which
  // only tracks whether a day had *any* activity, not how much).
  const weeklyPace = useMemo(() => Math.round((totalCompleted / (ACTIVITY_DAYS / 7)) * 10) / 10, [totalCompleted]);
  const { current: currentStreak, best: bestStreak, atRisk: streakAtRisk } = useMemo(() => computeStreaks(activitySeries), [activitySeries]);

  // Plays the badge's pop/burst animation once for an increment that happened elsewhere (the watch
  // player) while this page wasn't open to show its own version of it - see profileCelebratedStreak
  // for why this needs to be its own persisted value rather than reusing the player toast's. Read
  // directly during render (not via effect/state) because the value that matters is whatever it is
  // at the exact moment the badge's AnimatePresence groups first mount - by design that's the same
  // moment `currentStreak` first becomes > 0 (StreakBadge itself renders nothing before then), so
  // the query has necessarily already resolved by then and this can't race a stale default.
  const profileCelebratedStreak = useUiStore((s) => s.profileCelebratedStreak);
  const setProfileCelebratedStreak = useUiStore((s) => s.setProfileCelebratedStreak);
  const playStreakOnMount = profileCelebratedStreak !== -1 && currentStreak > profileCelebratedStreak;
  useEffect(() => {
    if (activityQuery.isSuccess && currentStreak !== profileCelebratedStreak) setProfileCelebratedStreak(currentStreak);
  }, [activityQuery.isSuccess, currentStreak, profileCelebratedStreak, setProfileCelebratedStreak]);

  const lifetimeRows = lifetimeActivityQuery.data ?? [];
  const lifetimeWatchedMs = useMemo(() => lifetimeRows.reduce((sum, d) => sum + d.watchedMs, 0), [lifetimeRows]);
  // Computed and kept fresh by useAchievementUnlocks (mounted once in __root.tsx, not here) - that
  // hook also owns detecting a newly-crossed tier and logging/toasting it, which has to keep
  // running regardless of whether this page happens to be open (most tiers actually clear from
  // the watch page, via "finisher"). Reading its output back out here just avoids recomputing the
  // same achievement list a second time.
  const achievements = useAchievementsStore((s) => s.achievements);

  const xpEventsQuery = useQuery({ queryKey: ["xpEvents"], queryFn: () => hibiki.xp.list() });

  // Mostly watch time, with unlocking (not just accumulating) achievement tiers as the bigger,
  // occasional bumps - see levelProgress.ts for the exact weighting.
  const levelProgress = useMemo(
    () => computeLevelProgress(totalXpEarned(achievements, lifetimeWatchedMs)),
    [achievements, lifetimeWatchedMs],
  );

  const recent = useMemo(() => [...entries].sort((a, b) => b.addedAt - a.addedAt).slice(0, RECENT_LIMIT), [entries]);
  // Shared with the home page's own "continue watching" row - see useContinueWatching, which
  // caches per-title lookups under query keys both pages agree on, so whichever page the user
  // visits first does the actual fetching and the other reads it straight back out of the cache.
  const { hasHistory } = useContinueWatching();

  // Every number on this page (streak, level, stat cards, activity chart, XP history) depends on
  // one of these - rendering the real layout before they've resolved just showed a page full of
  // zeroes and empty sections that then visibly jumped to their real values a moment later, which
  // read as broken/flaky rather than "still loading". `sourcesQuery` is deliberately left out -
  // it's only used for a card's source badge (a cosmetic, non-blocking detail), and library/
  // lifetime-activity are already warmed at the app shell level (see __root.tsx's own
  // useAchievementUnlocks), so in practice this only actually shows on a genuinely cold first
  // load, not once per profile visit.
  const isLoading = libraryQuery.isLoading || activityQuery.isLoading || lifetimeActivityQuery.isLoading || xpEventsQuery.isLoading;
  if (isLoading) return <ProfileSkeleton />;

  return (
    <div className="min-h-full bg-app-bg pb-16">
      <ProfileHeader
        name={name ?? DEFAULT_NAME}
        onNameChange={setName}
        avatarDataUrl={avatarDataUrl}
        onAvatarChange={setAvatarDataUrl}
        levelProgress={levelProgress}
        streak={{ current: currentStreak, best: bestStreak, atRisk: streakAtRisk }}
        playStreakOnMount={playStreakOnMount}
      />

      {/* A 4th column only kicks in once the window is wide enough to actually give it room
          (2xl, 1536px+) - below that, XP history just stacks under achievements inside their
          shared column instead of squeezing into its own sliver. */}
      <div className="grid max-w-6xl grid-cols-1 gap-8 px-8 pt-8 lg:grid-cols-3 2xl:max-w-[1600px] 2xl:grid-cols-4">
        <div className="space-y-8 lg:col-span-2">
          {/* The streak card moved up next to the name (see StreakBadge in ProfileHeader) - this
              slot now shows library size instead of just dropping to 3 cards. */}
          <div className="grid grid-cols-5 gap-4">
            <StatCard icon={Film} label={t("profile.statCompletedTitles")} value={completedTitlesCount} />
            <StatCard icon={Library} label={t("profile.statLibrarySize")} value={entries.length} />
            <StatCard icon={Clock} label={t("profile.statWatchTime")} value={t("profile.hours", { hours: (totalWatchedMs / 3_600_000).toFixed(1) })} />
            <StatCard icon={CheckCircle2} label={t("profile.episodesCompleted")} value={totalCompleted} />
            <StatCard icon={Gauge} label={t("profile.statPace")} value={t("common.episodesShort", { count: weeklyPace })} />
          </div>

          {hasHistory && (
            <section>
              <h2 className="mb-3 text-sm font-bold text-text">{t("profile.continueWatchingTitle")}</h2>
              <ContinueWatchingRow limit={CONTINUE_LIMIT} sourceById={sourceById} />
            </section>
          )}

          <section>
            <h2 className="mb-4 text-sm font-bold text-text">{t("profile.activityTitle")}</h2>
            <ActivityBars series={activitySeries} locale={i18n.language} />
          </section>

          <section>
            <h2 className="mb-3 text-sm font-bold text-text">{t("profile.recentTitle")}</h2>
            {recent.length === 0 ? (
              <p className="text-sm text-muted">{t("profile.recentEmpty")}</p>
            ) : (
              <div className="flex flex-col gap-1">
                {recent.map((entry) => <RecentRow key={`${entry.sourceId}:${entry.animeId}`} entry={entry} locale={i18n.language} />)}
              </div>
            )}
          </section>
        </div>

        <div className="grid grid-cols-1 gap-8 lg:col-span-1 2xl:col-span-2 2xl:grid-cols-2">
          <section>
            <h2 className="mb-3 text-sm font-bold text-text">{t("profile.achievementsTitle")}</h2>
            <AchievementGrid achievements={achievements} />
          </section>

          <section>
            <h2 className="mb-3 text-sm font-bold text-text">{t("profile.xpHistoryTitle")}</h2>
            {(xpEventsQuery.data ?? []).length === 0 ? (
              <p className="text-sm text-muted">{t("profile.xpHistoryEmpty")}</p>
            ) : (
              <div className="flex flex-col gap-1">
                {(xpEventsQuery.data ?? []).map((event) => <XpHistoryRow key={event.id} event={event} locale={i18n.language} />)}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// Matches ProfilePage's own layout proportions (same header/stat-row/two-column grid shape) so
// flipping over to the real content doesn't visibly reflow - same reasoning as AnimeCard's own
// SkeletonCard.
function ProfileSkeleton() {
  return (
    <div className="min-h-full animate-pulse bg-app-bg pb-16">
      <div className="border-b border-border px-8 pb-8 pt-10">
        <div className="flex items-center gap-5">
          <div className="h-20 w-20 shrink-0 rounded-full bg-text/[.06]" />
          <div className="min-w-0 flex-1">
            <div className="h-7 w-48 rounded bg-text/[.08]" />
            <div className="mt-3 h-1.5 w-full max-w-xs rounded-full bg-text/[.06]" />
          </div>
        </div>
      </div>
      <div className="grid max-w-6xl grid-cols-1 gap-8 px-8 pt-8 lg:grid-cols-3 2xl:max-w-[1600px] 2xl:grid-cols-4">
        <div className="space-y-8 lg:col-span-2">
          <div className="grid grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-border bg-text/[.03] p-4">
                <div className="h-5 w-5 rounded bg-text/[.08]" />
                <div className="mt-3 h-6 w-10 rounded bg-text/[.08]" />
                <div className="mt-2 h-3 w-16 rounded bg-text/[.06]" />
              </div>
            ))}
          </div>
          <div>
            <div className="mb-4 h-4 w-32 rounded bg-text/[.08]" />
            <div className="flex h-36 items-end gap-1.5">
              {Array.from({ length: ACTIVITY_DAYS }).map((_, i) => (
                <div key={i} className="flex-1 rounded-sm bg-text/[.06]" style={{ height: `${8 + ((i * 37) % 80)}%` }} />
              ))}
            </div>
          </div>
          <div>
            <div className="mb-3 h-4 w-28 rounded bg-text/[.08]" />
            <div className="flex flex-col gap-1">
              {Array.from({ length: RECENT_LIMIT }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-2">
                  <div className="h-14 w-10 shrink-0 rounded-lg bg-text/[.06]" />
                  <div className="min-w-0 flex-1"><div className="h-4 w-2/3 rounded bg-text/[.06]" /></div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-8 lg:col-span-1 2xl:col-span-2 2xl:grid-cols-2">
          <div>
            <div className="mb-3 h-4 w-32 rounded bg-text/[.08]" />
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-[70px] rounded-xl border border-border bg-text/[.02]" />
              ))}
            </div>
          </div>
          <div>
            <div className="mb-3 h-4 w-24 rounded bg-text/[.08]" />
            <div className="flex flex-col gap-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-2">
                  <div className="h-9 w-9 shrink-0 rounded-lg bg-text/[.06]" />
                  <div className="min-w-0 flex-1"><div className="h-4 w-1/2 rounded bg-text/[.06]" /></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfileHeader({ name, onNameChange, avatarDataUrl, onAvatarChange, levelProgress, streak, playStreakOnMount }: { name: string; onNameChange: (name: string | null) => void; avatarDataUrl: string | null; onAvatarChange: (dataUrl: string | null) => void; levelProgress: LevelProgress; streak: StreakInfo; playStreakOnMount: boolean }) {
  return (
    <div className="border-b border-border px-8 pb-8 pt-10">
      <div className="flex items-center gap-5">
        <AvatarPicker avatarDataUrl={avatarDataUrl} onChange={onAvatarChange} />
        <div className="min-w-0 flex-1">
          <NameEditor name={name} onChange={onNameChange} streak={streak} playStreakOnMount={playStreakOnMount} />
          <LevelBar levelProgress={levelProgress} />
        </div>
      </div>
    </div>
  );
}

function LevelBar({ levelProgress }: { levelProgress: LevelProgress }) {
  const { t } = useTranslation();
  const percent = Math.min(100, (levelProgress.xpIntoLevel / levelProgress.xpForLevel) * 100);
  return (
    <div className="mt-2.5 flex max-w-xs items-center gap-2.5">
      <span className="shrink-0 rounded-md bg-accent/15 px-2 py-0.5 text-xs font-bold text-accent-text">{t("profile.levelBadge", { level: levelProgress.level })}</span>
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-text/[.08]">
        <div className="h-full rounded-full bg-accent ring-1 ring-inset ring-border transition-[width] duration-500" style={{ width: `${percent}%` }} />
      </div>
      <span className="shrink-0 text-[11px] tabular-nums text-muted">{levelProgress.xpIntoLevel}/{levelProgress.xpForLevel} {t("profile.xp")}</span>
    </div>
  );
}

// A real canvas 2D resample (imageSmoothingQuality: "high"), not just a plain <img> - AnimeCard's
// own SmoothImage dropped exactly this technique (see that file) because doing it per-poster made
// a whole scrolling catalog of hundreds of cards expensive to keep smooth. None of that applies to
// a single always-mounted avatar, so there's no reason not to still do it here - this is a picked
// user file of whatever size/quality they happened to have, unlike a source's own catalog artwork,
// so it's much more likely to actually need real resampling instead of just being displayed at
// close to its native resolution already.
function ResampledAvatar({ src }: { src: string }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loadedSrc, setLoadedSrc] = useState("");

  useEffect(() => {
    const img = imageRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    let frame = 0;
    const draw = () => {
      canvas.style.opacity = "0";
      if (!img.complete || !img.naturalWidth || !img.naturalHeight) return;
      const width = img.clientWidth;
      const height = img.clientHeight;
      if (!width || !height) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      // Centered object-cover, matching the fallback <img> below without stretching it - this
      // still runs (unlike SmoothImage's old upscale bail-out) even when the picked file is
      // smaller than the 80x80 slot: canvas interpolation can't invent missing detail, but it
      // still smooths the transition between source pixels noticeably better than a plain <img>
      // occasionally does for a `data:` URL at an odd scale ratio.
      const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
      const sourceWidth = width / scale;
      const sourceHeight = height / scale;
      context.drawImage(img,
        (img.naturalWidth - sourceWidth) / 2, (img.naturalHeight - sourceHeight) / 2,
        sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      canvas.style.opacity = "1";
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(img);
    window.addEventListener("resize", schedule);
    let density: MediaQueryList;
    const trackDensity = () => {
      density?.removeEventListener("change", trackDensity);
      density = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      density.addEventListener("change", trackDensity);
      schedule();
    };
    trackDensity();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      density.removeEventListener("change", trackDensity);
    };
  }, [src, loadedSrc]);

  return (
    <span className="relative block h-full w-full overflow-hidden">
      <img
        ref={imageRef}
        src={src}
        alt=""
        className="h-full w-full object-cover"
        onLoad={(event) => setLoadedSrc(event.currentTarget.currentSrc)}
      />
      <canvas key={src} ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" style={{ opacity: 0 }} />
    </span>
  );
}

function AvatarPicker({ avatarDataUrl, onChange }: { avatarDataUrl: string | null; onChange: (dataUrl: string | null) => void }) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onChange(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  };
  return (
    <button onClick={() => inputRef.current?.click()} aria-label={t("profile.editAvatar")} className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-full bg-text/[.06] ring-2 ring-border">
      {avatarDataUrl ? <ResampledAvatar src={avatarDataUrl} /> : <div className="flex h-full w-full items-center justify-center"><User className="h-8 w-8 text-muted" strokeWidth={1.5} /></div>}
      <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
        <Pencil className="h-5 w-5 text-text" strokeWidth={2} />
      </div>
      <input ref={inputRef} type="file" accept="image/*" onChange={onPick} className="hidden" />
    </button>
  );
}

function NameEditor({ name, onChange, streak, playStreakOnMount }: { name: string; onChange: (name: string | null) => void; streak: StreakInfo; playStreakOnMount: boolean }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  const commit = () => {
    const trimmed = draft.trim();
    onChange(trimmed.length > 0 ? trimmed : null);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(name); setEditing(false); } }}
          onBlur={commit}
          className="h-10 w-full max-w-xs rounded-lg bg-text/[.06] px-3 text-xl font-bold text-text outline-none ring-1 ring-accent/50"
        />
        <button onClick={commit} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg"><Check className="h-4 w-4" strokeWidth={2.5} /></button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5">
      <StreakBadge current={streak.current} best={streak.best} atRisk={streak.atRisk} playOnMount={playStreakOnMount} />
      <button onClick={() => { setDraft(name); setEditing(true); }} aria-label={t("profile.editName")} className="group flex min-w-0 items-center gap-2">
        <h1 className="select-text truncate text-2xl font-bold text-text">{name}</h1>
        <Pencil className="h-4 w-4 shrink-0 text-muted/70 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={2} />
      </button>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub }: { icon: typeof Film; label: string; value: string | number; sub?: string }) {
  // A short number ("12", "3.2 ч") reads fine at text-2xl, but a longer value with a unit
  // ("0.5 эп./нед.") wraps onto two lines at that size and ends up looking oversized/cramped -
  // five narrower columns (since the pace card joined the row) made this a lot more likely to bite.
  const isLong = String(value).length > 6;
  return (
    <div className="rounded-2xl border border-border bg-text/[.03] p-4">
      <Icon className="h-5 w-5 text-accent-text" strokeWidth={2} />
      <p className={cn("mt-3 truncate font-bold text-text", isLong ? "text-lg" : "text-2xl")}>{value}</p>
      <p className="mt-0.5 text-xs text-muted">{label}</p>
      {sub && <p className="mt-1 text-[11px] text-muted/70">{sub}</p>}
    </div>
  );
}

function AchievementGrid({ achievements }: { achievements: Achievement[] }) {
  // Unlocked first - the ones you've actually earned are more interesting than a wall of grey
  // locked cards, and this way scrolling further down is "what's left to do" in a natural order.
  const sorted = useMemo(() => [...achievements].sort((a, b) => Number(b.unlocked) - Number(a.unlocked)), [achievements]);
  return <div className="space-y-2">{sorted.map((a) => <AchievementCard key={a.id} achievement={a} />)}</div>;
}

function AchievementCard({ achievement }: { achievement: Achievement }) {
  const { t } = useTranslation();
  const Icon = achievement.icon;
  const percent = Math.min(100, (achievement.current / achievement.target) * 100);
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border p-3 transition-colors", achievement.unlocked ? "border-accent/25 bg-accent/[.07]" : "border-border bg-text/[.02]")}>
      <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full", achievement.unlocked ? "bg-accent/15 text-accent-text" : "bg-text/[.05] text-muted/70")}>
        <Icon className="h-5 w-5" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className={cn("truncate text-sm font-semibold", achievement.unlocked ? "text-text" : "text-muted")}>{t(achievement.titleKey)}</p>
          {achievement.unlocked
            ? <Check className="h-4 w-4 shrink-0 text-accent-text" strokeWidth={2.5} />
            : <span className="shrink-0 text-[11px] tabular-nums text-muted/70">{achievement.current}/{achievement.target}</span>}
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted">{t(achievement.descriptionKey, { target: achievement.target })}</p>
          {/* What clearing this tier actually pays into the level bar - shown even once unlocked,
              as a reminder of what that checkmark was worth. */}
          <span className="shrink-0 text-[11px] font-semibold text-accent-text/80">+{achievement.xpReward} {t("profile.xp")}</span>
        </div>
        {!achievement.unlocked && (
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-text/[.06]">
            <div className="h-full rounded-full bg-accent/60 ring-1 ring-inset ring-border" style={{ width: `${percent}%` }} />
          </div>
        )}
        {/* Small dots, not another full-width bar - the first version used the same bar shape as
            the progress bar above and just read as a second, broken one. One dot per tier
            (Коллекционер/Энтузиаст/Куратор, ...) - only shown for a leveled family (maxLevel > 1);
            a single-tier achievement like "Первый шаг" gets no indicator at all. */}
        {achievement.maxLevel > 1 && (
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className="text-[10px] text-muted/70">{t("profile.achievementLevel", { level: achievement.level, maxLevel: achievement.maxLevel })}</span>
            <div className="flex gap-1">
              {Array.from({ length: achievement.maxLevel }).map((_, i) => (
                <span key={i} className={cn("h-1.5 w-1.5 rounded-full ring-1 ring-inset", i < achievement.level ? "bg-accent ring-border" : "bg-text/[.12] ring-transparent")} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RecentRow({ entry, locale }: { entry: LibraryEntry; locale: string }) {
  const { t } = useTranslation();
  const title = animeTitle(entry.anime);
  const Icon = LIBRARY_CATEGORY_ICONS[entry.category];
  return (
    <Link to="/anime/$sourceId/$animeId" params={{ sourceId: entry.sourceId, animeId: entry.animeId }} className="flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-text/[.05]">
      <div className="h-14 w-10 shrink-0 overflow-hidden rounded-lg bg-surface ring-1 ring-border">
        {entry.anime.posterUrl && <img src={entry.anime.posterUrl} alt="" loading="lazy" className="h-full w-full object-cover" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="select-text truncate text-sm font-semibold text-text">{title}</p>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
          <Icon className="h-3 w-3 shrink-0" strokeWidth={2} />
          <span>{t(LIBRARY_CATEGORY_LABEL_KEYS[entry.category])}</span>
        </div>
      </div>
      <span className="shrink-0 text-xs text-muted/70">{relativeDate(entry.addedAt, t, locale)}</span>
    </Link>
  );
}

function XpHistoryRow({ event, locale }: { event: XpEvent; locale: string }) {
  const { t } = useTranslation();
  const tier = ACHIEVEMENT_TIER_BY_ID[event.kind];
  const Icon = tier?.icon ?? Sparkles;
  return (
    <div className="flex items-center gap-3 rounded-xl p-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-text/[.06] text-muted">
        <Icon className="h-4 w-4" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-text">{tier ? t(`profile.achievements.${tier.id}.title`) : event.kind}</p>
        <span className="text-xs text-muted/70">{relativeDate(event.createdAt, t, locale)}</span>
      </div>
      <span className="shrink-0 text-[11px] font-semibold text-accent-text/80">+{event.xp} {t("profile.xp")}</span>
    </div>
  );
}

function ActivityBars({ series, locale }: { series: DailyActivity[]; locale: string }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((d) => d.completedCount));
  const hoveredDay = hovered !== null ? series[hovered] : null;
  return (
    <div>
      <div className="relative">
        {hoveredDay && (
          <div
            className="pointer-events-none absolute bottom-full z-10 mb-2 w-max -translate-x-1/2 select-text rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-2xl"
            style={{ left: `${((hovered! + 0.5) / series.length) * 100}%` }}
          >
            <p className="font-semibold text-text">{shortDayLabel(hoveredDay.date, locale)}</p>
            <p className="mt-1 text-muted">{t("profile.activityEpisodes", { count: hoveredDay.completedCount })}</p>
            <p className="text-muted">{t("profile.activityMinutes", { count: Math.round(hoveredDay.watchedMs / 60_000) })}</p>
          </div>
        )}
        <div className="flex h-36 items-end gap-1.5">
          {series.map((d, i) => (
            <motion.div
              key={d.date}
              initial={{ height: 0 }}
              animate={{ height: d.completedCount > 0 ? `${Math.max(8, (d.completedCount / max) * 100)}%` : 4 }}
              transition={{ duration: 0.35, ease: "easeOut", delay: i * 0.008 }}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered((h) => (h === i ? null : h))}
              // A fixed coral (#FF7A86, matching the Android app's own ActivityBarChart - see
              // LocalProfileAnalyticsSection.kt), not bg-accent - sidesteps the accent-vs
              // -background contrast problem entirely (a white or black accent color would
              // otherwise blend straight into a light or dark page background) and keeps this
              // reading the same across both apps regardless of whatever accent is picked here.
              className={cn("flex-1 rounded-sm transition-colors", d.completedCount === 0 && (hovered === i ? "bg-text/[.16]" : "bg-text/[.08]"))}
              style={d.completedCount > 0 ? { backgroundColor: hovered === i ? "#FF7A86CC" : "#FF7A86" } : undefined}
            />
          ))}
        </div>
      </div>
      <div className="mt-2 flex gap-1.5">
        {series.map((d, i) => (
          <div key={d.date} className="flex-1 text-center text-[10px] text-muted/70">
            {(i % 5 === 0 || i === series.length - 1) ? shortDayLabel(d.date, locale) : ""}
          </div>
        ))}
      </div>
    </div>
  );
}
