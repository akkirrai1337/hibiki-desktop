import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, UserRound, X } from "lucide-react";
import { hibiki } from "@/lib/hibiki";
import { Switch } from "@/components/Switch";
import { cn } from "@/lib/cn";
import type { SourceInfo, SourceSetting } from "@shared/types";

/**
 * One settings screen for every source.
 *
 * The app renders what a source declares - field types, not source names - so adding settings to a
 * source is a manifest change and nothing here has to learn about it. The one row that is not a
 * value is ACCOUNT: it stands for the sign-in block, which the app draws from the source's own
 * login/logout/getAccount, since a password field and a signed-in card are the same two states for
 * every source that has an account at all.
 */
export function SourceSettingsDialog({ source, onClose }: { source: SourceInfo; onClose: () => void }) {
  const { t } = useTranslation();
  const rows = source.settings ?? [];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60] bg-black/50" onClick={onClose} />
      <div className="pointer-events-none fixed inset-0 z-[61] flex items-center justify-center p-6">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 45 }}
          className="pointer-events-auto flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
        >
          <div className="flex items-center gap-3 border-b border-border px-5 py-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-text/[.06]">
              {source.iconUrl ? <img src={source.iconUrl} alt="" className="h-full w-full object-cover" /> : null}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-text">{source.name}</p>
              <p className="truncate text-xs text-muted">{t("sources.settingsTitle")}</p>
            </div>
            <button
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-text/[.06] hover:text-text"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>

          <div className="flex flex-col gap-5 overflow-y-auto p-5">
            {rows.length === 0 && <p className="py-4 text-center text-sm text-muted">{t("sources.settingsEmpty")}</p>}
            {rows.map((row) =>
              row.type === "ACCOUNT" ? (
                <AccountRow key={row.key} sourceId={source.id} row={row} />
              ) : (
                <ValueRow key={row.key} sourceId={source.id} row={row} />
              ),
            )}
          </div>
        </motion.div>
      </div>
    </>,
    document.body,
  );
}

function RowHeader({ row }: { row: SourceSetting }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-sm font-semibold text-text">{row.title}</p>
      {row.description && <p className="mt-0.5 text-xs text-muted">{row.description}</p>}
    </div>
  );
}

function ValueRow({ sourceId, row }: { sourceId: string; row: SourceSetting }) {
  const queryClient = useQueryClient();
  const stored = useQuery({
    queryKey: ["sourceSettings", sourceId],
    queryFn: () => hibiki.sources.settings.read(sourceId),
  });
  const value = stored.data?.[row.key];

  const save = useMutation({
    mutationFn: (next: string | null) => hibiki.sources.settings.write(sourceId, row.key, next),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sourceSettings", sourceId] }),
  });

  if (row.type === "TOGGLE") {
    // A stored value wins; the manifest's default only decides what an untouched toggle shows.
    const checked = value === undefined ? row.default === true : value === "true";
    return (
      <div className="flex items-start gap-4">
        <RowHeader row={row} />
        <Switch checked={checked} onChange={(next) => save.mutate(String(next))} />
      </div>
    );
  }

  if (row.type === "SELECT") {
    const options = row.options ?? [];
    const current = value ?? (typeof row.default === "string" ? row.default : options[0]?.id);
    return (
      <div className="flex flex-col gap-2">
        <RowHeader row={row} />
        <div className="flex flex-wrap gap-1.5">
          {options.map((option) => (
            <button
              key={option.id}
              onClick={() => save.mutate(option.id)}
              className={cn(
                "rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors",
                option.id === current ? "border-accent bg-accent text-accent-fg" : "border-border text-text/80 hover:bg-text/[.06]",
              )}
            >
              {option.title}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return <TextRow row={row} value={value ?? (typeof row.default === "string" ? row.default : "")} onSave={(next) => save.mutate(next)} />;
}

function TextRow({ row, value, onSave }: { row: SourceSetting; value: string; onSave: (next: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="flex flex-col gap-2">
      <RowHeader row={row} />
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        // Committed on blur and on Enter rather than per keystroke: every save crosses to the main
        // process and rewrites the source's store on disk.
        onBlur={() => draft !== value && onSave(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="w-full rounded-lg border border-border bg-text/[.04] px-3 py-2 text-sm text-text outline-none focus:border-accent"
      />
    </div>
  );
}

function AccountRow({ sourceId, row }: { sourceId: string; row: SourceSetting }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const account = useQuery({
    queryKey: ["sourceAccount", sourceId],
    queryFn: () => hibiki.sources.account.get(sourceId),
    // Asking the source means a network round trip through the extension worker; the answer only
    // changes when someone signs in or out here, both of which invalidate it themselves.
    staleTime: 5 * 60_000,
  });

  const signIn = useMutation({
    mutationFn: () => hibiki.sources.account.login(sourceId, { login, password }),
    onSuccess: (signedIn) => {
      setPassword("");
      setError(null);
      queryClient.setQueryData(["sourceAccount", sourceId], signedIn);
    },
    onError: (failure: unknown) => setError(messageOf(failure)),
  });

  const signOut = useMutation({
    mutationFn: () => hibiki.sources.account.logout(sourceId),
    onSuccess: () => queryClient.setQueryData(["sourceAccount", sourceId], null),
    onError: (failure: unknown) => setError(messageOf(failure)),
  });

  const busy = signIn.isPending || signOut.isPending;
  const signedIn = account.data ?? null;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <RowHeader row={row} />
      <AnimatePresence mode="wait" initial={false}>
        {account.isLoading ? (
          <p key="loading" className="text-sm text-muted">…</p>
        ) : signedIn ? (
          <motion.div key="in" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-text/[.06]">
              {signedIn.avatarUrl ? (
                <img src={signedIn.avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <UserRound className="h-4 w-4 text-muted" strokeWidth={1.75} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-text">{signedIn.name}</p>
              {signedIn.profileUrl && (
                <a href={signedIn.profileUrl} target="_blank" rel="noreferrer" className="truncate text-xs text-muted hover:text-text">
                  {t("sources.accountOpenProfile")}
                </a>
              )}
            </div>
            <button
              onClick={() => signOut.mutate()}
              disabled={busy}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-bold text-text/80 transition-colors hover:bg-text/[.06] disabled:opacity-50"
            >
              <LogOut className="h-3.5 w-3.5" strokeWidth={2} />
              {t("sources.accountSignOut")}
            </button>
          </motion.div>
        ) : (
          <motion.form
            key="out"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (login.trim().length > 0 && password.length > 0) signIn.mutate();
            }}
            className="flex flex-col gap-2"
          >
            <input
              value={login}
              onChange={(event) => setLogin(event.target.value)}
              placeholder={t("sources.accountLogin")}
              autoComplete="username"
              className="w-full rounded-lg border border-border bg-text/[.04] px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("sources.accountPassword")}
              type="password"
              autoComplete="current-password"
              className="w-full rounded-lg border border-border bg-text/[.04] px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
            <button
              type="submit"
              disabled={busy || login.trim().length === 0 || password.length === 0}
              className="self-end rounded-lg bg-text px-3 py-1.5 text-xs font-bold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {t("sources.accountSignIn")}
            </button>
          </motion.form>
        )}
      </AnimatePresence>
      {/* The source's own message, not a generic failure: "no user with that login" is worth
          reading, and only the source knows it. */}
      {error && <p className="select-text text-xs text-rose-400">{error}</p>}
    </div>
  );
}

function messageOf(failure: unknown): string {
  const raw = failure instanceof Error ? failure.message : String(failure);
  // Electron wraps a main-process throw as "Error invoking remote method '...': Error: <message>".
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "");
}
