import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: "src/renderer",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src/renderer/src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  plugins: [
    TanStackRouterVite({
      routesDirectory: "src/routes",
      generatedRouteTree: "src/routeTree.gen.ts",
    }),
    react(),
    electron({
      main: {
        entry: {
          index: path.join(root, "src/main/index.ts"),
          extensionWorker: path.join(root, "src/main/extensions/worker.ts"),
        },
        vite: {
          resolve: {
            alias: {
              "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
            },
          },
          build: {
            outDir: path.join(root, "dist-electron/main"),
            rollupOptions: {
              external: (id) =>
                id === "electron" ||
                id === "better-sqlite3" ||
                id === "undici" ||
                id === "sync-fetch" ||
                // ws's own optional-native-addon acceleration (used by @xhayper/discord-rpc's
                // websocket transport option) - neither is installed (ws falls back to a pure-JS
                // path at runtime when they're missing, which is fine), but Rollup tries to
                // eagerly resolve the import at bundle time and fails outright since they're not
                // in node_modules at all, crashing the whole app before it even loads.
                id === "bufferutil" ||
                id === "utf-8-validate" ||
                id.startsWith("node:"),
            },
          },
        },
      },
      preload: {
        input: path.join(root, "src/preload/index.ts"),
        vite: {
          resolve: {
            alias: {
              "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
            },
          },
          build: {
            outDir: path.join(root, "dist-electron/preload"),
          },
        },
      },
      renderer: {},
    }),
  ],
  build: {
    outDir: path.join(root, "dist"),
    emptyOutDir: true,
  },
});
