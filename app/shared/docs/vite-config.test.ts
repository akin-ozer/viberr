import path from "node:path";
import type { Rolldown } from "vite";
import { describe, expect, it } from "vitest";
import config from "../../../vite.config";

/**
 * Ruling 11: no font file is inlined into the render-blocking root
 * stylesheet. Vite's 4 KB default had put 9 base64 JetBrains Mono subsets
 * (20 KB gzip, 37% of the sheet) into `root-*.css`; the bundle ratchet
 * (`bundle:root.css`, `node scripts/measure-routes.mjs --check`) holds the
 * bytes, and this holds the reason they went away.
 */
describe("vite.config.ts never inlines a font (ruling 11)", () => {
  /** The build's own inline decision for one asset, as Vite asks it. */
  const limit = config.build?.assetsInlineLimit;
  const inlines = (file: string) =>
    limit instanceof Function ? limit(file, Buffer.alloc(0)) : limit;

  it("refuses every woff and woff2 file, whatever its size", () => {
    expect(inlines("/x/node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-vietnamese-400-normal.woff2")).toBe(false);
    expect(inlines("/x/jetbrains-mono-cyrillic-ext-500-normal.woff")).toBe(false);
    expect(inlines("/x/inter-latin-400-normal.woff2?url")).toBe(false);
  });

  it("leaves every other asset to Vite's default", () => {
    expect(inlines("/x/public/favicon.svg")).toBeUndefined();
    expect(inlines("/x/app/icon.png")).toBeUndefined();
  });
});

/**
 * Ruling 11: what every page loads anyway (the client entry's and the root
 * route's static closures) ships as two chunks, npm code and app code, not
 * ~30 slices cut by which routes import each piece. The bytes are held by the
 * bundle ratchet; this holds which modules may join those chunks, on a small
 * module graph, through the client build's own chunk namers.
 */
describe("the shell chunks (ruling 11)", () => {
  const app = (file: string) => path.resolve("app", file);
  const npm = (file: string) => path.resolve("node_modules", file);
  const ENTRY = app("entry.client.tsx");
  const ROOT = app("root.tsx");
  const ROOT_ENTRY = `${ROOT}?__react-router-build-client-route`;
  const graph = new Map([
    [ENTRY, [npm("react-dom/client.js"), app("ui/boot.ts")]],
    [ROOT_ENTRY, [ROOT]],
    [ROOT, [app("app.css"), app("ui/icon.tsx"), npm("react-router/index.js")]],
    [app("ui/icon.tsx"), [npm("react/index.js")]],
    [app("ui/boot.ts"), []],
    [app("app.css"), []],
    [npm("react-dom/client.js"), [npm("react/index.js")]],
    [npm("react/index.js"), []],
    [npm("react-router/index.js"), [npm("react/index.js")]],
    // Only a route (or a lazy chunk) imports these.
    [app("features/board/board-page.tsx"), [npm("@dnd-kit/react/index.js")]],
    [npm("@dnd-kit/react/index.js"), []],
  ]);
  const getModuleInfo = (next: string) => {
    const importedIds = graph.get(next);
    return importedIds ? { importedIds } : null;
  };
  const output = config.environments?.client?.build?.rolldownOptions?.output;
  const splitting = Array.isArray(output) ? undefined : output?.codeSplitting;
  const groups = splitting instanceof Object ? (splitting.groups ?? []) : [];
  // SAFETY: the build's chunk namers read only `importedIds` off a module's
  // info (the shell walk in vite.config.ts), which is all this graph holds.
  const ctx = { getModuleInfo } as Rolldown.ChunkingContext;
  /** The chunks the client build's groups name for one module. */
  const chunksOf = (id: string) =>
    groups.flatMap((group) =>
      (group.name instanceof Function ? group.name(id, ctx) : group.name) ?? [],
    );

  it("puts npm code every page loads in vendor and app code in shell", () => {
    expect(chunksOf(npm("react/index.js"))).toEqual(["vendor"]);
    expect(chunksOf(npm("react-dom/client.js"))).toEqual(["vendor"]);
    expect(chunksOf(npm("react-router/index.js"))).toEqual(["vendor"]);
    expect(chunksOf(app("ui/icon.tsx"))).toEqual(["shell"]);
    expect(chunksOf(app("ui/boot.ts"))).toEqual(["shell"]);
  });

  it("leaves the entries, root.tsx with its stylesheets, and route-only code alone", () => {
    for (const id of [ENTRY, ROOT_ENTRY, ROOT, app("app.css")]) expect(chunksOf(id), id).toEqual([]);
    expect(chunksOf(app("features/board/board-page.tsx"))).toEqual([]);
    expect(chunksOf(npm("@dnd-kit/react/index.js"))).toEqual([]);
  });
});
