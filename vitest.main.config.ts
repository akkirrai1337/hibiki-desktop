import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The default `npm test` root is the renderer (see vite.config.ts), so main-process tests need
// their own entry: `npm run test:main`.
export default defineConfig({
  resolve: { alias: { "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)) } },
  test: { include: ["src/main/**/*.test.ts"], environment: "node" },
});
