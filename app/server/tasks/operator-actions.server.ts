import type Database from "better-sqlite3";
import type { CapabilityMode } from "~/schemas/project-file.schema";
import type {
  TaskFileEvent,
  TaskPacket,
} from "~/schemas/task-file.schema";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { effectiveProfileView } from "~/features/agents/agents-query.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { defaultModelFor } from "~/server/runtimes/model-catalog.server";
import {
  OPERATOR_AUDIT_ACTOR,
  OPERATOR_TASK_ACTOR,
  transitionStage,
  type TaskMutationContext,
} from "./task-actions.server";
import {
  assignReviewer,
  assignSpecialist,
  listDeployedSpecialists,
  startReviewerRun,
  startSpecialistRun,
  type DeployedSpecialistView,
} from "./specialist-run.server";

/**
 * Operator-authorized, capability-GATED task mutations — the layer the
 * operator runtime (its in-process governance tools, operator-toolkit.server)
 * calls to actually drive a task. Every action is governed by the operator
 * deployment's capability policy plus its autonomy level:
 *
 *   direct     → perform the action as the operator.
 *   recommend  → do NOT perform it; post a recommendation (and, for
 *                completion, open a decision packet) for a human to decide.
 *                Under FULL autonomy, recommend is promoted to direct.
 *   human/off  → refuse (human = reserved for a human; off = withheld / the
 *                "don't recommend" operator-RBAC mode → the tool isn't offered).
 *
 * The one deliberate exception to the human-only-Done invariant lives here:
 * under FULL autonomy the operator may accept completion and move a task to
 * Done ({@link operatorAcceptCompletion}). Supervised operators only ever
 * RECOMMEND acceptance (they open the same completion packet a human resolves).
 * Every other agent, and every supervised operator, still cannot reach Done.
 */

export type OperatorAutonomy = "supervised" | "full";

/** The operator's resolved authority for a task's project. */
export interface OperatorAuthority {
  /** capabilityId → mode, from the project's operator deployment. */
  policy: Map<string, CapabilityMode>;
  autonomy: OperatorAutonomy;
  backend: RealBackend;
  model: string;
  effort: string;
  /** Display name of the deployed operator profile. */
  name: string;
  /** false when no operator profile is deployed in the project. */
  deployed: boolean;
}

/** How a gated capability resolves for the current authority. */
type Gate = "direct" | "recommend" | "deny";

export interface OperatorActionResult {
  /** done = performed · recommended = posted for a human · denied = refused. */
  outcome: "done" | "recommended" | "denied" | "noop";
  message: string;
}

// ------------------------------------------------------------- authority

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readAutonomy(definition: unknown): OperatorAutonomy {
  if (isRecord(definition) && definition.autonomy === "full") return "full";
  return "supervised";
}

/**
 * Resolve the operator's authority for a project from its `agents:`
 * deployment. `overrides` lets a run pick the backend / autonomy for THIS run
 * (the task-detail operator panel) without rewriting the deployment.
 */
export function resolveOperatorAuthority(
  ctx: TaskMutationContext,
  projectSlug: string,
  overrides: { backend?: RealBackend; autonomy?: OperatorAutonomy } = {},
): OperatorAuthority {
  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!file) throw AppError.notFound(`Project ${projectSlug} not found.`);

  const deployment = file.parsed.frontmatter.agents.find((a) => {
    const view = effectiveProfileView(a, ctx.dataRoot);
    return view.kind === "operator";
  });

  if (!deployment) {
    return {
      policy: new Map(),
      autonomy: overrides.autonomy ?? "supervised",
      backend: overrides.backend ?? "claude",
      model: defaultModelFor(overrides.backend ?? "claude"),
      effort: "",
      name: "Operator",
      deployed: false,
    };
  }

  const view = effectiveProfileView(deployment, ctx.dataRoot);
  const policy = new Map<string, CapabilityMode>(
    deployment.capabilities.map((c) => [c.capabilityId, c.mode]),
  );
  const definition = (deployment as Record<string, unknown>).definition;
  const backend: RealBackend =
    overrides.backend ??
    (view.backends.find((b) => b === "claude" || b === "codex") === "codex"
      ? "codex"
      : "claude");

  return {
    policy,
    autonomy: overrides.autonomy ?? readAutonomy(definition),
    backend,
    model: view.model || defaultModelFor(backend),
    effort: view.effort || "",
    name: view.name || "Operator",
    deployed: true,
  };
}

/** Resolve one capability to direct / recommend / deny for this authority. */
export function gate(authority: OperatorAuthority, capabilityId: string): Gate {
  const mode = authority.policy.get(capabilityId) ?? "off";
  if (mode === "direct") return "direct";
  if (mode === "recommend") return authority.autonomy === "full" ? "direct" : "recommend";
  // human (reserved for a human) and off (withheld) both mean "operator can't".
  return "deny";
}

// ------------------------------------------------------------- helpers

function taskRef(ctx: TaskMutationContext, projectSlug: string, taskKey: string) {
  return {
    projectSlug,
    taskKey,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  };
}

function reproject(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): void {
  rebuildPath(db, resolveTaskFilePath(taskRef(ctx, projectSlug, taskKey)), {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
}

/** The operator mutation context — carries the operator-authorized flag so
 *  the shared mutations skip human RBAC and attribute to the operator. */
function opCtx(ctx: TaskMutationContext): TaskMutationContext {
  return { ...ctx, operatorAuthorized: true };
}

/**
 * Append an operator-authored `comment` timeline event, reproject, audit.
 * `variant` distinguishes a plain narration comment from a recommendation
 * (kept as literal audit actions so the static audit-coverage sweep can parse
 * every call site).
 */
async function writeOperatorComment(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  text: string,
  variant: "comment" | "recommend",
): Promise<void> {
  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "comment",
    actor: { kind: "operator" },
    title: null,
    text,
    toAgent: false,
    evidence: null,
  };
  await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
    parsed.timeline.unshift(event);
  });
  reproject(db, ctx, projectSlug, taskKey);
  if (variant === "recommend") {
    recordAudit(db, {
      action: "task.operator.recommended",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug,
      taskKey,
      details: {},
    });
  } else {
    recordAudit(db, {
      action: "task.operator.commented",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug,
      taskKey,
      details: {},
    });
  }
}

// ------------------------------------------------------------- snapshot

export interface OperatorTaskSnapshot {
  key: string;
  title: string;
  goal: string;
  stage: string;
  stageName: string;
  readiness: string;
  waiting: string;
  owner: string | null;
  specialist: { profileId: string; role: string; backend: string } | null;
  reviewers: { profileId: string; role: string; backend: string }[];
  /** Stages the task may move to next (declared workflow boundaries). */
  nextStages: { id: string; name: string; boundary: string }[];
  /** The last stage id — reached only via accept_completion. */
  doneStageId: string | null;
  deployedSpecialists: DeployedSpecialistView[];
  openPacket: boolean;
  recentTimeline: { type: string; actor: string; text: string }[];
  autonomy: OperatorAutonomy;
  /** capabilityId → mode the operator holds (the RBAC the tools honor). */
  policy: Record<string, string>;
}

/** Read-only task snapshot for the operator's `get_task` tool. */
export function operatorSnapshot(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  authority: OperatorAuthority,
): OperatorTaskSnapshot {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!file) throw AppError.notFound(`Task ${taskKey} not found.`);
  const project = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!project) throw AppError.notFound(`Project ${projectSlug} not found.`);

  const fm = file.parsed.frontmatter;
  const stages = project.parsed.frontmatter.stages;
  const workflow = project.parsed.frontmatter.workflow;
  const stageName = (id: string) => stages.find((s) => s.id === id)?.name ?? id;
  const doneStageId = stages[stages.length - 1]?.id ?? null;

  const nextStages = workflow
    .filter((w) => w.from === fm.stage)
    .map((w) => ({ id: w.to, name: stageName(w.to), boundary: w.boundary }));

  const ownerName = fm.ownerUserId
    ? ((db
        .prepare(`SELECT name FROM users WHERE id = ?`)
        .get(fm.ownerUserId) as { name: string } | undefined)?.name ?? null)
    : null;

  return {
    key: fm.key,
    title: fm.title,
    goal: file.parsed.goal,
    stage: fm.stage,
    stageName: stageName(fm.stage),
    readiness: fm.readiness,
    waiting: fm.waiting,
    owner: ownerName,
    specialist: fm.specialist
      ? {
          profileId: fm.specialist.profileId,
          role: fm.specialist.role,
          backend: fm.specialist.backend,
        }
      : null,
    reviewers: fm.reviewers.map((r) => ({
      profileId: r.profileId,
      role: r.role,
      backend: r.backend,
    })),
    nextStages,
    doneStageId,
    deployedSpecialists: listDeployedSpecialists(db, projectSlug, ctx),
    openPacket: !!file.parsed.packet,
    recentTimeline: file.parsed.timeline.slice(0, 6).map((e) => ({
      type: e.type,
      actor:
        e.actor.kind === "human"
          ? (e.actor.nameHint ?? "human")
          : e.actor.kind,
      text: e.text,
    })),
    autonomy: authority.autonomy,
    policy: Object.fromEntries(authority.policy),
  };
}

// ------------------------------------------------------------- actions

/** Post an operator comment (governed by append-typed-events). */
export async function operatorPostComment(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; text: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const text = input.text.trim();
  if (!text) return { outcome: "noop", message: "Empty comment ignored." };
  if (gate(authority, "append-typed-events") === "deny") {
    return { outcome: "denied", message: "The operator cannot post events in this project." };
  }
  await writeOperatorComment(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    text,
    "comment",
  );
  return { outcome: "done", message: "Comment posted to the timeline." };
}

/** Assign the primary specialist (governed by assign-primary-specialist). */
export async function operatorAssignSpecialist(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; profileId: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = gate(authority, "assign-primary-specialist");
  if (g === "deny") {
    return {
      outcome: "denied",
      message: "Assigning the primary specialist is not permitted for the operator here.",
    };
  }
  if (g === "recommend") {
    await writeOperatorComment(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      `**Recommendation:** assign \`${input.profileId}\` as the primary specialist. Awaiting a maintainer to confirm.`,
      "recommend",
    );
    return { outcome: "recommended", message: "Posted an assignment recommendation." };
  }
  const result = await assignSpecialist(
    db,
    input,
    OPERATOR_TASK_ACTOR,
    opCtx(ctx),
  );
  return { outcome: "done", message: `Assigned ${result.name} as the primary specialist.` };
}

/** Start the primary specialist's run (governed by assign-primary-specialist). */
export async function operatorRunSpecialist(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = gate(authority, "assign-primary-specialist");
  if (g === "deny") {
    return { outcome: "denied", message: "Running the specialist is not permitted for the operator here." };
  }
  if (g === "recommend") {
    await writeOperatorComment(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      "**Recommendation:** start the primary specialist's run. Awaiting a maintainer to confirm.",
      "recommend",
    );
    return { outcome: "recommended", message: "Posted a run recommendation." };
  }
  const result = await startSpecialistRun(db, input, OPERATOR_TASK_ACTOR, opCtx(ctx));
  return {
    outcome: "done",
    message: `Started a ${result.backend === "claude" ? "Claude Code" : "Codex"} run for the ${result.role} specialist.`,
  };
}

/** Engage a reviewer (governed by summon-reviewers). */
export async function operatorAssignReviewer(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; profileId: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = gate(authority, "summon-reviewers");
  if (g === "deny") {
    return { outcome: "denied", message: "Summoning reviewers is not permitted for the operator here." };
  }
  if (g === "recommend") {
    await writeOperatorComment(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      `**Recommendation:** engage \`${input.profileId}\` as a reviewer. Awaiting a maintainer to confirm.`,
      "recommend",
    );
    return { outcome: "recommended", message: "Posted a reviewer recommendation." };
  }
  const result = await assignReviewer(db, input, OPERATOR_TASK_ACTOR, opCtx(ctx));
  return {
    outcome: "done",
    message: result.alreadyEngaged
      ? `${result.name} is already a reviewer.`
      : `Engaged ${result.name} as a reviewer.`,
  };
}

/** Start a reviewer's run (governed by summon-reviewers). */
export async function operatorRunReviewer(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; profileId: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = gate(authority, "summon-reviewers");
  if (g === "deny") {
    return { outcome: "denied", message: "Running a reviewer is not permitted for the operator here." };
  }
  if (g === "recommend") {
    await writeOperatorComment(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      `**Recommendation:** start the reviewer run for \`${input.profileId}\`. Awaiting a maintainer to confirm.`,
      "recommend",
    );
    return { outcome: "recommended", message: "Posted a reviewer-run recommendation." };
  }
  const result = await startReviewerRun(db, input, OPERATOR_TASK_ACTOR, opCtx(ctx));
  return {
    outcome: "done",
    message: `Started a ${result.backend === "claude" ? "Claude Code" : "Codex"} run for the ${result.role} reviewer.`,
  };
}

/** Move the task to an allowed next stage (governed by stage-transitions). */
export async function operatorTransitionStage(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; toStageId: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = gate(authority, "stage-transitions");
  if (g === "deny") {
    return { outcome: "denied", message: "Stage transitions are not permitted for the operator here." };
  }
  if (g === "recommend") {
    await writeOperatorComment(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      `**Recommendation:** move ${input.taskKey} to \`${input.toStageId}\`. A maintainer approves stage transitions under supervised autonomy.`,
      "recommend",
    );
    // Surface it as waiting on a human decision.
    await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
      parsed.frontmatter.waiting = "human";
    });
    reproject(db, ctx, input.projectSlug, input.taskKey);
    return { outcome: "recommended", message: "Posted a transition recommendation." };
  }
  const task = await transitionStage(db, input, OPERATOR_TASK_ACTOR, opCtx(ctx));
  return { outcome: "done", message: `Moved ${input.taskKey} to ${task.stage}.` };
}

/**
 * Accept completion and move the task to Done. This is the ONE deliberate
 * exception to the human-only-Done invariant: it performs the move ONLY under
 * FULL autonomy (governed additionally by completion-for-acceptance). Under
 * supervised autonomy it never moves to Done — it opens a completion packet a
 * human resolves (the existing acceptance UX).
 */
export async function operatorAcceptCompletion(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!file) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const project = readProjectFile({
    projectSlug: input.projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!project) throw AppError.notFound(`Project ${input.projectSlug} not found.`);
  const stages = project.parsed.frontmatter.stages;
  const doneStageId = stages[stages.length - 1]?.id ?? "done";

  if (file.parsed.frontmatter.stage === doneStageId) {
    return { outcome: "noop", message: `${input.taskKey} is already Done.` };
  }

  // Supervised (or without the completion capability) → recommend only: open a
  // completion packet for a human to accept (never move to Done ourselves).
  if (authority.autonomy !== "full" || gate(authority, "completion-for-acceptance") !== "direct") {
    const packet = completionPacket(input.taskKey);
    await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
      parsed.packet = packet;
      parsed.frontmatter.waiting = "human";
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "completion",
        actor: { kind: "operator" },
        title: "Completion report",
        text: "**Recommended:** accept completion. Opening a completion packet for human acceptance.",
        toAgent: false,
        evidence: null,
      });
    });
    reproject(db, ctx, input.projectSlug, input.taskKey);
    recordAudit(db, {
      action: "task.operator.recommended_completion",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: {},
    });
    return { outcome: "recommended", message: "Opened a completion packet for human acceptance." };
  }

  // FULL autonomy: the operator accepts completion and moves the task to Done.
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.frontmatter.stage = doneStageId;
    parsed.frontmatter.readiness = "ready";
    parsed.frontmatter.waiting = "none";
    if (parsed.frontmatter.pr) {
      parsed.frontmatter.pr = { ...parsed.frontmatter.pr, state: "merged" };
    }
    parsed.packet = null;
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "completion",
      actor: { kind: "operator" },
      title: "Completion accepted",
      text: `Operator accepted completion under **full-autonomy** policy — ${input.taskKey} moved to Done.`,
      toAgent: false,
      evidence: null,
    });
  });
  reproject(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.operator.accepted_completion",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { autonomy: "full", toStage: doneStageId },
  });
  return { outcome: "done", message: `Accepted completion — ${input.taskKey} moved to Done.` };
}

/** A minimal, schema-valid completion packet for human acceptance. */
function completionPacket(taskKey: string): TaskPacket {
  return {
    type: "input",
    kind: "Completion report",
    from: "operator",
    title: `${taskKey} ready for acceptance`,
    body: "The operator drove the task to the review boundary and recommends acceptance.",
    observations: [],
    options: [
      {
        kind: "accept_completion",
        t: "Accept completion",
        d: "Move the task to Done and mark the review PR merged.",
        rec: true,
        accept: true,
        ev: "Human acceptance recorded. Task transitioned to **Done**.",
      },
      {
        kind: "request_edit",
        t: "Request changes",
        d: "Send the task back to the specialist for edits.",
        rec: false,
      },
    ],
  };
}
