import { describe, expect, it } from "vitest";
import { engageStagesFor } from "./engage-stages";

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
const judges = { delivery: false, postsFiles: false };

/** As deployed there: each agent declared for its own stages. */
const DEPLOYED = [
  { name: "Writer", stages: ["brief", "writing"], spanAll: false, capabilities: makes },
  { name: "Diagrammer", stages: ["diagrams"], spanAll: false, capabilities: makes },
  { name: "Cover Designer", stages: ["cover"], spanAll: false, capabilities: makes },
  { name: "Editor", stages: ["review"], spanAll: false, capabilities: judges },
];

const supporting = [{ delivers: false }, { delivers: false }];

describe("ruling 702: the stages a task with no delivering agent may go back to", () => {
  it("BLOG-8 at Cover: the stages where an agent that cannot be engaged there can be, with who", () => {
    // Canary: return [] whenever the task has any engagement at all.
    expect(engageStagesFor(BOARD, { stage: "cover", engagements: supporting }, DEPLOYED)).toEqual([
      { stageId: "brief", agents: ["Writer"] },
      { stageId: "writing", agents: ["Writer"] },
      { stageId: "diagrams", agents: ["Diagrammer"] },
    ]);
  });

  it("offers nothing once the task has a delivering agent: it runs where the task stands (ruling 133)", () => {
    // Canary: drop the first line of the function.
    const engagements = [{ delivers: false }, { delivers: true }];
    expect(engageStagesFor(BOARD, { stage: "cover", engagements }, DEPLOYED)).toEqual([]);
  });

  it("offers only EARLIER stages: an agent declared further along is a forward move", () => {
    // At Writing the Diagrammer and the Cover Designer are ahead of the task,
    // and the Writer can be engaged where it stands.
    // Canary: scan every stage of the board instead of the ones before it.
    expect(engageStagesFor(BOARD, { stage: "writing", engagements: [] }, DEPLOYED)).toEqual([]);
  });

  it("an agent that can be engaged where the task stands is no reason to move", () => {
    // Canary: drop the `!eligibleAt(d, fm.stage)` half of the filter.
    const everywhere = DEPLOYED.map((d) =>
      d.name === "Writer" ? { ...d, stages: [], spanAll: true } : d,
    );
    expect(engageStagesFor(BOARD, { stage: "cover", engagements: [] }, everywhere)).toEqual([
      { stageId: "diagrams", agents: ["Diagrammer"] },
    ]);
    const undeclared = DEPLOYED.map((d) => (d.name === "Writer" ? { ...d, stages: [] } : d));
    expect(engageStagesFor(BOARD, { stage: "cover", engagements: [] }, undeclared)).toEqual([
      { stageId: "diagrams", agents: ["Diagrammer"] },
    ]);
  });

  it("an agent that cannot be given a delivery is no reason either", () => {
    // The Editor judges and saves nothing: a task past Review does not go back
    // there for it. Canary: drop the capability half of the filter.
    const board = {
      stages: [...BOARD.stages.slice(0, 5), { id: "publish" }, { id: "done" }],
      workflow: [
        ...BOARD.workflow.slice(0, 4),
        { from: "review", to: "publish" },
        { from: "publish", to: "done" },
      ],
    };
    const stages = engageStagesFor(board, { stage: "publish", engagements: [] }, DEPLOYED);
    expect(stages.map((s) => s.stageId)).toEqual(["brief", "writing", "diagrams", "cover"]);
    expect(stages.flatMap((s) => s.agents)).not.toContain("Editor");
  });

  it("a repository board: the developer declared for the work stage is reachable from Review", () => {
    const board = {
      stages: [{ id: "triage" }, { id: "impl" }, { id: "review" }, { id: "done" }],
      workflow: [
        { from: "triage", to: "impl" },
        { from: "impl", to: "review" },
        { from: "review", to: "done" },
      ],
    };
    const deployed = [
      { name: "Dev", stages: ["impl"], spanAll: false, capabilities: { delivery: true, postsFiles: false } },
    ];
    expect(engageStagesFor(board, { stage: "review", engagements: [] }, deployed)).toEqual([
      { stageId: "impl", agents: ["Dev"] },
    ]);
  });

  it("offers nothing at the first stage, at the terminal stage, or at a stage the board does not have", () => {
    for (const stage of ["brief", "done", "gone"]) {
      expect(engageStagesFor(BOARD, { stage, engagements: [] }, DEPLOYED)).toEqual([]);
    }
  });
});
