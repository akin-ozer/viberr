import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sha256Hex } from "~/server/files/content-hash.server";

/**
 * B06-T11 (pass 32): `tools/oxlint/anti-slop/` is a VENDORED copy of the
 * install-anti-slop skill's assets. A local rule edit would silently fork the
 * vendor copy, and the next skill re-run would overwrite it. Review F14
 * (pass 32): the tree is held to a committed manifest
 * (`tools/oxlint/anti-slop.manifest.json`, written by
 * `node scripts/anti-slop-manifest.mjs` after a skill refresh), which runs
 * everywhere: a local edit to a vendored rule fails until the tree is
 * re-pinned on purpose.
 */
const ROOT = process.cwd();
const MANIFEST = path.join(ROOT, "tools", "oxlint", "anti-slop.manifest.json");
const manifestSchema = z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/));
const VENDORED = path.join(ROOT, "tools", "oxlint", "anti-slop");

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

describe("tools/oxlint/anti-slop matches its committed manifest (B06-T11)", () => {
  it("matches the committed manifest, file for file (the CI gate)", () => {
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(MANIFEST, "utf8")));
    expect(walk(VENDORED)).toEqual(Object.keys(manifest).sort());
    for (const [rel, sha] of Object.entries(manifest)) {
      const actual = sha256Hex(readFileSync(path.join(VENDORED, rel)));
      expect(actual, `${rel} drifted from the manifest — re-pin with scripts/anti-slop-manifest.mjs`).toBe(sha);
    }
  });
});
