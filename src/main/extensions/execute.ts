// Pure extension-execution logic, with no Electron dependency, so it can run inside a
// worker_thread (see worker.ts) — kept separate from runtime.ts (the main-thread orchestrator)
// on purpose: this is the part that calls the extension's synchronous fetch() and must never run
// on Electron's main thread, or a single slow/blocking source call freezes the entire app (window
// repaint, IPC, everything) for as long as the request takes.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { buildExtensionGlobals } from "./globals";
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

export type ExtensionMethod =
  | "search"
  | "latest"
  | "getById"
  | "getPlaybackGroups"
  | "getPlayerLinks"
  | "getSettings"
  | "resolve"
  | "browserScript"
  // Account and the things an account unlocks. Every one of these is optional on the script side:
  // a source that declares none of the matching capabilities never gets asked, and one that
  // declares them but lacks the function fails loudly rather than silently doing nothing.
  | "login"
  | "logout"
  | "getAccount"
  | "listComments"
  | "postComment"
  | "listReviews"
  | "postReview"
  | "syncLibraryEntry"
  | "listLibrary";

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

function loadProvider(
  scriptPath: string,
  sourceId: string,
  providers: ExtensionBridgeProviders,
  storage?: ExtensionStorageBinding,
): Record<string, unknown> {
  const source = fs.readFileSync(scriptPath, "utf-8");

  const globals = buildExtensionGlobals({
    logger: {
      log: (m) => console.log(`[${sourceId}]`, m),
      warn: (m) => console.warn(`[${sourceId}]`, m),
      error: (m) => console.error(`[${sourceId}]`, m),
    },
    preferredLanguage: "ru",
    challenge: providers.challenge ?? notImplementedChallengeProvider,
    browserFetch: providers.browserFetch ?? notImplementedBrowserFetchProvider,
    netFetch: providers.netFetch,
    storage,
  });

  const sandbox: Record<string, unknown> = { ...globals, Provider: undefined };
  const context = vm.createContext(sandbox);
  const script = new vm.Script(source, { filename: scriptPath });
  script.runInContext(context, { timeout: 30_000 });

  const provider = sandbox.Provider as Record<string, unknown> | undefined;
  if (!provider) throw new Error(`Extension ${sourceId} did not define a Provider object`);
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
    case "logout":
    case "getAccount":
    case "listComments":
    case "postComment":
    case "listReviews":
    case "postReview":
    case "syncLibraryEntry":
    case "listLibrary": {
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
