import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { z } from "zod";
import { logger } from "~/server/logging/logger.server";

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

/** The on-disk bookkeeping this module maintains: shipped path → content hash. */
const manifestSchema = z.record(z.string(), z.string());
/** The asset a divergence warning names, and the drift it reports. */
const warnedAssetSchema = z.object({ asset: z.string() });
const divergenceFieldsSchema = z.object({
  onDisk: z.string(),
  shipped: z.string(),
  path: z.string(),
});
const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("shipped default assets", () => {
  it("exposes every persona/skill body with real content", async () => {
    const mod = await import("./default-assets.server");
    expect(mod.seedDefaultAgentAssets).toBeTypeOf("function");
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

  it("ships the Frontend/Design skill into a fresh store, like the base specialists' skills", async () => {
    const { seedDefaultAgentAssets } = await import("./default-assets.server");
    const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-frontend-design-skill-"));
    roots.push(dataRoot);
    seedDefaultAgentAssets(dataRoot);
    const skill = readFileSync(
      path.join(dataRoot, "skills", "frontend-design-expertise", "SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("Frontend/Design specialist");
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

  it("F15-14: the shipped operator doctrine carries the triage quality gate", () => {
    // The gate the New-task dialog promises ("underspecified goals get flagged")
    // lived nowhere in the persona, and live a textbook-vague goal walked
    // straight through Triage.
    const definition = readFileSync(
      path.join(REPO_ROOT, "app/server/seed/assets/operator.definition.md"),
      "utf8",
    );
    expect(definition).toContain("triage quality gate");
    expect(definition).toContain("MUST NOT transition forward");
    expect(definition).toContain("acceptance criteria");
  });

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

/**
 * B-OP1: `seedDefaultAgentAssets` only ever wrote MISSING files, so a store
 * seeded before a doctrine rewrite kept running the old one forever — live, the
 * operator followed a standard operating procedure naming tools that no longer
 * exist, because the runtime prefers the store copy over the shipped asset. A
 * copy that still hashes to something this app shipped is refreshed; a copy a
 * human edited is not.
 */
describe("shipped-asset refresh (B-OP1)", () => {
  const OPERATOR_REL = path.join("agents", "definitions", "operator.md");

  function freshStore(): string {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-assets-"));
    roots.push(dataRoot);
    return dataRoot;
  }

  const storeCopy = (dataRoot: string): string =>
    readFileSync(path.join(dataRoot, OPERATOR_REL), "utf8");

  const shipped = (): string =>
    readFileSync(
      path.join(REPO_ROOT, "app/server/seed/assets/operator.definition.md"),
      "utf8",
    );

  it("refreshes an UNEDITED copy of an older shipped version", async () => {
    const { seedDefaultAgentAssets } = await import("./default-assets.server");
    const dataRoot = freshStore();
    seedDefaultAgentAssets(dataRoot);
    expect(storeCopy(dataRoot)).toBe(shipped());

    // Roll the store back to a previous release's doctrine, exactly as that
    // release wrote it (its hash recorded in the manifest it maintained).
    const manifestPath = path.join(dataRoot, "state", "shipped-assets.json");
    const oldDoctrine = "---\nid: operator\n---\n\nCall assign_specialist, then prompt_specialist.\n";
    writeFileSync(path.join(dataRoot, OPERATOR_REL), oldDoctrine, "utf8");
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
    const { assetHash } = await import("./default-assets.server");
    manifest[OPERATOR_REL] = assetHash(oldDoctrine);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    seedDefaultAgentAssets(dataRoot);

    expect(storeCopy(dataRoot)).toBe(shipped());
    const after = manifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
    expect(after[OPERATOR_REL]).toBe(assetHash(shipped()));
  });

  it("never touches a copy a human edited", async () => {
    const { seedDefaultAgentAssets } = await import("./default-assets.server");
    const dataRoot = freshStore();
    seedDefaultAgentAssets(dataRoot);

    const edited = `${shipped()}\n\nOur team also always tags the on-call reviewer.\n`;
    writeFileSync(path.join(dataRoot, OPERATOR_REL), edited, "utf8");

    seedDefaultAgentAssets(dataRoot);
    expect(storeCopy(dataRoot)).toBe(edited);
  });

  /**
   * B7: preserving the edit is correct, but doing it SILENTLY is how the live
   * `./data` store ended up running an operator.md that matches no shipped
   * version and still names the deleted `prompt_specialist` /
   * `assign_specialist` tools. Boot must name the file and the drift.
   */
  it("WARNS that a diverged copy is being kept, naming the asset and both hashes", async () => {
    const { seedDefaultAgentAssets, assetHash } = await import(
      "./default-assets.server"
    );
    const dataRoot = freshStore();
    seedDefaultAgentAssets(dataRoot);

    // A copy that hashes to nothing this app ever shipped — the shape of the
    // real finding, not a hand-appended paragraph.
    const diverged = "---\nid: operator\n---\n\nCall assign_specialist, then prompt_specialist.\n";
    writeFileSync(path.join(dataRoot, OPERATOR_REL), diverged, "utf8");

    const warn = vi.spyOn(logger, "warn");
    try {
      seedDefaultAgentAssets(dataRoot);

      // Still preserved — the warning REPLACES silence, not the fail-safe.
      expect(storeCopy(dataRoot)).toBe(diverged);

      const call = warn.mock.calls.find(([, fields]) => {
        const warned = warnedAssetSchema.safeParse(fields);
        return warned.success && warned.data.asset === OPERATOR_REL;
      });
      expect(call, "no warning named the diverged asset").toBeDefined();
      const fields = divergenceFieldsSchema.parse(call![1]);
      expect(fields.onDisk).toBe(assetHash(diverged).slice(0, 12));
      expect(fields.shipped).toBe(assetHash(shipped()).slice(0, 12));
      expect(fields.path).toBe(path.join(dataRoot, OPERATOR_REL));
    } finally {
      warn.mockRestore();
    }
  });

  it("adopts a pre-manifest store that is already current, so the NEXT rewrite reaches it", async () => {
    const { seedDefaultAgentAssets, assetHash } = await import("./default-assets.server");
    const dataRoot = freshStore();
    // A store written by a build with no manifest: the file is there, the
    // bookkeeping is not.
    mkdirSync(path.dirname(path.join(dataRoot, OPERATOR_REL)), { recursive: true });
    writeFileSync(path.join(dataRoot, OPERATOR_REL), shipped(), "utf8");

    seedDefaultAgentAssets(dataRoot);

    const manifest = manifestSchema.parse(
      JSON.parse(
        readFileSync(path.join(dataRoot, "state", "shipped-assets.json"), "utf8"),
      ),
    );
    expect(manifest[OPERATOR_REL]).toBe(assetHash(shipped()));
  });

  it("recognizes the versions shipped before the manifest existed", async () => {
    const { PRIOR_SHIPPED_HASHES, shippedCopyIsUnedited } = await import(
      "./default-assets.server"
    );
    const known = PRIOR_SHIPPED_HASHES[OPERATOR_REL] ?? [];
    // The pre-pass-15 doctrine is in the list, so a store seeded from it — the
    // docker-data copy this finding was raised against — converges on boot.
    expect(known).toContain(
      "849d977503fe2a3b04776379b4017d40e50d95ed394770f28ef825e8513085d6",
    );
    expect(shippedCopyIsUnedited(OPERATOR_REL, known[0]!, {})).toBe(true);
    expect(shippedCopyIsUnedited(OPERATOR_REL, "f".repeat(64), {})).toBe(false);
    // The manifest is the other half: whatever this app last wrote counts.
    expect(shippedCopyIsUnedited(OPERATOR_REL, "a".repeat(64), {
      [OPERATOR_REL]: "a".repeat(64),
    })).toBe(true);
  });
});
