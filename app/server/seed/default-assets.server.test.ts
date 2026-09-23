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

  it("pass 34 A19/A21: the operator doctrine says a hand-off is about who builds, never about stages, and its outgoing hash is recorded", async () => {
    // Canaries: revert the rework paragraph; remove the outgoing hash.
    const { shippedCopyIsUnedited } = await import("./default-assets.server");
    expect(shippedCopyIsUnedited(OPERATOR_REL, "dd42d1a7614df74f937519f53a0e9690affa0e0eb8a89da07d38cac4fc580752", {})).toBe(true);
    expect(shipped()).toContain("the deliverer owes the rework and it runs at EVERY stage");
    expect(shipped()).toContain("Never hand delivery to another profile to get around a stage.");
    expect(shipped()).not.toContain("does not work the CURRENT stage");
  });

  it("pass 34 A13: the operator doctrine shipped before `set_dependencies` is a recorded prior hash, so a live store upgrades in place", async () => {
    // Canary: remove the outgoing hash from PRIOR_SHIPPED_HASHES.
    const { shippedCopyIsUnedited } = await import("./default-assets.server");
    expect(shippedCopyIsUnedited(OPERATOR_REL, "9731f0a69b6a8b5824277c4d1a2d4ad18cc126c2ca827a844369f9f0ed9ef3f6", {})).toBe(true);
    expect(shipped()).toContain("`set_dependencies`");
  });

  it("pass 34 A14: the controller definition and guide shipped before `blockedBy` are recorded prior hashes, so both upgrade in place", async () => {
    // Canary: omit the skill's hash.
    const { shippedCopyIsUnedited } = await import("./default-assets.server");
    const path = await import("node:path");
    expect(shippedCopyIsUnedited(path.join("agents", "definitions", "controller.md"), "e600925f824e5ec43ca962c56304e5099ae76a1ad41dff8bc94a431666756712", {})).toBe(true);
    expect(shippedCopyIsUnedited(path.join("skills", "controller-guide", "SKILL.md"), "69805ce6bb7bd0180014e164ae6d863268813bd4fb6a0f61bfa4e333b6674608", {})).toBe(true);
  });

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

// ------------------------------------------------------------ ruling 121

describe("the controller doctrine and skill upgrade in place (ruling 121)", () => {
  const assetsDir = path.join(import.meta.dirname, "assets");

  it("lists the outgoing versions of both files, so an unedited store copy is refreshed at boot", async () => {
    const { PRIOR_SHIPPED_HASHES, shippedCopyIsUnedited, assetHash } = await import(
      "./default-assets.server"
    );
    const definitionRel = path.join("agents", "definitions", "controller.md");
    const skillRel = path.join("skills", "controller-guide", "SKILL.md");
    expect(PRIOR_SHIPPED_HASHES[definitionRel]).toContain(
      "8dcb2d1bb8f3668bcc9337af2d07be196ed704b66d70b699b2ac55e39ebf258c",
    );
    expect(PRIOR_SHIPPED_HASHES[skillRel]).toContain(
      "a2defe42d6fb6a5eed063a1e7b9bb9b5636c1619c1f5ea0f6e56838b9628fecd",
    );
    for (const [rel, hashes] of [
      [definitionRel, PRIOR_SHIPPED_HASHES[definitionRel]!],
      [skillRel, PRIOR_SHIPPED_HASHES[skillRel]!],
    ] as const) {
      for (const hash of hashes) expect(shippedCopyIsUnedited(rel, hash, {})).toBe(true);
    }
    // The shipped text is NEW: neither outgoing hash is the current one.
    const definition = readFileSync(path.join(assetsDir, "controller.definition.md"), "utf8");
    const skill = readFileSync(path.join(assetsDir, "controller-guide.skill.md"), "utf8");
    expect(PRIOR_SHIPPED_HASHES[definitionRel]).not.toContain(assetHash(definition));
    expect(PRIOR_SHIPPED_HASHES[skillRel]).not.toContain(assetHash(skill));
  });

  /**
   * Review finding 33: the assertions above compare the constant with its own
   * literals, which a WRONG hash would pass while every existing store kept
   * the stale doctrine forever. The historical bytes cannot be re-derived once
   * this change is committed (HEAD would hold the new text, and CI clones at
   * depth 1), so what is asserted here is the MECHANISM the hash list feeds:
   * a store copy this app is recorded as having written is really replaced by
   * the shipped one, for the two ruling-121 assets specifically.
   */
  it("upgrades a recorded copy of the controller doctrine and skill in place", async () => {
    const { seedDefaultAgentAssets, assetHash } = await import("./default-assets.server");
    const definitionRel = path.join("agents", "definitions", "controller.md");
    const skillRel = path.join("skills", "controller-guide", "SKILL.md");
    const shipped = {
      [definitionRel]: readFileSync(path.join(assetsDir, "controller.definition.md"), "utf8"),
      [skillRel]: readFileSync(path.join(assetsDir, "controller-guide.skill.md"), "utf8"),
    };
    const root = mkdtempSync(path.join(tmpdir(), "viberr-ctl-upgrade-"));
    roots.push(root);
    const manifest: Record<string, string> = {};
    for (const rel of [definitionRel, skillRel]) {
      const older = `# an older shipped ${rel}\n`;
      const dest = path.join(root, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, older, "utf8");
      // What the app recorded when it last wrote that file — the same claim
      // every entry in PRIOR_SHIPPED_HASHES makes about a released version.
      manifest[rel] = assetHash(older);
    }
    mkdirSync(path.join(root, "state"), { recursive: true });
    writeFileSync(
      path.join(root, "state", "shipped-assets.json"),
      JSON.stringify(manifest),
      "utf8",
    );

    seedDefaultAgentAssets(root);

    for (const rel of [definitionRel, skillRel]) {
      expect(readFileSync(path.join(root, rel), "utf8")).toBe(shipped[rel]);
    }
    // A copy the app never wrote is still left alone.
    writeFileSync(path.join(root, definitionRel), "# mine now\n", "utf8");
    seedDefaultAgentAssets(root);
    expect(readFileSync(path.join(root, definitionRel), "utf8")).toBe("# mine now\n");
  });

  it("names the tools that exist and the context read, and no longer a comment that starts runs", () => {
    const definition = readFileSync(path.join(assetsDir, "controller.definition.md"), "utf8");
    const skill = readFileSync(path.join(assetsDir, "controller-guide.skill.md"), "utf8");
    for (const text of [definition, skill]) {
      expect(text).not.toContain("list_projects");
      expect(text).toContain("`whoami`");
      expect(text).toContain("update_task");
    }
    expect(definition).toContain("context block the server gathered when the turn started");
    expect(definition).toContain("A comment never starts a run by itself");
    expect(skill).toContain("## The context you are handed");
  });
});

/**
 * Ruling 134 (pass 34, F34-11): the shipped operator doctrine says that
 * rework on an open PR is delivered with `deliver_for_review`, and that
 * pushing is never a person's or an agent's job. The outgoing sha256 is
 * listed so an unedited store copy upgrades at boot.
 *
 * Canary: revert the persona sentence (or drop the outgoing hash) and the
 * matching assertion fails.
 */
describe("the operator doctrine upgrade in place (ruling 134)", () => {
  const assetsDir = path.join(import.meta.dirname, "assets");
  it("carries the rework-delivery sentence and lists its outgoing version", async () => {
    const { PRIOR_SHIPPED_HASHES, assetHash } = await import("./default-assets.server");
    const definition = readFileSync(path.join(assetsDir, "operator.definition.md"), "utf8");
    expect(definition).toContain("shows `pr.unpushedRevision`, call `deliver_for_review`");
    expect(definition).toContain("Pushing is never a person's job and never an agent's.");
    expect(definition).not.toMatch(/[–—]/);
    const rel = path.join("agents", "definitions", "operator.md");
    expect(PRIOR_SHIPPED_HASHES[rel]).toContain(
      "9462381afd6c87b991f5653610252ac2e7a4815b039709d818bbecec1db7532e",
    );
    expect(PRIOR_SHIPPED_HASHES[rel]).not.toContain(assetHash(definition));
  });
});

/**
 * Ruling 437 (F39-60): the operator's app skill told it to resolve any packet
 * that had become moot. `resolve_packet` refuses every packet the operator did
 * not raise, and operators planned it on agents' questions twice in half an
 * hour. The skill now draws the same line as the snapshot and the refusal.
 *
 * CANARY: restore "If a packet becomes moot because its input arrived another
 * way, resolve it." with no qualification.
 */
describe("ruling 437: the app skill says whose packets the operator may resolve", () => {
  const skill = readFileSync(
    path.join(import.meta.dirname, "assets/viberr-app-expertise.skill.md"),
    "utf8",
  );
  it("scopes the moot-packet rule to the operator's own packets and names `packet.yours`", () => {
    expect(skill).toContain("If a packet you raised becomes moot");
    expect(skill).toContain("`packet.yours: false` in `get_task`");
    expect(skill).not.toMatch(/If a packet becomes moot because/);
  });
});
