// Pure extension-execution logic, with no Electron dependency, so it can run inside a
// worker_thread (see worker.ts) — kept separate from runtime.ts (the main-thread orchestrator)
// on purpose: this is the part that calls the extension's synchronous fetch() and must never run
// on Electron's main thread, or a single slow/blocking source call freezes the entire app (window
// repaint, IPC, everything) for as long as the request takes.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { buildExtensionGlobals } from "./globals";
import type { ExtensionMethod } from "../../core/extensions/methods";
import type { ExtensionStorageBinding } from "@shared/extensionCallStorage";
import { notImplementedBrowserFetchProvider, notImplementedChallengeProvider } from "./browserBridge";
import type { BrowserFetchProvider, ChallengeProvider, NetFetchProvider } from "./browserBridge";

export interface ExtensionBridgeProviders {
  challenge?: ChallengeProvider;
  browserFetch?: BrowserFetchProvider;
  /** Left out only when there is no main thread to bridge to - globals.ts then falls back to
   * sync-fetch's child-process path. */
  netFetch?: NetFetchProvider;
}

export type { ExtensionMethod } from "../../core/extensions/methods";

export interface ExtensionCall {
  extensionsDir: string;
  sourceId: string;
  method: ExtensionMethod;
  args: unknown[];
  /** This source's stored values, as of the moment the call was dispatched. */
  storage?: Record<string, string>;
}

function findScriptPath(extensionsDir: string, sourceId: string): string {
  const manifestPath = path.join(extensionsDir, `${sourceId}.manifest.json`);
  const scriptPath = path.join(extensionsDir, `${sourceId}.js`);
  if (!fs.existsSync(manifestPath) || !fs.existsSync(scriptPath)) {
    throw new Error(`Unknown source: ${sourceId}`);
  }
  return scriptPath;
}

interface CompiledExtension {
  mtimeMs: number;
  size: number;
  script: vm.Script;
}

// execute.ts lives for the lifetime of a pooled worker. vm.Script is compiled code and can run in
// any number of contexts, so the expensive, source-independent part is kept here (a context is only
// rebuilt when the script changes on disk - see persistedProviders below).
// mtime + size makes an installed source update visible without having to restart the workers.
const compiledExtensions = new Map<string, CompiledExtension>();

function loadCompiledExtension(scriptPath: string): vm.Script {
  const stat = fs.statSync(scriptPath);
  const cached = compiledExtensions.get(scriptPath);
  if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.script;

  const script = new vm.Script(fs.readFileSync(scriptPath, "utf-8"), { filename: scriptPath });
  compiledExtensions.set(scriptPath, { mtimeMs: stat.mtimeMs, size: stat.size, script });
  return script;
}

// What the call in flight supplies to the script's host globals. Everything else in a persisted
// context (the script's own module-scope `var`s) outlives the call, but these are per-call: the
// storage snapshot is read at dispatch, and the bridge providers belong to the worker's current
// main-thread link.
interface CallBindings {
  providers: ExtensionBridgeProviders;
  storage?: ExtensionStorageBinding;
}

interface PersistedProvider {
  mtimeMs: number;
  size: number;
  hasNetFetch: boolean;
  provider: Record<string, unknown>;
  bindings: { current: CallBindings };
}

// A context per (worker, script), kept for the worker's whole life instead of rebuilt every call.
// Extensions are written against the Rhino/Android model where a Provider instance lives on and
// module-scope variables persist between calls - animepahe/anikappa keep their solved Cloudflare
// session in `cachedSession`, and several sources memoise filter definitions and per-title lookups.
// Rebuilding the context per call silently reset all of that, so every fetch replayed the doomed
// bare attempt (403) before falling back to a challenge it had already solved a call earlier.
// mtime + size still invalidates a stale context when an installed source is updated.
const persistedProviders = new Map<string, PersistedProvider>();

function loadProvider(
  scriptPath: string,
  sourceId: string,
  providers: ExtensionBridgeProviders,
  storage?: ExtensionStorageBinding,
): Record<string, unknown> {
  const stat = fs.statSync(scriptPath);
  const hasNetFetch = providers.netFetch !== undefined;
  const persisted = persistedProviders.get(scriptPath);
  if (persisted && persisted.mtimeMs === stat.mtimeMs && persisted.size === stat.size && persisted.hasNetFetch === hasNetFetch) {
    persisted.bindings.current = { providers, storage };
    return persisted.provider;
  }

  const bindings = { current: { providers, storage } as CallBindings };
  // Delegating wrappers read `bindings.current` at call time, so a persisted context always talks to
  // the *current* call's bridge and storage, never the first call's.
  const globals = buildExtensionGlobals({
    logger: {
      log: (m) => console.log(`[${sourceId}]`, m),
      warn: (m) => console.warn(`[${sourceId}]`, m),
      error: (m) => console.error(`[${sourceId}]`, m),
    },
    preferredLanguage: "ru",
    challenge: { acquire: (...args) => (bindings.current.providers.challenge ?? notImplementedChallengeProvider).acquire(...args) },
    browserFetch: { fetch: (...args) => (bindings.current.providers.browserFetch ?? notImplementedBrowserFetchProvider).fetch(...args) },
    netFetch: hasNetFetch
      ? {
          fetch: (...args) => bindings.current.providers.netFetch!.fetch(...args),
          fetchAll: (...args) => bindings.current.providers.netFetch!.fetchAll(...args),
        }
      : undefined,
    storage: {
      get: (key) => bindings.current.storage?.get(key) ?? null,
      set: (key, value) => bindings.current.storage?.set(key, value),
      remove: (key) => bindings.current.storage?.remove(key),
    },
  });

  const sandbox: Record<string, unknown> = { ...globals, Provider: undefined };
  const context = vm.createContext(sandbox);
  const script = loadCompiledExtension(scriptPath);
  script.runInContext(context, { timeout: 30_000 });

  const provider = sandbox.Provider as Record<string, unknown> | undefined;
  if (!provider) throw new Error(`Extension ${sourceId} did not define a Provider object`);
  persistedProviders.set(scriptPath, { mtimeMs: stat.mtimeMs, size: stat.size, hasNetFetch, provider, bindings });
  return provider;
}

function tagSource<T extends { id: string }>(sourceId: string, item: T): T & { sourceId: string } {
  return { ...item, sourceId };
}

export function executeExtensionCall(
  call: ExtensionCall,
  providers: ExtensionBridgeProviders = {},
  storage?: ExtensionStorageBinding,
): unknown {
  const scriptPath = findScriptPath(call.extensionsDir, call.sourceId);
  const provider = loadProvider(scriptPath, call.sourceId, providers, storage);

  switch (call.method) {
    case "search": {
      const fn = provider.search as (json: string) => Array<{ id: string }>;
      const results = fn.call(provider, JSON.stringify(call.args[0]));
      return results.map((r) => tagSource(call.sourceId, r));
    }
    case "latest": {
      const fn = provider.latest as (limit: number) => Array<{ id: string }>;
      const results = fn.call(provider, call.args[0] as number);
      return results.map((r) => tagSource(call.sourceId, r));
    }
    case "getById": {
      const fn = provider.getById as (id: string) => { id: string };
      return tagSource(call.sourceId, fn.call(provider, call.args[0] as string));
    }
    case "getPlaybackGroups": {
      const fn = provider.getPlaybackGroups as (titleId: string) => unknown[];
      return fn.call(provider, call.args[0] as string) ?? [];
    }
    case "getPlayerLinks": {
      const fn = provider.getPlayerLinks as (titleId: string, groupId: string, episodeId: string) => unknown[];
      return (
        fn.call(provider, call.args[0] as string, call.args[1] as string, call.args[2] as string) ?? []
      );
    }
    case "getSettings": {
      const fn = provider.getSettings as (() => unknown) | undefined;
      return fn ? (fn.call(provider) ?? {}) : {};
    }
    case "resolve": {
      // Player resolvers (extensions/extractors/*.js in hibiki-sources) expose Provider.resolve
      // instead of the catalog methods above - they turn one EMBED PlayerLink (a third-party
      // player page) into real DIRECT_HLS/DIRECT_MP4 candidates, so their result isn't tagged
      // with a source id the way search/getById results are.
      const fn = provider.resolve as (json: string) => unknown[];
      return fn.call(provider, call.args[0] as string) ?? [];
    }
    // One shape for all of these: the argument, if any, is a JSON string, and so is the answer's
    // payload - the same convention search/resolve already use, and the one Rhino needs, since it
    // cannot hand a real object across the boundary either.
    case "login":
    case "loginWeb":
    case "logout":
    case "getAccount":
    case "listComments":
    case "postComment":
    case "voteComment":
    case "listReviews":
    case "postReview":
    case "syncLibraryEntry":
    case "listLibrary":
    case "reportPlayback":
    case "pingOnline": {
      const fn = provider[call.method] as ((json?: string) => unknown) | undefined;
      if (typeof fn !== "function") {
        throw new Error(`Source "${call.sourceId}" declares ${call.method} but does not implement it`);
      }
      const argument = call.args.length > 0 ? JSON.stringify(call.args[0]) : undefined;
      return fn.call(provider, argument) ?? null;
    }
    case "browserScript": {
      // BROWSER-runtime resolvers (extractors/alloha.js and similar) expose this instead of
      // resolve() - it's a plain string of JS meant to run *inside* the embed page's own browser
      // context (see browserResolveHost.ts), not something this sandbox executes itself.
      const fn = provider.browserScript as (json: string) => string;
      return fn.call(provider, call.args[0] as string);
    }
    default:
      throw new Error(`Unknown extension method: ${call.method satisfies never}`);
  }
}
