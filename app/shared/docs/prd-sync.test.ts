import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ruling 27 / R15-8 — `design/prd.md` is a MIRROR of the canon PRD, and both
 * are maintained.
 *
 * The rule has now failed twice by memory alone. Pass 15 found the two copies
 * diverged and re-synced them; pass 18 found them diverged AGAIN — pass-17's
 * FR14/FR20/FR27 amendments (the generic-agents vocabulary, R15-1's
 * verdict-gating, R16-6's "Done means two things") had landed only in canon, so
 * anyone reading `design/prd.md` was handed the pre-generic-agents model as
 * though it were current. The owner chose re-sync over retiring the mirror, so
 * the requirement stands — and "maintained" is pinned here as **byte-identical**
 * rather than trusted to whoever edits next.
 *
 * Edit the CANON copy; this test makes the mirror a mechanical follow-up
 * instead of a thing to remember.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const CANON = path.join(ROOT, "planning", "planning-artifacts", "prd.md");
const MIRROR = path.join(ROOT, "design", "prd.md");

describe("ruling 27: the two PRD copies stay in sync", () => {
  it("design/prd.md is byte-identical to the canon PRD", () => {
    const canon = readFileSync(CANON, "utf8");
    const mirror = readFileSync(MIRROR, "utf8");
    if (canon === mirror) {
      expect(mirror).toBe(canon);
      return;
    }
    // Name the diverging lines — the whole failure mode is that nobody could
    // see WHICH requirement had gone stale.
    const c = canon.split("\n");
    const m = mirror.split("\n");
    const diverged: string[] = [];
    for (let i = 0; i < Math.max(c.length, m.length); i += 1) {
      if (c[i] !== m[i]) {
        diverged.push(
          `line ${i + 1}: canon="${(c[i] ?? "<missing>").slice(0, 90)}" mirror="${(m[i] ?? "<missing>").slice(0, 90)}"`,
        );
      }
    }
    expect(
      diverged,
      `design/prd.md has drifted from planning/planning-artifacts/prd.md ` +
        `(ruling 27). Copy the canon file over the mirror:\n${diverged.slice(0, 10).join("\n")}`,
    ).toEqual([]);
  });
});
