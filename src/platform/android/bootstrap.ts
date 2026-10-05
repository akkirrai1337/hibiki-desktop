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
import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core";
import { HibikiApp } from "./native";

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
  // The banner keeps one file name per type (banner.png, ...), so a new picture of the same type is
  // the same URL: the version makes the WebView fetch it again instead of showing its cached copy.
  let bannerVersion = Date.now();

  const api: HibikiApi = {
    ...core,
    sources: { ...core.sources, onChanged: (callback) => events.on(IPC.sourcesChanged, () => callback()) },
    downloads: { ...core.downloads, onProgress: (callback) => events.on(IPC.downloadsProgress, (progress) => callback(progress as DownloadProgress)) },
    player: {
      registerHeaders: (url, headers) => platform.player.registerHeaders(url, headers),
      registerHeaderOrigin: async (sessionId, url) => platform.player.registerHeaderOrigin(sessionId, url),
      unregisterHeaders: async (sessionId) => platform.player.unregisterHeaders(sessionId),
      resolveStreamUrl: (url, headers) => platform.player.resolveFinalUrl(url, headers),
      captureFrame: async () => null,
      streamUrl: (sessionId, url) => platform.player.playableUrl(sessionId, url),
    },
    // Desktop-only surfaces: present so the renderer's calls are harmless, hidden from the UI by
    // platform.capabilities as the mobile layout lands.
    discord: { setEnabled: async () => {}, updatePresence: async () => {}, setIdlePresence: async () => {}, clearPresence: async () => {} },
    window: { unmaximizeForDrag() {}, minimize() {}, toggleMaximize() {}, close() {}, isMaximized: async () => false, onMaximizedChanged: nothing },
    updates: { check: async () => null, downloadAndInstall: async () => {}, openRelease: (url) => platform.app.openExternal(url), onProgress: nothing },
    zoom: { set() {}, get: () => 1 },
    profile: {
      ...core.profile,
      setBanner: async (bytes, mimeType) => {
        const filename = await core.profile.setBanner(bytes, mimeType);
        bannerVersion = Date.now();
        return filename;
      },
      clearBanner: async () => {
        await core.profile.clearBanner();
        bannerVersion = Date.now();
      },
      // Capacitor's own local server hands out files from the app's storage under this URL.
      bannerUrl: (filename) => `${Capacitor.convertFileSrc(platform.files.join(platform.paths.profile, filename))}?v=${bannerVersion}`,
    },
    platform: "android",
    device: {
      onBack: (callback) => {
        window.addEventListener("hibikiback", callback);
        return () => window.removeEventListener("hibikiback", callback);
      },
      minimize: () => void HibikiApp.minimize(),
      setSystemBars: async ({ hidden, style }) => {
        // "dark" bars carry light icons - the app's dark theme; "light" bars carry dark icons.
        if (style) await SystemBars.setStyle({ style: style === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light });
        if (hidden !== undefined) await (hidden ? SystemBars.hide() : SystemBars.show());
      },
      keepAwake: (on) => HibikiApp.keepAwake({ value: on }),
      setOrientation: (orientation) => HibikiApp.setOrientation({ value: orientation }),
    },
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
