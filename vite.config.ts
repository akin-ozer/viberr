import { createRequire } from "node:module";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, searchForWorkspaceRoot, type Rolldown } from "vite";

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
// full reloads for files an agent writes there, and clear its TypeScript cache on the
// nested tsconfig (F10-36). Exclude the whole data root from the dev watcher.
const dataRoot = path.resolve(process.env.VIBERR_DATA_ROOT ?? "./data");

// A git worktree carries no node_modules of its own — Node resolution walks up
// to the primary checkout's install. Vite's fs allow-list only covers the
// workspace root, so assets served from the resolved package tree (fonts) 403
// unless that real node_modules directory is allowed explicitly.
const resolvedNodeModules = path.join(
  path.dirname(createRequire(import.meta.url).resolve("@fontsource/inter/package.json")),
  "..",
  "..",
);

/**
 * Ruling 11: a font file is never inlined. Vite inlines any asset under 4 KB
 * as a base64 `data:` URI by default, which put JetBrains Mono's cyrillic-ext
 * and vietnamese subsets (woff2 and woff, three weights) into the root
 * stylesheet that blocks every first paint: 20 KB of its 55.6 KB gzip, fetched
 * again after every deploy because app.css changes that sheet's hash. As files
 * they download only when a glyph in their `unicode-range` renders, and stay
 * cached. Every other asset keeps Vite's default (`undefined`).
 */
function inlineAsset(filePath: string): false | undefined {
  return /\.woff2?(?:$|\?)/.test(filePath) ? false : undefined;
}

const CLIENT_ENTRY = path.resolve("app/entry.client.tsx");
const ROOT_ROUTE = path.resolve("app/root.tsx");
// React Router builds each client route module through this query.
const ROOT_ROUTE_ENTRY = `${ROOT_ROUTE}?__react-router-build-client-route`;

/**
 * Ruling 11: every page loads the client entry and the root route, so every
 * route's closure already holds everything those two import statically.
 * Rolldown cannot know that (to it, route modules are unrelated entries), so
 * it cut that shared code into ~30 chunks by which routes import each piece,
 * half of them under 1 KB gzip, and a cold board load queued 46 requests
 * through HTTP/1.1's six connections (ruling 25). Here those modules go into
 * two chunks, npm code (`vendor`, whose hash survives deploys that do not
 * touch dependencies) and app code (`shell`). No route gains a byte it did
 * not already load, and one compression window per chunk makes each closure
 * smaller, not larger.
 *
 * The two entry modules stay entries, and CSS stays with root.tsx: a
 * stylesheet in a chunk that lazy chunks also import is treated as dynamic.
 */
function shellChunkOf(): (
  id: string,
  graph: { getModuleInfo(id: string): { importedIds: readonly string[] } | null },
) => "vendor" | "shell" | null {
  let shell: Set<string> | null = null;
  return (id, graph) => {
    if (!shell) {
      shell = new Set();
      const queue = [CLIENT_ENTRY, ROOT_ROUTE_ENTRY];
      while (queue.length > 0) {
        const next = queue.pop()!;
        const info = shell.has(next) ? null : graph.getModuleInfo(next);
        if (!info) continue;
        shell.add(next);
        queue.push(...info.importedIds);
      }
    }
    if (id === CLIENT_ENTRY || id === ROOT_ROUTE_ENTRY || id === ROOT_ROUTE) return null;
    if (!shell.has(id) || /\.css(?:$|\?)/.test(id)) return null;
    return /[\\/]node_modules[\\/]/.test(id) ? "vendor" : "shell";
  };
}

function shellChunks(): Rolldown.CodeSplittingGroup[] {
  const chunkOf = shellChunkOf();
  return [
    // First, so the app group's npm dependencies already have their chunk.
    { name: (id, ctx) => (chunkOf(id, ctx) === "vendor" ? "vendor" : null), priority: 2 },
    { name: (id, ctx) => (chunkOf(id, ctx) === "shell" ? "shell" : null), priority: 1 },
  ];
}

export default defineConfig({
  plugins: [reactRouter()],
  build: {
    assetsInlineLimit: inlineAsset,
  },
  environments: {
    client: {
      build: {
        rolldownOptions: {
          output: { codeSplitting: { groups: shellChunks() } },
        },
      },
    },
  },
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
