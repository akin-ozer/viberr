import type { DatabaseSync } from "node:sqlite";
import type { AgentRef, OperatorRef, Waiting } from "~/schemas/task-file.schema";
import type {
  AgentDeploymentView,
  DeploymentStatus,
  Engagement,
} from "~/features/agents/agent-types";
import { getProject } from "./board-query.server";
import { deployedSpecialistBackends } from "~/server/agents/deployment-view.server";

/**
 * Live agent-deployment projection (agents spec §3.3, orchestrator ruling 7):
 * engagement instances derived from task assignment records (operator /
 * specialist / reviewers in task_projections — PROFILE-ID keyed, never the
 * mock's `role.toLowerCase()` string coincidence) joined with agent_runs so
 * an engagement with a live run is honestly marked `running`.
 *
 * Status vocabulary is the mock's, derived from real waiting state
 * (contracts §2.4):
 *   operator   waiting=human → "packet open" WITH a packet, else "waiting on
 *              human" · else "coordinating"
 *   primary    waiting=agent → "working" · waiting=human → "waiting on
 *              human" · else "on call"
 *   reviewer always "anchored · on call"
 *
 * Done-stage tasks (the project's LAST stage) contribute nothing.
 */

type DeploymentTaskRow = {
  task_key: string;
  title: string;
  stage: string;
  waiting: Waiting;
  specialist_json: string | null;
  reviewers_json: string;
  operator_json: string | null;
  /** 1 when this task carries an open decision packet (the same predicate
   *  decisions.server.ts and home-query.server.ts use). */
  has_packet: number;
};

type RunningRunRow = {
  task_key: string;
  kind: "operator" | "primary" | "reviewer";
  thread_id: string;
};

/**
 * UXV19-7: this derived the label from `waiting` ALONE — every operator on a
 * human-waiting task was reported "packet open".
 *
 * Human-waiting is not the same as packet-present, and two server modules say
 * so in as many words: review-queue.server.ts ("a review-stage task waiting on
 * a human can have no packet/recommendation … yet still need a human to accept
 * it") and decisions.server.ts (B-FD5, "acceptance-ready review-stage tasks —
 * the class that carries no decision OBJECT"). The roster was the only surface
 * naming an ARTIFACT where every other names the STATE — board "waiting on a
 * human", queue "needs a human decision", task page "Waiting on: Human
 * decision" — and it is the only one of the four that can be false: clicking
 * that row lands on a task page whose Decision packet section does not render,
 * while the Decisions surfaces simultaneously list nothing for it. Any
 * non-terminal stage whose operator turn ends without opening a packet hits
 * this, not just Review.
 *
 * The state-named fallback is the vocabulary the rest of the app already uses
 * (and `primaryStatus`'s own human-waiting label), so the page-level "agent
 * threads waiting on a human" stat — which counts BOTH — stays exactly as
 * honest as it was.
 */
function operatorStatus(waiting: Waiting, hasPacket: boolean): DeploymentStatus {
  if (waiting !== "human") return "coordinating";
  return hasPacket ? "packet open" : "waiting on human";
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
  /** Data root for the live-backend overlay — tests only (production defaults
   *  to the env root, same as every file accessor). */
  opts: { dataRoot?: string } = {},
): AgentDeploymentView[] {
  const project = getProject(db, projectSlug);
  const lastStageId =
    project?.stages[project.stages.length - 1]?.id ?? "done";
  // The engagement rows chip a backend RIGHT under the profile card where a
  // human edits it — showing the engage-time snapshot there meant switching a
  // profile to Claude left its own roster row chipping Codex until the next
  // run healed the snapshot. Same live overlay as the task queries: the
  // deployment's current backend wins, an undeployed profile keeps the
  // snapshot (the run path's own fallback).
  const liveBackends = deployedSpecialistBackends(projectSlug, opts.dataRoot);
  const liveBackend = (ref: AgentRef): "codex" | "claude" =>
    liveBackends.get(ref.profileId) ?? ref.backend;

  // SAFETY: the SELECT names exactly DeploymentTaskRow's members, and
  // 0001_baseline declares every one of them NOT NULL on `task_projections`
  // except `specialist_json`/`operator_json` (typed nullable here); `waiting`
  // is CHECK-constrained to the three Waiting values, and `has_packet` is the
  // CASE expression's own 1/0.
  const tasks = db
    .prepare(
      `SELECT task_key, title, stage, waiting, specialist_json,
              reviewers_json, operator_json,
              (CASE WHEN packet_json IS NOT NULL AND packet_json <> ''
                    THEN 1 ELSE 0 END) AS has_packet
         FROM task_projections
        -- R14-3: an archived task is out of the flow, so its engagement must not
        -- keep showing under a profile's "Active deployments" (P14-RV-03).
        WHERE project_slug = ? AND archived = 0
        ORDER BY CAST(substr(task_key, instr(task_key, '-') + 1) AS INTEGER) ASC`,
    )
    .all(projectSlug) as DeploymentTaskRow[];

  // SAFETY: the SELECT names three `agent_runs` columns 0001_baseline declares
  // NOT NULL, and its CHECK restricts `kind` to exactly the three values
  // RunningRunRow lists.
  const runningRows = db
    .prepare(
      `SELECT task_key, kind, thread_id
         FROM agent_runs
        WHERE project_slug = ? AND state = 'running'`,
    )
    .all(projectSlug) as RunningRunRow[];
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

    // SAFETY: `operator_json` has ONE writer — the rebuilder stores
    // `fm.operator ? JSON.stringify(fm.operator) : null`, and `fm.operator` is
    // `operatorRefSchema.nullable()` output. The same holds for the specialist
    // and reviewer columns below, which the rebuilder fills from the file's
    // (schema-parsed) engagements; AgentRef is the subset this roster reads.
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
        status: operatorStatus(task.waiting, task.has_packet === 1),
        running: isRunning(task.task_key, "operator"),
      });
    }

    // SAFETY: see the operator note above — same writer, same guarantee.
    const specialist = task.specialist_json
      ? (JSON.parse(task.specialist_json) as AgentRef)
      : null;
    if (specialist) {
      instances.push({
        profileId: specialist.profileId,
        role: specialist.role,
        backend: liveBackend(specialist),
        engagement: "primary",
        taskKey: task.task_key,
        taskTitle: task.title,
        status: primaryStatus(task.waiting),
        running: isRunning(task.task_key, "primary"),
      });
    }

    // SAFETY: `reviewers_json` is NOT NULL and always a JSON array — the
    // rebuilder writes `JSON.stringify(supportingEngagements(fm))`, defaulting
    // to '[]' in the schema.
    const reviewers = JSON.parse(task.reviewers_json) as AgentRef[];
    reviewers.forEach((reviewer, index) => {
      instances.push({
        profileId: reviewer.profileId,
        role: reviewer.role,
        backend: liveBackend(reviewer),
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
