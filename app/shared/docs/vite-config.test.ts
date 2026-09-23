import path from "node:path";
import { describe, expect, it } from "vitest";
import config, { inlineAsset, shellChunkOf } from "../../../vite.config";

/**
 * Ruling 454: no font file is inlined into the render-blocking root
 * stylesheet. Vite's 4 KB default had put 9 base64 JetBrains Mono subsets
 * (20 KB gzip, 37% of the sheet) into `root-*.css`; the bundle ratchet
 * (`bundle:root.css`, `node scripts/measure-routes.mjs --check`) holds the
 * bytes, and this holds the reason they went away.
 */
describe("vite.config.ts never inlines a font (ruling 454)", () => {
  it("refuses every woff and woff2 file, whatever its size", () => {
    expect(inlineAsset("/x/node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-vietnamese-400-normal.woff2")).toBe(false);
    expect(inlineAsset("/x/jetbrains-mono-cyrillic-ext-500-normal.woff")).toBe(false);
    expect(inlineAsset("/x/inter-latin-400-normal.woff2?url")).toBe(false);
  });

  it("leaves every other asset to Vite's default", () => {
    expect(inlineAsset("/x/public/favicon.svg")).toBeUndefined();
    expect(inlineAsset("/x/app/icon.png")).toBeUndefined();
  });

  it("is the predicate the build uses", () => {
    expect(config.build?.assetsInlineLimit).toBe(inlineAsset);
  });
});

/**
 * Ruling 454: what every page loads anyway (the client entry's and the root
 * route's static closures) ships as two chunks, npm code and app code, not
 * ~30 slices cut by which routes import each piece. The bytes are held by the
 * bundle ratchet; this holds which modules may join those chunks, on a small
 * module graph.
 */
describe("the shell chunks (ruling 454)", () => {
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
  const classify = shellChunkOf();
  const chunkOf = (id: string) =>
    classify(id, {
      getModuleInfo: (next) => {
        const importedIds = graph.get(next);
        return importedIds ? { importedIds } : null;
      },
    });

  it("puts npm code every page loads in vendor and app code in shell", () => {
    expect(chunkOf(npm("react/index.js"))).toBe("vendor");
    expect(chunkOf(npm("react-dom/client.js"))).toBe("vendor");
    expect(chunkOf(npm("react-router/index.js"))).toBe("vendor");
    expect(chunkOf(app("ui/icon.tsx"))).toBe("shell");
    expect(chunkOf(app("ui/boot.ts"))).toBe("shell");
  });

  it("leaves the entries, root.tsx with its stylesheets, and route-only code alone", () => {
    for (const id of [ENTRY, ROOT_ENTRY, ROOT, app("app.css")]) expect(chunkOf(id), id).toBeNull();
    expect(chunkOf(app("features/board/board-page.tsx"))).toBeNull();
    expect(chunkOf(npm("@dnd-kit/react/index.js"))).toBeNull();
  });

  it("is what the client build uses", () => {
    const groups = config.environments?.client?.build?.rolldownOptions?.output;
    expect(JSON.stringify(groups)).toContain("codeSplitting");
  });
});
