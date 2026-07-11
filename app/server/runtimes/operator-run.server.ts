import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import {
  getDataRoot,
  agentProfilesDir,
  skillDirPath,
  kbDirPath,
} from "~/server/files/file-store-root.server";
import { splitFrontmatter } from "~/server/files/frontmatter.server";
import { logger } from "~/server/logging/logger.server";
import type { LogLine } from "~/features/runtime/runtime-types";
import { newId } from "~/shared/ids/new-id.server";
import {
  gate,
  operatorAcceptCompletion,
  operatorAssignReviewer,
  operatorAssignSpecialist,
  operatorOpenPacket,
  operatorPostComment,
  operatorPromptReviewer,
  operatorPromptSpecialist,
  operatorRunReviewer,
  operatorRunSpecialist,
  operatorSnapshot,
  operatorTransitionStage,
  resolveOperatorAuthority,
  type OperatorAuthority,
  type OperatorAutonomy,
  type OperatorTaskSnapshot,
} from "~/server/tasks/operator-actions.server";
import type { PacketOptionKind } from "~/schemas/task-file.schema";
import { buildOperatorToolkit } from "~/server/tasks/operator-toolkit.server";
import { normalizeEscapedNewlines } from "~/server/tasks/model-prose.server";
import { replyTextForRun } from "~/server/tasks/agent-reply.server";
import type { TaskMutationContext } from "~/server/tasks/task-actions.server";
import { isBackendAvailable, type RealBackend } from "./runtime-registry.server";
import { registerRunCompletion, startRun } from "./run-service.server";
import { buildScript } from "./simulated-runtime.server";

/**
 * Runs the OPERATOR as a real agent (Claude Code) or a deterministic scripted
 * drive (Codex / offline). The operator is given its persona (agent
 * definition) + the Viberr app-expertise skill as a system prompt, plus the
 * in-process governance tools (operator-toolkit). It drives the task toward
 * its next boundary under its capability policy + autonomy level.
 *
 *   claude + credential present → REAL tool-driven run: the model calls the
 *     `mcp__viberr__*` tools; every call mutates the store and updates the
 *     board live. This is the path the "operator end to end" proof exercises.
 *   codex, or claude unavailable → SCRIPTED drive: the same operator-actions
 *     are called deterministically in code (the board still advances honestly),
 *     and a simulated run streams the narrative to the agent logs. Codex has no
 *     in-process tool channel, so it always takes this path.
 */

const OPERATOR_AUDIT_ACTOR: AuditActor = { userId: null, label: "operator" };

export interface RunOperatorInput {
  projectSlug: string;
  taskKey: string;
  /** Backend to run the operator on (claude|codex). Defaults to the deployment. */
  backend?: RealBackend;
  /** Autonomy for THIS run (supervised|full). Defaults to the deployment. */
  autonomy?: OperatorAutonomy;
  /**
   * Why this operator run fired, which shapes what it does:
   *   create / transition / manual → COORDINATE: prompt the stage's agent with a
   *     task-related "@handle …" directive, then stop and wait for it to report.
   *   agent-reply → REACT: an agent the operator prompted just replied — read its
   *     report and propose the next state change (recommend/perform the transition
   *     or accept completion), rather than re-prompting.
   */
  trigger?: "create" | "transition" | "agent-reply" | "manual";
  /** Depth of the react re-invocation chain (bounds the prompt↔react loop). */
  reactDepth?: number;
  /** A human's `@operator …` comment to address in this run (when a person
   *  talks to the operator directly). The operator reads it and responds. */
  humanComment?: string;
  dataRoot?: string;
  actor?: AuditActor;
}

export interface RunOperatorResult {
  runId: string;
  backend: RealBackend;
  /** "real" = LLM tool-driven · "scripted" = deterministic drive. */
  mode: "real" | "scripted";
  autonomy: OperatorAutonomy;
}

/** A queued/running operator run for the same task, if one is already in flight. */
function inFlightOperatorRun(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
): { id: string; backend: RealBackend } | null {
  const row = db
    .prepare(
      `SELECT id, backend FROM agent_runs
       WHERE project_slug = ? AND task_key = ? AND kind = 'operator'
         AND state IN ('queued', 'running')
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(projectSlug, taskKey) as { id: string; backend: string } | undefined;
  return row ? { id: row.id, backend: row.backend as RealBackend } : null;
}

export async function runOperator(
  db: Database.Database,
  input: RunOperatorInput,
): Promise<RunOperatorResult> {
  const ctx: TaskMutationContext = {
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  };
  const authority = resolveOperatorAuthority(ctx, input.projectSlug, {
    ...(input.backend ? { backend: input.backend } : {}),
    ...(input.autonomy ? { autonomy: input.autonomy } : {}),
  });
  const backend = authority.backend;

  // Single-flight per task (NFR16, B6): one operator coordinates a task at a
  // time. Concurrent triggers — e.g. create-time auto-invoke racing an
  // "@operator …" comment, or two drag-transitions — must not start overlapping
  // operator runs that double-assign or lose writes. If a run is already
  // queued/running for this task, coalesce onto it instead of starting another.
  // (The react loop is unaffected: it re-invokes only AFTER the prompting run
  // has finished, so no run is in flight at that point.)
  const inflight = inFlightOperatorRun(db, input.projectSlug, input.taskKey);
  if (inflight) {
    logger.info("operator run coalesced — one already in flight", {
      taskKey: input.taskKey,
      runId: inflight.id,
      trigger: input.trigger ?? "manual",
    });
    return {
      runId: inflight.id,
      backend: inflight.backend,
      mode: inflight.backend === "claude" && isBackendAvailable("claude") ? "real" : "scripted",
      autonomy: authority.autonomy,
    };
  }

  // Carry the run's identity on the ctx so that when an agent this operator
  // prompts replies, the reply-completion hook can re-invoke the operator to
  // REACT (read the reply → propose a state change). The reactDepth bounds that
  // chain (see OPERATOR_REACT_DEPTH_CAP).
  ctx.operatorRun = {
    backend,
    autonomy: authority.autonomy,
    reactDepth: input.reactDepth ?? 0,
  };

  // Claude: real tool-driven operator (in-process MCP tools). Codex: no
  // in-process tool channel, so it runs a real STRUCTURED-OUTPUT operator (the
  // model emits a decision plan we execute through the same capability-gated
  // actions). Neither available → deterministic scripted drive.
  if (backend === "claude" && isBackendAvailable("claude")) {
    return startRealOperatorRun(db, ctx, input, authority);
  }
  if (backend === "codex" && isBackendAvailable("codex")) {
    return startCodexOperatorRun(db, ctx, input, authority);
  }
  return runScriptedOperatorDrive(db, ctx, input, authority);
}

// ------------------------------------------------- codex (structured output)

/**
 * JSON schema constraining the codex operator's decision plan. OpenAI strict
 * structured output requires EVERY object to set additionalProperties:false and
 * list ALL properties in `required` — optional fields are expressed as nullable
 * (the model emits null when unused). The executor treats null/"" as absent.
 */
const OPERATOR_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reasoning: {
      type: "string",
      description: "A concise operator comment: observed → changed → recommended → decision required.",
    },
    actions: {
      type: "array",
      description: "The coordination actions to take, in order.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          tool: {
            type: "string",
            enum: [
              "post_comment",
              "open_packet",
              "assign_specialist",
              "run_specialist",
              "prompt_specialist",
              "assign_reviewer",
              "run_reviewer",
              "prompt_reviewer",
              "transition_stage",
              "accept_completion",
            ],
          },
          profileId: { type: ["string", "null"], description: "For assign_/run_/prompt_ actions, else null." },
          toStageId: { type: ["string", "null"], description: "For transition_stage, else null." },
          packetType: { type: ["string", "null"], enum: ["input", "blocked", null], description: "For open_packet: 'blocked' when work is stuck, 'input' for a decision; else null." },
          text: { type: ["string", "null"], description: "For post_comment and prompt_/open_packet: the comment text, agent prompt, or packet title; else null." },
          reason: { type: ["string", "null"], description: "Short why — recommendation-card reasoning, or the packet body for open_packet." },
        },
        required: ["tool", "profileId", "toStageId", "packetType", "text", "reason"],
      },
    },
  },
  required: ["reasoning", "actions"],
} as const;

interface OperatorPlanAction {
  tool: string;
  profileId?: string;
  toStageId?: string;
  packetType?: "input" | "blocked";
  text?: string;
  reason?: string;
}

/**
 * The Codex plan schema is flat, so it can't author rich per-option packets the
 * way Claude's `open_decision_packet` tool does. We give the Codex operator a
 * usable default option set keyed to the packet type instead — the human still
 * gets a real, resolvable FR26 packet rather than a comment wall.
 */
function defaultPacketOptions(
  packetType: "input" | "blocked",
): { kind: PacketOptionKind; title: string; recommended?: boolean }[] {
  return packetType === "blocked"
    ? [
        { kind: "block_on_policy", title: "Update the policy / credential and unblock", recommended: true },
        { kind: "redirect", title: "Redirect the specialist with new guidance" },
        { kind: "hold_runtime_debug", title: "Hold for runtime debugging" },
      ]
    : [
        { kind: "request_edit", title: "Send back to the specialist for changes", recommended: true },
        { kind: "redirect", title: "Reassign or redirect the work" },
      ];
}

async function startCodexOperatorRun(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
): Promise<RunOperatorResult> {
  const snapshot = operatorSnapshot(db, ctx, input.projectSlug, input.taskKey, authority);
  const prompt = buildCodexOperatorPrompt(
    authority,
    snapshot,
    input.trigger ?? "manual",
    input.dataRoot,
    input.humanComment,
  );

  const { runId } = await startRun(db, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId: "op-" + newId("t").replace("t_", "").slice(0, 8),
    role: "Operator",
    kind: "operator",
    backend: "codex",
    model: authority.model,
    ...(authority.effort ? { effort: authority.effort } : {}),
    agentName: authority.name,
    agentProfileId: "operator",
    prompt,
    outputSchema: OPERATOR_PLAN_SCHEMA,
    autonomous: true,
    actor: input.actor ?? OPERATOR_AUDIT_ACTOR,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  });

  // When the run finishes, parse its decision plan and execute it through the
  // capability-gated operator-actions (so codex honors the exact same RBAC +
  // autonomy as the Claude tool-driven operator).
  registerRunCompletion(runId, (finished) => {
    void executeCodexPlan(db, ctx, input, authority, finished.id).catch((error) => {
      logger.error("codex operator plan execution failed", {
        taskKey: input.taskKey,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    });
  });

  logger.info("operator run started (codex structured output)", {
    taskKey: input.taskKey,
    runId,
    autonomy: authority.autonomy,
  });
  return { runId, backend: "codex", mode: "real", autonomy: authority.autonomy };
}

/** Pull the first JSON object out of a model response (tolerates prose around it). */
function extractPlanJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Execute a finished codex operator run's decision plan (capability-gated). */
async function executeCodexPlan(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
  runId: string,
): Promise<void> {
  const text = replyTextForRun(db, runId);
  if (!text) {
    logger.info("codex operator produced no plan text", { taskKey: input.taskKey, runId });
    return;
  }
  const plan = extractPlanJson(text) as
    | { reasoning?: string; actions?: OperatorPlanAction[] }
    | null;
  if (!plan) {
    logger.warn("codex operator plan was not valid JSON", { taskKey: input.taskKey, runId });
    return;
  }
  // The plan's prose fields persist to the timeline / packets — repair
  // double-escaped `\n` sequences the model emitted inside its JSON strings
  // (finding #23: literal "\n" rendered verbatim in the UI).
  if (plan.reasoning) plan.reasoning = normalizeEscapedNewlines(plan.reasoning);
  for (const a of plan.actions ?? []) {
    if (a.text) a.text = normalizeEscapedNewlines(a.text);
    if (a.reason) a.reason = normalizeEscapedNewlines(a.reason);
  }
  const base = { projectSlug: input.projectSlug, taskKey: input.taskKey };
  // One operator turn → one comment. The plan's `reasoning` IS that comment;
  // codex often ALSO emits redundant `post_comment` actions repeating it almost
  // verbatim (observed live: three near-identical "Observed…/Recommended…"
  // comments in one turn). Track what we've already said and drop duplicates so
  // the timeline stays a decision log, not an echo chamber.
  const postedComments = new Set<string>();
  const commentKey = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  if (plan.reasoning) {
    await operatorPostComment(db, ctx, { ...base, text: plan.reasoning }, authority);
    postedComments.add(commentKey(plan.reasoning));
  }
  for (const a of plan.actions ?? []) {
    try {
      switch (a.tool) {
        case "post_comment":
          if (a.text && !postedComments.has(commentKey(a.text))) {
            await operatorPostComment(db, ctx, { ...base, text: a.text }, authority);
            postedComments.add(commentKey(a.text));
          }
          break;
        case "open_packet": {
          const packetType = a.packetType === "blocked" ? "blocked" : "input";
          if (a.text)
            await operatorOpenPacket(
              db,
              ctx,
              {
                ...base,
                packetType,
                title: a.text,
                ...(a.reason ? { body: a.reason } : {}),
                options: defaultPacketOptions(packetType),
              },
              authority,
            );
          break;
        }
        case "assign_specialist":
          if (a.profileId)
            await operatorAssignSpecialist(
              db,
              ctx,
              { ...base, profileId: a.profileId, ...(a.reason ? { reason: a.reason } : {}) },
              authority,
            );
          break;
        case "run_specialist":
          await operatorRunSpecialist(db, ctx, base, authority);
          break;
        case "prompt_specialist":
          if (a.profileId)
            await operatorPromptSpecialist(
              db,
              ctx,
              { ...base, profileId: a.profileId, ...(a.text ? { directive: a.text } : {}) },
              authority,
            );
          break;
        case "assign_reviewer":
          if (a.profileId)
            await operatorAssignReviewer(
              db,
              ctx,
              { ...base, profileId: a.profileId, ...(a.reason ? { reason: a.reason } : {}) },
              authority,
            );
          break;
        case "run_reviewer":
          if (a.profileId) await operatorRunReviewer(db, ctx, { ...base, profileId: a.profileId }, authority);
          break;
        case "prompt_reviewer":
          if (a.profileId)
            await operatorPromptReviewer(
              db,
              ctx,
              { ...base, profileId: a.profileId, ...(a.text ? { directive: a.text } : {}) },
              authority,
            );
          break;
        case "transition_stage":
          if (a.toStageId)
            await operatorTransitionStage(
              db,
              ctx,
              { ...base, toStageId: a.toStageId, ...(a.reason ? { reason: a.reason } : {}) },
              authority,
            );
          break;
        case "accept_completion":
          await operatorAcceptCompletion(db, ctx, base, authority);
          break;
      }
    } catch (error) {
      logger.error("codex operator action failed", {
        taskKey: input.taskKey,
        tool: a.tool,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}

// ------------------------------------------------------- real (tool-driven)

async function startRealOperatorRun(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
): Promise<RunOperatorResult> {
  const snapshot = operatorSnapshot(db, ctx, input.projectSlug, input.taskKey, authority);
  const systemPrompt = buildOperatorSystemPrompt(authority, input.dataRoot);
  const toolkit = buildOperatorToolkit({
    db,
    ctx,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    authority,
  });
  const prompt = buildOperatorTurnPrompt(snapshot, input.trigger ?? "manual", input.humanComment);

  const { runId } = await startRun(db, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId: "op-" + newId("t").replace("t_", "").slice(0, 8),
    role: "Operator",
    kind: "operator",
    backend: "claude",
    model: authority.model,
    ...(authority.effort ? { effort: authority.effort } : {}),
    agentName: authority.name,
    agentProfileId: "operator",
    prompt,
    systemPrompt,
    mcpServers: toolkit.mcpServers,
    allowedTools: toolkit.allowedTools,
    autonomous: true,
    actor: input.actor ?? OPERATOR_AUDIT_ACTOR,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  });

  logger.info("operator run started (real)", {
    taskKey: input.taskKey,
    runId,
    autonomy: authority.autonomy,
  });
  return { runId, backend: "claude", mode: "real", autonomy: authority.autonomy };
}

// ------------------------------------------------------- scripted drive

/**
 * Deterministic operator supervision: performs the same capability-gated
 * operator-actions in code, so a Codex / offline operator still moves the board.
 * Terminates: it makes at most one forward action per stage, stopping the first
 * time an action is only recommended (supervised autonomy) or denied.
 */
async function runScriptedOperatorDrive(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
): Promise<RunOperatorResult> {
  const { projectSlug, taskKey } = input;
  const lines: LogLine[] = [];
  const say = (text: string) =>
    lines.push({ t: "", ev: "text", tag: "assistant", text });

  lines.push({
    t: "",
    ev: "init",
    tag: "system·init",
    text: `operator runtime · ${authority.autonomy} autonomy · anchored projects/${projectSlug}/tasks/${taskKey}/task.md`,
  });

  try {
    const isReact = (input.trigger ?? "manual") === "agent-reply";
    let snap = operatorSnapshot(db, ctx, projectSlug, taskKey, authority);
    const doneStageId = snap.doneStageId;
    // Classify stages from the workflow graph (NOT positionally): the review
    // stage has an edge into Done, the work stage an edge into review. This is
    // correct for custom/lightweight boards, not just the default 5-stage one.
    const reviewStageId = snap.reviewStageId;
    const workStageId = snap.workStageId;

    say(
      `Supervising ${taskKey} at stage “${snap.stageName}” — ${isReact ? "reacting to an agent report" : "coordinating"}. Autonomy: ${authority.autonomy}.`,
    );

    // COORDINATE the current stage: prompt its agent (reviewer at the review
    // stage, specialist at the work stage), advancing through any pre-work
    // stages first. Stops once it has prompted an agent (now waiting for that
    // agent to report) or hit a recommend boundary under supervised autonomy.
    const coordinate = async () => {
      for (let step = 0; step < 8; step++) {
        snap = operatorSnapshot(db, ctx, projectSlug, taskKey, authority);
        if (snap.stage === doneStageId) return;
        if (snap.stage === reviewStageId) {
          // Prompt EVERY engaged reviewer (not just the first) so each records a
          // verdict; a single engaged/picked reviewer keeps the common case.
          const revIds = snap.reviewers.length
            ? snap.reviewers.map((r) => r.profileId)
            : [pickReviewer(snap)?.id].filter((x): x is string => !!x);
          if (revIds.length && gate(authority, "summon-reviewers") !== "deny") {
            for (const rev of revIds) {
              say(
                (await operatorPromptReviewer(db, ctx, { projectSlug, taskKey, profileId: rev }, authority)).message,
              );
            }
          }
          return;
        }
        if (snap.stage === workStageId || !workStageId) {
          const pick = snap.specialist
            ? snap.deployedSpecialists.find((s) => s.id === snap.specialist!.profileId) ??
              pickSpecialist(snap)
            : pickSpecialist(snap);
          if (pick && gate(authority, "assign-primary-specialist") !== "deny") {
            say(
              (await operatorPromptSpecialist(db, ctx, { projectSlug, taskKey, profileId: pick.id }, authority)).message,
            );
          }
          return;
        }
        // Pre-work stage — advance toward the work stage.
        const nid = snap.nextStages[0]?.id;
        if (!nid) return;
        const t = await operatorTransitionStage(db, ctx, { projectSlug, taskKey, toStageId: nid }, authority);
        say(t.message);
        if (t.outcome !== "done") return; // recommended (supervised) → stop.
      }
    };

    // REACT to an agent's report: propose the NEXT state change. Under full
    // autonomy the move is performed and the new stage is coordinated; under
    // supervised it is only recommended (a human bridges to the next stage).
    const react = async () => {
      snap = operatorSnapshot(db, ctx, projectSlug, taskKey, authority);
      if (snap.stage === doneStageId) return;
      if (snap.stage === reviewStageId) {
        say((await operatorAcceptCompletion(db, ctx, { projectSlug, taskKey }, authority)).message);
        return;
      }
      const nid = snap.nextStages[0]?.id;
      if (!nid) {
        say("No further governed transition from here — handing back to humans.");
        return;
      }
      const t = await operatorTransitionStage(db, ctx, { projectSlug, taskKey, toStageId: nid }, authority);
      say(t.message);
      if (t.outcome === "done") await coordinate(); // full: performed → coordinate the new stage.
    };

    // A human is talking to the operator directly (@operator) — acknowledge them
    // first, then continue coordinating.
    if (input.humanComment?.trim()) {
      await operatorPostComment(
        db,
        ctx,
        {
          projectSlug,
          taskKey,
          text: `**Operator:** got your message — "${input.humanComment.trim()}". Reviewing ${taskKey} at “${snap.stageName}” and continuing to coordinate.`,
        },
        authority,
      );
    }

    if (isReact) {
      await operatorPostComment(
        db,
        ctx,
        {
          projectSlug,
          taskKey,
          text: `**Read the agent's report on ${taskKey}.** Proposing the next state change based on what it reported.`,
        },
        authority,
      );
      await react();
    } else {
      await operatorPostComment(
        db,
        ctx,
        {
          projectSlug,
          taskKey,
          text: `**Operator (${authority.autonomy}) engaged.** Plan: prompt the stage's agent with a task-related @mention directive, then read its report before proposing the next transition.`,
        },
        authority,
      );
      await coordinate();
    }
  } catch (error) {
    logger.error("operator scripted drive failed", {
      taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    say("Operator halted on an error — see the task timeline.");
  }

  lines.push({
    t: "",
    ev: "result",
    tag: "result",
    text: "operator pass complete",
    stats: { subtype: "success", dur: 1200, api: 900, turns: 1, cost: 0, in: 0, cached: 0, out: 0 },
  });

  const sid = newId("op").replace("op_", "");
  const now = new Date().toISOString();
  const script = buildScript({
    lines,
    occurredAt: lines.map(() => now),
    sessionId: sid,
    backend: authority.backend,
    model: authority.model,
    op: true,
    keepRunning: false,
    instant: true,
  });

  const { runId } = await startRun(db, {
    projectSlug,
    taskKey,
    threadId: "op-" + newId("t").replace("t_", "").slice(0, 8),
    role: "Operator",
    kind: "operator",
    backend: authority.backend,
    model: authority.model,
    agentName: authority.name,
    agentProfileId: "operator",
    prompt: `Supervise ${taskKey} toward its next boundary.`,
    script,
    simulate: true,
    actor: input.actor ?? OPERATOR_AUDIT_ACTOR,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  });

  logger.info("operator run started (scripted)", {
    taskKey,
    runId,
    autonomy: authority.autonomy,
  });
  return { runId, backend: authority.backend, mode: "scripted", autonomy: authority.autonomy };
}

// ------------------------------------------------------- specialist picks

/** Prefer an implementation specialist eligible for the current stage. */
function pickSpecialist(snap: OperatorTaskSnapshot) {
  const specs = snap.deployedSpecialists;
  return (
    specs.find((s) => /develop|implement/i.test(s.role) || s.id === "developer") ??
    specs.find((s) => !/review/i.test(s.role)) ??
    specs[0] ??
    null
  );
}

/** Prefer a review specialist to engage before acceptance. */
function pickReviewer(snap: OperatorTaskSnapshot) {
  const specs = snap.deployedSpecialists.filter(
    (s) => !snap.reviewers.some((r) => r.profileId === s.id) && s.id !== snap.specialist?.profileId,
  );
  return (
    specs.find((s) => /review/i.test(s.role) || s.id === "reviewer") ??
    specs[0] ??
    null
  );
}

// ------------------------------------------------------- system prompt

/** Baked-in fallback persona when the store has no operator definition file. */
const FALLBACK_OPERATOR_DEFINITION = `You are the Operator: the coordinator for one Viberr task. You never write code and you never close a task unless full autonomy grants it. You are given the "viberr" governance tools and the Viberr app-expertise skill. Always call get_task first, then drive the task toward its next boundary using your tools, respecting your capability policy: perform direct actions, post recommendations for recommend-only actions and stop, and never attempt human-reserved actions. Keep every comment concise — each action appears on the human-visible board.`;

/** Read the shipped operator agent definition (body only), or the fallback. */
function readOperatorDefinition(dataRoot?: string): string {
  try {
    const file = path.join(agentProfilesDir(dataRoot), "..", "definitions", "operator.md");
    if (existsSync(file)) {
      const { body } = splitFrontmatter(readFileSync(file, "utf8"));
      const trimmed = body.trim();
      if (trimmed) return trimmed;
    }
  } catch {
    // fall through to the baked-in persona
  }
  return FALLBACK_OPERATOR_DEFINITION;
}

/** Read one skill's body from the store, or "" when absent. */
function readSkillBody(name: string, dataRoot?: string): string {
  try {
    const file = path.join(skillDirPath(name, dataRoot), "SKILL.md");
    if (existsSync(file)) {
      const { body } = splitFrontmatter(readFileSync(file, "utf8"));
      return body.trim();
    }
  } catch {
    // missing/unreadable skill — skip it
  }
  return "";
}

/**
 * Read a knowledge base's documents from the store (F6): every `.md` under
 * `data/kb/<dir>/`, concatenated (bounded so a large KB can't blow the context
 * window). Returns "" when the KB folder is absent — profile KB references that
 * don't resolve to a real store folder inject nothing, exactly as skills do.
 */
function readKbBody(name: string, dataRoot?: string): string {
  try {
    const dir = kbDirPath(name, dataRoot);
    if (!existsSync(dir)) return "";
    const docs: string[] = [];
    let budget = 24_000; // cap total KB text per run
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith(".md") || budget <= 0) continue;
      try {
        const raw = readFileSync(path.join(dir, entry), "utf8").trim();
        const slice = raw.slice(0, budget);
        budget -= slice.length;
        docs.push(`### ${entry}\n\n${slice}`);
      } catch {
        // unreadable doc — skip
      }
    }
    return docs.join("\n\n");
  } catch {
    return "";
  }
}

/** Assemble the operator's system prompt: persona + expertise + live policy. */
export function buildOperatorSystemPrompt(
  authority: OperatorAuthority,
  dataRoot?: string,
): string {
  const definition = readOperatorDefinition(dataRoot);
  const policyLines = [...authority.policy.entries()]
    .map(([id, mode]) => `- ${id}: ${mode}`)
    .join("\n");

  const parts = [definition];
  // Load EVERY declared skill that exists in the store (not just one), so the
  // operator's profile-declared skills are actually in its context.
  const skills = authority.skills.length ? authority.skills : ["viberr-app-expertise"];
  for (const name of skills) {
    const body = readSkillBody(name, dataRoot);
    if (body) parts.push(`\n\n---\n# ${name} (skill)\n\n${body}`);
  }
  // Inject declared knowledge-base docs into context (F6, FR9): the KB leg was
  // decorative — no run ever received KB content. Load every declared KB folder
  // that exists in the store, same as skills.
  for (const name of authority.kb) {
    const body = readKbBody(name, dataRoot);
    if (body) parts.push(`\n\n---\n# ${name} (knowledge base)\n\n${body}`);
  }
  parts.push(
    "\n\n---\n# Your authority for this task\n\n" +
      `Autonomy: **${authority.autonomy}**.\n\n` +
      "Capability policy (capabilityId: mode):\n" +
      policyLines +
      "\n\nRules:\n" +
      "- `direct` capabilities: act via the matching tool.\n" +
      "- `recommend` capabilities: under supervised autonomy the tool posts a recommendation and you must stop; under FULL autonomy it acts directly.\n" +
      "- `human` / `off` / withheld: the tool is not offered — never attempt it.\n" +
      "- When a task is at (or enters) a stage, TRIGGER its agent with a task-related prompt: prompt_specialist for a working stage, prompt_reviewer for the review stage. The prompt is the agent's directive — make it specific to this task and stage, never a bare 'proceed'.\n" +
      "- Reach Done ONLY via accept_completion, and only under full autonomy; otherwise recommend acceptance.\n" +
      "- Never write code, run shell commands, or touch the repository. You have only the `mcp__viberr__*` tools.",
  );
  return parts.join("");
}

/**
 * The full prompt for the CODEX structured-output operator. Codex has no
 * system-prompt field and no in-process tools, so the persona + expertise, the
 * live task snapshot, and the output instruction all go in one prompt; the
 * model returns a decision plan (constrained by OPERATOR_PLAN_SCHEMA) that we
 * execute through the same capability-gated actions.
 */
export function buildCodexOperatorPrompt(
  authority: OperatorAuthority,
  snapshot: OperatorTaskSnapshot,
  trigger: "create" | "transition" | "agent-reply" | "manual",
  dataRoot?: string,
  humanComment?: string,
): string {
  const persona = buildOperatorSystemPrompt(authority, dataRoot);
  const decision = humanComment?.trim()
    ? `A human just addressed YOU directly with: "${humanComment.trim()}". RESPOND to them: put your reply to the human in \`reasoning\` (answer their question or acknowledge their instruction, grounded in the task state), and add any coordination actions their message warrants (prompt an agent, transition, etc.) — or none if a reply is all that's needed.`
    : trigger === "agent-reply"
      ? "An agent you prompted has just REPORTED BACK (its latest reply is in recentTimeline). React to it: " +
        "summarize what it reported (in `reasoning`), then PROPOSE THE NEXT STATE CHANGE — a transition_stage " +
        "toward review if the implementation looks complete, or accept_completion if the review is clean. Only " +
        "re-prompt the same agent (prompt_specialist/prompt_reviewer) if the work is clearly incomplete. Do not " +
        "prompt just to repeat yourself."
      : "TRIGGER the agent for THIS stage and then STOP: use prompt_specialist (a working stage) or prompt_reviewer " +
        "(the review stage), putting a concrete task-related directive addressed to the agent (\"@dev implement …\") " +
        "in the action's `text`. Do NOT also propose the stage transition yet — you will be re-invoked to react once " +
        "the agent reports back. (You may advance a PRE-work stage like triage→ready if no implementation is needed there.)";
  return (
    persona +
    "\n\n---\n# This task\n\n" +
    "```json\n" +
    JSON.stringify(snapshot, null, 2) +
    "\n```\n\n" +
    "# Your decision\n\n" +
    "You cannot call tools. Instead, DECIDE the coordination actions to take now and return them as a plan. " +
    "Use the deployedSpecialists' profileId values for assign/prompt actions, and nextStages' ids for transitions.\n\n" +
    decision +
    "\nRespect your capability policy + autonomy: under supervised autonomy, governed actions become recommendation cards; " +
    "under full autonomy they are performed. Reach Done only via accept_completion (full autonomy).\n\n" +
    "Return ONLY a JSON object of the form " +
    `{ "reasoning": "<a concise operator comment>", "actions": [ { "tool": "prompt_specialist", "profileId": "…", "text": "<task-related directive>", "reason": "…" }, { "tool": "transition_stage", "toStageId": "…", "reason": "…" } ] }. ` +
    "Include a short reason on each governed action (it is shown on the recommendation card)."
  );
}

/**
 * The operator's opening turn prompt. It differs by WHY the run fired:
 *   agent-reply → REACT: an agent the operator prompted just reported back; read
 *     its report and propose the next state change (do not re-prompt).
 *   otherwise  → COORDINATE: prompt the stage's agent with an "@handle …"
 *     directive and stop; the reaction comes when the agent reports.
 */
export function buildOperatorTurnPrompt(
  snapshot: OperatorTaskSnapshot,
  trigger: "create" | "transition" | "agent-reply" | "manual",
  humanComment?: string,
): string {
  const header =
    `You are operating task ${snapshot.key} — "${snapshot.title}". ` +
    `Goal: ${snapshot.goal}\n\n` +
    `It is currently at stage "${snapshot.stageName}" (autonomy: ${snapshot.autonomy}).\n\n`;

  // A human is talking to you directly (@operator). Answer them first, then take
  // any coordination action that their message warrants.
  if (humanComment?.trim()) {
    return (
      header +
      `A human just addressed YOU directly with: "${humanComment.trim()}"\n\n` +
      "Do this now:\n" +
      "1. Call get_task to read the live state, your policy, and the allowed next stages.\n" +
      "2. Post a `post_comment` that RESPONDS to the human's message — answer their question or acknowledge their instruction, grounded in the task's real state.\n" +
      "3. If their message calls for a coordination action you're allowed to take (prompt an agent, engage a reviewer, recommend/perform a transition), do it and say so. If it does not, just respond.\n" +
      "Respect your capability policy. Keep it concise and directly responsive."
    );
  }

  if (trigger === "agent-reply") {
    return (
      header +
      "An agent you prompted has just REPORTED BACK (see the latest comment on the timeline).\n\n" +
      "Do this now:\n" +
      "1. Call get_task and read the agent's latest report in recentTimeline.\n" +
      "2. Post a brief comment summarizing what the agent reported.\n" +
      "3. Based on that report, PROPOSE THE NEXT STATE CHANGE:\n" +
      "   · if the implementation looks complete → transition_stage toward review (or recommend it under supervised);\n" +
      "   · if the review looks clean → accept_completion (or recommend acceptance under supervised);\n" +
      "   · only if the work is clearly incomplete, re-prompt the SAME agent with prompt_specialist/prompt_reviewer, and say why.\n" +
      "Do NOT prompt a fresh agent turn just to repeat yourself. React to the report, then act or recommend.\n\n" +
      "Respect your capability policy at every step. Keep comments concise."
    );
  }

  return (
    header +
    "Do this now:\n" +
    "1. Call get_task to see the live state, your policy, and the allowed next stages.\n" +
    "2. Post a brief plan comment.\n" +
    "3. TRIGGER the right agent for THIS stage with a concrete, task-related directive, addressed to it by name (\"@dev implement …\"):\n" +
    "   · a working stage (before review) → prompt_specialist(profileId, prompt) — assigns the\n" +
    "     specialist, posts your \"@name …\" prompt to it, and starts its run on your directive;\n" +
    "   · the review stage → prompt_reviewer(profileId, prompt) — engages + prompts + runs a reviewer.\n" +
    "   Write the prompt about THIS task (its goal and what to do at this stage), not a generic 'go'.\n" +
    "4. Then STOP and wait — do NOT propose the stage transition yet. When the agent reports back you\n" +
    "   will be re-invoked to read its report and propose the next state change.\n" +
    "   (Only advance a PRE-work stage, e.g. triage → ready, if no implementation is needed there yet.)\n\n" +
    "Respect your capability policy at every step. Keep comments concise."
  );
}
