// The Android Platform: Capacitor plugins for transports and host capabilities, Web Workers for
// extensions. Assembled once at startup by bootstrap.ts.
import type { EventsPort, PlatformPaths, PlayerPort } from "../types";
import type { Platform } from "../types";
import { androidBrowser } from "./browser";
import { createAndroidDb } from "./db";
import { AndroidExtensionHost } from "./extensionHost";
import { HibikiFiles, HibikiNet } from "./native";
import { androidDownloadTransfer, androidFiles, androidHttp, androidSecureStore } from "./transports";

type Listener = (payload: unknown) => void;

/** Backend -> UI notifications stay in this one JS context; the HibikiApi listeners subscribe here. */
export class AndroidEvents implements EventsPort {
  private readonly listeners = new Map<string, Set<Listener>>();

  emit(channel: string, payload?: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) listener(payload);
  }

  on(channel: string, listener: Listener): () => void {
    const set = this.listeners.get(channel) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(channel, set);
    return () => set.delete(listener);
  }
}

// Playback goes through the native stream proxy (StreamProxy.java): every request of a session
// carries its headers - whatever the origin, so registerHeaderOrigin has nothing to add - and the
// proxy follows redirects itself, so there is nothing to pre-resolve either.
function createPlayer(): PlayerPort {
  return {
    registerHeaders: async (_url, headers) => (await HibikiNet.registerStream({ headers: headers ?? {} })).sid,
    registerHeaderOrigin: () => true,
    unregisterHeaders: (sid) => void HibikiNet.unregisterStream({ sid }),
    playableUrl: (sid, url) => `/_hibiki/stream?sid=${encodeURIComponent(sid)}&u=${encodeURIComponent(url)}`,
    resolveFinalUrl: async (url) => url,
  };
}

export async function createAndroidPlatform(version: string): Promise<{ platform: Platform; events: AndroidEvents; migrate: () => Promise<number> }> {
  const { path: userData } = await HibikiFiles.dataDir();
  const join = androidFiles.join;
  const paths: PlatformPaths = {
    userData,
    database: join(userData, "hibiki.db"),
    extensions: join(userData, "extensions"),
    extensionStorage: join(userData, "extension-storage"),
    downloads: join(userData, "downloads"),
    profile: join(userData, "profile"),
  };
  const db = createAndroidDb(paths.database);
  const events = new AndroidEvents();
  const platform: Platform = {
    kind: "android",
    capabilities: {
      windowControls: false,
      zoom: false,
      discordPresence: false,
      hardwareAccelerationToggle: false,
      appUpdates: "none",
      revealLogFolder: false,
    },
    paths,
    files: androidFiles,
    secureStore: androidSecureStore,
    http: androidHttp,
    downloads: androidDownloadTransfer,
    db,
    browser: androidBrowser,
    player: createPlayer(),
    events,
    app: {
      version: () => version,
      openExternal: async (url) => {
        window.open(url, "_blank");
      },
      relaunch: () => window.location.reload(),
    },
    extensionHost: new AndroidExtensionHost(androidFiles),
  };
  return { platform, events, migrate: () => db.migrate() };
}
