// Brings the backend up inside the Android WebView and exposes it as `window.hibiki` - the same
// object the Electron preload exposes over IPC on desktop, here answered in-process by core.
// Runs before the renderer's own modules load (see src/renderer/android-entry.ts), because
// lib/hibiki.ts reads window.hibiki once at import time.
import type { HibikiApi } from "@shared/hibikiApi";
import { IPC } from "@shared/ipc";
import type { DownloadProgress } from "@shared/types";
import { createCoreApi } from "../../core/api";
import { ExtensionRuntime } from "../../core/extensions/runtime";
import { log, recentEntries } from "../../core/logger";
import { installPlatform } from "../../core/platform";
import { createAndroidPlatform } from "./index";

declare const __APP_VERSION__: string;

export async function installAndroidHibiki(): Promise<void> {
  const version = __APP_VERSION__;
  const { platform, events, migrate } = await createAndroidPlatform(version);
  installPlatform(platform);
  log("info", "app", `--- session start (android ${version}) ---`);

  const applied = await migrate();
  if (applied > 0) log("info", "db", `applied ${applied} migration(s)`);

  const runtime = new ExtensionRuntime(platform.paths.extensions);
  await runtime.reload();
  const core = createCoreApi(runtime);
  const nothing = () => () => {};

  const api: HibikiApi = {
    ...core,
    sources: { ...core.sources, onChanged: (callback) => events.on(IPC.sourcesChanged, () => callback()) },
    downloads: { ...core.downloads, onProgress: (callback) => events.on(IPC.downloadsProgress, (progress) => callback(progress as DownloadProgress)) },
    player: {
      registerHeaders: async (url, headers) => platform.player.registerHeaders(url, headers),
      registerHeaderOrigin: async (sessionId, url) => platform.player.registerHeaderOrigin(sessionId, url),
      unregisterHeaders: async (sessionId) => platform.player.unregisterHeaders(sessionId),
      resolveStreamUrl: (url, headers) => platform.player.resolveFinalUrl(url, headers),
      captureFrame: async () => null,
    },
    // Desktop-only surfaces: present so the renderer's calls are harmless, hidden from the UI by
    // platform.capabilities as the mobile layout lands.
    discord: { setEnabled: async () => {}, updatePresence: async () => {}, setIdlePresence: async () => {}, clearPresence: async () => {} },
    window: { unmaximizeForDrag() {}, minimize() {}, toggleMaximize() {}, close() {}, isMaximized: async () => false, onMaximizedChanged: nothing },
    updates: { check: async () => null, downloadAndInstall: async () => {}, openRelease: (url) => platform.app.openExternal(url), onProgress: nothing },
    zoom: { set() {}, get: () => 1 },
    platform: "android",
    app: {
      getVersion: async () => version,
      relaunch: () => platform.app.relaunch(),
      getHardwareAcceleration: async () => true,
      setHardwareAcceleration: async () => {},
      onDeepLinkWatch: nothing,
    },
    logs: {
      export: async () => null,
      recent: async (limit) => recentEntries(limit ?? 300),
      openFolder() {},
      memory: async () => ({ time: Date.now(), processes: [], totalMb: 0, mainHeapUsedMb: 0, rendererCount: 0 }),
      append: (level, scope, message) => log(level, `ui:${scope}`, String(message).slice(0, 4000)),
    },
    backup: { create: async () => null, restore: async () => null },
  };

  window.hibiki = api;
  runtime.warmWorkers();
}
