import type { CapabilityMode } from "~/schemas/project-file.schema";
import type { OperatorAuthority } from "~/server/tasks/operator-authority.server";
import type { OperatorTaskSnapshot } from "~/server/tasks/operator-snapshot.server";

/**
 * The task snapshot an operator prompt-byte test hands `buildOperatorTurnPrompt`
 * or `buildCodexOperatorPrompt`: VIB-1, ready at the work stage ("In Progress")
 * and waiting on nobody, with no owner, specialist, reviewer, packet, PR,
 * branch, live run or next stage.
 *
 * Pass only the fields the case is about. Each prompt describe used to copy
 * this literal whole, so a field added to `OperatorTaskSnapshot` was one edit
 * per copy; now the type checks this one.
 */
export function operatorSnapshot(
  over: Partial<OperatorTaskSnapshot> = {},
): OperatorTaskSnapshot {
  return {
    key: "VIB-1",
    // Ruling 302: the window's own size, always present.
    timelineTotal: 0,
    title: "Add the file listing",
    goal: "Ship the file-listing deliverable.",
    priority: "normal",
    labels: [],
    dueDate: null,
    blockedBy: [],
    stage: "impl",
    stageName: "In Progress",
    previousStage: null,
    readiness: "ready",
    waiting: "none",
    validation: "changed",
    owner: null,
    specialist: null,
    reviewers: [],
    nextStages: [],
    reworkStages: [],
    stageIds: ["triage", "impl", "review", "done"],
    doneStageId: "done",
    reviewStageId: "review",
    workStageId: "impl",
    deployedSpecialists: [],
    openPacket: false,
    packet: null,
    recentTimeline: [],
    pr: null,
    branch: null,
    liveRuns: [],
    autonomy: "supervised",
    operatorPolicy: { scope: "operator", note: "", capabilities: {} },
    ...over,
  };
}

/** A deployed Claude operator's resolved authority holding `policy`
 *  (capability → mode): supervised, on a board with no human gate before work,
 *  with no skills, knowledge bases or MCP servers. What a prompt or toolkit
 *  test hands in place of `resolveOperatorAuthority`; pass what the case is about. */
export function operatorAuthority(
  policy: Readonly<Record<string, CapabilityMode>> = {},
  patch: Partial<OperatorAuthority> = {},
): OperatorAuthority {
  return {
    policy: new Map(Object.entries(policy)),
    autonomy: "supervised",
    backend: "claude",
    model: "sonnet",
    effort: "",
    name: "Operator",
    skills: [],
    kb: [],
    mcps: [],
    persona: null,
    deployed: true,
    humanGatedBeforeWork: false,
    ...patch,
  };
}
