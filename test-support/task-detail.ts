import type { TaskRunPrincipalView } from "~/features/task-detail/run-principal-view";
import type { TaskDetail } from "~/server/projections/task-query.server";
import type { AcceptanceAffordance } from "~/server/tasks/task-acceptance.server";
import type { TaskSummary } from "~/shared/mapping/task.server";

/**
 * VIB-151 as the task projection hands it over: open, undelivered, unowned and
 * waiting on its agent, with nothing pending, so no panel branches on a field
 * a fixture forgot. A test passes the fields its case is about.
 */
export function taskSummary(patch: Partial<TaskSummary> = {}): TaskSummary {
  return {
    projectSlug: "viberr-core",
    key: "VIB-151",
    title: "Compress long-running task timelines",
    stage: "review",
    readiness: "ready",
    displayReadiness: "ready",
    waiting: "agent",
    urgent: false,
    priority: "normal",
    labels: [],
    dueDate: null,
    blockedBy: [],
    archived: false,
    validation: "healthy",
    continuity: null,
    blockReason: null,
    atAcceptanceBoundary: false,
    owner: null,
    specialist: null,
    reviewers: [],
    operator: null,
    branch: "vib-151",
    repo: "akin-ozer/viberr",
    pr: null,
    prChecks: null,
    prReview: null,
    commits: [],
    otherCommits: [],
    changed: null,
    unownedPr: null,
    foreignHead: null,
    goal: "Keep the timeline readable on long tasks.",
    packet: null,
    eventCount: 0,
    commentCount: 0,
    diagnosticCount: 0,
    createdAt: null,
    updatedAt: null,
    boardRank: null,
    filePath: "projects/viberr-core/tasks/VIB-151/task.md",
    ...patch,
  };
}

/** The same task as the task page reads it: an empty timeline on three stages. */
export function taskDetail(patch: Partial<TaskDetail> = {}): TaskDetail {
  return {
    ...taskSummary(),
    timeline: [],
    diagnostics: [],
    stages: [
      { id: "triage", name: "Triage", color: "slate" },
      { id: "review", name: "Review", color: "blue" },
      { id: "done", name: "Done", color: "green" },
    ],
    workflow: [],
    lastActivityAt: null,
    quiet: false,
    ...patch,
  };
}

/** A run's principal: Arda Kaya (`u-arda`) with both backends connected (ruling 137). */
export function connectedPrincipal(patch: Partial<TaskRunPrincipalView> = {}): TaskRunPrincipalView {
  return {
    ownerUserId: "u-arda",
    ownerName: "Arda Kaya",
    claude: { available: true, detail: null },
    codex: { available: true, detail: null },
    ...patch,
  };
}

/** Acceptance at the review boundary for a viewer who may accept: nothing blocks
 *  it, an agent's verdict (not a person's GitHub approval, R19-B) cleared the
 *  verdict gate, and the project declares no gates. */
export function acceptanceAffordance(patch: Partial<AcceptanceAffordance> = {}): AcceptanceAffordance {
  return {
    hasAuthority: true,
    atBoundary: true,
    blockedReason: null,
    blockedGates: [],
    blockedReasonViaPacket: null,
    canAccept: true,
    terminallyBlocked: false,
    verdictSatisfiedBy: null,
    ...patch,
  };
}
