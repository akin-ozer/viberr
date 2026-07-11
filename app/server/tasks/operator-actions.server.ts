import type Database from "better-sqlite3";
import type { CapabilityMode } from "~/schemas/project-file.schema";
import type {
  PacketOption,
  PacketOptionKind,
  Recommendation,
  RecommendationKind,
  TaskFileEvent,
  TaskPacket,
} from "~/schemas/task-file.schema";
import { PACKET_OPTION_KINDS } from "~/schemas/task-file.schema";
import { compactTimelineEvents } from "./timeline-compaction.server";
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
import {
  defaultModelFor,
  resolveRunModel,
} from "~/server/runtimes/model-catalog.server";
import {
  OPERATOR_AUDIT_ACTOR,
  OPERATOR_TASK_ACTOR,
  notifyTaskWatchers,
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
  /** The operator's declared knowledge bases (docs injected into its context). */
  kb: string[];
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
      kb: [],
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
  // resolveRunModel also rejects display placeholders ("orchestration runtime")
  // and any other non-catalog value, so nothing invalid leaks into the run.
  const model =
    backend === deploymentBackend
      ? resolveRunModel(backend, view.model)
      : defaultModelFor(backend);

  return {
    policy,
    autonomy: overrides.autonomy ?? readAutonomy(definition),
    backend,
    model,
    effort: backend === deploymentBackend ? view.effort || "" : "",
    name: view.name || "Operator",
    skills: view.resources.skills,
    kb: view.resources.kb ?? [],
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

/** Whether a project anti-noise guardrail is enabled (F5). Reads project.md
 *  fresh; a missing guardrail (older/other projects) is treated as off. */
function guardrailOn(
  ctx: TaskMutationContext,
  projectSlug: string,
  id: string,
): boolean {
  const project = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  return (
    project?.parsed.frontmatter.guardrails?.some((g) => g.id === id && g.on === true) ??
    false
  );
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
  // Anti-noise guardrail (F5, FR: "operator brevity" / "no-duplicate-summary"):
  // when the project enables no-duplicate-summary, drop an operator comment that
  // exactly restates the operator's most recent comment instead of appending it
  // — otherwise a re-running operator accretes duplicate narration and the
  // canonical contract grows noisier over time (a named PRD adoption risk).
  const dedupeOn = guardrailOn(ctx, projectSlug, "no-duplicate-summary");
  const compactOn = guardrailOn(ctx, projectSlug, "compression-threshold");
  let suppressed = false;
  await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
    if (dedupeOn) {
      const lastOperator = parsed.timeline.find(
        (e) => e.type === "comment" && e.actor.kind === "operator",
      );
      if (lastOperator && lastOperator.text.trim() === text.trim()) {
        suppressed = true;
        return;
      }
    }
    parsed.timeline.unshift(event);
    // Timeline compaction (F5/FR17): once a long-running task crosses the
    // compression threshold, collapse OLD routine comments into a marker while
    // keeping every typed governance event, so the canonical file the agents
    // re-anchor on stays readable. Typed events + the recent window survive.
    if (compactOn) {
      parsed.timeline = compactTimelineEvents(parsed.timeline);
    }
  });
  if (suppressed) return;
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
  let wasNew = false;
  await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
    const dup = parsed.frontmatter.recommendations.some(
      (r) =>
        r.kind === rec.kind &&
        r.profileId === rec.profileId &&
        r.toStageId === rec.toStageId,
    );
    if (!dup) {
      parsed.frontmatter.recommendations.push(recommendation);
      wasNew = true;
    }
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
  // Ping the supervisors: a supervised operator recommendation is a decision
  // waiting on a human. Without this, the recommendation card only appears if
  // someone happens to open the task — the bell and "Waiting on you" inbox stay
  // dark. (Journey 2: blocked tasks must reach a human decision quickly.) Only
  // on a NEW recommendation, so a re-running operator doesn't re-notify the same
  // pending decision every cycle.
  if (wasNew) {
    notifyTaskWatchers(
      db,
      {
        projectSlug,
        taskKey,
        kind: "approval",
        ptype: "input",
        title: `Operator recommends: ${rec.label}`,
        text: reasoning,
      },
      ctx,
    );
  }
}

/** One option the operator offers on a decision/blocking packet. */
export interface OperatorPacketOptionInput {
  kind: PacketOptionKind;
  title: string;
  detail?: string;
  recommended?: boolean;
  /** Pre-authored timeline text written when a human chooses this option. */
  ev?: string;
}

export interface OperatorOpenPacketInput {
  projectSlug: string;
  taskKey: string;
  /** input = a decision the human should make; blocked = work is stuck. */
  packetType: "input" | "blocked";
  title: string;
  body?: string;
  observations?: { k: string; v: string; code?: boolean }[];
  options: OperatorPacketOptionInput[];
}

const PACKET_KIND_SET = new Set<string>(PACKET_OPTION_KINDS);

/**
 * Open a structured decision/blocking PACKET on the task (FR26, Journey 2) —
 * the artifact the whole product is built around. This is what an operator
 * produces at a genuine decision point or when it hits the limit of its
 * authority, instead of leaving a comment wall and a bare `waiting:human`.
 *
 * Governed by `generate-packets`. The packet carries typed observations and a
 * set of resolvable options (each a stable {@link PacketOptionKind}); exactly
 * one is marked recommended. Writing it sets `waiting=human` (and, for a
 * `blocked` packet, `readiness=blocked`), then fans a `packet` notification out
 * to the task's supervisors. The human resolves it through the existing
 * DecisionPacket UI → `resolvePacket`, so no new resolution path is needed.
 */
export async function operatorOpenPacket(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: OperatorOpenPacketInput,
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "generate-packets") === "deny") {
    return {
      outcome: "denied",
      message: "The operator cannot open decision packets in this project.",
    };
  }
  const title = input.title.trim();
  if (!title) {
    return { outcome: "noop", message: "A packet needs a title." };
  }
  const rawOptions = input.options ?? [];
  if (rawOptions.length === 0) {
    return { outcome: "noop", message: "A packet needs at least one option." };
  }
  for (const o of rawOptions) {
    if (!PACKET_KIND_SET.has(o.kind)) {
      return {
        outcome: "denied",
        message: `Unknown packet option kind "${o.kind}". Valid kinds: ${PACKET_OPTION_KINDS.join(", ")}.`,
      };
    }
  }

  // Exactly one recommended option (the parser expects this): honour the first
  // one the operator marked, else default to the first option.
  let recSeen = false;
  const options: PacketOption[] = rawOptions.map((o) => {
    const rec = !recSeen && o.recommended === true;
    if (rec) recSeen = true;
    return {
      kind: o.kind,
      t: o.title.trim() || o.kind,
      d: (o.detail ?? "").trim(),
      rec,
      ...(o.ev ? { ev: o.ev } : {}),
    };
  });
  if (!recSeen && options[0]) options[0].rec = true;

  const packet: TaskPacket = {
    type: input.packetType,
    kind: input.packetType === "blocked" ? "Blocked decision" : "Decision required",
    from: "operator",
    title,
    body: (input.body ?? "").trim(),
    observations: (input.observations ?? []).map((o) => ({
      k: o.k,
      v: o.v,
      code: o.code ?? false,
    })),
    options,
  };

  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.packet = packet;
    parsed.frontmatter.waiting = "human";
    if (input.packetType === "blocked") {
      parsed.frontmatter.readiness = "blocked";
      parsed.frontmatter.validation = "failing"; // blocked work is unhealthy (FR24)
    }
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: input.packetType === "blocked" ? "blocked" : "comment",
      actor: { kind: "operator" },
      title,
      text:
        input.packetType === "blocked"
          ? `**Blocked:** ${title}. Opened a decision packet for the owner to resolve.`
          : `**Decision packet:** ${title}. Awaiting a human decision.`,
      toAgent: false,
      evidence: null,
    });
  });
  reproject(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.operator.packet_opened",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { type: input.packetType },
  });
  notifyTaskWatchers(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      kind: "packet",
      ptype: input.packetType,
      title:
        input.packetType === "blocked"
          ? `Blocked — decision needed: ${title}`
          : `Decision needed: ${title}`,
      text: packet.body || title,
    },
    ctx,
  );
  return {
    outcome: "done",
    message: `Opened a ${input.packetType === "blocked" ? "blocking" : "decision"} packet with ${options.length} option(s).`,
  };
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

  const nextStages = workflow.flatMap((w) =>
    w.from === fm.stage
      ? [{ id: w.to, name: stageName(w.to), boundary: w.boundary }]
      : [],
  );

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

/**
 * Best-effort task-key branch creation on GitHub when a specialist is about to
 * work. Isolated + swallowing so a GitHub failure (or unconfigured repo) can
 * never fail the operator's coordination — ensureTaskBranch already returns
 * typed results and writes the branch name into task.md on success.
 */
async function ensureTaskBranchBestEffort(
  db: Database.Database,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): Promise<void> {
  try {
    const { ensureTaskBranch } = await import("~/server/github/branch-sync.server");
    await ensureTaskBranch(
      db,
      { projectSlug, taskKey },
      OPERATOR_AUDIT_ACTOR,
      { ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}) },
    );
  } catch {
    // Non-fatal: coordination proceeds without a branch when GitHub is absent.
  }
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
  // Delivery spine (FR31): the developer is about to work, so ensure the
  // task-key branch exists on GitHub. Best-effort — degrades cleanly (no throw)
  // when the repo/PAT isn't configured, and writes the branch name into task.md
  // so the PR/commit/branch chain stays traceable to this task.
  await ensureTaskBranchBestEffort(db, ctx, input.projectSlug, input.taskKey);
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
  // An `auto` boundary is ungoverned by the project's own workflow — it declares
  // "no approval needed" — so crossing it is not an exercise of governance
  // authority and does NOT wait on a human, even when the operator's
  // stage-transitions capability is `recommend` (supervised). Otherwise a task
  // strands at a pre-work stage (e.g. Ready→In Progress "when a specialist is
  // assigned") with a recommendation nobody needs to approve. Governed
  // boundaries (`approval`/`human`) still route through the recommend/deny gate.
  const boundary = operatorBoundaryFor(ctx, input.projectSlug, input.taskKey, input.toStageId);
  if (g === "recommend" && boundary !== "auto") {
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

/** The workflow boundary the operator would cross to move a task from its
 *  current stage to `toStageId`, or null when it isn't a declared transition. */
function operatorBoundaryFor(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  toStageId: string,
): "auto" | "approval" | "human" | null {
  const task = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  const project = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!task || !project) return null;
  const from = task.parsed.frontmatter.stage;
  const w = project.parsed.frontmatter.workflow.find((b) => b.from === from && b.to === toStageId);
  return w ? w.boundary : null;
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

  // Never accept a task a reviewer FLAGGED (validation "failing"): a
  // request-changes verdict blocks acceptance until the developer reworks it
  // (which resets validation off "failing"). This stops the operator from
  // auto-accepting flagged work — e.g. when one of several reviewers rejected
  // it — under full autonomy.
  if (file.parsed.frontmatter.validation === "failing") {
    return {
      outcome: "noop",
      message: `${input.taskKey} has an open "changes requested" verdict — not accepting until it's resolved.`,
    };
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
  // A REAL PR merge is attributed to a human (mergeTaskPr requires a user
  // identity), so the operator cannot merge — it records the PR as "accepted"
  // (merge pending), never a false "merged". A human merges / reconciles later.
  const hasPr = !!file.parsed.frontmatter.pr;
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.frontmatter.stage = doneStageId;
    parsed.frontmatter.readiness = "ready";
    parsed.frontmatter.waiting = "none";
    if (parsed.frontmatter.pr) {
      parsed.frontmatter.pr = { ...parsed.frontmatter.pr, state: "accepted" };
    }
    parsed.packet = null;
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "completion",
      actor: { kind: "operator" },
      title: "Completion accepted",
      text: hasPr
        ? `Operator accepted completion under **full-autonomy** policy — ${input.taskKey} moved to Done; the review PR is **accepted, merge pending** (a human merges it).`
        : `Operator accepted completion under **full-autonomy** policy — ${input.taskKey} moved to Done.`,
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
