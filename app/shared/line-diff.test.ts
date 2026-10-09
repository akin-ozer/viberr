import { describe, expect, it } from "vitest";
import { changedSpans, diffSteps, type DiffStep } from "./line-diff";

/** Replays a script: the old list must come back from its `same`/`del` steps
 *  and the new one from its `same`/`add` steps, in order. */
function replay(a: readonly string[], b: readonly string[], steps: readonly DiffStep[]) {
  const old: string[] = [];
  const next: string[] = [];
  let i = 0;
  let j = 0;
  for (const step of steps) {
    if (step === "same") {
      expect(a[i]).toBe(b[j]);
      old.push(a[i++]!);
      next.push(b[j++]!);
    } else if (step === "del") old.push(a[i++]!);
    else next.push(b[j++]!);
  }
  return { old, next };
}

const cost = (steps: readonly DiffStep[]) => steps.filter((s) => s !== "same").length;

describe("ruling 168: diffSteps is the shortest edit script between two lists", () => {
  it("keeps what both share and names only the change", () => {
    const a = ["## Step 1", "", "4. Build", "5. builds: on", "tail"];
    const b = ["## Step 1", "", "4. Build", "5. builds: off", "tail"];
    expect(diffSteps(a, b)).toEqual(["same", "same", "same", "del", "add", "same"]);
  });

  it("finds the shortest script, not just any, through a changed middle", () => {
    // CANARY: drop the forward search (always delete all, then add all) and
    // this costs 12 steps instead of 4.
    const a = ["a", "b", "c", "d", "e", "f"];
    const b = ["a", "x", "c", "d", "y", "f"];
    const steps = diffSteps(a, b);
    expect(cost(steps)).toBe(4);
    expect(replay(a, b, steps)).toEqual({ old: a, next: b });
  });

  it("replays both sides exactly for insertions, deletions and a total rewrite", () => {
    const cases: [string[], string[]][] = [
      [[], ["new"]],
      [["gone"], []],
      [["a", "b"], ["b", "a"]],
      [["x", "y", "z"], ["p", "q"]],
      [["same", "same", "x"], ["same", "x", "same"]],
    ];
    for (const [a, b] of cases) {
      const steps = diffSteps(a, b);
      expect(replay(a, b, steps)).toEqual({ old: a, next: b });
    }
    expect(diffSteps(["a", "b"], ["b", "a"]).filter((s) => s !== "same")).toHaveLength(2);
  });

  it("past its caps, reads a large change as all of the old then all of the new", () => {
    // Two lists with nothing in common past the search's cost cap: a true
    // account, only not a searched one.
    const a = Array.from({ length: 700 }, (_, i) => `old ${i}`);
    const b = Array.from({ length: 700 }, (_, i) => `new ${i}`);
    const steps = diffSteps(a, b);
    expect(steps.slice(0, 700).every((s) => s === "del")).toBe(true);
    expect(steps.slice(700).every((s) => s === "add")).toBe(true);
    expect(replay(a, b, steps)).toEqual({ old: a, next: b });
  });
});

describe("ruling 168: changedSpans marks the words that changed in a paired line", () => {
  it("marks the changed words, joining a phrase across its spaces", () => {
    const before = "5. Non-production branch builds: on";
    const after = "5. Non-production branch builds: off (previews_enabled: false)";
    const spans = changedSpans(before, after)!;
    expect(spans.before.map(([s, e]) => before.slice(s, e))).toEqual(["on"]);
    expect(spans.after.map(([s, e]) => after.slice(s, e))).toEqual(["off (previews_enabled: false)"]);
  });

  it("marks a change of indentation, which a line tint alone would hide", () => {
    const spans = changedSpans("  return x;", "    return x;")!;
    expect(spans.before).toEqual([[0, 2]]);
    expect(spans.after).toEqual([[0, 4]]);
  });

  it("marks nothing on lines that share too little: a rewrite, not an edit", () => {
    // CANARY: drop the MIN_KEPT check and every word of both lines is marked.
    expect(
      changedSpans(
        "That connection does not exist yet.",
        "The Cloudflare API answers authenticated reads.",
      ),
    ).toBeNull();
  });

  it("reads words in any script, not only ASCII", () => {
    const spans = changedSpans("Dağıtım kılavuzu hazır", "Dağıtım kılavuzu güncel")!;
    expect(spans.before.map(([s, e]) => "Dağıtım kılavuzu hazır".slice(s, e))).toEqual(["hazır"]);
    expect(spans.after.map(([s, e]) => "Dağıtım kılavuzu güncel".slice(s, e))).toEqual(["güncel"]);
  });
});
