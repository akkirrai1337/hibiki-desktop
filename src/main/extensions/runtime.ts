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
import { logger } from "../logger";
import { performBrowserResolve } from "./browserResolveHost";
import type { BridgeRequestMessage } from "./syncHostBridge";
import { ExtensionStorage } from "./extensionStorage";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_TIMEOUT_MS = 30_000;

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
  capabilities?: string[];
  supportedSorts?: string[];
  supportedFilters?: string[];
  settings?: SourceInfo["settings"];
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
}

export class ExtensionRuntime {
  private readonly extensions = new Map<string, LoadedExtension>();
  private readonly resolvers = new Map<string, ResolverManifest>();
  private readonly resolverHealth = new Map<string, ResolverHealth>();
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

    this.resolvers.clear();
    if (fs.existsSync(this.resolversDir)) {
      for (const file of fs.readdirSync(this.resolversDir)) {
        if (!file.endsWith(".manifest.json")) continue;
        const manifestPath = path.join(this.resolversDir, file);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ResolverManifest;
        const scriptPath = manifestPath.replace(/\.manifest\.json$/, ".js");
        if (!fs.existsSync(scriptPath)) continue;
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
      capabilities: (manifest.capabilities ?? []) as SourceInfo["capabilities"],
      supportedSorts: manifest.supportedSorts ?? [],
      supportedFilters: (manifest.supportedFilters ?? []) as SourceInfo["supportedFilters"],
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

  /** Starts the expensive worker bundle parsing before the renderer's first source queries arrive.
   * Only workers that have loaded the whole module and posted `ready` enter the idle pool; calls
   * arriving earlier still take the normal fresh-worker path rather than waiting behind warm-up. */
  warmWorkers(): void {
    const missing = ExtensionRuntime.MAX_IDLE_WORKERS - this.idleWorkers.length - this.warmingWorkers.size;
    for (let i = 0; i < missing; i++) {
      const worker = new Worker(path.join(__dirname, "extensionWorker.js"));
      this.warmingWorkers.add(worker);
      worker.once("message", (_message: WorkerReadyMessage) => {
        this.warmingWorkers.delete(worker);
        this.releaseWorker(worker);
      });
      worker.once("error", (error) => {
        this.warmingWorkers.delete(worker);
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
    options?: { extensionsDir: string },
  ): Promise<T> {
    const extensionsDir = options?.extensionsDir ?? this.extensionsDir;
    if (!options && !this.extensions.has(sourceId)) return Promise.reject(new Error(`Unknown source: ${sourceId}`));

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

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Deliberately terminated, never pooled: this worker is stuck inside a script that hasn't
        // returned, and handing the next call to it would hang that one too.
        void worker.terminate();
        logger.error("ext", `${sourceId}.${method}() timed out after ${WORKER_TIMEOUT_MS}ms`);
        reject(new Error(`Source "${sourceId}" timed out calling ${method}()`));
      }, WORKER_TIMEOUT_MS);

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
        void worker.terminate();
        const failure = error instanceof Error ? error : new Error(String(error));
        logger.error("ext", `${sourceId}.${method}() crashed in ${Date.now() - startedAt}ms: ${failure.message}`);
        reject(failure);
      });

      if (!fresh) worker.postMessage({ kind: "call", id: callId, call } satisfies WorkerCallMessage);
    });
  }

  /** Tears the pool down - called on app quit, so idle threads don't hold the process open. */
  dispose(): void {
    for (const worker of this.idleWorkers.splice(0)) void worker.terminate();
    for (const worker of this.warmingWorkers) void worker.terminate();
    this.warmingWorkers.clear();
  }

  search(sourceId: string, request: SearchRequest): Promise<AnimeTitle[]> {
    return this.run("search", sourceId, [request]);
  }

  latest(sourceId: string, limit: number): Promise<AnimeTitle[]> {
    return this.run("latest", sourceId, [limit]);
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
    return this.run("getById", sourceId, [id]);
  }

  getPlaybackGroups(sourceId: string, titleId: string): Promise<PlaybackGroup[]> {
    return this.run("getPlaybackGroups", sourceId, [titleId]);
  }

  async getPlayerLinks(sourceId: string, titleId: string, groupId: string, episodeId: string, preference?: PlayerLinkPreference): Promise<PlayerLink[]> {
    const links = await this.run<PlayerLink[]>("getPlayerLinks", sourceId, [titleId, groupId, episodeId]);
    const preferredIndex = this.preferredLinkIndex(links, preference);
    // A source-provided direct link needs no resolver at all. Let the renderer adopt the saved
    // choice from the returned list instead of resolving an unrelated EMBED first.
    if (preferredIndex >= 0 && links[preferredIndex].type !== "EMBED") return links;
    return this.resolveEmbedLinks(links, preferredIndex);
  }

  async resolvePlayerLink(link: PlayerLink): Promise<PlayerLink[]> {
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
    const previous = this.resolverHealth.get(resolverId)?.consecutiveFailures ?? 0;
    this.resolverHealth.set(resolverId, { consecutiveFailures: succeeded ? 0 : previous + 1 });
  }

  // BROWSER-runtime resolvers (extractors/alloha.js and similar) expose Provider.browserScript()
  // instead of Provider.resolve() - the script text itself is plain, portable JS (fetched cheaply
  // via the same sandboxed worker as every other extension call), but *running* it has to happen
  // inside a real page in a real browser context, which is Electron-main-only territory (see
  // browserResolveHost.ts, same reasoning as challenge()/browserFetch() elsewhere in this app).
  private async runBrowserResolver(resolverId: string, link: PlayerLink): Promise<Array<PlayerLink & { type: string }>> {
    const script = await this.run<string>("browserScript", resolverId, [JSON.stringify(link)], {
      extensionsDir: this.resolversDir,
    });
    const streams = await performBrowserResolve(link, script);
    return streams as unknown as Array<PlayerLink & { type: string }>;
  }

  // Mirrors Android's PlaybackResolver: an EMBED link is a third-party player *page*, not a media
  // file, so try the resolvers installed for it (see resolverDependencies in marketplace.ts) to
  // turn it into a real DIRECT_HLS/DIRECT_MP4 stream before the UI ever falls back to showing that
  // page in an iframe. Stops at the first resolver that actually returns something playable.
  //
  // A source can return a dozen+ EMBED mirrors for one episode (YummyAnime does), most of them
  // pointing at the same handful of providers. Trying every one of them in order would spend the
  // whole budget re-confirming that a broken provider is broken, so the budget is spread two ways:
  // MAX_ATTEMPTS caps the total work, and MAX_ATTEMPTS_PER_RESOLVER caps how much of it any single
  // provider may consume before the loop moves on to a different one.
  //
  // That per-resolver allowance used to be 1, which is the bug behind "Kodik sometimes just
  // doesn't load": a *mirror* failing is not the same as a *provider* failing. YummyAnime's Kodik
  // links are per-dub, and an individual one can be a dead season/serial id, or hit an edge node
  // that drops the connection - in which case Kodik as a whole was written off after one attempt
  // and the episode silently fell through to a slow browser-runtime provider or a bare iframe,
  // even though the very next Kodik mirror in the same list resolves fine. One retry on a
  // *different* mirror costs one extra request on the rare failing path and nothing at all on the
  // normal one (the first mirror succeeds and the loop returns immediately).
  private async resolveEmbedLinks(links: PlayerLink[], preferredIndex = -1): Promise<PlayerLink[]> {
    const MAX_ATTEMPTS = 5;
    const MAX_ATTEMPTS_PER_RESOLVER = 2;
    const attemptsByResolver = new Map<string, number>();
    let attempts = 0;
    const startedAt = Date.now();

    const orderedIndexes = links.map((_link, index) => index);
    if (preferredIndex >= 0) {
      orderedIndexes.splice(preferredIndex, 1);
      orderedIndexes.unshift(preferredIndex);
    }
    // Preserve the source's declared ordering while all providers are healthy. Once one starts
    // failing, put untouched/working resolvers ahead of it on subsequent episodes instead of
    // repeatedly paying its timeout first. The failed resolver remains in the list as fallback.
    orderedIndexes.sort((a, b) => {
      if (a === preferredIndex) return -1;
      if (b === preferredIndex) return 1;
      const resolverA = links[a].type === "EMBED" ? this.findResolverForUrl(links[a].url) : null;
      const resolverB = links[b].type === "EMBED" ? this.findResolverForUrl(links[b].url) : null;
      const failuresA = resolverA ? (this.resolverHealth.get(resolverA.id)?.consecutiveFailures ?? 0) : 0;
      const failuresB = resolverB ? (this.resolverHealth.get(resolverB.id)?.consecutiveFailures ?? 0) : 0;
      return failuresA - failuresB || a - b;
    });

    for (const i of orderedIndexes) {
      if (attempts >= MAX_ATTEMPTS) break;
      const link = links[i];
      if (link.type !== "EMBED") continue;
      const resolver = this.findResolverForUrl(link.url);
      if (!resolver) continue;
      const used = attemptsByResolver.get(resolver.id) ?? 0;
      if (used >= MAX_ATTEMPTS_PER_RESOLVER) continue;
      attemptsByResolver.set(resolver.id, used + 1);
      attempts += 1;
      const attemptStartedAt = Date.now();
      logger.info("resolve", `attempt ${attempts}/${MAX_ATTEMPTS} via ${resolver.id} (${resolver.runtime ?? "NODE"}) for ${link.playerName ?? "?"}/${link.translation ?? "?"} ${link.url}`);
      try {
        const raw =
          resolver.runtime === "BROWSER"
            ? await this.runBrowserResolver(resolver.id, link)
            : await this.run<Array<PlayerLink & { type: string }>>("resolve", resolver.id, [JSON.stringify(link)], {
                extensionsDir: this.resolversDir,
              });
        // Resolvers speak the same VideoStream.type vocabulary as their compiled-in Kotlin
        // originals (HLS/MP4/DASH - see extractors/kodik.js's streamTypeFor), not this app's own
        // PlayerLinkType - mapped to the DIRECT_* counterpart the player actually understands.
        //
        // A resolver only ever returns stream-technical info (url/quality/type) - it has no way to
        // know which dub studio or embed provider the EMBED link it resolved even came from, so
        // without this the in-player "Озвучка"/"Плеер" picker shows a blank selection for whatever
        // resolved link ends up auto-selected, even though the source's *other* links (still-EMBED
        // ones further down the list) clearly have that metadata. Carrying it over from the
        // original link it resolved (only where the resolver itself didn't already supply one)
        // keeps the picker's selection in sync with reality.
        //
        // Same story for `segments` (opening/ending skip windows): only kodik.js actually parses
        // its own from the embed page - every other extractor (aksor/sibnet/vk/cvh/dailymotion/
        // anitube-ashdi/aniboom) just hardcodes `segments: []`, which would otherwise silently
        // break "auto-skip opening/ending" for any episode that resolves through one of those, even
        // though the source's own getPlayerLinks() (yummy-anime.js, at least) already had real
        // timings on that EMBED link.
        const resolved = raw
          .map((candidate): Omit<PlayerLink, "type"> & { type: PlayerLinkType | undefined } => ({
            ...candidate,
            type: RESOLVER_STREAM_TYPE_TO_PLAYER_LINK_TYPE[candidate.type],
            translation: candidate.translation ?? link.translation,
            playerName: candidate.playerName ?? link.playerName,
            segments: candidate.segments && candidate.segments.length > 0 ? candidate.segments : link.segments,
            // Same reason as the three above, and now it matters: this is the source's own id for
            // the episode, and reporting watch time to an account is addressed by it. A resolver
            // has no idea what it is, so dropping it here left every resolved stream - which is
            // most of them - unable to report anything.
            videoId: candidate.videoId ?? link.videoId,
          }))
          .filter((candidate): candidate is PlayerLink => candidate.type !== undefined);
        if (resolved.length > 0) {
          this.noteResolverResult(resolver.id, true);
          logger.info("resolve", `${resolver.id} resolved ${resolved.length} stream(s) [${resolved.map((r) => r.quality ?? "?").join(", ")}] in ${Date.now() - attemptStartedAt}ms (${Date.now() - startedAt}ms total)`);
          return [...resolved, ...links.slice(0, i), ...links.slice(i + 1)];
        }
        this.noteResolverResult(resolver.id, false);
        logger.warn("resolve", `${resolver.id} returned nothing playable in ${Date.now() - attemptStartedAt}ms`);
      } catch (error) {
        this.noteResolverResult(resolver.id, false);
        logger.warn("resolve", `${resolver.id} failed on ${link.url} after ${Date.now() - attemptStartedAt}ms: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (attempts > 0) {
      logger.warn("resolve", `no resolver produced a playable stream after ${attempts} attempt(s) in ${Date.now() - startedAt}ms - falling back to the raw embed list`);
    }
    return links;
  }

  async getFilterCatalog(sourceId: string): Promise<SearchFilterCatalog> {
    const settings = await this.run<Partial<SearchFilterCatalog>>("getSettings", sourceId, []);
    return {
      sortOptions: settings.sortOptions ?? [],
      typeOptions: settings.typeOptions ?? [],
      statusOptions: settings.statusOptions ?? [],
      genreOptions: settings.genreOptions ?? [],
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
