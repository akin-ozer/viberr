import { describe, expect, it } from "vitest";
import type { WorkRevision } from "~/schemas/task-file.schema";
import { engageStagesFor, hasDeliveringAgent, type EngageTaskState } from "./engage-stages";

/**
 * Ruling 702: where a task with no delivering agent may go back to so that one
 * can be engaged. Three callers share this answer (the operator's snapshot,
 * its move, and `transitionStage`), so the cases live here once.
 */

/** The board the finding came from (BLOG-8): two drawing stages between the
 *  writing and the review. */
const BOARD = {
  stages: [
    { id: "brief" },
    { id: "writing" },
    { id: "diagrams" },
    { id: "cover" },
    { id: "review" },
    { id: "done" },
  ],
  workflow: [
    { from: "brief", to: "writing" },
    { from: "writing", to: "diagrams" },
    { from: "diagrams", to: "cover" },
    { from: "cover", to: "review" },
    { from: "review", to: "done" },
  ],
};

const makes = { delivery: false, postsFiles: true };

/** As deployed there: each agent declared for its own stages. */
const DEPLOYED = [
  { id: "writer", name: "Writer", stages: ["brief", "writing"], spanAll: false, capabilities: makes },
  { id: "diagrammer", name: "Diagrammer", stages: ["diagrams"], spanAll: false, capabilities: makes },
  { id: "cover-designer", name: "Cover Designer", stages: ["cover"], spanAll: false, capabilities: makes },
  { id: "editor", name: "Editor", stages: ["review"], spanAll: false, capabilities: makes },
];
/** The project's rule there: the Editor's review is required at Review. */
const REQUIRED = [{ profileId: "editor" }];

const WRITER = { id: "writer", name: "Writer" };
const DIAGRAMMER = { id: "diagrammer", name: "Diagrammer" };

/** A task at `stage` that nobody delivers and that has delivered nothing. */
function task(stage: string, patch: Partial<EngageTaskState> = {}): EngageTaskState {
  return {
    stage,
    engagements: [
      { profileId: "diagrammer", delivers: false },
      { profileId: "cover-designer", delivers: false },
    ],
    blockedBy: [],
    recommendations: [],
    workRevision: null,
    deliveredAt: null,
    ...patch,
  };
}

const at = (stage: string, patch: Partial<EngageTaskState> = {}, deployed = DEPLOYED, required = REQUIRED) =>
  engageStagesFor(BOARD, task(stage, patch), deployed, required);

describe("ruling 702: the stages a task with no delivering agent may go back to", () => {
  it("BLOG-8 at Cover: the stages where an agent that cannot be engaged there can be, with who", () => {
    // Canary: return [] whenever the task has any engagement at all.
    expect(at("cover")).toEqual([
      { stageId: "brief", agents: [WRITER] },
      { stageId: "writing", agents: [WRITER] },
      { stageId: "diagrams", agents: [DIAGRAMMER] },
    ]);
  });

  it("offers nothing once the task has delivered anything: from then on a review decides the way back", () => {
    // A task approved and waiting to be accepted would otherwise be offered a
    // move that withdraws its offer. Canary: drop the first guard.
    expect(at("cover", { deliveredAt: "2026-10-08T15:03:04.630Z" })).toEqual([]);
    const revision: WorkRevision = {
      id: "rev_1",
      headSha: "a".repeat(40),
      treeSha: null,
      branch: null,
      createdAt: "2026-10-08T15:00:00.000Z",
      sourceProfileId: null,
    };
    expect(at("cover", { workRevision: revision })).toEqual([]);
    // A revision that was discarded is under nobody's review (ruling 161):
    // the task has delivered nothing again. Canary: read `workRevision`
    // without asking whether it is still active.
    const discarded: WorkRevision = { ...revision, kind: "discarded" };
    expect(at("cover", { workRevision: discarded }).map((s) => s.stageId)).toEqual(["brief", "writing", "diagrams"]);
  });

  it("offers nothing while an acceptance offer stands: a task can be acceptable with nothing delivered", () => {
    // The move would withdraw the offer a person is being asked about.
    // Canary: drop the `recommendations` guard.
    expect(at("cover", { recommendations: [{ kind: "accept_completion" }] })).toEqual([]);
    // Any other pending card is no reason to hold the entries back.
    expect(at("cover", { recommendations: [{ kind: "transition_stage" }] })).toHaveLength(3);
  });

  it("offers nothing while the task is held on other work: the hand-off would be refused", () => {
    // Canary: drop the `blockedBy` guard.
    expect(at("cover", { blockedBy: ["BLOG-7"] })).toEqual([]);
  });

  it("offers nothing once a delivering agent that can run is engaged, and offers it again when that agent is no longer deployed", () => {
    // Ruling 133 covers the first task: its deliverer runs where it stands.
    // The second names an agent nobody can dispatch.
    // Canary: count any engagement with `delivers`, deployed or not.
    const engagements = [{ profileId: "writer", delivers: true }];
    expect(at("cover", { engagements })).toEqual([]);
    expect(hasDeliveringAgent({ engagements }, DEPLOYED)).toBe(true);
    const gone = [{ profileId: "ghost-writer", delivers: true }];
    expect(at("cover", { engagements: gone }).map((s) => s.stageId)).toEqual(["brief", "writing", "diagrams"]);
    expect(hasDeliveringAgent({ engagements: gone }, DEPLOYED)).toBe(false);
  });

  it("offers only EARLIER stages: an agent declared further along is a forward move", () => {
    // At Writing the Diagrammer and the Cover Designer are ahead of the task,
    // and the Writer can be engaged where it stands.
    // Canary: scan every stage of the board instead of the ones before it.
    expect(at("writing", { engagements: [] })).toEqual([]);
  });

  it("an agent that can be engaged where the task stands is no reason to move", () => {
    // Canary: drop the `!eligibleAt(d, fm.stage)` half of the filter.
    const everywhere = DEPLOYED.map((d) => (d.id === "writer" ? { ...d, stages: [], spanAll: true } : d));
    expect(at("cover", {}, everywhere)).toEqual([{ stageId: "diagrams", agents: [DIAGRAMMER] }]);
    const undeclared = DEPLOYED.map((d) => (d.id === "writer" ? { ...d, stages: [] } : d));
    expect(at("cover", {}, undeclared)).toEqual([{ stageId: "diagrams", agents: [DIAGRAMMER] }]);
  });

  it("an agent that cannot be given a delivery is no reason either: no grant to save or commit, or the project's required reviewer", () => {
    // Past Review on a longer board, the Editor is declared for an earlier
    // stage. As the project's required reviewer it cannot deliver (ruling
    // 556), and a hand-off to it would be refused. Canary: drop that half of
    // the filter, and the Editor is offered at Review.
    const board = {
      stages: [...BOARD.stages.slice(0, 5), { id: "publish" }, { id: "done" }],
      workflow: [
        ...BOARD.workflow.slice(0, 4),
        { from: "review", to: "publish" },
        { from: "publish", to: "done" },
      ],
    };
    const publish = task("publish");
    const stages = (deployed = DEPLOYED, required = REQUIRED) =>
      engageStagesFor(board, publish, deployed, required).map((s) => s.stageId);
    expect(stages()).toEqual(["brief", "writing", "diagrams", "cover"]);
    // Not required by the project, it can be handed a delivery like anybody.
    expect(stages(DEPLOYED, [])).toEqual(["brief", "writing", "diagrams", "cover", "review"]);
    // Canary: drop the capability half, and an agent that can neither save a
    // file nor commit is offered.
    const judgesOnly = DEPLOYED.map((d) =>
      d.id === "editor" ? { ...d, capabilities: { delivery: false, postsFiles: false } } : d,
    );
    expect(stages(judgesOnly, [])).toEqual(["brief", "writing", "diagrams", "cover"]);
  });

  it("a repository board: the developer declared for the work stage is reachable from Review, by id or by structural role", () => {
    // The second board names its work stage `doing`; the profile declares
    // `impl`, which resolves there by role (R14-1).
    // Canary: match declared ids literally instead of through `stageEligible`.
    const commits = { delivery: true, postsFiles: false };
    const dev = [{ id: "developer", name: "Dev", stages: ["impl"], spanAll: false, capabilities: commits }];
    const nobody = { stage: "review", engagements: [], blockedBy: [], recommendations: [], workRevision: null, deliveredAt: null };
    const literal = {
      stages: [{ id: "triage" }, { id: "impl" }, { id: "review" }, { id: "done" }],
      workflow: [
        { from: "triage", to: "impl" },
        { from: "impl", to: "review" },
        { from: "review", to: "done" },
      ],
    };
    expect(engageStagesFor(literal, nobody, dev, [])).toEqual([
      { stageId: "impl", agents: [{ id: "developer", name: "Dev" }] },
    ]);
    const byRole = {
      stages: [{ id: "todo" }, { id: "doing" }, { id: "review" }, { id: "done" }],
      workflow: [
        { from: "todo", to: "doing" },
        { from: "doing", to: "review" },
        { from: "review", to: "done" },
      ],
    };
    expect(engageStagesFor(byRole, nobody, dev, [])).toEqual([
      { stageId: "doing", agents: [{ id: "developer", name: "Dev" }] },
    ]);
  });

  it("offers nothing at the first stage, at the terminal stage, or at a stage the board does not have", () => {
    // Canary: drop the terminal guard, or the guard on a stage not found.
    for (const stage of ["brief", "done", "gone"]) {
      expect(at(stage, { engagements: [] }), stage).toEqual([]);
    }
  });
});
