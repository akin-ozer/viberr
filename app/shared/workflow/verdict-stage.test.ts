import { describe, expect, it } from "vitest";
import type { Engagement } from "~/schemas/task-file.schema";
import { verdictStageFor } from "./verdict-stage";

/**
 * Ruling 163 (pass 35, F35-13): where a task whose revision changed after a
 * verdict goes back to. Three doors share this one answer (the operator's
 * backward move, a conflict packet's redirect, a delivery that moved the head),
 * and each of them is scoped by the plan to a task standing AT OR PAST the
 * review stage — which is the half the scan itself has to enforce, because the
 * delivery door writes the move without going through `transitionStage`.
 */

/** The observed board: a Validation stage sits between Implementation and
 *  Review, and Merge is the stage with the edge into Done. */
const BOARD = {
  stages: [
    { id: "triage" },
    { id: "design" },
    { id: "impl" },
    { id: "validation" },
    { id: "review" },
    { id: "merge" },
    { id: "done" },
  ],
  workflow: [
    { from: "triage", to: "design" },
    { from: "design", to: "impl" },
    { from: "impl", to: "validation" },
    { from: "validation", to: "review" },
    { from: "review", to: "merge" },
    { from: "merge", to: "done" },
  ],
};

/** The seeded reviewer profile's own declaration (agent-catalog.server.ts). */
const DEPLOYED = [
  { id: "reviewer", stages: ["impl", "review"], spanAll: false },
  { id: "developer", stages: ["impl"], spanAll: false },
];

const reviewer: Engagement = {
  profileId: "reviewer",
  backend: "claude",
  role: "Reviewer",
  delivers: false,
  verdictCapable: true,
};

describe("verdictStageFor: only a task at or past the review stage is returned", () => {
  it("moves nothing from a WORK stage, however the reviewers declared their stages", () => {
    // The scan walked backwards from ANY stage where no required reviewer was
    // eligible, so a delivery at Validation (reviewers declare `impl` and
    // `review`) moved the task BACK to Implementation — a stage that reviews
    // nothing, with no verdict in existence and no boundary check, on a
    // human's own Deliver click too.
    // CANARY: drop the `currentIndex < reviewIndex` guard and this returns
    // "impl".
    expect(
      verdictStageFor(BOARD, { stage: "validation", engagements: [reviewer] }, DEPLOYED),
    ).toBeNull();
    expect(
      verdictStageFor(BOARD, { stage: "design", engagements: [reviewer] }, DEPLOYED),
    ).toBeNull();
  });

  it("still returns the reviewers' stage from the acceptance boundary and past it", () => {
    // Merge is `reviewId` here (the edge into Done) and no reviewer is eligible
    // there, so the task goes back to Review — ruling 163's whole point.
    expect(
      verdictStageFor(BOARD, { stage: "merge", engagements: [reviewer] }, DEPLOYED),
    ).toBe("review");
    // Eligible where it stands: nothing to do.
    expect(
      verdictStageFor(BOARD, { stage: "review", engagements: [reviewer] }, DEPLOYED),
    ).toBeNull();
    // Terminal is an ending, never a return.
    expect(
      verdictStageFor(BOARD, { stage: "done", engagements: [reviewer] }, DEPLOYED),
    ).toBeNull();
  });

  it("with no reviewer deployed the structural boundary still answers past it, and never before", () => {
    expect(verdictStageFor(BOARD, { stage: "merge", engagements: [] }, [])).toBeNull();
    expect(
      verdictStageFor(
        BOARD,
        { stage: "done", engagements: [{ ...reviewer, profileId: "gone" }] },
        [],
      ),
    ).toBeNull();
    // A required reviewer that is not deployed leaves no specs: the structural
    // arm answers, and only from past the boundary.
    expect(
      verdictStageFor(
        BOARD,
        { stage: "validation", engagements: [{ ...reviewer, profileId: "gone" }] },
        [],
      ),
    ).toBeNull();
  });
});
