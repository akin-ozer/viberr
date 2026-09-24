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
 * Status vocabulary is the mock's (contracts §2.4), but since F34-5 it is
 * derived from the engagement's OWN run row first and from the task's
 * `waiting` flag only when no run is in flight — `waiting === "agent"` is a
 * display flag about the task, not proof that THIS engagement is executing
 * (ruling 91's family: `liveRuns` is the only proof a run is in flight). Live,
 * the roster called a Developer "working" for twenty minutes after its run had
 * finished because the operator's own turns kept the task agent-waiting, and
 * called a reviewer "anchored · on call" while it was the one running.
 *
 *   agent_runs state=running  → operator "coordinating" · anyone else "working"
 *   agent_runs state=queued   → "queued" (admitted, no slot yet —
 *                               run-service writes it when no reservation was
 *                               granted)
 *   no run, waiting=human     → operator "packet open" WITH a packet, else
 *                               "waiting on human" · anyone else "waiting on
 *                               human"
 *   no run, otherwise         → "on call"
 *
 * The rule is the same for every engagement kind; the reviewer literal the
 * mock hard-coded is gone. Done-stage tasks (the project's LAST stage)
 * contribute nothing.
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

type LiveRunRow = {
  task_key: string;
  kind: "operator" | "primary" | "reviewer";
  thread_id: string;
  state: "running" | "queued";
};

type LiveRunState = LiveRunRow["state"];

/**
 * ONE status rule for every engagement kind (F34-5). The run row wins: a
 * running row is the only fact that says this engagement is executing, and a
 * queued row is a real state (run-service.server.ts writes it when admission
 * granted no reservation), not an idle one. Only with no live row does the
 * task's `waiting` flag speak, and then it names the TASK's state — parked on
 * a human, or nothing to do right now ("on call").
 *
 * UXV19-7 still holds inside the idle branch: a human-waiting operator is
 * "packet open" only WITH a packet. Human-waiting is not the same as
 * packet-present, and two server modules say so in as many words:
 * review-queue.server.ts ("a review-stage task waiting on a human can have no
 * packet/recommendation … yet still need a human to accept it") and
 * decisions.server.ts (B-FD5, "acceptance-ready review-stage tasks — the class
 * that carries no decision OBJECT"). The roster was the only surface naming an
 * ARTIFACT where every other names the STATE — board "waiting on a human",
 * queue "needs a human decision", task page "Waiting on: Human decision" — and
 * it was the only one of the four that could be false: clicking that row
 * landed on a task page whose Decision packet section does not render, while
 * the Decisions surfaces simultaneously listed nothing for it. Any
 * non-terminal stage whose operator turn ends without opening a packet hits
 * this, not just Review.
 *
 * Before F34-5 an idle operator on a non-human-waiting task read
 * "coordinating" and an idle deliverer on an agent-waiting task read
 * "working" — both from the flag alone. Those two words now mean a running
 * row and nothing else; the idle wording for that case is "on call".
 */
function engagementStatus(
  engagement: Engagement,
  live: LiveRunState | null,
  waiting: Waiting,
  hasPacket: boolean,
): DeploymentStatus {
  if (live === "running") {
    return engagement === "operator" ? "coordinating" : "working";
  }
  if (live === "queued") return "queued";
  // Ruling 225: a clock rest reaches this line as `schedule` and lands on "on
  // call", which is the honest word for it — the agent is not running and will
  // be invoked without anybody asking. The one thing it must not say is
  // "waiting on human", which is the branch below.
  if (waiting !== "human") return "on call";
  return engagement === "operator" && hasPacket ? "packet open" : "waiting on human";
}

/** Reviewer thread ids index into the task's supporting engagements
 *  (`reviewers_json`, written from `supportingEngagements(fm)`; ruling 98
 *  retired the `reviewers[]` slot) — "r0", "r1", …. Ruling 458(a): only the
 *  `r` prefix is read. `c` was the consultant prefix until consultants became
 *  reviewers (5c13978d), and nothing has written it since. */
function reviewerIndex(threadId: string): number {
  const match = /^r(\d+)/.exec(threadId);
  return match ? Number(match[1]) : 0;
}

/** The join key between a task's engagement and its run rows: operator and
 *  primary are singletons per task; a reviewer is addressed by its index into
 *  the supporting engagements, which the run's thread id carries. */
function engagementKey(taskKey: string, engagement: Engagement, index: number): string {
  return engagement === "reviewer"
    ? `${taskKey}·reviewer·${index}`
    : `${taskKey}·${engagement}`;
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
  // F28-P2: a STUCK retry pin (F27-B1) wins over the live-deployment overlay,
  // exactly as `withLiveAgentIdentities` (the task/board queries' helper) does —
  // otherwise the per-task engagement chip here contradicts the task page,
  // showing the profile's backend for an engagement the retry pinned elsewhere.
  const liveBackend = (ref: AgentRef): "codex" | "claude" =>
    ref.pinnedBackend ?? liveBackends.get(ref.profileId) ?? ref.backend;

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

  // SAFETY: the SELECT names four `agent_runs` columns 0001_baseline declares
  // NOT NULL; the WHERE restricts `state` to the two values LiveRunRow lists,
  // and `kind` to the three it lists because the fourth CHECK value,
  // 'controller', is written only with `project_slug = ''` (the instance
  // machinery's non-project scope), which a real project slug never equals.
  const liveRows = db
    .prepare(
      `SELECT task_key, kind, thread_id, state
         FROM agent_runs
        WHERE project_slug = ? AND state IN ('running', 'queued')`,
    )
    .all(projectSlug) as LiveRunRow[];
  // Two maps, engagement key → live state. Where both could name the same
  // engagement, "running" outranks "queued": it is the stronger claim.
  const running = new Set<string>();
  const queued = new Set<string>();
  for (const row of liveRows) {
    const key = engagementKey(
      row.task_key,
      row.kind,
      row.kind === "reviewer" ? reviewerIndex(row.thread_id) : 0,
    );
    (row.state === "running" ? running : queued).add(key);
  }
  const liveState = (
    taskKey: string,
    engagement: Engagement,
    index = 0,
  ): LiveRunState | null => {
    const key = engagementKey(taskKey, engagement, index);
    return running.has(key) ? "running" : queued.has(key) ? "queued" : null;
  };

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
      const live = liveState(task.task_key, "operator");
      instances.push({
        profileId: "operator",
        role: "Operator",
        backend: null,
        engagement: "operator",
        taskKey: task.task_key,
        taskTitle: task.title,
        status: engagementStatus("operator", live, task.waiting, task.has_packet === 1),
        running: live === "running",
        taskWaiting: task.waiting,
      });
    }

    // SAFETY: see the operator note above — same writer, same guarantee.
    const specialist = task.specialist_json
      ? (JSON.parse(task.specialist_json) as AgentRef)
      : null;
    if (specialist) {
      const live = liveState(task.task_key, "primary");
      instances.push({
        profileId: specialist.profileId,
        role: specialist.role,
        backend: liveBackend(specialist),
        engagement: "primary",
        taskKey: task.task_key,
        taskTitle: task.title,
        status: engagementStatus("primary", live, task.waiting, task.has_packet === 1),
        running: live === "running",
        taskWaiting: task.waiting,
      });
    }

    // SAFETY: `reviewers_json` is NOT NULL and always a JSON array — the
    // rebuilder writes `JSON.stringify(supportingEngagements(fm))`, defaulting
    // to '[]' in the schema.
    const reviewers = JSON.parse(task.reviewers_json) as AgentRef[];
    reviewers.forEach((reviewer, index) => {
      const live = liveState(task.task_key, "reviewer", index);
      instances.push({
        profileId: reviewer.profileId,
        role: reviewer.role,
        backend: liveBackend(reviewer),
        engagement: "reviewer",
        taskKey: task.task_key,
        taskTitle: task.title,
        // F34-5: the same rule as the two rows above — a supporting engagement
        // with a live run says so, one without reads the task's state.
        status: engagementStatus("reviewer", live, task.waiting, task.has_packet === 1),
        running: live === "running",
        taskWaiting: task.waiting,
      });
    });
  }
  return instances;
}
