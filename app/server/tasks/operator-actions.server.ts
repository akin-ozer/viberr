import type Database from "better-sqlite3";
import type { CapabilityMode } from "~/schemas/project-file.schema";
import type {
  Recommendation,
  RecommendationKind,
  TaskFileEvent,
} from "~/schemas/task-file.schema";
import { newId } from "~/shared/ids/new-id.server";
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
  operatorPromptAgent,
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
  /** The operator's declared skills (loaded into its system prompt at run). */
  skills: string[];
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
      skills: [],
      deployed: false,
    };
  }

  const view = effectiveProfileView(deployment, ctx.dataRoot);
  const policy = new Map<string, CapabilityMode>(
    deployment.capabilities.map((c) => [c.capabilityId, c.mode]),
  );
  const definition = (deployment as Record<string, unknown>).definition;
  const deploymentBackend: RealBackend =
    view.backends.find((b) => b === "claude" || b === "codex") === "codex"
      ? "codex"
      : "claude";
  const backend: RealBackend = overrides.backend ?? deploymentBackend;

  // The deployment's model is specific to its own backend (e.g. a Claude model).
  // When a run overrides to a DIFFERENT backend, the stored model is invalid for
  // it (Codex rejects a Claude model id) — fall back to that backend's default.
  // "orchestration runtime" is a display placeholder from the seed template, not
  // a real model id, so treat it as unset (otherwise it leaks into the run and
  // shows as the run's Runtime label).
  const rawModel = view.model?.trim();
  const deploymentModel =
    rawModel && rawModel.toLowerCase() !== "orchestration runtime" ? rawModel : "";
  const model =
    backend === deploymentBackend
      ? deploymentModel || defaultModelFor(backend)
      : defaultModelFor(backend);

  return {
    policy,
    autonomy: overrides.autonomy ?? readAutonomy(definition),
    backend,
    model,
    effort: backend === deploymentBackend ? view.effort || "" : "",
    name: view.name || "Operator",
    skills: view.resources.skills,
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

/**
 * Append a structured, ACTIONABLE operator recommendation to the task (rendered
 * as a one-click Apply/Dismiss card) AND post the operator's reasoning as a
 * comment. Sets waiting=human. Idempotent per (kind, target). This is what a
 * SUPERVISED operator does instead of performing a governed action itself.
 */
async function addRecommendation(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  rec: { kind: RecommendationKind; profileId?: string; toStageId?: string; label: string },
  reasoning: string,
): Promise<void> {
  const recommendation: Recommendation = {
    id: newId("rec"),
    kind: rec.kind,
    label: rec.label,
    detail: reasoning,
    ...(rec.profileId ? { profileId: rec.profileId } : {}),
    ...(rec.toStageId ? { toStageId: rec.toStageId } : {}),
  };
  await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
    const dup = parsed.frontmatter.recommendations.some(
      (r) =>
        r.kind === rec.kind &&
        r.profileId === rec.profileId &&
        r.toStageId === rec.toStageId,
    );
    if (!dup) parsed.frontmatter.recommendations.push(recommendation);
    parsed.frontmatter.waiting = "human";
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "comment",
      actor: { kind: "operator" },
      title: null,
      text: `**Recommendation:** ${rec.label}. ${reasoning}`,
      toAgent: false,
      evidence: null,
    });
  });
  reproject(db, ctx, projectSlug, taskKey);
  recordAudit(db, {
    action: "task.operator.recommended",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: taskKey,
    projectSlug,
    taskKey,
    details: { kind: rec.kind },
  });
}

/** Resolve a deployed specialist's display name for a recommendation label. */
function specialistName(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  profileId: string,
): string {
  const found = listDeployedSpecialists(db, projectSlug, ctx).find(
    (s) => s.id === profileId,
  );
  return found?.name ?? profileId;
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
  /** All stage ids in workflow order (first → done). Lets a coordinator tell a
   *  pre-work stage from the implementation stage from the review stage. */
  stageIds: string[];
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
    stageIds: stages.map((s) => s.id),
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
  input: { projectSlug: string; taskKey: string; profileId: string; reason?: string },
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
    const name = specialistName(db, ctx, input.projectSlug, input.profileId);
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      {
        kind: "assign_specialist",
        profileId: input.profileId,
        label: `Assign ${name} as the primary specialist`,
      },
      input.reason ?? `${name} fits the current stage of work.`,
    );
    return { outcome: "recommended", message: `Recommended assigning ${name} as the primary specialist.` };
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
  input: { projectSlug: string; taskKey: string; profileId: string; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = gate(authority, "summon-reviewers");
  if (g === "deny") {
    return { outcome: "denied", message: "Summoning reviewers is not permitted for the operator here." };
  }
  if (g === "recommend") {
    const name = specialistName(db, ctx, input.projectSlug, input.profileId);
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      {
        kind: "assign_reviewer",
        profileId: input.profileId,
        label: `Engage ${name} as a reviewer`,
      },
      input.reason ?? `${name} should review the work at this stage.`,
    );
    return { outcome: "recommended", message: `Recommended engaging ${name} as a reviewer.` };
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

// --------------------------------------------------- prompt (engage + trigger)

/** Resolve a deployed specialist's role + backend for a prompt/run. */
function deployedAgent(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  profileId: string,
): DeployedSpecialistView | null {
  return (
    listDeployedSpecialists(db, projectSlug, ctx).find((s) => s.id === profileId) ??
    null
  );
}

/** Title / goal / current stage name for building a default prompt directive. */
function taskContext(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): { title: string; goal: string; stageName: string } {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  const project = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  const title = file?.parsed.frontmatter.title ?? taskKey;
  const goal = file?.parsed.goal ?? "";
  const stageId = file?.parsed.frontmatter.stage ?? "";
  const stageName =
    project?.parsed.frontmatter.stages.find((s) => s.id === stageId)?.name ?? stageId;
  return { title, goal, stageName };
}

/**
 * Engage + PROMPT the primary specialist for the current stage (governed by
 * `assign-primary-specialist`). Direct → assign it as primary (if it isn't
 * already), post an operator prompt comment related to the task, and start its
 * run with that prompt as the turn directive. Recommend (supervised with the
 * assign capability set to recommend) → post a recommendation card and stop.
 *
 * This is how the operator "hands a task to" its specialist when the task enters
 * a working stage: it triggers the agent with a task-related prompt, not a
 * silent run. Pass `directive` to control the prompt text; when omitted a
 * stage-aware default is generated from the task's goal.
 */
export async function operatorPromptSpecialist(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId: string;
    directive?: string;
    reason?: string;
  },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = gate(authority, "assign-primary-specialist");
  if (g === "deny") {
    return {
      outcome: "denied",
      message: "Prompting the primary specialist is not permitted for the operator here.",
    };
  }
  const agent = deployedAgent(db, ctx, input.projectSlug, input.profileId);
  if (!agent) {
    return { outcome: "denied", message: `No deployed specialist "${input.profileId}" to prompt.` };
  }

  if (g === "recommend") {
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      {
        kind: "assign_specialist",
        profileId: input.profileId,
        label: `Assign ${agent.name} as the primary specialist`,
      },
      input.reason ?? input.directive ?? `${agent.name} fits the current stage of work.`,
    );
    return { outcome: "recommended", message: `Recommended assigning ${agent.name} as the primary specialist.` };
  }

  // direct: assign as primary if it isn't already, then prompt + run.
  const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  const currentPrimary = file?.parsed.frontmatter.specialist?.profileId ?? null;
  if (currentPrimary !== input.profileId) {
    await assignSpecialist(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey, profileId: input.profileId },
      OPERATOR_TASK_ACTOR,
      opCtx(ctx),
    );
  }
  const c = taskContext(db, ctx, input.projectSlug, input.taskKey);
  const directive =
    (input.directive ?? "").trim() ||
    `implement "${c.title}" (now in ${c.stageName}). ` +
      `Goal: ${c.goal} Please pick it up and do the stage work, then report back.`;
  await operatorPromptAgent(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      role: agent.role,
      backend: agent.backend,
      handle: agent.name,
      directive,
      kind: "primary",
    },
    ctx,
  );
  return { outcome: "done", message: `Prompted @${agent.name} and started its run.` };
}

/**
 * Engage + PROMPT a reviewer for the current stage (governed by
 * `summon-reviewers`). Direct → engage the reviewer (idempotent), post an
 * operator prompt comment, and start its reviewer run with that prompt as its
 * turn directive. Recommend → post an "engage reviewer" recommendation card and
 * stop. Used when a task reaches the review stage.
 */
export async function operatorPromptReviewer(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId: string;
    directive?: string;
    reason?: string;
  },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = gate(authority, "summon-reviewers");
  if (g === "deny") {
    return {
      outcome: "denied",
      message: "Prompting a reviewer is not permitted for the operator here.",
    };
  }
  const agent = deployedAgent(db, ctx, input.projectSlug, input.profileId);
  if (!agent) {
    return { outcome: "denied", message: `No deployed specialist "${input.profileId}" to engage as a reviewer.` };
  }

  if (g === "recommend") {
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      {
        kind: "assign_reviewer",
        profileId: input.profileId,
        label: `Engage ${agent.name} as a reviewer`,
      },
      input.reason ?? input.directive ?? `${agent.name} should review the work at this stage.`,
    );
    return { outcome: "recommended", message: `Recommended engaging ${agent.name} as a reviewer.` };
  }

  // direct: engage (idempotent) then prompt + run.
  await assignReviewer(
    db,
    { projectSlug: input.projectSlug, taskKey: input.taskKey, profileId: input.profileId },
    OPERATOR_TASK_ACTOR,
    opCtx(ctx),
  );
  const c = taskContext(db, ctx, input.projectSlug, input.taskKey);
  const directive =
    (input.directive ?? "").trim() ||
    `please review the work on "${c.title}" against the goal: ${c.goal} ` +
      `Flag correctness, security, and gaps, then report back.`;
  await operatorPromptAgent(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      role: agent.role,
      backend: agent.backend,
      handle: agent.name,
      directive,
      kind: "reviewer",
      profileId: input.profileId,
    },
    ctx,
  );
  return { outcome: "done", message: `Prompted reviewer @${agent.name} and started its run.` };
}

/** Move the task to an allowed next stage (governed by stage-transitions). */
export async function operatorTransitionStage(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; toStageId: string; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = gate(authority, "stage-transitions");
  if (g === "deny") {
    return { outcome: "denied", message: "Stage transitions are not permitted for the operator here." };
  }
  if (g === "recommend") {
    const name = stageNameOf(db, ctx, input.projectSlug, input.toStageId);
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      {
        kind: "transition",
        toStageId: input.toStageId,
        label: `Move the task to ${name}`,
      },
      input.reason ?? `The work is ready to advance to ${name}.`,
    );
    return { outcome: "recommended", message: `Recommended moving the task to ${name}.` };
  }
  const task = await transitionStage(db, input, OPERATOR_TASK_ACTOR, opCtx(ctx));
  return { outcome: "done", message: `Moved ${input.taskKey} to ${task.stage}.` };
}

/** Resolve a stage's display name for a recommendation label. */
function stageNameOf(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  stageId: string,
): string {
  const file = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  return file?.parsed.frontmatter.stages.find((s) => s.id === stageId)?.name ?? stageId;
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

  // Supervised (or without the completion capability) → recommend only: post an
  // actionable "accept completion → Done" recommendation card (symmetric with the
  // other stage-transition cards, so the review→done boundary gets the same clear
  // one-click prompt as impl→review) — never move to Done ourselves. A
  // maintainer applies it to accept completion into Done.
  if (authority.autonomy !== "full" || gate(authority, "completion-for-acceptance") !== "direct") {
    const doneName = stageNameOf(db, ctx, input.projectSlug, doneStageId);
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      {
        kind: "accept_completion",
        toStageId: doneStageId,
        label: `Accept completion — move ${input.taskKey} to ${doneName}`,
      },
      `The review is clean and the work meets the goal. Accepting completion moves ${input.taskKey} to ${doneName} and marks the review PR merged (human acceptance).`,
    );
    recordAudit(db, {
      action: "task.operator.recommended_completion",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { toStage: doneStageId },
    });
    return {
      outcome: "recommended",
      message: `Recommended accepting completion — move ${input.taskKey} to ${doneName}.`,
    };
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
