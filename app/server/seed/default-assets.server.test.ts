import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";

/**
 * P13 regression: the shipped agent assets must load under EVERY runtime, not
 * just Vite's.
 *
 * They used to be imported with Vite's `?raw`. When `seed.server.ts` began
 * emitting the shipped personas (AP-03), this module entered the import graph
 * of `tsx scripts/seed.ts` and the documented install step `npm run seed` died
 * with `ERR_UNKNOWN_FILE_EXTENSION ".md"`. Typecheck, the whole unit suite and
 * the production build were green throughout — vitest and vite both understand
 * `?raw` — so nothing except a real CLI invocation could catch it.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("shipped default assets", () => {
  it("exposes every persona/skill body with real content", async () => {
    const mod = await import("./default-assets.server");
    expect(typeof mod.seedDefaultAgentAssets).toBe("function");
    // The operator profile template is built from the assets; an empty asset
    // would silently ship an agent with no instructions.
    const assetDir = path.join(REPO_ROOT, "app/server/seed/assets");
    for (const file of readdirSync(assetDir).filter((f) => f.endsWith(".md"))) {
      expect(
        readFileSync(path.join(assetDir, file), "utf8").trim().length,
        `${file} is empty`,
      ).toBeGreaterThan(50);
    }
  });

  it("uses no Vite-only import loader anywhere the CLI entrypoints can reach", () => {
    // `scripts/*.ts` run under tsx, which has no `?raw` loader. Keeping the
    // server tree free of it is what makes `npm run seed` / `npm run seed:demo`
    // survive any future import-graph change.
    // Only IMPORT statements matter; prose mentioning `?raw` is fine.
    let hits = "";
    try {
      hits = execFileSync(
        "grep",
        [
          "-rnE",
          "--include=*.ts",
          "--include=*.tsx",
          "from \\\"[^\\\"]*\\?raw\\\"",
          "app",
          "test-support",
          "scripts",
        ],
        { cwd: REPO_ROOT, encoding: "utf8" },
      ).trim();
    } catch {
      hits = ""; // grep exits 1 when there are no matches — that is the pass case
    }
    expect(hits, `Vite-only ?raw imports found:\n${hits}`).toBe("");
  }, 20_000);

  it("`npm run seed` completes on a clean data root", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-seed-cli-"));
    roots.push(dataRoot);
    execFileSync("npm", ["run", "seed"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        VIBERR_DATA_ROOT: dataRoot,
        VIBERR_SESSION_SECRET: "seed-cli-secret-0123456789abcdefghijklmnop",
        VIBERR_SECRET_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
    });
    // AP-03: the seeded specialist templates carry the SHIPPED persona, not the
    // two-sentence catalog blurb.
    const developer = readFileSync(
      path.join(dataRoot, "agents/profiles/developer.md"),
      "utf8",
    );
    expect(developer).toContain("You are the Developer");
  }, 120_000);
});
