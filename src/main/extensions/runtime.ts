// Main-thread orchestrator for Hibiki's scripted extensions (hibiki-sources/extensions/*.js).
// `list()` just reads manifest JSON (fast, no network) and stays synchronous; every call that
// actually runs a script (search/latest/getById/...) is dispatched to a fresh worker_thread (see
// worker.ts) — extension scripts call a *synchronous* fetch() (matching the Rhino runtime they
// were written for), which blocks whichever thread runs it. Running that on Electron's main
// thread freezes the whole app (window, IPC, everything) for the request's duration; a worker
// keeps the freeze contained to that one call.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  AnimeTitle,
  PlaybackGroup,
  PlayerLink,
  PlayerLinkPreference,
  PlayerLinkType,
  SearchFilterCatalog,
  SearchRequest,
  SourceAccount,
  SourceComment,
  SourceInfo,
  SourceLibraryEntry,
  SourceReview,
} from "@shared/types";
import type { ExtensionCall, ExtensionMethod } from "./execute";
import type { WorkerCallMessage, WorkerReadyMessage, WorkerResultMessage } from "./worker";
import { performBrowserFetch, performChallenge } from "./browserFetchHost";
import { performNetFetch, performNetFetchAll } from "./netFetchHost";
import { loginViaWebview } from "./webLogin";
import { logger } from "../logger";
import { performBrowserResolve } from "./browserResolveHost";
import type { BridgeRequestMessage } from "./syncHostBridge";
import { ExtensionStorage } from "./extensionStorage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_TIMEOUT_MS = 30_000;
const FILTER_TYPES = ["select", "multi", "tristate", "text", "range"];
const RESOLVE_TOTAL_TIMEOUT_MS = 45_000;
// How long a resolver attempt may run alone before the next candidate is started beside it.
const RESOLVE_STAGGER_MS = 1_200;

function playerUrlLabel(raw: string): string {
  try {
    const url = new URL(raw);
    const tail = url.pathname.split("/").filter(Boolean).slice(-2).map((part) =>
      part.length > 24 ? `${part.slice(0, 8)}…` : part,
    ).join("/");
    return `${url.host}/${tail || "…"}${url.search ? "?…" : ""}`;
  } catch {
    return "<invalid-url>";
  }
}

const RESOLVER_STREAM_TYPE_TO_PLAYER_LINK_TYPE: Record<string, PlayerLinkType | undefined> = {
  HLS: "DIRECT_HLS",
  MP4: "DIRECT_MP4",
  DASH: "DIRECT_DASH",
};

interface Manifest {
  id: string;
  name: string;
  version: string;
  iconUrl?: string;
  lang?: string;
  isNsfw?: boolean;
  capabilities?: string[];
  resolverDependencies?: string[];
  settings?: SourceInfo["settings"];
}

export interface InstalledResolverRequirement {
  sourceId: string;
  originUrl: string;
  resolverIds: string[];
}

interface LoadedExtension {
  manifest: Manifest;
}

// Player resolvers (extensions/extractors/*.js in hibiki-sources) are installed alongside a
// source via its manifest's resolverDependencies (see marketplace.ts), not by the user directly -
// they're not sources themselves (no search/catalog capability) and Android hides them from its
// source picker for the same reason, so they live in their own subdirectory rather than
// extensionsDir, which keeps them out of list() for free instead of needing a type-based filter.
interface ResolverManifest {
  id: string;
  version: string;
  hosts: string[];
  // Most resolvers are plain HTTP (Provider.resolve(linkJson), runs on this app's existing
  // sandboxed-worker infra - see execute.ts). A "BROWSER" runtime resolver instead exposes
  // Provider.browserScript(linkJson), which runs inside a real browser engine (see
  // browserResolveHost.ts) via runBrowserResolver() below.
  runtime?: "NODE" | "BROWSER";
}

interface ResolverHealth {
  consecutiveFailures: number;
  lastFailureAt: number;
}

// A resolver that failed once - a dropped connection, an ISP hiccup at app start - must not stay
// demoted for the whole session waiting for a success it is never ordered first enough to get.
// Failures older than this stop counting against it.
const RESOLVER_FAILURE_DECAY_MS = 10 * 60_000;

// These hosts only expose their own iframe UI in practice. CVH and Sibnet both intermittently
// report "video unavailable" there, which leaves the application without its player controls and
// gives the viewer no reliable way to switch away. Keep the retirement centralized so old local
// resolver files and a source update declaring either dependency cannot re-enable them.
const RETIRED_RESOLVER_IDS = new Set(["cvh", "sibnet"]);
const RETIRED_PLAYER_NAMES = new Set(["cvh", "sibnet"]);
const RETIRED_PLAYER_HOSTS = ["yummyani.me", "sibnet.ru"];

export function isRetiredResolver(id: string): boolean {
  return RETIRED_RESOLVER_IDS.has(id.toLowerCase());
}

interface BrowserResolverPayload {
  script: string;
  /** Optional page to host the embed frame under, supplied by the resolver when required. */
  parentUrl?: string;
}

const BROWSER_RESOLVER_PAYLOAD_PREFIX = "hibiki-browser-resolver:v1:";

function parseBrowserResolverPayload(value: string): BrowserResolverPayload {
  if (!value.startsWith(BROWSER_RESOLVER_PAYLOAD_PREFIX)) return { script: value };
  try {
    const parsed = JSON.parse(value.slice(BROWSER_RESOLVER_PAYLOAD_PREFIX.length)) as Partial<BrowserResolverPayload>;
    if (typeof parsed.script !== "string" || !parsed.script) throw new Error("missing script");
    return {
      script: parsed.script,
      ...(typeof parsed.parentUrl === "string" ? { parentUrl: parsed.parentUrl } : {}),
    };
  } catch (error) {
    throw new Error(`Invalid browser resolver payload: ${String(error)}`);
  }
}

function isRetiredPlayerLink(link: PlayerLink): boolean {
  if (link.playerName && RETIRED_PLAYER_NAMES.has(link.playerName.trim().toLowerCase())) return true;
  try {
    const host = new URL(link.url).hostname.toLowerCase();
    return RETIRED_PLAYER_HOSTS.some((retiredHost) => host === retiredHost || host.endsWith(`.${retiredHost}`));
  } catch {
    return false;
  }
}

export class ExtensionRuntime {
  private readonly extensions = new Map<string, LoadedExtension>();
  private readonly resolvers = new Map<string, ResolverManifest>();
  private readonly resolverHealth = new Map<string, ResolverHealth>();
  private readonly inFlightReads = new Map<string, Promise<unknown>>();
  private readonly cancellations = new Map<string, () => void>();
  private readonly resolversDir: string;

  private readonly storage: ExtensionStorage;

  constructor(private readonly extensionsDir: string) {
    this.resolversDir = path.join(extensionsDir, "resolvers");
    // Beside the extensions rather than inside them: uninstalling a source should be able to take
    // its stored token with it without the store having to survive a directory being rewritten.
    this.storage = new ExtensionStorage(path.join(path.dirname(extensionsDir), "extension-storage"));
  }

  /** Called when a source is removed - a token for a source that is no longer installed is only a
   * secret waiting to leak. */
  forgetStorage(sourceId: string): void {
    this.storage.clear(sourceId);
  }

  /**
   * The values behind a source's declared settings rows.
   *
   * Only declared keys, never the whole store: a source's session token lives in the same place,
   * and the settings screen has no business reading it - nor does anything else in the renderer.
   */
  readSettings(sourceId: string): Record<string, string> {
    const declared = new Set(this.settingKeysOf(sourceId));
    const stored = this.storage.read(sourceId);
    return Object.fromEntries(Object.entries(stored).filter(([key]) => declared.has(key)));
  }

  writeSetting(sourceId: string, key: string, value: string | null): void {
    if (!this.settingKeysOf(sourceId).includes(key)) {
      throw new Error(`Source "${sourceId}" declares no setting named "${key}"`);
    }
    this.storage.apply(sourceId, { [key]: value });
  }

  /** ACCOUNT rows are excluded: they stand for the sign-in block, not for a value. */
  private settingKeysOf(sourceId: string): string[] {
    const manifest = this.extensions.get(sourceId)?.manifest;
    return (manifest?.settings ?? []).filter((setting) => setting.type !== "ACCOUNT").map((setting) => setting.key);
  }

  reload(): void {
    // New source files/settings must not adopt a request that started against the previous loaded
    // extension. The old work may still finish for its original caller, but no new call shares it.
    this.inFlightReads.clear();
    this.extensions.clear();
    if (fs.existsSync(this.extensionsDir)) {
      for (const file of fs.readdirSync(this.extensionsDir)) {
        if (!file.endsWith(".manifest.json")) continue;
        const manifestPath = path.join(this.extensionsDir, file);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Manifest;
        const scriptPath = manifestPath.replace(/\.manifest\.json$/, ".js");
        if (!fs.existsSync(scriptPath)) continue;
        this.extensions.set(manifest.id, { manifest });
      }
    }

    this.removeRetiredResolverFiles();
    this.resolvers.clear();
    if (fs.existsSync(this.resolversDir)) {
      for (const file of fs.readdirSync(this.resolversDir)) {
        if (!file.endsWith(".manifest.json")) continue;
        const manifestPath = path.join(this.resolversDir, file);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ResolverManifest;
        const scriptPath = manifestPath.replace(/\.manifest\.json$/, ".js");
        if (!fs.existsSync(scriptPath)) continue;
        if (isRetiredResolver(manifest.id)) continue;
        this.resolvers.set(manifest.id, {
          id: manifest.id,
          version: manifest.version ?? "0.0.0",
          hosts: manifest.hosts ?? [],
          runtime: manifest.runtime,
        });
      }
    }
  }

  list(): SourceInfo[] {
    return [...this.extensions.values()].map(({ manifest }) => ({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      iconUrl: manifest.iconUrl ?? null,
      lang: manifest.lang ?? null,
      isNsfw: manifest.isNsfw === true,
      capabilities: (manifest.capabilities ?? []) as SourceInfo["capabilities"],
      runtime: "NODE",
      settings: manifest.settings ?? [],
    }));
  }

  // Services one challenge()/browserFetch() request from a worker's extension script (see
  // syncHostBridge.ts) - runs the real, GUI-capable BrowserWindow work here on the actual main
  // thread, then wakes the worker back up via its Atomics.wait() flag.
  private async serviceBridgeRequest(message: BridgeRequestMessage): Promise<void> {
    let response: { ok: boolean; result?: unknown; error?: string };
    try {
      let result: unknown;
      if (message.bridgeKind === "challenge") {
        result = await performChallenge(
          message.payload.url as string,
          (message.payload.cookieNames as string[]) ?? [],
          Boolean(message.payload.forceRefresh),
        );
      } else if (message.bridgeKind === "netFetchAll") {
        result = await performNetFetchAll(
          (message.payload.requests as Array<{ url: string; options?: Record<string, unknown> }>) ?? [],
        );
      } else if (message.bridgeKind === "netFetch") {
        result = await performNetFetch(
          message.payload.url as string,
          (message.payload.options as { method?: string; headers?: Record<string, string>; body?: string } | undefined) ?? {},
        );
      } else {
        result = await performBrowserFetch(
          message.payload.pageUrl as string,
          message.payload.targetUrl as string,
          message.payload.options as { method?: string; headers?: Record<string, string>; body?: string } | undefined,
        );
      }
      response = { ok: true, result };
    } catch (error) {
      response = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    message.port.postMessage(response);
    message.port.close();
    const flag = new Int32Array(message.sab);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  }

  // A worker that is done with a call goes back on this list instead of being terminated - see
  // worker.ts for why (~195ms of bundle parsing per spawn, paid on every search keystroke,
  // catalog card and resolver attempt). A worker is only ever handed one call at a time, so the
  // list length is exactly "workers currently idle"; a call that arrives with none idle spawns a
  // fresh one rather than queueing, since the calls are network-bound and serializing them behind
  // a fixed pool size would make a multi-source catalog load slower, not faster.
  private readonly idleWorkers: Worker[] = [];
  private readonly warmingWorkers = new Set<Worker>();
  private nextCallId = 1;
  // Only ever grown back to this on release. Beyond it a worker is terminated: a handful of live
  // threads is the point, a thread per source the user has ever touched is not.
  private static readonly MAX_IDLE_WORKERS = 4;

  // Deliberately below MAX_IDLE_WORKERS: warm-up runs while the window is still being created and
  // the renderer's own bundle is being parsed, so spawning the whole pool up front competes for
  // CPU on the one load where first paint matters most. The pool still grows to its full size on
  // demand, from calls that would have spawned a worker anyway.
  private static readonly WARM_WORKERS = 2;

  /** Starts the expensive worker bundle parsing before the renderer's first source queries arrive.
   * Only workers that have loaded the whole module and posted `ready` enter the idle pool; calls
   * arriving earlier still take the normal fresh-worker path rather than waiting behind warm-up. */
  warmWorkers(): void {
    const missing = ExtensionRuntime.WARM_WORKERS - this.idleWorkers.length - this.warmingWorkers.size;
    for (let i = 0; i < missing; i++) {
      const worker = new Worker(path.join(__dirname, "extensionWorker.js"));
      this.warmingWorkers.add(worker);
      worker.once("message", (_message: WorkerReadyMessage) => {
        this.warmingWorkers.delete(worker);
        this.releaseWorker(worker);
      });
      worker.once("error", (error) => {
        this.warmingWorkers.delete(worker);
        // Terminated, not just forgotten: a warm-up that failed still holds a live thread.
        void worker.terminate();
        logger.warn("ext", `worker warm-up failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  private acquireWorker(call: ExtensionCall): { worker: Worker; fresh: boolean } {
    const idle = this.idleWorkers.pop();
    if (idle) {
      // Dropped now that it is in use again - otherwise every release/acquire cycle would leave
      // another one behind and trip Node's max-listeners warning after ten reuses.
      idle.removeAllListeners("exit");
      return { worker: idle, fresh: false };
    }
    // A fresh worker takes its first call through workerData, so it starts executing as soon as it
    // has booted rather than waiting for a message to arrive afterwards.
    return { worker: new Worker(path.join(__dirname, "extensionWorker.js"), { workerData: call }), fresh: true };
  }

  private releaseWorker(worker: Worker): void {
    worker.removeAllListeners("message");
    worker.removeAllListeners("error");
    if (this.idleWorkers.length >= ExtensionRuntime.MAX_IDLE_WORKERS) {
      void worker.terminate();
      return;
    }
    // An idle worker that dies on its own (OOM, a native crash) must not stay on the list waiting
    // to be handed a call it can never answer.
    worker.once("exit", () => {
      const index = this.idleWorkers.indexOf(worker);
      if (index >= 0) this.idleWorkers.splice(index, 1);
    });
    this.idleWorkers.push(worker);
  }

  private run<T>(
    method: ExtensionMethod,
    sourceId: string,
    args: unknown[],
    options?: { extensionsDir?: string; requestId?: string; timeoutMs?: number },
  ): Promise<T> {
    const extensionsDir = options?.extensionsDir ?? this.extensionsDir;
    const timeoutMs = options?.timeoutMs ?? WORKER_TIMEOUT_MS;
    if (!options?.extensionsDir && !this.extensions.has(sourceId)) return Promise.reject(new Error(`Unknown source: ${sourceId}`));

    // Read once per call, at dispatch: the script sees a consistent snapshot for its whole run,
    // and a call that writes has its writes applied when it comes back.
    const call: ExtensionCall = { extensionsDir, sourceId, method, args, storage: this.storage.read(sourceId) };

    const startedAt = Date.now();
    logger.debug("ext", `${sourceId}.${method}() start`);

    return new Promise<T>((resolve, reject) => {
      const { worker, fresh } = this.acquireWorker(call);
      const callId = fresh ? 0 : this.nextCallId++;
      // Guards against resolve()/reject() firing twice: a worker that times out is terminated,
      // which itself can surface as an "error" event, and a script that throws right after posting
      // a result would deliver both a result and an error.
      let settled = false;

      const clearCancellation = () => {
        if (options?.requestId && this.cancellations.get(options.requestId) === cancel) {
          this.cancellations.delete(options.requestId);
        }
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearCancellation();
        void worker.terminate();
        reject(new Error(`Source "${sourceId}" cancelled calling ${method}()`));
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearCancellation();
        // Deliberately terminated, never pooled: this worker is stuck inside a script that hasn't
        // returned, and handing the next call to it would hang that one too.
        void worker.terminate();
        logger.error("ext", `${sourceId}.${method}() timed out after ${timeoutMs}ms`);
        reject(new Error(`Source "${sourceId}" timed out calling ${method}()`));
      }, timeoutMs);

      worker.on("message", (message: BridgeRequestMessage | WorkerResultMessage) => {
        if (message.kind === "bridge") {
          void this.serviceBridgeRequest(message);
          return;
        }
        // A late result from a call this promise already gave up on (a timeout that fired while
        // the worker was still working) - the worker was terminated, so this can only be a
        // straggler already in the queue.
        if (settled || message.id !== callId) return;
        settled = true;
        clearTimeout(timeout);
        clearCancellation();
        this.releaseWorker(worker);
        // Before resolve/reject either way: a call that stored a token and then failed still
        // stored the token.
        if (message.storageWrites) this.storage.apply(sourceId, message.storageWrites);
        if (message.ok) {
          logger.debug("ext", `${sourceId}.${method}() ok in ${Date.now() - startedAt}ms`);
          resolve(message.result as T);
        } else {
          logger.warn("ext", `${sourceId}.${method}() failed in ${Date.now() - startedAt}ms: ${message.error}`);
          reject(new Error(message.error));
        }
      });
      worker.once("error", (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearCancellation();
        void worker.terminate();
        const failure = error instanceof Error ? error : new Error(String(error));
        logger.error("ext", `${sourceId}.${method}() crashed in ${Date.now() - startedAt}ms: ${failure.message}`);
        reject(failure);
      });

      if (!fresh) worker.postMessage({ kind: "call", id: callId, call } satisfies WorkerCallMessage);
      if (options?.requestId) this.cancellations.set(options.requestId, cancel);
    });
  }

  cancelRequest(requestId: string): boolean {
    const cancel = this.cancellations.get(requestId);
    if (!cancel) return false;
    cancel();
    return true;
  }

  /** Tears the pool down - called on app quit, so idle threads don't hold the process open. */
  dispose(): void {
    for (const worker of this.idleWorkers.splice(0)) void worker.terminate();
    for (const worker of this.warmingWorkers) void worker.terminate();
    this.warmingWorkers.clear();
  }

  /**
   * Shares only an identical read that is currently running. This is deliberately not a result
   * cache: source data and signed URLs retain their existing freshness rules, while two screens
   * arriving in the same tick no longer spawn duplicate workers and duplicate network requests.
   */
  private shareRead<T>(method: string, sourceId: string, args: unknown[], read: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([method, sourceId, ...args]);
    const existing = this.inFlightReads.get(key);
    if (existing) return existing as Promise<T>;

    const pending = read();
    this.inFlightReads.set(key, pending);
    const clear = () => {
      if (this.inFlightReads.get(key) === pending) this.inFlightReads.delete(key);
    };
    void pending.then(clear, clear);
    return pending;
  }

  search(sourceId: string, request: SearchRequest, requestId?: string): Promise<AnimeTitle[]> {
    // A renderer search carries a cancellation id, so it must own its worker rather than sharing
    // one whose other caller might still need it. Background/catalog reads remain coalesced.
    if (requestId) return this.run("search", sourceId, [request], { requestId });
    return this.shareRead("search", sourceId, [request], () => this.run("search", sourceId, [request]));
  }

  latest(sourceId: string, limit: number): Promise<AnimeTitle[]> {
    return this.shareRead("latest", sourceId, [limit], () => this.run("latest", sourceId, [limit]));
  }

  /**
   * Account and the things it unlocks.
   *
   * All of them are optional on the script side and gated by the source's declared capabilities -
   * see ExtensionMethod in execute.ts. Credentials pass straight through to the script and are
   * never written anywhere by the host; whatever the script needs to prove itself again later goes
   * in its own store instead.
   */
  login(sourceId: string, credentials: { login: string; password: string }): Promise<SourceAccount> {
    return this.run("login", sourceId, [credentials]);
  }

  /** The ACCOUNT row's own `webLoginUrl`/`webLoginSuccessCookie` - a real sign-in window instead
   * of a login+password pair (see main/extensions/webLogin.ts for what that actually opens). */
  async loginWeb(sourceId: string): Promise<SourceAccount> {
    const manifest = this.extensions.get(sourceId)?.manifest;
    const row = (manifest?.settings ?? []).find((setting) => setting.type === "ACCOUNT");
    if (!row?.webLoginUrl || !row.webLoginSuccessCookie) {
      throw new Error(`Source "${sourceId}" does not declare a web login`);
    }
    const cookies = await loginViaWebview(sourceId, row.webLoginUrl, row.webLoginSuccessCookie);
    return this.run("loginWeb", sourceId, [cookies]);
  }

  logout(sourceId: string): Promise<void> {
    return this.run("logout", sourceId, []);
  }

  getAccount(sourceId: string): Promise<SourceAccount | null> {
    return this.run("getAccount", sourceId, []);
  }

  listComments(sourceId: string, request: { animeId: string; parentId?: string | null; offset?: number }): Promise<SourceComment[]> {
    return this.run("listComments", sourceId, [request]);
  }

  postComment(sourceId: string, request: { animeId: string; text: string; parentId?: string | null }): Promise<SourceComment> {
    return this.run("postComment", sourceId, [request]);
  }

  /** 1 to like, -1 to dislike, 0 to take a vote back. */
  voteComment(sourceId: string, request: { commentId: string; vote: number }): Promise<boolean> {
    return this.run("voteComment", sourceId, [request]);
  }

  listReviews(sourceId: string, request: { animeId: string; offset?: number }): Promise<SourceReview[]> {
    return this.run("listReviews", sourceId, [request]);
  }

  postReview(sourceId: string, request: { animeId: string; text: string; rating?: number | null }): Promise<SourceReview> {
    return this.run("postReview", sourceId, [request]);
  }

  /**
   * Whether this source both can sync a library and has been told to.
   *
   * Asked before every push, and cheap on purpose - it reads the manifest and the source's own
   * store, no script and no network. A source that declares nothing, or whose switch is off, must
   * cost nothing at all on a library change.
   */
  isLibrarySyncEnabled(sourceId: string): boolean {
    return this.isSwitchOn(sourceId, "LIBRARY_SYNC");
  }

  /** Whether this source reports watching to its account. Asked on every progress save, so it
   * reads the manifest and the source's store and nothing else. */
  isActivitySyncEnabled(sourceId: string): boolean {
    return this.isSwitchOn(sourceId, "ACTIVITY_SYNC");
  }

  /** A capability the source declares, plus the switch of the same type being on. */
  private isSwitchOn(sourceId: string, kind: "LIBRARY_SYNC" | "ACTIVITY_SYNC"): boolean {
    const manifest = this.extensions.get(sourceId)?.manifest;
    if (!manifest || !(manifest.capabilities ?? []).includes(kind)) return false;
    const row = (manifest.settings ?? []).find((setting) => setting.type === kind);
    if (!row) return false;
    const stored = this.storage.read(sourceId)[row.key];
    return stored === undefined ? row.default === true : stored === "true";
  }

  /** Everything in the signed-in account's own lists - what the first-run reconciliation needs in
   * order to say "3 there, 50 here" rather than asking blind. */
  listLibrary(sourceId: string): Promise<SourceLibraryEntry[]> {
    return this.run("listLibrary", sourceId, []);
  }

  /**
   * Reports one episode's watching: the seconds actually played, not the position reached.
   *
   * Answers false when there was nothing new to report, which is the normal case between two
   * saves that happened while paused.
   */
  reportPlayback(
    sourceId: string,
    request: { videoId: string; positionSeconds: number; durationSeconds: number; watchedSeconds: number[] },
  ): Promise<boolean> {
    return this.run("reportPlayback", sourceId, [request]);
  }

  /** Marks the account online for today - what its day streak counts. */
  pingOnline(sourceId: string): Promise<boolean> {
    return this.run("pingOnline", sourceId, []);
  }

  /** Pushes one library row's status (and rating, when there is one) to the account. */
  syncLibraryEntry(
    sourceId: string,
    request: { animeId: string; category: string | null; rating?: number | null },
  ): Promise<void> {
    return this.run("syncLibraryEntry", sourceId, [request]);
  }

  getById(sourceId: string, id: string): Promise<AnimeTitle> {
    return this.shareRead("getById", sourceId, [id], () => this.run("getById", sourceId, [id]));
  }

  getPlaybackGroups(sourceId: string, titleId: string): Promise<PlaybackGroup[]> {
    return this.shareRead("getPlaybackGroups", sourceId, [titleId], () => this.run("getPlaybackGroups", sourceId, [titleId]));
  }

  getPlayerLinks(sourceId: string, titleId: string, groupId: string, episodeId: string, preference?: PlayerLinkPreference): Promise<PlayerLink[]> {
    return this.shareRead("getPlayerLinks", sourceId, [titleId, groupId, episodeId, preference ?? null], async () => {
      const sourceLinks = await this.run<PlayerLink[]>("getPlayerLinks", sourceId, [titleId, groupId, episodeId]);
      const links = sourceLinks.filter((link) => !isRetiredPlayerLink(link));
      if (links.length !== sourceLinks.length) {
        logger.info("resolve", `removed ${sourceLinks.length - links.length} retired CVH/Sibnet link(s) before playback`);
      }
      const preferredIndex = this.preferredLinkIndex(links, preference);
      // A source-provided direct link needs no resolver at all. Let the renderer adopt the saved
      // choice from the returned list instead of resolving an unrelated EMBED first.
      if (preferredIndex >= 0 && links[preferredIndex].type !== "EMBED") return links;
      return this.resolveEmbedLinks(links, preferredIndex);
    });
  }

  async resolvePlayerLink(link: PlayerLink): Promise<PlayerLink[]> {
    if (isRetiredPlayerLink(link)) return [];
    return this.resolveEmbedLinks([link]);
  }

  private findResolverForUrl(url: string): ResolverManifest | null {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
    for (const manifest of this.resolvers.values()) {
      if (manifest.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return manifest;
    }
    return null;
  }

  private preferredLinkIndex(links: PlayerLink[], preference?: PlayerLinkPreference): number {
    if (!preference?.translation && !preference?.playerName) return -1;
    // A persisted pick can outlive the player it names. Treat a retired player as no preference
    // at all rather than letting a translation-only partial match jump to a different mirror.
    if (preference.playerName && RETIRED_PLAYER_NAMES.has(preference.playerName.trim().toLowerCase())) return -1;
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < links.length; i++) {
      const score =
        (preference.translation && links[i].translation === preference.translation ? 1 : 0) +
        (preference.playerName && links[i].playerName === preference.playerName ? 1 : 0);
      if (score > bestScore) {
        bestIndex = i;
        bestScore = score;
      }
    }
    return bestIndex;
  }

  private noteResolverResult(resolverId: string, succeeded: boolean): void {
    if (succeeded) {
      this.resolverHealth.delete(resolverId);
      return;
    }
    const previous = this.recentFailures(resolverId);
    this.resolverHealth.set(resolverId, { consecutiveFailures: previous + 1, lastFailureAt: Date.now() });
  }

  private recentFailures(resolverId: string): number {
    const health = this.resolverHealth.get(resolverId);
    if (!health) return 0;
    if (Date.now() - health.lastFailureAt >= RESOLVER_FAILURE_DECAY_MS) {
      this.resolverHealth.delete(resolverId);
      return 0;
    }
    return health.consecutiveFailures;
  }

  // BROWSER-runtime resolvers (extractors/alloha.js and similar) expose Provider.browserScript()
  // instead of Provider.resolve() - the script text itself is plain, portable JS (fetched cheaply
  // via the same sandboxed worker as every other extension call), but *running* it has to happen
  // inside a real page in a real browser context, which is Electron-main-only territory (see
  // browserResolveHost.ts, same reasoning as challenge()/browserFetch() elsewhere in this app).
  private async runBrowserResolver(resolverId: string, link: PlayerLink, deadline: number): Promise<Array<PlayerLink & { type: string }>> {
    const resolveStartedAt = Date.now();
    logger.info("resolve", `${resolverId} browser resolver: loading extractor script`);
    const result = await this.run<string>("browserScript", resolverId, [JSON.stringify(link)], {
      extensionsDir: this.resolversDir,
      timeoutMs: Math.max(1, Math.min(WORKER_TIMEOUT_MS, deadline - Date.now())),
    });
    const { script, parentUrl } = parseBrowserResolverPayload(result);
    logger.info("resolve", `${resolverId} extractor script ready in ${Date.now() - resolveStartedAt}ms (${script.length} chars); starting hidden-browser resolve`);
    const browserStartedAt = Date.now();
    const streams = await performBrowserResolve(link, script, Math.max(1, deadline - Date.now()), parentUrl);
    logger.info("resolve", `${resolverId} hidden-browser resolve finished in ${Date.now() - browserStartedAt}ms: ${streams.length} stream(s)`);
    return streams as unknown as Array<PlayerLink & { type: string }>;
  }

  // Mirrors Android's PlaybackResolver: an EMBED link is a third-party player *page*, not a media
  // file, so try the resolvers installed for it (see resolverDependencies in marketplace.ts) to
  // turn it into a real DIRECT_HLS/DIRECT_MP4 stream before the UI ever falls back to showing that
  // page in an iframe. The first resolver to return something playable wins.
  //
  // A source can return a dozen+ EMBED mirrors for one episode (YummyAnime does), most of them
  // pointing at the same handful of providers. The plan below caps the work two ways:
  // MAX_ATTEMPTS caps the total, and MAX_ATTEMPTS_PER_RESOLVER caps how much of it any single
  // provider may consume. A per-resolver allowance of 1 was the bug behind "Kodik sometimes just
  // doesn't load" - a *mirror* failing is not the same as a *provider* failing, and one retry on a
  // *different* mirror costs nothing on the normal path.
  //
  // Attempts used to run strictly one after another, so a slow or dead provider at the head of the
  // list (a browser-runtime resolver that fails after ~2.5s, twice, for its two mirrors) was paid
  // for in full before the next provider was even tried. They now overlap: the first starts at
  // once, and each next one starts as soon as the previous fails - or after RESOLVE_STAGGER_MS of
  // it still being in flight, whichever comes first. The stagger keeps the source's preferred
  // provider ahead in a healthy race (it gets a head start rather than a handicap), and keeps a
  // fast plain-HTTP fallback from waiting behind a slow one. Browser-runtime resolvers open a real
  // hidden window, so only one of them runs at a time.
  private async resolveEmbedLinks(links: PlayerLink[], preferredIndex = -1): Promise<PlayerLink[]> {
    const MAX_ATTEMPTS = 5;
    const MAX_ATTEMPTS_PER_RESOLVER = 2;
    const startedAt = Date.now();
    const deadline = startedAt + RESOLVE_TOTAL_TIMEOUT_MS;

    const orderedIndexes = links.map((_link, index) => index);
    if (preferredIndex >= 0) {
      orderedIndexes.splice(preferredIndex, 1);
      orderedIndexes.unshift(preferredIndex);
    }
    // Preserve the source's declared ordering while all providers are healthy. Once one starts
    // failing, put untouched/working resolvers ahead of it on subsequent episodes instead of
    // repeatedly paying its timeout first. The failed resolver remains in the list as fallback.
    const failuresByIndex = links.map((link) => {
      const resolver = link.type === "EMBED" ? this.findResolverForUrl(link.url) : null;
      return resolver ? this.recentFailures(resolver.id) : 0;
    });
    orderedIndexes.sort((a, b) => {
      if (a === preferredIndex) return -1;
      if (b === preferredIndex) return 1;
      return failuresByIndex[a] - failuresByIndex[b] || a - b;
    });

    interface Candidate { index: number; link: PlayerLink; resolver: ResolverManifest }
    const plan: Candidate[] = [];
    const plannedByResolver = new Map<string, number>();
    for (const index of orderedIndexes) {
      if (plan.length >= MAX_ATTEMPTS) break;
      const link = links[index];
      if (link.type !== "EMBED") continue;
      const resolver = this.findResolverForUrl(link.url);
      if (!resolver) continue;
      const used = plannedByResolver.get(resolver.id) ?? 0;
      if (used >= MAX_ATTEMPTS_PER_RESOLVER) continue;
      plannedByResolver.set(resolver.id, used + 1);
      plan.push({ index, link, resolver });
    }
    if (plan.length === 0) return links;

    const total = plan.length;
    let launched = 0;
    let active = 0;
    let browserActive = 0;
    let settled = false;
    let stagger: NodeJS.Timeout | undefined;

    return new Promise<PlayerLink[]>((resolveAll) => {
      const finish = (result: PlayerLink[], winner?: { resolverId: string; resolved: PlayerLink[] }) => {
        if (settled) return;
        settled = true;
        clearTimeout(stagger);
        if (winner) {
          logger.info("resolve", `${winner.resolverId} resolved ${winner.resolved.length} stream(s) [${winner.resolved.map((r) => r.quality ?? "?").join(", ")}] (${Date.now() - startedAt}ms total, ${launched}/${total} attempts started)`);
        } else {
          logger.warn("resolve", `no resolver produced a playable stream after ${launched} attempt(s) in ${Date.now() - startedAt}ms - falling back to the raw embed list`);
        }
        resolveAll(result);
      };

      const launchNext = () => {
        clearTimeout(stagger);
        if (settled) return;
        if (plan.length === 0 || Date.now() >= deadline) {
          if (active === 0) finish(links);
          return;
        }
        // The first candidate that is allowed to run now: a browser resolver has to wait for the
        // one before it, but must not hold up a plain-HTTP candidate queued behind it.
        const pick = plan.findIndex((c) => c.resolver.runtime !== "BROWSER" || browserActive === 0);
        if (pick < 0) return; // Only browser candidates are left and one is running: its end relaunches.
        const [candidate] = plan.splice(pick, 1);
        launched += 1;
        active += 1;
        const isBrowser = candidate.resolver.runtime === "BROWSER";
        if (isBrowser) browserActive += 1;
        if (plan.length > 0) stagger = setTimeout(launchNext, RESOLVE_STAGGER_MS);

        void this.attemptResolve(candidate.resolver, candidate.link, launched, total, deadline)
          .then((resolved) => {
            if (resolved.length > 0) {
              this.noteResolverResult(candidate.resolver.id, true);
              finish([...resolved, ...links.slice(0, candidate.index), ...links.slice(candidate.index + 1)], {
                resolverId: candidate.resolver.id,
                resolved,
              });
              return;
            }
            this.noteResolverResult(candidate.resolver.id, false);
            logger.warn("resolve", `${candidate.resolver.id} returned nothing playable`);
          })
          .catch((error: unknown) => {
            this.noteResolverResult(candidate.resolver.id, false);
            logger.warn("resolve", `${candidate.resolver.id} failed on ${candidate.link.url}: ${error instanceof Error ? error.message : String(error)}`);
          })
          .finally(() => {
            active -= 1;
            if (isBrowser) browserActive -= 1;
            launchNext();
          });
      };

      launchNext();
    });
  }

  /** One resolver run for one link, with the resolver's stream vocabulary mapped onto this app's
   * PlayerLink. Resolves to [] when the resolver found nothing playable. */
  private async attemptResolve(resolver: ResolverManifest, link: PlayerLink, attemptNo: number, of: number, deadline: number): Promise<PlayerLink[]> {
    logger.info("resolve", `attempt ${attemptNo}/${of} via ${resolver.id} (${resolver.runtime ?? "NODE"}) for ${link.playerName ?? "?"}/${link.translation ?? "?"} ${playerUrlLabel(link.url)}`);
    const raw =
      resolver.runtime === "BROWSER"
        ? await this.runBrowserResolver(resolver.id, link, deadline)
        : await this.run<Array<PlayerLink & { type: string }>>("resolve", resolver.id, [JSON.stringify(link)], {
            extensionsDir: this.resolversDir,
            timeoutMs: Math.max(1, Math.min(WORKER_TIMEOUT_MS, deadline - Date.now())),
          });
    // Resolvers speak the same VideoStream.type vocabulary as their compiled-in Kotlin originals
    // (HLS/MP4/DASH - see extractors/kodik.js's streamTypeFor), not this app's own PlayerLinkType -
    // mapped to the DIRECT_* counterpart the player actually understands.
    //
    // A resolver only ever returns stream-technical info (url/quality/type) - it has no way to know
    // which dub studio or embed provider the EMBED link it resolved even came from, so without this
    // the in-player "Озвучка"/"Плеер" picker shows a blank selection for whatever resolved link ends
    // up auto-selected. Carrying it over from the original link (only where the resolver itself
    // didn't already supply one) keeps the picker's selection in sync with reality.
    //
    // Same story for `segments` (opening/ending skip windows): only kodik.js parses its own from the
    // embed page - every other extractor just hardcodes `segments: []`, which would otherwise
    // silently break "auto-skip opening/ending" for any episode that resolves through one of those.
    //
    // And `videoId`: the source's own id for the episode, which reporting watch time to an account
    // is addressed by. A resolver has no idea what it is, so dropping it here left every resolved
    // stream - which is most of them - unable to report anything.
    return raw
      .map((candidate): Omit<PlayerLink, "type"> & { type: PlayerLinkType | undefined } => ({
        ...candidate,
        type: RESOLVER_STREAM_TYPE_TO_PLAYER_LINK_TYPE[candidate.type],
        translation: candidate.translation ?? link.translation,
        playerName: candidate.playerName ?? link.playerName,
        segments: candidate.segments && candidate.segments.length > 0 ? candidate.segments : link.segments,
        videoId: candidate.videoId ?? link.videoId,
      }))
      .filter((candidate): candidate is PlayerLink => candidate.type !== undefined);
  }

  /** What the source offers to search by: its own sort orders and filters, as it describes them. */
  async getFilterCatalog(sourceId: string): Promise<SearchFilterCatalog> {
    const settings = await this.run<Partial<SearchFilterCatalog>>("getSettings", sourceId, []);
    return {
      sortOptions: (settings.sortOptions ?? []).filter((o) => o && typeof o.id === "string" && o.id && typeof o.title === "string"),
      filters: (settings.filters ?? []).filter((f) => f && f.id && f.title && FILTER_TYPES.includes(f.type)),
    };
  }

  installedVersions(): Map<string, string> {
    return new Map([...this.extensions].map(([id, { manifest }]) => [id, manifest.version]));
  }

  /** Resolvers aren't user-installable, so they never appear in list() - but the Sources screen
   * still has to know their versions to notice that one of them has an update waiting. */
  installedResolverVersions(): Record<string, string> {
    return Object.fromEntries([...this.resolvers].map(([id, manifest]) => [id, manifest.version]));
  }

  /** The resolver dependencies that installed sources expect to be present. Keeping this on the
   * runtime means startup repair reads the installed manifest (the actual source contract), not a
   * possibly stale marketplace index entry. */
  installedResolverRequirements(): InstalledResolverRequirement[] {
    const requirements: InstalledResolverRequirement[] = [];
    for (const [sourceId, { manifest }] of this.extensions) {
      const resolverIds = [...new Set((manifest.resolverDependencies ?? []).filter((id) => id && !isRetiredResolver(id)))];
      if (resolverIds.length === 0) continue;
      const originUrl = this.originOf(sourceId);
      if (originUrl) requirements.push({ sourceId, originUrl, resolverIds });
    }
    return requirements;
  }

  private originPath(id: string): string {
    return path.join(this.extensionsDir, `${id}.origin`);
  }

  originOf(id: string): string | null {
    const file = this.originPath(id);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim() : null;
  }

  /**
   * Writes `<id>.manifest.json` + `<id>.js`, refusing to overwrite an id that was last installed
   * from a *different* repository — without this, a third-party repository could silently replace
   * trusted code published under an id like "animego" the moment anyone reinstalls/updates it.
   * Mirrors the Android app's ScriptExtensionRepository.install origin guard.
   */
  install(id: string, manifestJson: string, jsPayload: string, originUrl: string): void {
    let manifest: { id?: string };
    try {
      manifest = JSON.parse(manifestJson);
    } catch {
      throw new Error(`Manifest for "${id}" is not valid JSON`);
    }
    if (manifest.id !== id) throw new Error(`Manifest id "${manifest.id}" doesn't match "${id}"`);

    const existingOrigin = this.originOf(id);
    if (existingOrigin && existingOrigin !== originUrl) {
      throw new Error(`"${id}" is already installed from a different repository and can't be overwritten`);
    }

    fs.mkdirSync(this.extensionsDir, { recursive: true });
    fs.writeFileSync(path.join(this.extensionsDir, `${id}.manifest.json`), manifestJson);
    fs.writeFileSync(path.join(this.extensionsDir, `${id}.js`), jsPayload);
    fs.writeFileSync(this.originPath(id), originUrl);
    this.reload();
  }

  /** Installs a player resolver (best-effort dependency of a source, see marketplace.ts) - unlike
   * install(), there's no origin-trust guard here: resolvers aren't user-facing or user-chosen,
   * and a source can freely redeclare/update its own resolverDependencies. */
  installResolver(id: string, manifestJson: string, jsPayload: string): void {
    if (isRetiredResolver(id)) {
      logger.info("resolvers", `skipping retired resolver ${id}`);
      return;
    }
    let manifest: { id?: string };
    try {
      manifest = JSON.parse(manifestJson);
    } catch {
      throw new Error(`Resolver manifest for "${id}" is not valid JSON`);
    }
    if (manifest.id !== id) throw new Error(`Resolver manifest id "${manifest.id}" doesn't match "${id}"`);

    fs.mkdirSync(this.resolversDir, { recursive: true });
    fs.writeFileSync(path.join(this.resolversDir, `${id}.manifest.json`), manifestJson);
    fs.writeFileSync(path.join(this.resolversDir, `${id}.js`), jsPayload);
    this.reload();
  }

  private removeRetiredResolverFiles(): void {
    for (const id of RETIRED_RESOLVER_IDS) {
      for (const suffix of [".manifest.json", ".js"]) {
        fs.rmSync(path.join(this.resolversDir, `${id}${suffix}`), { force: true });
      }
    }
  }

  uninstall(id: string): void {
    // A stored token for a source that is no longer installed is a secret nobody is watching.
    this.forgetStorage(id);
    for (const suffix of [".manifest.json", ".js", ".origin"]) {
      const file = path.join(this.extensionsDir, `${id}${suffix}`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    this.reload();
  }
}
