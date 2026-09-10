import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, Ban, Check, CheckCircle2, ChevronDown, ChevronUp, DatabaseBackup, FileText, FolderOpen, Globe, Info, Languages, MessageCircle, Moon, Palette, RefreshCw, RotateCcw, ScrollText, Sparkles, Sun, Timer, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { Switch } from "@/components/Switch";
import { SUPPORTED_LOCALES, setLocale } from "@/lib/i18n";
import { SKIP_TIMER_MAX_SECONDS, SKIP_TIMER_MIN_SECONDS, WATCHED_THRESHOLD_MAX_PERCENT, WATCHED_THRESHOLD_MIN_PERCENT, usePlayerPrefsStore } from "@/stores/playerPrefsStore";
import { useUiStore } from "@/stores/uiStore";
import { ACCENT_PRESETS, applyAccentColor, BACKGROUND_THEME_PRESETS, DEFAULT_ACCENT } from "@/lib/theme";
import { hibiki, type LogEntry } from "@/lib/hibiki";

// A bold title above its rows - the rows themselves are separate cards (see SettingsRow), matching
// how the rest of the app groups things (Sources' extension list, Library's grid) rather than one
// single bordered container with internal dividers, which read as off-style next to everything else.
function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 last:mb-0">
      <h2 className="mb-2 px-1 text-sm font-bold text-text">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

// Every row is its own rounded card, icon-led - same visual unit as a source/extension row elsewhere
// in the app, instead of a bare list item divided from its neighbors by a hairline.
function SettingsRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-border bg-text/[.03] p-4">
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-text/[.06] text-muted">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// Same stepper look as SearchFiltersPanel's YearNumberInput (no-spinner input + a stacked
// up/down chevron pair, instead of the browser's own spinner arrows) plus a slider for the same
// value - kept in sync via local text state so a mid-edit "5" or an empty field while typing "12"
// doesn't get clobbered back to the last committed number on every keystroke, only committed
// (blur/Enter/stepper click) once it parses to a number in range.
function SecondsControl({ label, hint, value, onChange }: { label: string; hint: string; value: number; onChange: (seconds: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const commit = (next: number) => {
    const clamped = Math.min(SKIP_TIMER_MAX_SECONDS, Math.max(SKIP_TIMER_MIN_SECONDS, next));
    onChange(clamped);
    setDraft(String(clamped));
  };
  const commitDraft = () => {
    const parsed = Number.parseInt(draft, 10);
    if (Number.isFinite(parsed)) commit(parsed);
    else setDraft(String(value));
  };
  return <div>
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm font-semibold text-text">{label}</p>
      <div className="flex h-8 w-16 shrink-0 items-stretch overflow-hidden rounded-lg border border-border bg-text/[.04] focus-within:border-accent/70">
        <input
          type="number"
          min={SKIP_TIMER_MIN_SECONDS}
          max={SKIP_TIMER_MAX_SECONDS}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => { if (e.key === "Enter") { commitDraft(); e.currentTarget.blur(); } }}
          className="no-spinner min-w-0 flex-1 bg-transparent pl-2 text-center text-sm text-text outline-none"
        />
        <div className="flex w-4 shrink-0 flex-col border-l border-border">
          <button type="button" onClick={() => commit(value + 1)} aria-label="+1" className="flex flex-1 items-center justify-center text-muted transition-colors hover:bg-text/[.06] hover:text-text">
            <ChevronUp className="h-2.5 w-2.5" strokeWidth={3} />
          </button>
          <button type="button" onClick={() => commit(value - 1)} aria-label="-1" className="flex flex-1 items-center justify-center border-t border-border text-muted transition-colors hover:bg-text/[.06] hover:text-text">
            <ChevronDown className="h-2.5 w-2.5" strokeWidth={3} />
          </button>
        </div>
      </div>
    </div>
    <input
      type="range"
      min={SKIP_TIMER_MIN_SECONDS}
      max={SKIP_TIMER_MAX_SECONDS}
      value={value}
      onChange={(e) => commit(Number(e.target.value))}
      className="mt-2.5 w-full cursor-pointer accent-accent"
    />
    <p className="mt-1.5 text-xs leading-relaxed text-muted">{hint}</p>
  </div>;
}

// Same shape as SecondsControl above, just a percent (with its own bounds/suffix) instead of a
// plain integer of seconds - kept separate rather than parameterizing that one further, since the
// "s" vs "%" suffix and each control's own min/max constants would've made the shared component
// more generic than either caller actually needs.
function PercentControl({ label, hint, value, onChange }: { label: string; hint: string; value: number; onChange: (percent: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const commit = (next: number) => {
    const clamped = Math.min(WATCHED_THRESHOLD_MAX_PERCENT, Math.max(WATCHED_THRESHOLD_MIN_PERCENT, next));
    onChange(clamped);
    setDraft(String(clamped));
  };
  const commitDraft = () => {
    const parsed = Number.parseInt(draft, 10);
    if (Number.isFinite(parsed)) commit(parsed);
    else setDraft(String(value));
  };
  return <div>
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm font-semibold text-text">{label}</p>
      <div className="flex h-8 w-[4.5rem] shrink-0 items-stretch overflow-hidden rounded-lg border border-border bg-text/[.04] focus-within:border-accent/70">
        <input
          type="number"
          min={WATCHED_THRESHOLD_MIN_PERCENT}
          max={WATCHED_THRESHOLD_MAX_PERCENT}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => { if (e.key === "Enter") { commitDraft(); e.currentTarget.blur(); } }}
          className="no-spinner min-w-0 flex-1 bg-transparent pl-2 text-right text-sm text-text outline-none"
        />
        <span className="flex shrink-0 items-center pr-1 text-sm text-muted">%</span>
        <div className="flex w-4 shrink-0 flex-col border-l border-border">
          <button type="button" onClick={() => commit(value + 1)} aria-label="+1" className="flex flex-1 items-center justify-center text-muted transition-colors hover:bg-text/[.06] hover:text-text">
            <ChevronUp className="h-2.5 w-2.5" strokeWidth={3} />
          </button>
          <button type="button" onClick={() => commit(value - 1)} aria-label="-1" className="flex flex-1 items-center justify-center border-t border-border text-muted transition-colors hover:bg-text/[.06] hover:text-text">
            <ChevronDown className="h-2.5 w-2.5" strokeWidth={3} />
          </button>
        </div>
      </div>
    </div>
    <input
      type="range"
      min={WATCHED_THRESHOLD_MIN_PERCENT}
      max={WATCHED_THRESHOLD_MAX_PERCENT}
      value={value}
      onChange={(e) => commit(Number(e.target.value))}
      className="mt-2.5 w-full cursor-pointer accent-accent"
    />
    <p className="mt-1.5 text-xs leading-relaxed text-muted">{hint}</p>
  </div>;
}

function ThemeOption({ active, icon: Icon, label, onClick }: { active: boolean; icon: typeof Sun; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors",
        active ? "bg-accent text-accent-fg" : "text-muted hover:text-text",
      )}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2} />
      {label}
    </button>
  );
}

// Same segmented control as the theme picker above, minus the icon - a provider has no glyph that
// would read as anything but decoration.
function ProviderOption({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors",
        active ? "bg-accent text-accent-fg" : "text-muted hover:text-text",
      )}
    >
      {label}
    </button>
  );
}

// One round swatch per preset, Discord-picker style - the active one gets a checkmark instead of
// just a ring, since a ring around a small circle this size reads ambiguously (is it hover, focus,
// or "selected"?) while a checkmark can only ever mean one thing.
function AccentSwatch({ color, active, onClick }: { color: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={color}
      style={{ backgroundColor: color }}
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border transition-transform hover:scale-110",
        active && "ring-2 ring-offset-2 ring-offset-bg",
      )}
    >
      {active && <Check className="h-3.5 w-3.5 text-white drop-shadow" strokeWidth={3} style={{ color: accentForegroundColor(color) }} />}
    </button>
  );
}

// Plain black/white (not the app's own accent-fg CSS var, which only tracks the *currently
// applied* accent) - each swatch needs its own checkmark contrast computed against its own color,
// including the seven presets that aren't the active accent at all.
function accentForegroundColor(hex: string): string {
  const int = Number.parseInt(hex.slice(1), 16);
  const r = (int >> 16) & 255, g = (int >> 8) & 255, b = int & 255;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 140 ? "#1d0c15" : "#ffffff";
}

// A square swatch (not round, unlike AccentSwatch) - a gradient reads better filling a bigger flat
// area than it does packed into a small circle, and the shape difference also makes "this row
// picks a whole background theme" visually distinct from "that row above picks one accent color".
// The `null` (no theme) option renders as a plain checkerboard-free empty square with a label
// instead of a swatch of its own, since there's no single color/gradient standing in for "off".
function BackgroundThemeSwatch({ gradient, active, onClick, label }: { gradient?: string; active: boolean; onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      style={gradient ? { backgroundImage: gradient } : undefined}
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-transform hover:scale-105",
        gradient ? "border-transparent" : "border-dashed border-border bg-text/[.04] text-muted",
        active && "ring-2 ring-accent ring-offset-2 ring-offset-bg",
      )}
    >
      {!gradient && <Ban className="h-3.5 w-3.5" strokeWidth={2} />}
      {active && gradient && <Check className="h-4 w-4 text-white drop-shadow" strokeWidth={3} />}
    </button>
  );
}

// Dragging inside the native color picker fires the `input` event continuously (tens of times a
// second) - routing every one of those straight into setAccentColor felt laggy because each call
// went through the persisted zustand store, which (a) re-renders this whole page and __root.tsx's
// layout on every single tick and (b) synchronously re-serializes and writes the *entire* store to
// localStorage every time, since zustand's persist middleware has no built-in throttling. Neither
// cost is needed while still dragging - only the final color, once - so this applies each tick
// straight to the CSS variable via applyAccentColor (cheap: two style.setProperty calls, no React
// re-render at all) for instant visual feedback, and only commits to the real store via onCommit
// on the native `change` event, which fires once when the picker actually closes.
//
// One more thing needed doing on top of that for the live preview to actually feel live: zeroing
// every transition-colors duration for the drag's duration (the accent-live-preview class, see
// globals.css) - without it, buttons/switches/badges keep easing toward whatever --color-accent
// was a moment ago instead of snapping to the latest one, since a plain CSS variable change
// doesn't itself animate but the elements' own `transition-colors` still does.
//
// Two bugs already got fixed here, both worth keeping in mind before touching this again:
// - `input` firing far more often than the page repaints made requestAnimationFrame-coalescing the
//   obvious move, but the first attempt cancelled the pending frame on `blur` - and Chromium fires
//   `blur` on this input the instant its color-picker popup opens (the popup isn't a
//   focus-following child the way a <select>'s dropdown is), so every scheduled frame kept getting
//   cancelled again by the *next* input's blur before it ever ran. `applyAccentColor` never fired
//   once. Fixed by only ever cancelling the pending frame on unmount, never on blur.
// - The element used to carry `key={value}`, remounting a fresh `<input>` on every commit (a
//   preset click, or the color picker's own `change`). If the OS/Chromium popup was still open at
//   that instant (nothing stops the user from picking a preset first, then reopening the custom
//   picker for a tweak, or the picker itself firing an intermediate `change` while still open for
//   further adjustment), the popup stayed bound to a DOM node that had just been destroyed - every
//   drag after that first commit silently went nowhere. Fixed by keeping one stable element for
//   the component's whole lifetime and syncing its `.value` imperatively instead of remounting.
function CustomAccentInput({ value, onCommit, theme }: { value: string; onCommit: (color: string) => void; theme: "light" | "dark" }) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Keeps the swatch in sync when the color changes from elsewhere (a preset click) without ever
  // recreating the element - see the second bug above for why recreating it is what broke this.
  useEffect(() => {
    if (inputRef.current) inputRef.current.value = value;
  }, [value]);

  // Native listeners attached by hand (not React's onChange/onInput props) - React normalizes
  // onChange across input types in ways that don't cleanly separate "still dragging" from "picker
  // closed" for type="color" specifically, and getting that distinction right is the entire point
  // here (see the comment above this component).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const root = document.documentElement;
    let rafHandle: number | null = null;

    const onInput = () => {
      root.classList.add("accent-live-preview");
      if (rafHandle !== null) return;
      rafHandle = requestAnimationFrame(() => {
        rafHandle = null;
        applyAccentColor(el.value, theme);
      });
    };
    const onChange = () => {
      onCommit(el.value);
      root.classList.remove("accent-live-preview");
    };
    el.addEventListener("input", onInput);
    el.addEventListener("change", onChange);
    return () => {
      el.removeEventListener("input", onInput);
      el.removeEventListener("change", onChange);
      root.classList.remove("accent-live-preview");
      // Unmount only - see the first bug above for why this must never also happen on `blur`.
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    };
  }, [onCommit, theme]);
  return (
    <input
      ref={inputRef}
      type="color"
      defaultValue={value}
      className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
    />
  );
}

// Everything zustand's persist middleware could have written for this origin - not a hardcoded
// list of store names, so a future new persisted store is automatically included without anyone
// having to remember to update this. Safe to dump wholesale: nothing else in the app uses
// localStorage for anything but these persisted stores.
function readAllLocalStorage(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null) entries[key] = localStorage.getItem(key)!;
  }
  return entries;
}

type BackupStatus = { kind: "success" | "error"; message: string };

// Diagnostics. The failures this app actually gets reported for (an episode that "sometimes"
// won't load, a source that resolves in ten seconds instead of one) are network-shaped and happen
// only on the user's machine - by the time anyone describes them, the evidence is gone. Every
// extension HTTP request, resolver attempt and player error now records a timed line (see
// main/logger.ts and lib/log.ts); this is the button that gets that out of the app and into a
// file worth attaching to a bug report.
function DiagnosticsSection() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [preview, setPreview] = useState<LogEntry[]>([]);
  const [expanded, setExpanded] = useState(false);

  // Only while the preview is actually open - a settings page left on screen shouldn't keep
  // pulling the whole log across IPC every two seconds for nobody to look at.
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    const load = () => {
      hibiki.logs.recent(200).then((entries) => { if (!cancelled) setPreview(entries); }).catch(() => {});
    };
    load();
    const timer = setInterval(load, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [expanded]);

  const handleExport = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const filePath = await hibiki.logs.export();
      if (filePath) setStatus({ kind: "success", message: t("settings.diagnostics.exported", { path: filePath }) });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={t("settings.diagnostics.title")}>
      <SettingsRow icon={<ScrollText className="h-[18px] w-[18px]" strokeWidth={2} />}>
        <p className="text-sm font-semibold text-text">{t("settings.diagnostics.export")}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("settings.diagnostics.exportHint")}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={handleExport}
            disabled={busy}
            className="rounded-lg bg-text/[.08] px-3 py-1.5 text-sm font-semibold text-text transition-colors hover:bg-text/[.14] disabled:opacity-50"
          >
            {t("settings.diagnostics.exportAction")}
          </button>
          <button
            onClick={() => hibiki.logs.openFolder()}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-muted transition-colors hover:bg-text/[.06]"
          >
            <FolderOpen className="h-3.5 w-3.5" strokeWidth={2} />
            {t("settings.diagnostics.openFolder")}
          </button>
          <button
            onClick={() => setExpanded((value) => !value)}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-muted transition-colors hover:bg-text/[.06]"
          >
            <FileText className="h-3.5 w-3.5" strokeWidth={2} />
            {expanded ? t("settings.diagnostics.hide") : t("settings.diagnostics.show")}
          </button>
        </div>

        {expanded && (
          <div className="mt-3 max-h-72 select-text overflow-auto rounded-lg border border-border bg-text/[.03] p-2 font-mono text-[11px] leading-relaxed">
            {preview.length === 0
              ? <p className="text-muted">{t("settings.diagnostics.empty")}</p>
              : preview.map((entry, index) => (
                  <p
                    key={`${entry.time}-${index}`}
                    className={cn(
                      "whitespace-pre-wrap break-all",
                      entry.level === "error" ? "text-rose-500" : entry.level === "warn" ? "text-amber-500" : "text-muted",
                    )}
                  >
                    {new Date(entry.time).toLocaleTimeString()} [{entry.scope}] {entry.message}
                  </p>
                ))}
          </div>
        )}

        {status && (
          <p className={cn("mt-2 select-text text-xs leading-relaxed", status.kind === "error" ? "text-rose-500" : "text-muted")}>
            {status.message}
          </p>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}


// Backs up hibiki.db, installed sources, and every persisted setting (see readAllLocalStorage) to
// a single file the user picks the location for - and restores the same. Deliberately excludes
// downloaded episodes (see main/backup.ts) - those can be many GB and are re-downloadable from the
// source at any time, unlike a watch history or an installed-but-since-removed source's script.
function BackupSection() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => { hibiki.app.getVersion().then(setVersion); }, []);

  const handleCreate = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const filePath = await hibiki.backup.create(readAllLocalStorage());
      if (filePath) setStatus({ kind: "success", message: t("settings.data.backupCreated", { path: filePath }) });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    setConfirmingRestore(false);
    setBusy(true);
    setStatus(null);
    try {
      const result = await hibiki.backup.restore();
      if (!result) { setBusy(false); return; }
      // Applied here (not by main/backup.ts itself) - the main process has no access to this
      // origin's localStorage, only the renderer does. `hibiki.app.relaunch()` right after is what
      // actually makes the restored data take effect - see the IPC handler for why a fresh start
      // is simpler and safer here than trying to hot-swap the live DB connection and re-read every
      // already-mounted store mid-session.
      localStorage.clear();
      for (const [key, value] of Object.entries(result.localStorage)) localStorage.setItem(key, value);
      // A short delay, not an immediate relaunch - `localStorage.setItem` returns before Chromium's
      // storage backend has necessarily flushed those writes to disk, and app.exit() right after
      // would risk tearing the process down before that finishes, silently reverting some of what
      // was just restored the moment the new process reads localStorage back on its own first load.
      await new Promise((resolve) => setTimeout(resolve, 250));
      hibiki.app.relaunch();
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      setBusy(false);
    }
  };

  return (
    <SettingsSection title={t("settings.data.title")}>
      <SettingsRow icon={<DatabaseBackup className="h-[18px] w-[18px]" strokeWidth={2} />}>
        <p className="text-sm font-semibold text-text">{t("settings.data.backup")}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("settings.data.backupHint")}</p>
        <button
          onClick={handleCreate}
          disabled={busy}
          className="mt-3 rounded-lg bg-text/[.08] px-3 py-1.5 text-sm font-semibold text-text transition-colors hover:bg-text/[.14] disabled:opacity-50"
        >
          {t("settings.data.backupAction")}
        </button>
      </SettingsRow>

      <SettingsRow icon={<RotateCcw className="h-[18px] w-[18px]" strokeWidth={2} />}>
        <p className="text-sm font-semibold text-text">{t("settings.data.restore")}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("settings.data.restoreHint")}</p>
        {confirmingRestore ? (
          <div className="mt-3 rounded-lg border border-rose-400/30 bg-rose-400/10 p-3 dark:border-rose-400/20 dark:bg-rose-400/5">
            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-rose-700 dark:text-rose-200">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} />
              {t("settings.data.restoreConfirm")}
            </p>
            <div className="mt-2.5 flex gap-2">
              <button onClick={handleRestore} disabled={busy} className="rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50">
                {t("settings.data.restoreConfirmAction")}
              </button>
              <button onClick={() => setConfirmingRestore(false)} disabled={busy} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-text/[.06] disabled:opacity-50">
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmingRestore(true)}
            disabled={busy}
            className="mt-3 rounded-lg bg-text/[.08] px-3 py-1.5 text-sm font-semibold text-text transition-colors hover:bg-text/[.14] disabled:opacity-50"
          >
            {t("settings.data.restoreAction")}
          </button>
        )}
      </SettingsRow>

      {status && (
        <p className={cn("select-text px-1 text-xs leading-relaxed", status.kind === "error" ? "text-rose-500" : "text-muted")}>
          {status.message}
        </p>
      )}

      {version && (
        <p className="flex items-center gap-1.5 px-1 text-xs text-muted">
          <Info className="h-3 w-3 shrink-0" strokeWidth={2} />
          {t("settings.data.version", { version })}
        </p>
      )}
    </SettingsSection>
  );
}

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const autoSkipDelaySeconds = usePlayerPrefsStore((s) => s.autoSkipDelaySeconds);
  const setAutoSkipDelaySeconds = usePlayerPrefsStore((s) => s.setAutoSkipDelaySeconds);
  const skipButtonTimeoutSeconds = usePlayerPrefsStore((s) => s.skipButtonTimeoutSeconds);
  const setSkipButtonTimeoutSeconds = usePlayerPrefsStore((s) => s.setSkipButtonTimeoutSeconds);
  const watchedThresholdPercent = usePlayerPrefsStore((s) => s.watchedThresholdPercent);
  const setWatchedThresholdPercent = usePlayerPrefsStore((s) => s.setWatchedThresholdPercent);
  const autoUpdate = useUiStore((s) => s.autoUpdate);
  const setAutoUpdate = useUiStore((s) => s.setAutoUpdate);
  const discordRpcEnabled = useUiStore((s) => s.discordRpcEnabled);
  const setDiscordRpcEnabled = useUiStore((s) => s.setDiscordRpcEnabled);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const accentColor = useUiStore((s) => s.accentColor);
  const setAccentColor = useUiStore((s) => s.setAccentColor);
  const backgroundTheme = useUiStore((s) => s.backgroundTheme);
  const setBackgroundTheme = useUiStore((s) => s.setBackgroundTheme);
  const catalogAutoLoad = useUiStore((s) => s.catalogAutoLoad);
  const setCatalogAutoLoad = useUiStore((s) => s.setCatalogAutoLoad);
  const externalMetadataEnabled = useUiStore((s) => s.externalMetadataEnabled);
  const setExternalMetadataEnabled = useUiStore((s) => s.setExternalMetadataEnabled);
  const externalMetadataProvider = useUiStore((s) => s.externalMetadataProvider);
  const setExternalMetadataProvider = useUiStore((s) => s.setExternalMetadataProvider);
  const externalMetadataFallback = useUiStore((s) => s.externalMetadataFallback);
  const setExternalMetadataFallback = useUiStore((s) => s.setExternalMetadataFallback);
  const externalMetadataShowBinding = useUiStore((s) => s.externalMetadataShowBinding);
  const setExternalMetadataShowBinding = useUiStore((s) => s.setExternalMetadataShowBinding);
  const aggregatorCatalog = useUiStore((s) => s.aggregatorCatalog);
  const setAggregatorCatalog = useUiStore((s) => s.setAggregatorCatalog);
  return <div className="min-h-full bg-app-bg p-8">
    <div className="mx-auto max-w-xl">
      <h1 className="mb-6 text-xl font-semibold text-text">{t("nav.settings")}</h1>

      <SettingsSection title={t("settings.appearance.title")}>
        <SettingsRow icon={theme === "dark" ? <Moon className="h-[18px] w-[18px]" strokeWidth={2} /> : <Sun className="h-[18px] w-[18px]" strokeWidth={2} />}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text">{t("settings.appearance.theme")}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("settings.appearance.themeHint")}</p>
            </div>
            <div className="flex shrink-0 rounded-lg bg-text/[.05] p-0.5">
              <ThemeOption active={theme === "light"} icon={Sun} label={t("settings.appearance.light")} onClick={() => setTheme("light")} />
              <ThemeOption active={theme === "dark"} icon={Moon} label={t("settings.appearance.dark")} onClick={() => setTheme("dark")} />
            </div>
          </div>
        </SettingsRow>

        <SettingsRow icon={<Palette className="h-[18px] w-[18px]" strokeWidth={2} />}>
          <p className="text-sm font-semibold text-text">{t("settings.appearance.accentColor")}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("settings.appearance.accentColorHint")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {ACCENT_PRESETS.map((color) => (
              <AccentSwatch key={color} color={color} active={(accentColor ?? DEFAULT_ACCENT) === color} onClick={() => setAccentColor(color === DEFAULT_ACCENT ? null : color)} />
            ))}
            {/* A relative wrapper around the native color input - the input itself is made invisible
                but stays interactive and on top (opacity-0, not display:none), so clicking anywhere
                on our own custom-styled swatch still opens the OS color picker exactly as if the
                native input were the thing visibly clicked. */}
            <label className="relative flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full border border-dashed border-border text-muted transition-colors hover:border-accent/60 hover:text-text" title={t("settings.appearance.customColor")}>
              <Palette className="h-3.5 w-3.5" strokeWidth={2} />
              <CustomAccentInput value={accentColor ?? DEFAULT_ACCENT} onCommit={setAccentColor} theme={theme} />
            </label>
          </div>
        </SettingsRow>

        <SettingsRow icon={<Sparkles className="h-[18px] w-[18px]" strokeWidth={2} />}>
          <p className="text-sm font-semibold text-text">{t("settings.appearance.backgroundTheme")}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("settings.appearance.backgroundThemeHint")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <BackgroundThemeSwatch active={backgroundTheme === null} onClick={() => setBackgroundTheme(null)} label={t("settings.appearance.backgroundThemeNone")} />
            {BACKGROUND_THEME_PRESETS.map((preset) => (
              <BackgroundThemeSwatch key={preset.id} gradient={preset.gradient} active={backgroundTheme === preset.id} onClick={() => setBackgroundTheme(preset.id)} />
            ))}
          </div>
        </SettingsRow>

      </SettingsSection>

      <SettingsSection title={t("settings.general")}>
        <SettingsRow icon={<Languages className="h-[18px] w-[18px]" strokeWidth={2} />}>
          <p className="mb-2.5 text-sm font-semibold text-text">{t("settings.language")}</p>
          <div className="flex flex-wrap gap-2">
            {SUPPORTED_LOCALES.map((locale) => (
              <button
                key={locale}
                onClick={() => setLocale(locale)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                  i18n.language === locale ? "bg-accent text-accent-fg" : "bg-text/[.05] text-muted hover:bg-text/[.08] hover:text-text",
                )}
              >
                {t(`settings.languageNames.${locale}`)}
              </button>
            ))}
          </div>
        </SettingsRow>

        <SettingsRow icon={<MessageCircle className="h-[18px] w-[18px]" strokeWidth={2} />}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text">{t("settings.discord.enabled")}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("settings.discord.hint")}</p>
            </div>
            <Switch checked={discordRpcEnabled} onChange={setDiscordRpcEnabled} />
          </div>
        </SettingsRow>

        <SettingsRow icon={<Globe className="h-[18px] w-[18px]" strokeWidth={2} />}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text">{t("settings.externalMetadata.enabled")}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("settings.externalMetadata.hint")}</p>
            </div>
            <Switch checked={externalMetadataEnabled} onChange={setExternalMetadataEnabled} />
          </div>
          {/* Which aggregator, and whether to try the other one, only mean anything while the
              switch above is on - so they appear with it rather than sitting greyed out. */}
          {externalMetadataEnabled && (
            <div className="mt-4 flex flex-col gap-4 border-t border-border pt-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text">{t("settings.externalMetadata.provider")}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("settings.externalMetadata.providerHint")}</p>
                </div>
                <div className="flex shrink-0 rounded-lg bg-text/[.05] p-0.5">
                  {/* Provider names are proper nouns, so they are not translated - and MAL is
                      labelled by the site people know, not by Jikan, the API it is read through. */}
                  <ProviderOption active={externalMetadataProvider === "anilist"} label="AniList" onClick={() => setExternalMetadataProvider("anilist")} />
                  <ProviderOption active={externalMetadataProvider === "mal"} label="MAL" onClick={() => setExternalMetadataProvider("mal")} />
                  <ProviderOption active={externalMetadataProvider === "kitsu"} label="Kitsu" onClick={() => setExternalMetadataProvider("kitsu")} />
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text">{t("settings.externalMetadata.fallback")}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("settings.externalMetadata.fallbackHint")}</p>
                </div>
                <Switch checked={externalMetadataFallback} onChange={setExternalMetadataFallback} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text">{t("settings.externalMetadata.aggregatorCatalog")}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("settings.externalMetadata.aggregatorCatalogHint")}</p>
                </div>
                <Switch checked={aggregatorCatalog} onChange={setAggregatorCatalog} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text">{t("settings.externalMetadata.showBinding")}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("settings.externalMetadata.showBindingHint")}</p>
                </div>
                <Switch checked={externalMetadataShowBinding} onChange={setExternalMetadataShowBinding} />
              </div>
            </div>
          )}
        </SettingsRow>

        <SettingsRow icon={<ArrowDownToLine className="h-[18px] w-[18px]" strokeWidth={2} />}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text">{t("settings.catalogAutoLoad.enabled")}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("settings.catalogAutoLoad.hint")}</p>
            </div>
            <Switch checked={catalogAutoLoad} onChange={setCatalogAutoLoad} />
          </div>
        </SettingsRow>
        <SettingsRow icon={<RefreshCw className="h-[18px] w-[18px]" strokeWidth={2} />}>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text">{t("settings.autoUpdate")}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{t("settings.autoUpdateHint")}</p>
            </div>
            <Switch checked={autoUpdate} onChange={setAutoUpdate} />
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("settings.player.title")}>
        <SettingsRow icon={<Timer className="h-[18px] w-[18px]" strokeWidth={2} />}>
          <SecondsControl
            label={t("settings.player.autoSkipDelay")}
            hint={t("settings.player.autoSkipDelayHint")}
            value={autoSkipDelaySeconds}
            onChange={setAutoSkipDelaySeconds}
          />
        </SettingsRow>
        <SettingsRow icon={<Timer className="h-[18px] w-[18px]" strokeWidth={2} />}>
          <SecondsControl
            label={t("settings.player.skipButtonTimeout")}
            hint={t("settings.player.skipButtonTimeoutHint")}
            value={skipButtonTimeoutSeconds}
            onChange={setSkipButtonTimeoutSeconds}
          />
        </SettingsRow>
        <SettingsRow icon={<CheckCircle2 className="h-[18px] w-[18px]" strokeWidth={2} />}>
          <PercentControl
            label={t("settings.player.watchedThreshold")}
            hint={t("settings.player.watchedThresholdHint")}
            value={watchedThresholdPercent}
            onChange={setWatchedThresholdPercent}
          />
        </SettingsRow>
      </SettingsSection>

      <BackupSection />
      <DiagnosticsSection />
    </div>
  </div>;
}
