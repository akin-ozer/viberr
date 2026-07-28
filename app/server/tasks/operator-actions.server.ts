import type { DatabaseSync } from "node:sqlite";
import type { CapabilityMode } from "~/schemas/project-file.schema";
import {
  deliveringEngagement,
  supportingEngagements,
  type PacketOption,
  type PrState,
  type PacketOptionKind,
  type Recommendation,
  type RecommendationKind,
  type TaskFileEvent,
  type TaskPacket,
} from "~/schemas/task-file.schema";
import { PACKET_OPTION_KINDS } from "~/schemas/task-file.schema";
import {
  compactTimelineEvents,
  DEFAULT_COMPACTION,
} from "./timeline-compaction.server";
import {
  enforceOperatorBrevity,
  guardrailOn,
  guardrailValue,
  isMeaninglessComment,
  separateEvidence,
} from "./comment-guardrails.server";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
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
import { logger } from "~/server/logging/logger.server";
import {
  notifyMentionedUsers,
  withAmbiguityDisclosure,
} from "./mention-notify.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import {
  defaultModelFor,
  resolveRunModel,
} from "~/server/runtimes/model-catalog.server";
import {
  DEFAULT_GOAL,
  OPERATOR_AUDIT_ACTOR,
  OPERATOR_TASK_ACTOR,
  acceptanceRefusalFor,
  applyAcceptanceWrite,
  notifyTaskWatchers,
  operatorPromptAgent,
  performDelivery,
  transitionStage,
  type TaskMutationContext,
} from "./task-actions.server";
import {
  assignReviewer,
  assignSpecialist,
  listDeployedSpecialists,
  projectBoard,
  specialistEligibleForStage,
  startAgentRun,
  type DeployedSpecialistView,
} from "./specialist-run.server";
import { markTaskPacketApprovalRead } from "~/server/projections/notifications.server";

/** Capability-gated task mutations used only by the in-process operator toolkit. */

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
  /**
   * The operator's declared org MCP servers. P13-KM-03 wired them into the
   * Claude toolkit (they had reached NO run on either backend — `OperatorAuthority`
   * carried skills and kb only, and an operator granted `everything-mcp`
   * reported "MCP servers/tools I can call: none"); P14-RT-04 mounts them on the
   * Codex operator too, so the grant is real on both backends. On Codex the CLI
   * translation drops credentials (argv exposure) and stamps approve-mode, as it
   * does for specialists.
   */
  mcps: string[];
  /** The deployment's persona override (P11-21) — when a project edits the
   *  operator's persona in the UI, the run uses it in place of the shipped
   *  operator definition. `null` falls back to the shipped/baked persona. */
  persona: string | null;
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
/**
 * The operator deployment's configured backend for a project (P11-76) — a cheap
 * read for the UI so the "Run operator" backend picker defaults to what the
 * operator actually runs on, not a hardcoded "claude". Falls back to "claude"
 * when no operator is deployed (the same default the run path uses).
 */
export function operatorBackendFor(
  ctx: TaskMutationContext,
  projectSlug: string,
): RealBackend {
  try {
    const file = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
    const deployment = file?.parsed.frontmatter.agents.find(
      (a) => effectiveProfileView(a, ctx.dataRoot).kind === "operator",
    );
    if (!deployment) return "claude";
    const view = effectiveProfileView(deployment, ctx.dataRoot);
    return view.backends.find((b) => b === "claude" || b === "codex") === "codex"
      ? "codex"
      : "claude";
  } catch {
    return "claude";
  }
}

export function resolveOperatorAuthority(
  ctx: TaskMutationContext,
  projectSlug: string,
  overrides: { backend?: RealBackend; autonomy?: OperatorAutonomy } = {},
): OperatorAuthority {
  const file = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
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
      persona: null,
      mcps: [],
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
    mcps: view.resources.mcps ?? [],
    persona:
      isRecord(definition) && typeof definition.persona === "string"
        ? definition.persona.trim() || null
        : null,
    deployed: true,
  };
}

/** Resolve one capability to direct / recommend / deny for this authority. */
export function gate(authority: OperatorAuthority, capabilityId: string): Gate {
  const mode = authority.policy.get(capabilityId) ?? "off";
  if (mode === "direct") return "direct";
  if (mode === "recommend") {
    // Full autonomy promotes recommend → direct — EXCEPT for acceptance-to-Done.
    // The human-only-Done invariant's single agent exception requires the
    // capability be EXPLICITLY `direct` (owner ruling Q1, 2026-07-11): an admin
    // who configured `recommend` expecting a human gate must never get a silent
    // agent-close just because the run was launched at full autonomy.
    if (capabilityId === "completion-for-acceptance") return "recommend";
    return authority.autonomy === "full" ? "direct" : "recommend";
  }
  // human (reserved for a human) and off (withheld) both mean "operator can't".
  return "deny";
}

/**
 * R15-2: the `deliver-review-pr` gate with ABSENT-means-granted polarity. The
 * capability postdates many live operator deployments (whose grant lists were
 * persisted at deploy time), and its catalog default is `direct` — an absent
 * grant must not silently kill delivery on every pre-R15-2 project. An explicit
 * mode goes through the normal gate (full autonomy promotes recommend→direct).
 * Same deliberate polarity as `use-web-search-fetch` (operatorWebWithheld).
 */
export function deliverGate(authority: OperatorAuthority): Gate {
  return authority.policy.has("deliver-review-pr")
    ? gate(authority, "deliver-review-pr")
    : "direct";
}

// ------------------------------------------------------------- helpers

function taskRef(ctx: TaskMutationContext, projectSlug: string, taskKey: string) {
  return {
    projectSlug,
    taskKey,
    dataRoot: ctx.dataRoot,
  };
}

function reproject(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): void {
  rebuildPath(db, resolveTaskFilePath(taskRef(ctx, projectSlug, taskKey)), {
    dataRoot: ctx.dataRoot,
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
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  text: string,
  variant: "comment" | "recommend",
): Promise<void> {
  // Anti-noise guardrails — ALL enforced for real (owner ruling Q3):
  //  · meaningful-comment: trivial chatter never reaches the canonical record;
  //  · evidence-separation: raw output dumps are trimmed to a head + reference;
  //  · operator-brevity: operator narration is hard-capped;
  //  · no-duplicate-summary: an exact restatement of the last operator comment
  //    is dropped;
  //  · compression-threshold: long timelines compact at the CONFIGURED value.
  if (
    guardrailOn(ctx, projectSlug, "meaningful-comment") &&
    isMeaninglessComment(text)
  ) {
    logger.info("operator comment dropped by the meaningful-comment guardrail", {
      taskKey,
    });
    return;
  }
  if (guardrailOn(ctx, projectSlug, "evidence-separation")) {
    text = separateEvidence(text);
  }
  if (guardrailOn(ctx, projectSlug, "operator-brevity")) {
    text = enforceOperatorBrevity(text);
  }
  // S5-G3: the operator is instructed to tag the human it answers, so a handle
  // that matches two people is a NEW-4 failure the operator cannot fix on its
  // own — the comment discloses the non-delivery instead of dropping it in
  // silence. Applied after brevity so the disclosure is never trimmed away.
  text = withAmbiguityDisclosure(db, text);
  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "comment",
    actor: { kind: "operator" },
    title: null,
    text,
    toAgent: false,
    evidence: null,
  };
  const dedupeOn = guardrailOn(ctx, projectSlug, "no-duplicate-summary");
  const compactOn = guardrailOn(ctx, projectSlug, "compression-threshold");
  const compactAt = guardrailValue(ctx, projectSlug, "compression-threshold");
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
    // re-anchor on stays readable. The guardrail's CONFIGURED value drives the
    // threshold (it used to be ignored — the settings row advertised 40 while
    // the code hardcoded 60).
    if (compactOn) {
      parsed.timeline = compactTimelineEvents(
        parsed.timeline,
        compactAt != null
          ? {
              threshold: compactAt,
              keepRecent: Math.min(
                DEFAULT_COMPACTION.keepRecent,
                Math.max(4, Math.floor(compactAt / 2)),
              ),
            }
          : DEFAULT_COMPACTION,
      );
    }
  });
  if (suppressed) return;
  reproject(db, ctx, projectSlug, taskKey);
  // NEW-4: the operator is instructed to tag the person it answers ("@Arda …");
  // the tag must actually notify them — same fan-out as every other comment.
  notifyMentionedUsers(db, {
    text,
    projectSlug,
    taskKey,
    from: { kind: "agent", name: "Operator" },
    occurredAt: event.occurredAt,
  });
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
  db: DatabaseSync,
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
  // Same disclosure the narration path carries (S5-G3): the reasoning is
  // operator prose and can tag a human, so an ambiguous handle must not vanish.
  const commentText = withAmbiguityDisclosure(
    db,
    `**Recommendation:** ${rec.label}. ${reasoning}`,
  );
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
      text: commentText,
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
  // NEW-4: recommendation reasoning that tags a person pings them too.
  notifyMentionedUsers(db, {
    text: commentText,
    projectSlug,
    taskKey,
    from: { kind: "agent", name: "Operator" },
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
  /** retry_other_backend — the backend to re-run the failed agent on. */
  backend?: "codex" | "claude";
  /** retry_other_backend — a reviewer retry names its profile. */
  profileId?: string;
  /** archive_task — also delete the task's remote branch (discard the work). */
  deleteBranch?: boolean;
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

/** Open a typed human-decision packet and notify the task's supervisors. */
export async function operatorOpenPacket(
  db: DatabaseSync,
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
      ...(o.backend ? { backend: o.backend } : {}),
      ...(o.profileId ? { profileId: o.profileId } : {}),
      ...(o.deleteBranch ? { deleteBranch: true } : {}),
    };
  });
  if (!recSeen && options[0]) options[0].rec = true;

  const packet: TaskPacket = {
    id: newId("pkt"), // F10-09: stable identity for concurrent-resolution safety
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
      // Blocked-ness lives on `readiness` alone (F7-VAL1). It used to ALSO set
      // validation="failing", but `validation` is REVIEW health — only a
      // reviewer verdict or an acceptance owns it. A blocked packet from an
      // unrelated cause (e.g. a commit was denied, a run crashed) then made the
      // acceptance gate refuse with "the latest review is failing — rework and
      // re-review", which is nonsense when no review ever ran. The readiness
      // flag already gates the board; validation stays whatever review left it.
      parsed.frontmatter.readiness = "blocked";
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

/**
 * WITHDRAW the task's open decision packet — the operator's own cleanup for a
 * packet that has become moot (the input it asked for was provided out-of-band,
 * e.g. a human edited the goal instead of clicking an option). Same authority
 * as opening one (generate-packets). Restores `readiness` when the packet was
 * the thing that blocked it, and writes a typed timeline note so the decision
 * log shows WHY the packet disappeared. No-op when no packet is open.
 */
export async function operatorResolvePacket(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "generate-packets") === "deny") {
    return {
      outcome: "denied",
      message: "The operator cannot manage decision packets in this project.",
    };
  }
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) {
    return { outcome: "noop", message: `Task ${input.taskKey} not found.` };
  }
  const packet = existing.parsed.packet;
  if (!packet) {
    return { outcome: "noop", message: "No open decision packet to resolve." };
  }
  const reason =
    (input.reason ?? "").trim() ||
    "The input it asked for has since been provided.";
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.packet = null;
    // A blocked packet set readiness=blocked when it opened — withdrawing the
    // packet lifts that (a genuine standing block would re-assert itself).
    if (packet.type === "blocked" && parsed.frontmatter.readiness === "blocked") {
      parsed.frontmatter.readiness = "ready";
    }
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "transition",
      actor: { kind: "operator" },
      title: null,
      text: `**Packet withdrawn:** ${packet.title} — ${reason}`,
      toAgent: false,
      evidence: null,
    });
  });
  reproject(db, ctx, input.projectSlug, input.taskKey);
  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.operator.packet_withdrawn",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { title: packet.title, reason },
  });
  return { outcome: "done", message: `Withdrew the packet "${packet.title}".` };
}

/** Resolve a deployed specialist's display name for a recommendation label. */
function specialistName(
  ctx: TaskMutationContext,
  projectSlug: string,
  profileId: string,
): string {
  const found = listDeployedSpecialists(projectSlug, ctx).find(
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
  /** The review stage id (edge into Done) — resolved from the workflow graph,
   *  NOT positionally, so custom/lightweight boards classify correctly. */
  reviewStageId: string | null;
  /** The implementation ("work") stage id (edge into review). */
  workStageId: string | null;
  deployedSpecialists: (DeployedSpecialistView & {
    /** Whether this specialist may work the task's CURRENT stage (F1) — the
     *  operator should only assign/prompt an eligible one. */
    eligibleForCurrentStage: boolean;
  })[];
  openPacket: boolean;
  /** The open decision packet's CONTENT (null when none) — the operator needs
   *  it to judge whether the packet is now moot (resolve_decision_packet)
   *  rather than only knowing "a packet exists". */
  packet: {
    type: "input" | "blocked";
    title: string;
    body: string;
    options: string[];
  } | null;
  recentTimeline: { type: string; actor: string; text: string }[];
  /** P13-D-4: the review PR, or null. The operator used to be structurally
   *  blind to it — no `pr` field anywhere in the snapshot — so it could neither
   *  see that a human had CLOSED the PR on GitHub (an out-of-band rejection)
   *  nor reason about it before recommending/accepting completion. `state` is
   *  the task-file cache vocabulary: review | merged | closed | accepted. */
  pr: { number: number; state: PrState; title: string } | null;
  /** The task's delivery branch (null before any delivery). Lets recovery
   *  packets name the branch a `deleteBranch` archive option would remove. */
  branch: string | null;
  /** Queued/running agent runs on THIS task — the ONLY truth for "a run is
   *  in flight". Live-caught: the operator inferred an in-flight deliverer
   *  from `waiting: "agent"` (a board display flag) plus its own directive
   *  comment, when the prompt's run had actually REFUSED to start — so the
   *  rework never resumed. An empty list here means nothing is running,
   *  whatever the timeline or `waiting` suggest. */
  liveRuns: {
    kind: "operator" | "primary" | "reviewer";
    profileId: string | null;
    state: "queued" | "running";
  }[];
  autonomy: OperatorAutonomy;
  /** capabilityId → mode the operator holds (the RBAC the tools honor). */
  policy: Record<string, string>;
}

/** Read-only task snapshot for the operator's `get_task` tool. */
export function operatorSnapshot(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  authority: OperatorAuthority,
): OperatorTaskSnapshot {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!file) throw AppError.notFound(`Task ${taskKey} not found.`);
  const project = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!project) throw AppError.notFound(`Project ${projectSlug} not found.`);

  const fm = file.parsed.frontmatter;
  const stages = project.parsed.frontmatter.stages;
  const workflow = project.parsed.frontmatter.workflow;
  const stageName = (id: string) => stages.find((s) => s.id === id)?.name ?? id;
  const roles = resolveStageRoles(stages, workflow);
  const doneStageId = roles.terminalId;

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
    specialist: (() => {
      const delivering = deliveringEngagement(fm);
      return delivering
        ? {
            profileId: delivering.profileId,
            role: delivering.role,
            backend: delivering.backend,
          }
        : null;
    })(),
    reviewers: supportingEngagements(fm).map((r) => ({
      profileId: r.profileId,
      role: r.role,
      backend: r.backend,
    })),
    nextStages,
    stageIds: stages.map((s) => s.id),
    doneStageId,
    reviewStageId: roles.reviewId,
    workStageId: roles.workId,
    deployedSpecialists: listDeployedSpecialists(projectSlug, ctx).map((s) => ({
      ...s,
      eligibleForCurrentStage: specialistEligibleForStage(
        s,
        file.parsed.frontmatter.stage,
        { stages, workflow },
      ),
    })),
    openPacket: !!file.parsed.packet,
    packet: file.parsed.packet
      ? {
          type: file.parsed.packet.type,
          title: file.parsed.packet.title,
          body: file.parsed.packet.body,
          options: file.parsed.packet.options.map((o) => o.t),
        }
      : null,
    recentTimeline: file.parsed.timeline.slice(0, 6).map((e) => ({
      type: e.type,
      actor:
        e.actor.kind === "human"
          ? (e.actor.nameHint ?? "human")
          : e.actor.kind,
      // Timeline comments store the agent's FULL report (no 1,200-char cap
      // since 2026-07-17) — cap here so six entries can't balloon the prompt.
      text:
        e.text.length > 1500 ? e.text.slice(0, 1497) + "…" : e.text,
    })),
    // P13-D-4: expose the review PR. `state: "closed"` means a human closed it
    // on GitHub WITHOUT merging — an out-of-band rejection the operator must
    // not paper over by recommending or accepting completion.
    pr: fm.pr
      ? { number: fm.pr.number, state: fm.pr.state, title: fm.pr.title }
      : null,
    // The task branch, so recovery copy can NAME what an `archive_task`
    // option with `deleteBranch: true` would delete instead of gesturing at
    // "the branch".
    branch: fm.branch ?? null,
    liveRuns: (
      db
        .prepare(
          `SELECT kind, agent_profile_id, state FROM agent_runs
           WHERE project_slug = ? AND task_key = ?
             AND state IN ('queued', 'running')
           ORDER BY rowid`,
        )
        .all(projectSlug, taskKey) as {
        kind: string;
        agent_profile_id: string | null;
        state: string;
      }[]
    ).map((r) => ({
      kind: r.kind as "operator" | "primary" | "reviewer",
      profileId: r.agent_profile_id,
      state: r.state as "queued" | "running",
    })),
    autonomy: authority.autonomy,
    policy: Object.fromEntries(authority.policy),
  };
}

// ------------------------------------------------------------- actions

/** Post an operator comment (governed by append-typed-events). */
export async function operatorPostComment(
  db: DatabaseSync,
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

/** Fill only an unspecified goal; established scope remains human-controlled. */
export async function operatorSetGoal(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; goal: string; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "append-typed-events") === "deny") {
    return { outcome: "denied", message: "The operator cannot draft the goal in this project." };
  }
  const goal = input.goal.trim();
  if (goal.length < 3) {
    return { outcome: "noop", message: "A goal of at least 3 characters is required." };
  }
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) {
    return { outcome: "denied", message: `Task ${input.taskKey} not found.` };
  }
  const current = existing.parsed.goal.trim();
  if (current !== "" && current !== DEFAULT_GOAL) {
    return {
      outcome: "denied",
      message:
        "The goal is already specified — open an edit_goal packet to propose a change instead of overwriting it.",
    };
  }
  if (current === goal) {
    return { outcome: "noop", message: "Goal unchanged." };
  }
  let clearedPacket = false;
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.goal = goal;
    // Fulfil an awaiting goal-edit packet (the operator drafted the scope the
    // human asked it to) — clear it + lift its readiness gate, exactly like
    // updateTaskGoal does for a human edit.
    if (parsed.packet?.awaiting === "goal_edit") {
      const wasBlocked = parsed.packet.type === "blocked";
      parsed.packet = null;
      clearedPacket = true;
      if (wasBlocked && parsed.frontmatter.readiness === "blocked") {
        parsed.frontmatter.readiness = "ready";
      }
    }
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      // A drafted goal is a neutral lifecycle note, not a policy violation
      // (P13-LV-03 — this rendered as a coral "Policy violation" shield).
      type: "note",
      actor: { kind: "operator" },
      title: "Goal drafted",
      text: input.reason?.trim()
        ? `The operator drafted the task goal — ${input.reason.trim()}. Downstream agents re-anchor on the new goal.`
        : "The operator drafted the task goal from the request. Downstream agents re-anchor on the new goal.",
      toAgent: false,
      evidence: null,
    });
  });
  if (clearedPacket) {
    markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey);
  }
  reproject(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.goal.updated",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { by: "operator" },
  });
  return { outcome: "done", message: "Task goal drafted." };
}

/** Assign the primary specialist (governed by assign-primary-specialist). */
export async function operatorAssignSpecialist(
  db: DatabaseSync,
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
    const name = specialistName(ctx, input.projectSlug, input.profileId);
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
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = gate(authority, "assign-primary-specialist");
  if (g === "deny") {
    return { outcome: "denied", message: "Running the specialist is not permitted for the operator here." };
  }
  if (g === "recommend") {
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      { kind: "run_specialist", label: "Start the primary specialist's run" },
      "The specialist is ready to work this task; a maintainer starts the run.",
    );
    return { outcome: "recommended", message: "Recommended starting the primary specialist's run." };
  }
  const result = await startAgentRun(db, input, OPERATOR_TASK_ACTOR, opCtx(ctx));
  return {
    outcome: "done",
    message: `Started a ${result.backend === "claude" ? "Claude Code" : "Codex"} run for the ${result.role} specialist.`,
  };
}

/** Engage a reviewer (governed by summon-reviewers). */
export async function operatorAssignReviewer(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; profileId: string; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = gate(authority, "summon-reviewers");
  if (g === "deny") {
    return { outcome: "denied", message: "Summoning reviewers is not permitted for the operator here." };
  }
  if (g === "recommend") {
    const name = specialistName(ctx, input.projectSlug, input.profileId);
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
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; profileId: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = gate(authority, "summon-reviewers");
  if (g === "deny") {
    return { outcome: "denied", message: "Running a reviewer is not permitted for the operator here." };
  }
  if (g === "recommend") {
    const name = specialistName(ctx, input.projectSlug, input.profileId);
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      { kind: "run_reviewer", profileId: input.profileId, label: `Start ${name}'s review run` },
      `${name} is engaged as a reviewer; a maintainer starts the review run.`,
    );
    return { outcome: "recommended", message: `Recommended starting ${name}'s review run.` };
  }
  const result = await startAgentRun(db, input, OPERATOR_TASK_ACTOR, opCtx(ctx));
  return {
    outcome: "done",
    message: `Started a ${result.backend === "claude" ? "Claude Code" : "Codex"} run for the ${result.role} reviewer.`,
  };
}

// --------------------------------------------------- prompt (engage + trigger)

/** Resolve a deployed specialist's role + backend for a prompt/run. */
function deployedAgent(
  ctx: TaskMutationContext,
  projectSlug: string,
  profileId: string,
): DeployedSpecialistView | null {
  return (
    listDeployedSpecialists(projectSlug, ctx).find((s) => s.id === profileId) ??
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
  db: DatabaseSync,
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
      { dataRoot: ctx.dataRoot },
    );
  } catch {
    // Non-fatal: coordination proceeds without a branch when GitHub is absent.
  }
}

/** Title / goal / current stage name for building a default prompt directive. */
function taskContext(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): { title: string; goal: string; stageName: string } {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  const project = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  const title = file?.parsed.frontmatter.title ?? taskKey;
  const goal = file?.parsed.goal ?? "";
  const stageId = file?.parsed.frontmatter.stage ?? "";
  const stageName =
    project?.parsed.frontmatter.stages.find((s) => s.id === stageId)?.name ?? stageId;
  return { title, goal, stageName };
}

/** Assign and prompt the stage's delivering specialist, or recommend the handoff. */
export async function operatorPromptSpecialist(
  db: DatabaseSync,
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
  const agent = deployedAgent(ctx, input.projectSlug, input.profileId);
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
  const currentPrimary = file
    ? (deliveringEngagement(file.parsed.frontmatter)?.profileId ?? null)
    : null;
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
  const c = taskContext(ctx, input.projectSlug, input.taskKey);
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
  db: DatabaseSync,
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
  const agent = deployedAgent(ctx, input.projectSlug, input.profileId);
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
  const c = taskContext(ctx, input.projectSlug, input.taskKey);
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

// ------------------------------------------------- generic agent dispatch

/** Best-effort audit trace for every operator profile selection. */
function recordAgentSelectionTrace(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId: string;
    delivers: boolean;
    reason?: string;
  },
): void {
  try {
    const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    const stage = file?.parsed.frontmatter.stage;
    const engaged = new Set(
      (file?.parsed.frontmatter.engagements ?? []).map((e) => e.profileId),
    );
    const candidates = listDeployedSpecialists(input.projectSlug, ctx).map(
      (s) => ({
        profileId: s.id,
        eligibleForStage: stage
          ? specialistEligibleForStage(s, stage, projectBoard(ctx, input.projectSlug))
          : false,
        alreadyEngaged: engaged.has(s.id),
        chosen: s.id === input.profileId,
      }),
    );
    recordAudit(db, {
      action: "task.operator.agent_selected",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: {
        chosen: input.profileId,
        delivers: input.delivers,
        reason: input.reason ?? null,
        candidates,
      },
    });
  } catch {
    // Tracing must never block a routing decision.
  }
}

export async function operatorEngageAgent(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId: string;
    delivers: boolean;
    reason?: string;
  },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const { profileId, projectSlug, taskKey } = input;
  const base = { projectSlug, taskKey, profileId };
  recordAgentSelectionTrace(db, ctx, input);
  return input.delivers
    ? operatorAssignSpecialist(
        db,
        ctx,
        { ...base, ...(input.reason ? { reason: input.reason } : {}) },
        authority,
      )
    : operatorAssignReviewer(
        db,
        ctx,
        { ...base, ...(input.reason ? { reason: input.reason } : {}) },
        authority,
      );
}

/** Resolve whether `profileId` names the task's delivering engagement (or the
 * intended one): explicit hint wins; an engaged profile keeps its shape; an
 * unengaged profile delivers iff the task has no deliverer yet. */
function resolveDeliversIntent(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  profileId: string | undefined,
  hint: boolean | undefined,
): boolean {
  if (hint !== undefined) return hint;
  const file = readTaskFile({
    projectSlug,
    taskKey,
    dataRoot: ctx.dataRoot,
  });
  const fm = file?.parsed.frontmatter;
  if (!fm) return !profileId;
  const delivering = deliveringEngagement(fm);
  if (!profileId) return true;
  if (delivering?.profileId === profileId) return true;
  if (fm.engagements.some((e) => e.profileId === profileId)) return false;
  return delivering === null;
}

export async function operatorRunAgent(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId?: string;
    delivers?: boolean;
  },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const delivers = resolveDeliversIntent(
    ctx,
    input.projectSlug,
    input.taskKey,
    input.profileId,
    input.delivers,
  );
  const base = { projectSlug: input.projectSlug, taskKey: input.taskKey };
  if (delivers) {
    // P11-22: a delivering run always runs the CURRENT deliverer
    // (operatorRunSpecialist ignores profileId). If the plan names a specific
    // profileId that is NOT the current deliverer, DON'T silently run the wrong
    // agent — refuse and point the operator at engage_agent to change who
    // delivers (the single-deliverer invariant means only one can).
    if (input.profileId) {
      const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
      const current = file
        ? deliveringEngagement(file.parsed.frontmatter)?.profileId ?? null
        : null;
      if (current && current !== input.profileId) {
        return {
          outcome: "denied",
          message:
            `"${input.profileId}" is not the delivering agent ("${current}" is). ` +
            "Engage it as the deliverer first if you want it to deliver — a delivering run always runs the current deliverer.",
        };
      }
    }
    return operatorRunSpecialist(db, ctx, base, authority);
  }
  if (!input.profileId) {
    return {
      outcome: "denied",
      message: "A profileId is required to run a supporting agent.",
    };
  }
  return operatorRunReviewer(
    db,
    ctx,
    { ...base, profileId: input.profileId },
    authority,
  );
}

export async function operatorPromptAgentGeneric(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId: string;
    directive?: string;
    delivers?: boolean;
    reason?: string;
  },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const delivers = resolveDeliversIntent(
    ctx,
    input.projectSlug,
    input.taskKey,
    input.profileId,
    input.delivers,
  );
  // F10-35: prompt_agent is also a routing decision — record its selection trace.
  recordAgentSelectionTrace(db, ctx, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    profileId: input.profileId,
    delivers,
    ...(input.reason ? { reason: input.reason } : {}),
  });
  const base = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    profileId: input.profileId,
    ...(input.directive ? { directive: input.directive } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
  return delivers
    ? operatorPromptSpecialist(db, ctx, base, authority)
    : operatorPromptReviewer(db, ctx, base, authority);
}

/**
 * R15-2: DELIVER the task — push the deliverer's branch and open (or reuse) the
 * review PR. Delivery is the operator's decision, gated by `deliver-review-pr`:
 * `direct` performs it via the shared `performDelivery` core and reports the
 * push + PR outcome honestly (including `push_conflict`); `recommend` posts a
 * `delivery` recommendation card a human applies. The server executes the
 * mechanics either way; agents never push or open PRs themselves.
 */
export async function operatorDeliverForReview(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = deliverGate(authority);
  if (g === "deny") {
    return {
      outcome: "denied",
      message: "Delivering the branch & opening the review PR is not permitted for the operator here.",
    };
  }
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) {
    return { outcome: "noop", message: `Task ${input.taskKey} not found.` };
  }
  const pr = existing.parsed.frontmatter.pr;
  if (pr && pr.state !== "closed" && pr.state !== "merged") {
    // Idempotent: a live PR already stands for review. performDelivery would
    // reuse it, but a fresh push of an unchanged workspace is wasted motion —
    // report the live PR instead.
    return {
      outcome: "noop",
      message: `PR #${pr.number} is already open for review — nothing to deliver.`,
    };
  }
  if (g === "recommend") {
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      { kind: "delivery", label: "Deliver the branch & open the review PR" },
      input.reason ??
        "The work is committed and ready for review; delivering pushes the task branch and opens the review PR.",
    );
    return {
      outcome: "recommended",
      message: "Recommended delivering the branch & opening the review PR.",
    };
  }
  const outcome = await performDelivery(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    OPERATOR_TASK_ACTOR,
  );
  recordAudit(db, {
    action: "github.delivery.operator",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      status: outcome.status,
      ...(outcome.status === "delivered" ? { prNumber: outcome.prNumber } : {}),
    },
  });
  switch (outcome.status) {
    case "delivered":
      return {
        outcome: "done",
        message:
          `Delivered: push ${outcome.pushStatus === "pushed" ? "succeeded" : `skipped (${outcome.pushStatus})`}, ` +
          (outcome.created
            ? `opened review PR #${outcome.prNumber}.`
            : `reusing open review PR #${outcome.prNumber}.`),
      };
    case "push_conflict":
      return {
        outcome: "noop",
        message:
          `Delivery push CONFLICTED: ${outcome.message}. No PR was opened. This is a ` +
          `branch-history conflict on \`${outcome.branch}\`, not a credential problem — ` +
          `open a decision packet so a human resolves the remote branch (delete/rename ` +
          `or deliberate force-push) or archives the task.`,
      };
    case "grant_withheld":
    case "push_failed":
    case "nothing_to_review":
    case "failed":
      return { outcome: "noop", message: `Delivery did not complete: ${outcome.message}` };
  }
}

export async function operatorTransitionStage(
  db: DatabaseSync,
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
  // R7-4 rework routing: a BACKWARD move to an earlier stage on a task whose
  // latest review is `failing` sends the rejected work back to the developer.
  // The operator does this directly (no human, no recommendation) so a failed
  // review re-drives itself; transitionStage vets that it is genuinely backward
  // + failing before honoring the off-graph move.
  const isRework = isReworkMove(ctx, input.projectSlug, input.taskKey, input.toStageId);
  const boundary = operatorBoundaryFor(ctx, input.projectSlug, input.taskKey, input.toStageId);
  if (g === "recommend" && boundary !== "auto" && !isRework) {
    const name = stageNameOf(ctx, input.projectSlug, input.toStageId);
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
  const task = await transitionStage(
    db,
    { ...input, ...(isRework ? { rework: true } : {}) },
    OPERATOR_TASK_ACTOR,
    opCtx(ctx),
  );
  return { outcome: "done", message: `Moved ${input.taskKey} to ${task.stage}.` };
}

/** Resolve a stage's display name for a recommendation label. */
function stageNameOf(
  ctx: TaskMutationContext,
  projectSlug: string,
  stageId: string,
): string {
  const file = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  return file?.parsed.frontmatter.stages.find((s) => s.id === stageId)?.name ?? stageId;
}

/** True when moving `taskKey` to `toStageId` is an operator rework move (R7-4):
 *  a BACKWARD step to an earlier stage on a task whose latest review is
 *  `failing`. The operator performs these directly to route a rejected task
 *  back to the developer without a human. */
function isReworkMove(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  toStageId: string,
): boolean {
  const task = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  const project = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!task || !project) return false;
  if (task.parsed.frontmatter.validation !== "failing") return false;
  const stages = project.parsed.frontmatter.stages;
  const fromIndex = stages.findIndex((s) => s.id === task.parsed.frontmatter.stage);
  const toIndex = stages.findIndex((s) => s.id === toStageId);
  return toIndex >= 0 && fromIndex >= 0 && toIndex < fromIndex;
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
    dataRoot: ctx.dataRoot,
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
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!file) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const project = readProjectFile({
    projectSlug: input.projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!project) throw AppError.notFound(`Project ${input.projectSlug} not found.`);
  const stages = project.parsed.frontmatter.stages;
  // B-WF4: the STRUCTURAL terminal stage (one resolver everywhere), positional
  // only as the degenerate fallback.
  const doneStageId =
    resolveStageRoles(stages, project.parsed.frontmatter.workflow).terminalId ??
    stages[stages.length - 1]?.id ??
    "done";

  if (file.parsed.frontmatter.stage === doneStageId) {
    return { outcome: "noop", message: `${input.taskKey} is already Done.` };
  }

  // P14-LV-02/B-WF6: ONE shared gate — `acceptanceRefusalFor` reads the same
  // helper every human writer does (graph position, required reviewers, the
  // R15-1 verdict gate, blocked packet, closed/conflicting PR, archived task).
  // The per-gate copies this function used to stack on top had already drifted
  // in wording and would drift in behavior next. Checked before BOTH branches
  // below, so a supervised operator never posts a card acceptance would refuse
  // and a full-autonomy one never closes a task off-gate.
  {
    const refusal = acceptanceRefusalFor(
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      ctx,
    );
    if (refusal) return { outcome: "noop", message: refusal };
  }

  // Supervised (or without the completion capability) → recommend only: post an
  // actionable "accept completion → Done" recommendation card (symmetric with the
  // other stage-transition cards, so the review→done boundary gets the same clear
  // one-click prompt as impl→review) — never move to Done ourselves. A
  // maintainer applies it to accept completion into Done.
  if (authority.autonomy !== "full" || gate(authority, "completion-for-acceptance") !== "direct") {
    const doneName = stageNameOf(ctx, input.projectSlug, doneStageId);
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
      `The review is clean and the work meets the goal. Accepting completion moves ${input.taskKey} to ${doneName} and merges the review PR when GitHub is reachable — otherwise it records the PR as accepted (merge pending).`,
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
  // B-WF6: the Done write itself is the SHARED acceptance core
  // (`applyAcceptanceWrite`) — this inlined mutation historically mirrored the
  // human path gate by gate and shipped with a subset more than once. The core
  // also re-checks the refusal gates inside the write lock (B-WF1).
  const hasPr = !!file.parsed.frontmatter.pr;
  await applyAcceptanceWrite(db, ctx, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    doneStageId,
    prState: "accepted",
    event: {
      occurredAt: new Date().toISOString(),
      type: "completion",
      actor: { kind: "operator" },
      title: "Completion accepted",
      text: hasPr
        ? `Operator accepted completion under **full-autonomy** policy — ${input.taskKey} moved to Done; the review PR is **accepted, merge pending** (a human merges it).`
        : `Operator accepted completion under **full-autonomy** policy — ${input.taskKey} moved to Done.`,
      toAgent: false,
      evidence: null,
    },
  });
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
