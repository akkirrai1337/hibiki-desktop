// Brings the backend up inside the Android WebView and exposes it as `window.hibiki` - the same
// object the Electron preload exposes over IPC on desktop, here answered in-process by core.
// Runs before the renderer's own modules load (see src/renderer/android-entry.ts), because
// lib/hibiki.ts reads window.hibiki once at import time.
import type { HibikiApi, PipAction } from "@shared/hibikiApi";
import { IPC } from "@shared/ipc";
import type { DownloadProgress } from "@shared/types";
import { createCoreApi } from "../../core/api";
import { ExtensionRuntime } from "../../core/extensions/runtime";
import { log, recentEntries, renderLog } from "../../core/logger";
import { installPlatform } from "../../core/platform";
import { createAndroidPlatform } from "./index";
import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core";
import { HibikiApp } from "./native";

declare const __APP_VERSION__: string;

/**
 * The "continue watching" frame: the playing video's own decoded pixels drawn to a small canvas,
 * as the desktop main process does, never a screenshot with the controls on it. Streams go
 * through the same-origin /_hibiki/stream route, so the canvas stays readable; a video that
 * still taints it keeps the previous thumbnail.
 */
function captureVideoFrame(): string | null {
  const videos = [...document.querySelectorAll("video")]
    .filter((v) => v.readyState >= 2 && v.videoWidth && v.videoHeight && !v.seeking && v.getClientRects().length)
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  for (const video of videos) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = Math.max(1, Math.round((400 * video.videoHeight) / video.videoWidth));
      const context = canvas.getContext("2d");
      if (!context) continue;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.8);
    } catch { /* Cross-origin or protected video. */ }
  }
  return null;
}

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
      registerHeaders: (url, headers) => platform.player.registerHeaders(url, headers),
      registerHeaderOrigin: async (sessionId, url) => platform.player.registerHeaderOrigin(sessionId, url),
      unregisterHeaders: async (sessionId) => platform.player.unregisterHeaders(sessionId),
      resolveStreamUrl: (url, headers) => platform.player.resolveFinalUrl(url, headers),
      captureFrame: async () => captureVideoFrame(),
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
      // Capacitor's own local server hands out files from the app's storage under this URL. Each
      // banner has a name of its own (see core/api/profile.ts), so no cache-busting is needed.
      bannerUrl: (filename) => Capacitor.convertFileSrc(platform.files.join(platform.paths.profile, filename)),
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
        // Hidden is the player's immersive full screen, which HibikiApp keeps applied across rotations.
        if (hidden !== undefined) await HibikiApp.setImmersive({ value: hidden });
      },
      keepAwake: (on) => HibikiApp.keepAwake({ value: on }),
      setOrientation: (orientation) => HibikiApp.setOrientation({ value: orientation }),
      pip: {
        update: (state) => void HibikiApp.updatePip({ ...state, width: state.width ? Math.round(state.width) : undefined, height: state.height ? Math.round(state.height) : undefined }).catch(() => undefined),
        enter: async () => (await HibikiApp.enterPip().catch(() => ({ entered: false }))).entered,
        onAction: (callback) => {
          const handle = HibikiApp.addListener("pipAction", (event) => callback(event.action as PipAction));
          return () => void handle.then((h) => h.remove());
        },
        onModeChange: (callback) => {
          const listener = (event: Event) => callback(Boolean((event as Event & { active?: boolean }).active));
          window.addEventListener("hibikipip", listener);
          return () => window.removeEventListener("hibikipip", listener);
        },
      },
    },
    app: {
      getVersion: async () => version,
      relaunch: () => platform.app.relaunch(),
      getHardwareAcceleration: async () => true,
      setHardwareAcceleration: async () => {},
      onDeepLinkWatch: nothing,
    },
    logs: {
      // No save dialog on the phone: the share sheet is where the file goes (a messenger, Files...).
      // Resolves null like a cancelled desktop dialog - there is no saved path to report.
      export: async () => {
        const sources = await core.sources.list().then((list) => list.map((source) => source.id).join(", ")).catch(() => "?");
        const text = renderLog({
          app: `hibiki ${version} (android)`,
          webview: navigator.userAgent,
          exportedAt: new Date().toISOString(),
          sources: sources || "none",
        });
        // Local time, as the user will look for it.
        const now = new Date();
        const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 19).replace(/[T:]/g, "-");
        await HibikiApp.shareText({ name: `hibiki-log-${stamp}.txt`, text });
        return null;
      },
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
