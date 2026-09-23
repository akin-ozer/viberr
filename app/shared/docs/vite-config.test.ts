import { describe, expect, it } from "vitest";
import config, { inlineAsset } from "../../../vite.config";

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
