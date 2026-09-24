import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sha256Hex } from "~/server/files/content-hash.server";

/**
 * B06-T11 (pass 32): `tools/oxlint/anti-slop/` is a VENDORED copy of the
 * install-anti-slop skill's assets. Nothing pinned the two trees to each other,
 * so a local rule edit would silently fork the vendor copy and the next skill
 * re-run would overwrite it. Byte-identical, both directions.
 *
 * V11-7 (pass 32, DECIDED-NO-CHANGE): the vendored tree also ships an `effect/`
 * sub-plugin (`no-service-constructor-imports`) that `.oxlintrc.json` does not
 * register. That is deliberate — Viberr has no Effect services for the rule to
 * judge — and the file stays because the tree is vendored whole; registering a
 * rule that can never fire would be noise, deleting the file would fork the
 * vendor copy this test pins.
 *
 * The skill assets are a local developer tool (`.claude/skills/` is not part
 * of the repository), so the byte-identity half runs only where they exist.
 * Review F14 (pass 32): that made this a local-only pin, not a gate — so the
 * tree is ALSO held to a committed manifest (`tools/oxlint/anti-slop.manifest.json`,
 * written by `node scripts/anti-slop-manifest.mjs` after a skill refresh),
 * which runs everywhere: a local edit to a vendored rule fails CI until the
 * tree is re-pinned on purpose. The V11-7 half needs no source tree either.
 */
const ROOT = process.cwd();
const MANIFEST = path.join(ROOT, "tools", "oxlint", "anti-slop.manifest.json");
const manifestSchema = z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/));
const VENDORED = path.join(ROOT, "tools", "oxlint", "anti-slop");
const SOURCE = path.join(
  ROOT,
  ".claude",
  "skills",
  "install-anti-slop",
  "assets",
  "anti-slop",
);

function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, relPath));
    else out.push(relPath);
  }
  return out;
}

describe("tools/oxlint/anti-slop mirrors the install-anti-slop skill assets (B06-T11)", () => {
  const skillPresent = existsSync(SOURCE);

  it.skipIf(!skillPresent)("lists the same files", () => {
    expect(walk(VENDORED)).toEqual(walk(SOURCE));
  });

  it.skipIf(!skillPresent)("holds byte-identical content for every file", () => {
    for (const rel of walk(SOURCE)) {
      expect(
        readFileSync(path.join(VENDORED, rel), "utf8"),
        `${rel} drifted from the skill assets`,
      ).toBe(readFileSync(path.join(SOURCE, rel), "utf8"));
    }
  });

  it("matches the committed manifest, file for file (the CI gate)", () => {
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(MANIFEST, "utf8")));
    expect(walk(VENDORED)).toEqual(Object.keys(manifest).sort());
    for (const [rel, sha] of Object.entries(manifest)) {
      const actual = sha256Hex(readFileSync(path.join(VENDORED, rel)));
      expect(actual, `${rel} drifted from the manifest — re-pin with scripts/anti-slop-manifest.mjs`).toBe(sha);
    }
  });

  it("V11-7: the effect/ sub-plugin is vendored but intentionally unregistered", () => {
    expect(walk(VENDORED)).toContain(
      "effect/rules/no-service-constructor-imports.ts",
    );
    const rc = readFileSync(path.join(ROOT, ".oxlintrc.json"), "utf8");
    expect(rc).not.toContain("no-service-constructor-imports");
  });
});
