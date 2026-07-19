import path from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import dotenv from "dotenv";
import { defineConfig } from "vite";

// Load .env so PORT (and the rest of the app env) is available in dev.
// Values already present in the real environment always win.
dotenv.config({ quiet: true });

// Resolve the active runtime data root the same way the app does
// (app/server/config/env.server.ts). Task workspaces under it are full nested
// clones of the target repository — each with its own .git and tsconfig.json.
// Vite's default root watch would treat those as application source, emit HMR /
// full reloads for planning/design files, and clear its TypeScript cache on the
// nested tsconfig (F10-36). Exclude the whole data root from the dev watcher.
const dataRoot = path.resolve(process.env.VIBERR_DATA_ROOT ?? "./data");

export default defineConfig({
  plugins: [reactRouter()],
  resolve: {
    // Vite 8 resolves the tsconfig "paths" alias (~/*) natively; the
    // vite-tsconfig-paths plugin is no longer needed.
    tsconfigPaths: true,
  },
  server: {
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    watch: {
      // Merged with Vite's built-in ignores (node_modules, .git, cacheDir).
      ignored: [`${dataRoot}/**`],
    },
  },
});
