import type { DatabaseSync } from "node:sqlite";
import type { AgentRef, OperatorRef, Waiting } from "~/schemas/task-file.schema";
import type {
  AgentDeploymentView,
  DeploymentStatus,
  Engagement,
} from "~/features/agents/agent-types";
import { getProject } from "./board-query.server";

/**
 * Live agent-deployment projection (agents spec §3.3, orchestrator ruling 7):
 * engagement instances derived from task assignment records (operator /
 * specialist / reviewers in task_projections — PROFILE-ID keyed, never the
 * mock's `role.toLowerCase()` string coincidence) joined with agent_runs so
 * an engagement with a live run is honestly marked `running`.
 *
 * Status vocabulary is the mock's, derived from real waiting state
 * (contracts §2.4):
 *   operator   waiting=human → "packet open", else "coordinating"
 *   primary    waiting=agent → "working" · waiting=human → "waiting on
 *              human" · else "on call"
 *   reviewer always "anchored · on call"
 *
 * Done-stage tasks (the project's LAST stage) contribute nothing.
 */

interface DeploymentTaskRow {
  task_key: string;
  title: string;
  stage: string;
  waiting: Waiting;
  specialist_json: string | null;
  reviewers_json: string;
  operator_json: string | null;
}

interface RunningRunRow {
  task_key: string;
  kind: "operator" | "primary" | "reviewer";
  thread_id: string;
}

function operatorStatus(waiting: Waiting): DeploymentStatus {
  return waiting === "human" ? "packet open" : "coordinating";
}

function primaryStatus(waiting: Waiting): DeploymentStatus {
  if (waiting === "agent") return "working";
  if (waiting === "human") return "waiting on human";
  return "on call";
}

/** Reviewer thread ids index into reviewers[] — "r0", "r1", … for app-started
 *  runs, "c0", "c1", … for legacy/seed rows (both accepted). */
function reviewerIndex(threadId: string): number {
  const match = /^[rc](\d+)/.exec(threadId);
  return match ? Number(match[1]) : 0;
}

export function listAgentDeployments(
  db: DatabaseSync,
  projectSlug: string,
): AgentDeploymentView[] {
  const project = getProject(db, projectSlug);
  const lastStageId =
    project?.stages[project.stages.length - 1]?.id ?? "done";

  const tasks = db
    .prepare(
      `SELECT task_key, title, stage, waiting, specialist_json,
              reviewers_json, operator_json
         FROM task_projections
        WHERE project_slug = ?
        ORDER BY CAST(substr(task_key, instr(task_key, '-') + 1) AS INTEGER) ASC`,
    )
    .all(projectSlug) as unknown as DeploymentTaskRow[];

  const runningRows = db
    .prepare(
      `SELECT task_key, kind, thread_id
         FROM agent_runs
        WHERE project_slug = ? AND state = 'running'`,
    )
    .all(projectSlug) as unknown as RunningRunRow[];
  const running = new Map<string, Set<string>>();
  for (const row of runningRows) {
    const key =
      row.kind === "reviewer"
        ? `${row.task_key}·reviewer·${reviewerIndex(row.thread_id)}`
        : `${row.task_key}·${row.kind}`;
    if (!running.has(key)) running.set(key, new Set());
    running.get(key)!.add(row.thread_id);
  }
  const isRunning = (taskKey: string, engagement: Engagement, index = 0) =>
    running.has(
      engagement === "reviewer"
        ? `${taskKey}·reviewer·${index}`
        : `${taskKey}·${engagement}`,
    );

  const instances: AgentDeploymentView[] = [];
  for (const task of tasks) {
    if (task.stage === lastStageId) continue; // done tasks contribute nothing

    const operator = task.operator_json
      ? (JSON.parse(task.operator_json) as OperatorRef)
      : null;
    if (operator) {
      instances.push({
        profileId: "operator",
        role: "Operator",
        backend: null,
        engagement: "operator",
        taskKey: task.task_key,
        taskTitle: task.title,
        status: operatorStatus(task.waiting),
        running: isRunning(task.task_key, "operator"),
      });
    }

    const specialist = task.specialist_json
      ? (JSON.parse(task.specialist_json) as AgentRef)
      : null;
    if (specialist) {
      instances.push({
        profileId: specialist.profileId,
        role: specialist.role,
        backend: specialist.backend,
        engagement: "primary",
        taskKey: task.task_key,
        taskTitle: task.title,
        status: primaryStatus(task.waiting),
        running: isRunning(task.task_key, "primary"),
      });
    }

    const reviewers = JSON.parse(task.reviewers_json) as AgentRef[];
    reviewers.forEach((reviewer, index) => {
      instances.push({
        profileId: reviewer.profileId,
        role: reviewer.role,
        backend: reviewer.backend,
        engagement: "reviewer",
        taskKey: task.task_key,
        taskTitle: task.title,
        status: "anchored · on call",
        running: isRunning(task.task_key, "reviewer", index),
      });
    });
  }
  return instances;
}
