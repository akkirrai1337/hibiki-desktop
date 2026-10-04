import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const shim = (name: string) => fileURLToPath(new URL(`./src/shims/${name}.ts`, import.meta.url));

// The PoC deliberately imports the desktop app's own extension code (src/main/extensions/globals.ts,
// jsoupShim.ts) instead of copying it: the point is to prove that exact code runs in a Web Worker.
// The two Node built-ins it touches are swapped for browser shims here; desktop sources stay untouched.
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  resolve: {
    alias: {
      "node:module": shim("module"),
      "node:zlib": shim("zlib"),
      "@shared": `${desktopRoot}src/shared`,
    },
  },
  worker: { format: "es" },
  build: { target: "es2022" },
  server: {
    host: true,
    headers: isolationHeaders,
    fs: { allow: [desktopRoot, fileURLToPath(new URL("../../../hibiki-sources", import.meta.url))] },
  },
  preview: { headers: isolationHeaders },
});
