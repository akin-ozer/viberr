import { describe, expect, it } from "vitest";
import type { TaskSummary } from "~/shared/mapping/task.server";
import { toBoardCard } from "./board-card";

/** Only the fields `toBoardCard` reads; the rest of the summary is not its
 *  business, and a cast here would hide a field it starts to need. */
function summary(packet: TaskSummary["packet"]): TaskSummary & { quiet: boolean } {
  const base: Omit<TaskSummary, "packet"> & { quiet: boolean } = {
    projectSlug: "viberr-core",
    key: "VIB-1",
    title: "t",
    stage: "impl",
    readiness: "ready",
    displayReadiness: "ready",
    waiting: "human",
    waitingOnMe: false,
    liveRun: null,
    resumesAt: null,
    urgent: false,
    priority: "normal",
    labels: [],
    dueDate: null,
    blockedBy: [],
    archived: false,
    validation: "none",
    acceptance: null,
    continuity: null,
    blockReason: null,
    atAcceptanceBoundary: true,
    owner: null,
    specialist: null,
    reviewers: [],
    operator: null,
    branch: null,
    repo: null,
    pr: null,
    prChecks: null,
    prReview: null,
    workRevisionSha: null,
    commits: [],
    otherCommits: [],
    changed: null,
    unownedPr: null,
    foreignHead: null,
    goal: "",
    eventCount: 0,
    commentCount: 0,
    diagnosticCount: 0,
    createdAt: null,
    updatedAt: null,
    boardRank: null,
    filePath: "",
    quiet: false,
  };
  return { ...base, packet };
}

const PACKET = {
  type: "input" as const,
  kind: "Completion report",
  from: "Operator",
  title: "Ready to accept?",
  body: "",
  observations: [],
  options: [{ kind: "accept_completion" as const, t: "Accept VIB-1", d: "", rec: true }],
};

describe("ruling 316: the board card carries the option its acceptance answers", () => {
  it("ships `acceptAnswersWith` when the loader set it, and nothing extra when it did not", () => {
    // CANARY: slice the packet back to `{ type, title }` in toBoardCard and the
    // board's dialog says "Withdraws" about a decision its move answers.
    expect(toBoardCard(summary({ ...PACKET, acceptAnswersWith: "Accept VIB-1" })).packet).toEqual({
      type: "input",
      title: "Ready to accept?",
      acceptAnswersWith: "Accept VIB-1",
    });
    expect(toBoardCard(summary(PACKET)).packet).toEqual({ type: "input", title: "Ready to accept?" });
    expect(toBoardCard(summary(null)).packet).toBeNull();
  });
});
