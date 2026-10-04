// The Android build: the same renderer as desktop, bundled for a Capacitor WebView. Instead of the
// Electron preload, android-entry.ts brings core up in-process (src/platform/android/bootstrap.ts).
// The extension worker reuses desktop's own sandbox globals (src/main/extensions/globals.ts); the
// two Node built-ins they touch are swapped for browser shims here.
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const shim = (name: string) => path.join(root, `src/platform/android/shims/${name}.ts`);
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")) as { version: string };

const androidEntry: Plugin = {
  name: "hibiki-android-entry",
  // "pre": before Vite turns the module script into a hashed asset reference.
  transformIndexHtml: {
    order: "pre",
    handler: (html) => {
      const desktopEntry = '<script type="module" src="/src/main.tsx"></script>';
      if (!html.includes(desktopEntry)) throw new Error("index.html no longer loads /src/main.tsx - update vite.android.config.ts");
      return html.replace(desktopEntry, '<script type="module" src="/android-entry.ts"></script>');
    },
  },
};

const aliases = {
  "@": path.join(root, "src/renderer/src"),
  "@shared": path.join(root, "src/shared"),
  "node:module": shim("module"),
  "node:zlib": shim("zlib"),
};

export default defineConfig({
  root: "src/renderer",
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: { alias: aliases },
  plugins: [
    TanStackRouterVite({
      routesDirectory: "src/routes",
      generatedRouteTree: "src/routeTree.gen.ts",
      autoCodeSplitting: true,
    }),
    react(),
    androidEntry,
  ],
  worker: { format: "es", plugins: () => [] },
  build: {
    outDir: path.join(root, "dist-android"),
    emptyOutDir: true,
    target: "es2022",
  },
});
