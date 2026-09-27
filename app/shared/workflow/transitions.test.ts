import { describe, expect, it } from "vitest";
import type { WorkflowBoundary } from "~/schemas/project-file.schema";
import { GOVERNED_TEMPLATE } from "./templates";
import {
  defaultTransitionBy,
  realignChainToStages,
  rejoinChainAroundStage,
  spliceStageIntoChain,
  stageFlowPath,
} from "./transitions";

/**
 * P13-D-1 — the transition chain. Before this, `frontmatter.workflow` had no
 * create path at all: adding a stage produced a board column no rule reached,
 * so `transitionStage` refused it except as a manual admin move and the
 * operator's `nextStages` (built purely from `workflow`) was empty for it.
 *
 * Every case here asserts the two structural invariants as well as the specific
 * rewrite: the chain covers every consecutive stage pair (so the terminal stage
 * stays reachable and nothing is stranded), and no rule points at a stage that
 * does not exist.
 */

type Stage = { id: string };

const stages = (...ids: string[]): Stage[] => ids.map((id) => ({ id }));

function rule(
  from: string,
  to: string,
  boundary: "auto" | "approval" | "human",
  extra: Partial<WorkflowBoundary> = {},
): WorkflowBoundary {
  return {
    from,
    to,
    boundary,
    by: `${from}->${to}`,
    locked: boundary === "human" && to === "done",
    ...extra,
  };
}

/** [from, to, boundary] triples — the readable shape for table assertions. */
const edges = (workflow: readonly WorkflowBoundary[]) =>
  workflow.map((w) => [w.from, w.to, w.boundary] as const);

/** The chain invariant: one rule per consecutive pair, no dangling endpoints. */
function expectWellFormedChain(
  stageList: readonly Stage[],
  workflow: readonly WorkflowBoundary[],
): void {
  const ids = new Set(stageList.map((s) => s.id));
  for (const w of workflow) {
    expect(ids.has(w.from), `dangling from: ${w.from}`).toBe(true);
    expect(ids.has(w.to), `dangling to: ${w.to}`).toBe(true);
  }
  for (let i = 1; i < stageList.length; i += 1) {
    const from = stageList[i - 1]!.id;
    const to = stageList[i]!.id;
    expect(
      workflow.some((w) => w.from === from && w.to === to),
      `missing chain edge ${from} → ${to}`,
    ).toBe(true);
  }
  // No stage stranded: everything but the entry has an in-edge, everything but
  // the terminal has an out-edge.
  for (const [i, s] of stageList.entries()) {
    if (i > 0) expect(workflow.some((w) => w.to === s.id)).toBe(true);
    if (i < stageList.length - 1) {
      expect(workflow.some((w) => w.from === s.id)).toBe(true);
    }
  }
}

const GOVERNED_STAGES = stages("triage", "ready", "impl", "review", "done");
const GOVERNED_WORKFLOW = GOVERNED_TEMPLATE.workflow;

describe("spliceStageIntoChain", () => {
  it("the preset's 4 rules round-trip untouched when nothing is inserted", () => {
    const out = spliceStageIntoChain(GOVERNED_STAGES, GOVERNED_WORKFLOW, "nope");
    expect(out).toEqual(GOVERNED_WORKFLOW);
  });

  it("addStage's real insert point (before the terminal stage) wires both halves", () => {
    // Exactly what addStage does: splice at stages.length - 1.
    const next = stages("triage", "ready", "impl", "review", "qa", "done");
    const out = spliceStageIntoChain(next, GOVERNED_WORKFLOW, "qa");

    expect(edges(out)).toEqual([
      ["triage", "ready", "auto"],
      ["ready", "impl", "auto"],
      ["impl", "review", "approval"],
      // review→done (human, locked) is replaced IN PLACE by the two halves.
      ["review", "qa", "human"],
      ["qa", "done", "human"],
    ]);
    expectWellFormedChain(next, out);

    // Governance did not loosen: the human gate that guarded the hop is on
    // both halves. Only the edge that still ends at the terminal stage stays
    // locked — a lock on review→qa would disable a control the server is
    // perfectly willing to change.
    const [reviewToQa, qaToDone] = out.slice(3);
    expect(reviewToQa!.locked).toBe(false);
    expect(qaToDone!.locked).toBe(true);
    // The outgoing half keeps the replaced rule's copy (same destination, same
    // decision); the new decision point gets generated copy.
    expect(qaToDone!.by).toBe("Human acceptance of the completion report");
    expect(reviewToQa!.by).toBe(defaultTransitionBy("human"));
  });

  const midTable = ["auto", "approval", "human"] as const;
  for (const boundary of midTable) {
    it(`a mid-chain insert inherits the replaced ${boundary} boundary on both halves`, () => {
      const before = [
        rule("triage", "ready", boundary),
        rule("ready", "impl", "auto"),
        rule("impl", "done", "human"),
      ];
      const next = stages("triage", "new", "ready", "impl", "done");
      const out = spliceStageIntoChain(next, before, "new");
      expect(edges(out).slice(0, 2)).toEqual([
        ["triage", "new", boundary],
        ["new", "ready", boundary],
      ]);
      expect(out).toHaveLength(before.length + 1);
      expectWellFormedChain(next, out);
    });
  }

  it("inserting at the head wires the single adjacent edge", () => {
    const next = stages("intake", "triage", "ready", "impl", "review", "done");
    const out = spliceStageIntoChain(next, GOVERNED_WORKFLOW, "intake");
    expect(edges(out)[0]).toEqual(["intake", "triage", "approval"]);
    expect(out).toHaveLength(5);
    expectWellFormedChain(next, out);
  });

  it("inserting at the tail makes the new stage terminal: human + locked, and the old lock is released", () => {
    const next = stages("triage", "ready", "impl", "review", "done", "archive");
    const out = spliceStageIntoChain(next, GOVERNED_WORKFLOW, "archive");
    expect(edges(out)).toEqual([
      ["triage", "ready", "auto"],
      ["ready", "impl", "auto"],
      ["impl", "review", "approval"],
      ["review", "done", "human"],
      ["done", "archive", "human"],
    ]);
    // review→done no longer ends the board, so its lock goes; the new terminal
    // edge is forced human + locked.
    expect(out[3]!.locked).toBe(false);
    expect(out[4]!.locked).toBe(true);
    expectWellFormedChain(next, out);
  });

  it("wires the stage in even when the chain was already broken (no prev→next rule)", () => {
    const broken = [rule("triage", "ready", "auto")]; // impl/review/done unwired
    const next = stages("triage", "ready", "impl", "new", "done");
    const out = spliceStageIntoChain(next, broken, "new");
    expect(edges(out)).toEqual([
      ["triage", "ready", "auto"],
      ["impl", "new", "approval"],
      ["new", "done", "human"],
    ]);
  });

  it("a single-stage board grows its first rule, forced human into the terminal", () => {
    const next = stages("new", "done");
    const out = spliceStageIntoChain(next, [], "new");
    expect(edges(out)).toEqual([["new", "done", "human"]]);
    expect(out[0]!.locked).toBe(true);
  });
});

describe("rejoinChainAroundStage", () => {
  it("re-joins the neighbours with the STRICTER of the two boundaries it replaces", () => {
    const before = [
      rule("triage", "ready", "auto"),
      rule("ready", "signoff", "approval"), // the gate being collapsed
      rule("signoff", "impl", "auto"),
      rule("impl", "done", "human"),
    ];
    const out = rejoinChainAroundStage(
      stages("triage", "ready", "signoff", "impl", "done"),
      before,
      "signoff",
    );
    expect(edges(out)).toEqual([
      ["triage", "ready", "auto"],
      // approval survives the collapse — removing a column must not delete a
      // governance checkpoint as a side effect.
      ["ready", "impl", "approval"],
      ["impl", "done", "human"],
    ]);
    // `by` follows the edge whose boundary won.
    expect(out[1]!.by).toBe("ready->signoff");
    expectWellFormedChain(stages("triage", "ready", "impl", "done"), out);
  });

  const strictnessTable = [
    { inB: "auto", outB: "auto", merged: "auto", by: "x->b" },
    { inB: "auto", outB: "approval", merged: "approval", by: "x->b" },
    { inB: "approval", outB: "auto", merged: "approval", by: "a->x" },
    { inB: "human", outB: "auto", merged: "human", by: "a->x" },
    { inB: "auto", outB: "human", merged: "human", by: "x->b" },
    { inB: "human", outB: "approval", merged: "human", by: "a->x" },
    // Tie → the OUT edge's copy: the merged rule still ends where it ended.
    { inB: "approval", outB: "approval", merged: "approval", by: "x->b" },
    { inB: "human", outB: "human", merged: "human", by: "x->b" },
  ] as const;
  for (const { inB, outB, merged, by } of strictnessTable) {
    it(`${inB} + ${outB} collapses to ${merged}`, () => {
      const out = rejoinChainAroundStage(
        stages("a", "x", "b", "done"),
        [rule("a", "x", inB), rule("x", "b", outB), rule("b", "done", "human")],
        "x",
      );
      expect(edges(out)[0]).toEqual(["a", "b", merged]);
      expect(out[0]!.by).toBe(by);
    });
  }

  it("leaves no orphan rule pointing at the removed stage", () => {
    const before = [
      rule("triage", "ready", "auto"),
      rule("ready", "impl", "auto"),
      rule("impl", "review", "approval"),
      rule("review", "done", "human"),
      // A non-adjacent rule into the doomed stage (hand-edited file).
      rule("triage", "impl", "auto"),
    ];
    const out = rejoinChainAroundStage(GOVERNED_STAGES, before, "impl");
    expect(out.some((w) => w.from === "impl" || w.to === "impl")).toBe(false);
    expect(edges(out)).toEqual([
      ["triage", "ready", "auto"],
      ["ready", "review", "approval"],
      ["review", "done", "human"],
    ]);
    expectWellFormedChain(stages("triage", "ready", "review", "done"), out);
  });

  it("does not duplicate an edge the graph already has", () => {
    const before = [
      rule("a", "x", "human"),
      rule("x", "b", "auto"),
      rule("a", "b", "auto"),
    ];
    const out = rejoinChainAroundStage(stages("a", "x", "b"), before, "x");
    expect(edges(out)).toEqual([["a", "b", "auto"]]);
  });

  it("removing the stage before the terminal keeps Done human-gated and locked", () => {
    const out = rejoinChainAroundStage(
      GOVERNED_STAGES,
      [...GOVERNED_WORKFLOW],
      "review",
    );
    const last = out.at(-1)!;
    expect([last.from, last.to, last.boundary]).toEqual([
      "impl",
      "done",
      "human",
    ]);
    expect(last.locked).toBe(true);
    expectWellFormedChain(stages("triage", "ready", "impl", "done"), out);
  });

  it("is a no-op for a stage the board does not have", () => {
    const out = rejoinChainAroundStage(GOVERNED_STAGES, GOVERNED_WORKFLOW, "zzz");
    expect(out).toEqual(GOVERNED_WORKFLOW);
  });
});

describe("realignChainToStages", () => {
  it("is a no-op on an already-aligned chain", () => {
    expect(realignChainToStages(GOVERNED_STAGES, GOVERNED_WORKFLOW)).toEqual(
      GOVERNED_WORKFLOW,
    );
  });

  it("re-points the chain at the new column order, each stage keeping the gate that guarded ENTRY into it", () => {
    // The admin drags Review to the front of the middle.
    const reordered = stages("triage", "review", "impl", "ready", "done");
    const out = realignChainToStages(reordered, GOVERNED_WORKFLOW);
    expect(edges(out)).toEqual([
      ["triage", "review", "approval"], // review was entered by approval
      ["review", "impl", "auto"], // impl was entered by auto
      ["impl", "ready", "auto"], // ready was entered by auto
      ["ready", "done", "human"], // done stays human…
    ]);
    expect(out.at(-1)!.locked).toBe(true); // …and locked
    expect(out.at(-1)!.by).toBe("Human acceptance of the completion report");
    expectWellFormedChain(reordered, out);
  });

  it("drops rules that are no longer consecutive pairs (narrows, never widens)", () => {
    const before = [
      rule("a", "b", "auto"),
      rule("b", "c", "auto"),
      rule("a", "c", "auto"), // skip edge
    ];
    const out = realignChainToStages(stages("a", "b", "c"), before);
    expect(edges(out)).toEqual([
      ["a", "b", "auto"],
      ["b", "c", "auto"],
    ]);
  });

  it("a board with fewer than two stages has no transitions", () => {
    expect(realignChainToStages(stages("only"), GOVERNED_WORKFLOW)).toEqual([]);
  });
});

describe("stageFlowPath", () => {
  it("walks the real rules, not stage order", () => {
    // Columns say triage, review, impl, ready, done; the RULES still describe
    // the governed path. The map must draw the rules.
    const scrambled = stages("triage", "review", "impl", "ready", "done");
    expect(stageFlowPath(scrambled, GOVERNED_WORKFLOW)).toEqual({
      chain: ["triage", "ready", "impl", "review", "done"],
      offChain: [],
    });
  });

  it("reports a stage no rule reaches instead of drawing it mid-flow", () => {
    const withOrphan = stages("triage", "ready", "impl", "review", "qa", "done");
    expect(stageFlowPath(withOrphan, GOVERNED_WORKFLOW)).toEqual({
      chain: ["triage", "ready", "impl", "review", "done"],
      offChain: ["qa"],
    });
  });

  it("terminates on a cycle", () => {
    const cyclic = [rule("a", "b", "auto"), rule("b", "a", "auto")];
    expect(stageFlowPath(stages("a", "b"), cyclic)).toEqual({
      chain: ["a", "b"],
      offChain: [],
    });
  });

  it("an empty board yields an empty map", () => {
    expect(stageFlowPath([], [])).toEqual({ chain: [], offChain: [] });
  });
});
