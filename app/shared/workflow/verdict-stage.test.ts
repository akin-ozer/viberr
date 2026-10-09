import { describe, expect, it } from "vitest";
import type { Engagement, ReviewVerdict, WorkRevision } from "~/schemas/task-file.schema";
import { verdictStageFor } from "./verdict-stage";

/**
 * Ruling 90 (pass 35, F35-13): where a task whose revision changed after a
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

/**
 * Ruling 90 (F37-29, live on SHOP-15). A board may declare required reviewers
 * at DIFFERENT stages — here a code reviewer at Review and an integration
 * verifier at Verify, which is exactly the shape the controller designed for
 * the shopify-clone board. Asking whether ANY required reviewer is eligible at
 * the current stage then answers for the wrong one: the verifier had approved
 * the delivered revision and is eligible at Verify, so the scan returned null,
 * `reworkStages` was empty, and `transitionStage` refused "No allowed
 * transition from Verify to Review" — leaving the task unable to reach the only
 * stage where the reviewer it is actually waiting on can run.
 */
describe("ruling 90: the reviewers who still OWE a verdict decide, not the ones who approved", () => {
  const TWO_STAGE_BOARD = {
    stages: [
      { id: "triage" },
      { id: "design" },
      { id: "build" },
      { id: "review" },
      { id: "verify" },
      { id: "done" },
    ],
    workflow: [
      { from: "triage", to: "design" },
      { from: "design", to: "build" },
      { from: "build", to: "review" },
      { from: "review", to: "verify" },
      { from: "verify", to: "done" },
    ],
  };
  const DEPLOYED_TWO = [
    { id: "code-reviewer", stages: ["build", "review"], spanAll: false },
    { id: "integration-verifier", stages: ["review", "verify"], spanAll: false },
  ];
  const engagement = (profileId: string): Engagement => ({
    profileId,
    backend: "codex",
    role: profileId,
    delivers: false,
    verdictCapable: true,
  });
  const rev: WorkRevision = {
    id: "rev_2",
    headSha: "b".repeat(40),
    treeSha: "c".repeat(40),
    branch: "shop-15",
    createdAt: "2026-09-13T16:40:00.000Z",
    sourceProfileId: "infra",
    kind: "delivered",
  };
  const approve = (profileId: string): ReviewVerdict => ({
    profileId,
    revisionId: rev.id,
    headSha: rev.headSha,
    result: "approve",
    reason: "ok",
    at: "2026-09-13T16:45:00.000Z",
    rounds: 1,
  });

  it("sends the task back to the stage the MISSING reviewer can run at", () => {
    // CANARY: ask `eligibleAt(fm.stage)` over ALL required reviewers (the
    // shipped rule) and this returns null — the verifier's own eligibility at
    // Verify answers for the code reviewer, and the task is stuck there.
    expect(
      verdictStageFor(
        TWO_STAGE_BOARD,
        {
          stage: "verify",
          engagements: [engagement("code-reviewer"), engagement("integration-verifier")],
          workRevision: rev,
          verdicts: [approve("integration-verifier")],
        },
        DEPLOYED_TWO,
      ),
    ).toBe("review");
  });

  it("moves nothing once every required reviewer has approved the current revision", () => {
    expect(
      verdictStageFor(
        TWO_STAGE_BOARD,
        {
          stage: "verify",
          engagements: [engagement("code-reviewer"), engagement("integration-verifier")],
          workRevision: rev,
          verdicts: [approve("integration-verifier"), approve("code-reviewer")],
        },
        DEPLOYED_TWO,
      ),
    ).toBeNull();
  });

  it("moves nothing while the reviewer that owes the verdict CAN run where the task stands", () => {
    // The verifier owes it and is eligible at Verify: the re-verdict happens
    // here, so there is no move to make. The old rule got this case right and
    // it must keep getting it right.
    expect(
      verdictStageFor(
        TWO_STAGE_BOARD,
        {
          stage: "verify",
          engagements: [engagement("code-reviewer"), engagement("integration-verifier")],
          workRevision: rev,
          verdicts: [approve("code-reviewer")],
        },
        DEPLOYED_TWO,
      ),
    ).toBeNull();
  });
});

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
    // there, so the task goes back to Review — ruling 90's whole point.
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
    // A stage standing past the review stage (its own edge into Done) is sent
    // back to it.
    const pastReview = {
      stages: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "done" }],
      workflow: [
        { from: "a", to: "b" },
        { from: "b", to: "done" },
        { from: "b", to: "c" },
        { from: "c", to: "done" },
      ],
    };
    expect(verdictStageFor(pastReview, { stage: "c", engagements: [] }, [])).toBe("b");
  });
});
