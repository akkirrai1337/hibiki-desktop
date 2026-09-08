import { Client } from "@xhayper/discord-rpc";
import { ActivityType } from "discord-api-types/v10";
import type { DiscordPresence } from "@shared/types";

// Same Application ID as the Android app's own DiscordRpcManager (DISCORD_APPLICATION_ID) - an
// "Application" isn't platform-locked, it's just a shared identity (name/icon/Rich Presence
// assets), so both clients showing up under the same one is correct, not a collision.
//
// Unlike Android's DiscordRpcManager (which spoofs presence over the gateway using the user's own
// account token, since a phone has no local Discord process to talk to), this uses Discord's
// actual sanctioned local RPC IPC - the same mechanism Spotify/VS Code/games use.
const DISCORD_CLIENT_ID = "1527613923338096764";

const EPISODE_LABEL = "Эп."; // Localizing this would need the renderer's own i18n state piped
// over IPC just for one word - not worth it for a label only shown on a Discord profile card.

// Discord fetches image URLs itself, so this has to be a real public host, not a bundled local
// file - reusing the icon already published in the project's own public GitHub repo. A raster
// format (not the sibling .svg) since Discord's Rich Presence image pipeline expects one.
const HIBIKI_ICON_URL = "https://raw.githubusercontent.com/akkirrai1337/hibiki/main/docs/hibiki.jpg";

// What to show outside the player - deliberately just "using hibiki" with an elapsed timer, not
// per-page text ("Просматривает каталог", "В профиле", ...). Per-page presence was tried and
// rejected as noisy/low-value; a single steady line reads better and needs no upkeep as pages get
// added or renamed.
const IDLE_DETAILS = "hibiki";

type PendingState = { kind: "watching"; presence: DiscordPresence } | { kind: "idle" } | null;

let client: Client | null = null;
let ready = false;
let enabled = false;
let pending: PendingState = null;
// Set once, the moment the app actually goes idle - not recomputed on every idle call, so the
// "for X minutes" Discord shows keeps counting from when browsing actually started instead of
// resetting every time setIdleDiscordPresence happens to be called again.
let idleSinceMs: number | null = null;

function log(message: string, error?: unknown): void {
  console.warn(`[discord] ${message}`, error instanceof Error ? error.message : (error ?? ""));
}

// @xhayper/discord-rpc's own ClientUser#clearActivity() sends SET_ACTIVITY with no `activity`
// field at all, instead of the `activity: null` Discord's protocol actually needs to clear one -
// so calling it left the last-set activity showing indefinitely after leaving the player. Sending
// the frame directly (mirroring what a real IPC clear looks like) bypasses the bug.
function clearActivity(c: Client): void {
  c.request("SET_ACTIVITY" as Parameters<Client["request"]>[0], { pid: process.pid, activity: null }).catch((error) =>
    log("clearActivity failed", error),
  );
}

function createClient(): Client {
  const c = new Client({ clientId: DISCORD_CLIENT_ID });
  c.on("ready", () => {
    ready = true;
    console.log("[discord] connected");
    applyPending();
  });
  c.on("disconnected", () => {
    ready = false;
  });
  c.login().catch((error) => log("could not connect to the local Discord client", error));
  return c;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function applyWatchingPresence(presence: DiscordPresence): void {
  if (!client?.user) return;
  const nowMs = Date.now();
  const hasValidDuration = presence.durationMs > presence.positionMs;
  // Discord's own elapsed/remaining display is computed client-side from these timestamps and
  // ticks in real time on its own - there's no "paused at this timestamp" variant of it, so a
  // frozen instant would either have to keep re-sending the same still-ticking clock (not actually
  // frozen) or go blank entirely (Android's own choice: `timestamps = null` while paused). Neither
  // reads as "still showing where I am, just not moving", so instead this drops the live
  // timestamps and puts the position as a plain, static "10:23/24:00" string in `state` - text
  // Discord doesn't touch until *we* push a new update, i.e. genuinely frozen.
  const progressText = !presence.isPlaying && hasValidDuration ? `${formatDuration(presence.positionMs)}/${formatDuration(presence.durationMs)}` : null;
  const state = [
    presence.translation,
    presence.episodeNumber != null ? `${EPISODE_LABEL} ${presence.episodeNumber}` : null,
    progressText,
  ]
    .filter((part): part is string => !!part)
    .join(" · ");

  client.user
    .setActivity({
      type: ActivityType.Watching,
      details: presence.animeTitle.slice(0, 128),
      state: state ? state.slice(0, 128) : undefined,
      startTimestamp: presence.isPlaying ? nowMs - presence.positionMs : undefined,
      endTimestamp: presence.isPlaying && hasValidDuration ? nowMs - presence.positionMs + presence.durationMs : undefined,
      // The local RPC IPC protocol (unlike Discord's REST Activities API) accepts a plain https
      // URL directly in `assets.large_image` with no pre-registration and no OAuth - `largeImageKey`
      // is what @xhayper/discord-rpc maps straight onto that field (its separate `largeImageUrl`
      // option maps onto `assets.large_url` instead, which Discord's client doesn't render from at
      // all - that's the dead end the OAuth/External-Assets detour upstream of this was chasing).
      largeImageKey: presence.posterUrl ?? HIBIKI_ICON_URL,
      largeImageText: presence.posterUrl ? presence.animeTitle : "hibiki",
      smallImageKey: presence.posterUrl ? HIBIKI_ICON_URL : undefined,
      smallImageText: presence.posterUrl ? "hibiki" : undefined,
      instance: false,
    })
    .then(() => console.log(`[discord] activity set: ${presence.animeTitle}`))
    .catch((error) => log("setActivity failed", error));
}

function applyIdlePresence(): void {
  if (!client?.user) return;
  idleSinceMs ??= Date.now();
  client.user
    .setActivity({
      type: ActivityType.Watching,
      details: IDLE_DETAILS,
      startTimestamp: idleSinceMs,
      largeImageKey: HIBIKI_ICON_URL,
      largeImageText: "hibiki",
      instance: false,
    })
    .then(() => console.log("[discord] activity set: idle"))
    .catch((error) => log("setActivity failed", error));
}

function applyPending(): void {
  if (!ready || !pending) return;
  if (pending.kind === "watching") applyWatchingPresence(pending.presence);
  else applyIdlePresence();
}

export function setDiscordRpcEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  if (!enabled) {
    pending = null;
    idleSinceMs = null;
    const c = client;
    client = null;
    ready = false;
    if (c) {
      clearActivity(c);
      c.destroy().catch(() => {});
    }
    return;
  }
  if (!DISCORD_CLIENT_ID) {
    log("enabled, but no DISCORD_CLIENT_ID is configured - see the comment at the top of discordRpc.ts");
    return;
  }
  client ??= createClient();
}

export function updateDiscordPresence(presence: DiscordPresence): void {
  pending = { kind: "watching", presence };
  if (!enabled || !DISCORD_CLIENT_ID) return;
  client ??= createClient();
  applyPending();
}

// Shown whenever the app is open but nothing is playing - the root layout calls this on launch and
// every time the route leaves /watch/*, so Discord presence follows "the app is open" rather than
// just "a video happens to be playing".
export function setIdleDiscordPresence(): void {
  if (pending?.kind !== "idle") idleSinceMs = null; // fresh idle stretch - restart its own timer
  pending = { kind: "idle" };
  if (!enabled || !DISCORD_CLIENT_ID) return;
  client ??= createClient();
  applyPending();
}

export function clearDiscordPresence(): void {
  pending = null;
  idleSinceMs = null;
  if (client && ready) clearActivity(client);
}

export function shutdownDiscordRpc(): void {
  const c = client;
  client = null;
  ready = false;
  if (c) {
    clearActivity(c);
    c.destroy().catch(() => {});
  }
}
