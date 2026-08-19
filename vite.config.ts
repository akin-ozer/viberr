import { createRequire } from "node:module";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, searchForWorkspaceRoot } from "vite";

try {
  loadEnvFile();
} catch (error) {
  // No `.env` at all is the normal case in CI and in the container image;
  // anything else (unreadable file, bad syntax) is a real failure.
  const missing =
    error instanceof Error && "code" in error && error.code === "ENOENT";
  if (!missing) throw error;
}

// Resolve the active runtime data root the same way the app does
// (app/server/config/env.server.ts). Task workspaces under it are full nested
// clones of the target repository — each with its own .git and tsconfig.json.
// Vite's default root watch would treat those as application source, emit HMR /
// full reloads for planning/design files, and clear its TypeScript cache on the
// nested tsconfig (F10-36). Exclude the whole data root from the dev watcher.
const dataRoot = path.resolve(process.env.VIBERR_DATA_ROOT ?? "./data");

// A git worktree carries no node_modules of its own — Node resolution walks up
// to the primary checkout's install. Vite's fs allow-list only covers the
// workspace root, so assets served from the resolved package tree (fonts) 403
// unless that real node_modules directory is allowed explicitly.
const resolvedNodeModules = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@fontsource/manrope/package.json")),
  "..",
  "..",
);

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
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd()), resolvedNodeModules],
    },
    watch: {
      // Merged with Vite's built-in ignores (node_modules, .git, cacheDir).
      ignored: [`${dataRoot}/**`],
    },
  },
});
