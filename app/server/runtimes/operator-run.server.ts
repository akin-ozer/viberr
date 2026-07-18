import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import {
  getDataRoot,
  agentProfilesDir,
  skillDirPath,
} from "~/server/files/file-store-root.server";
import { KB_INJECTION_BUDGET, readKbBody } from "~/server/files/kb-injection.server";
import { splitFrontmatter } from "~/server/files/frontmatter.server";
import { logger } from "~/server/logging/logger.server";
import type { LogLine } from "~/features/runtime/runtime-types";
import { newId } from "~/shared/ids/new-id.server";
import {
  gate,
  operatorAcceptCompletion,
  operatorEngageAgent,
  operatorOpenPacket,
  operatorPostComment,
  operatorPromptAgentGeneric,
  operatorRunAgent,
  operatorSnapshot,
  operatorTransitionStage,
  operatorResolvePacket,
  resolveOperatorAuthority,
  type OperatorAuthority,
  type OperatorAutonomy,
  type OperatorTaskSnapshot,
} from "~/server/tasks/operator-actions.server";
import type { PacketOptionKind } from "~/schemas/task-file.schema";
import { buildOperatorToolkit } from "~/server/tasks/operator-toolkit.server";
import { normalizeEscapedNewlines } from "~/server/tasks/model-prose.server";
import { fullReplyTextForRun } from "~/server/tasks/agent-reply.server";
import { specialistEligibleForStage } from "~/server/tasks/specialist-run.server";
import type { TaskMutationContext } from "~/server/tasks/task-actions.server";
import {
  isBackendAvailable,
  simulatedRuntimePermitted,
  type RealBackend,
} from "./runtime-registry.server";
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
 *   codex + credential present → STRUCTURED-PLAN run: Codex emits a structured
 *     JSON plan (OPERATOR_PLAN_SCHEMA), which `executeCodexPlan` runs through the
 *     same gated operator-actions as the Claude tools — so Codex honors the
 *     identical RBAC + autonomy, it just plans-then-executes instead of
 *     calling tools live.
 *   R7-2 test gate open (vitest / Playwright) → SCRIPTED drive: the same
 *     operator-actions are called deterministically in code (the board still
 *     advances honestly), and a simulated run streams the narrative to the
 *     agent logs. Unreachable in production/dev.
 *   no credential, gate closed → NO fabricated drive: the run starts anyway
 *     and startRun fails it fast as an honest error; the completion hook
 *     escalates a blocked recovery packet (F-OP1 path, "unavailable" class).
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
  trigger?: "create" | "transition" | "agent-reply" | "goal-updated" | "manual";
  /** Depth of the react re-invocation chain (bounds the prompt↔react loop). */
  reactDepth?: number;
  /** A human's `@operator …` comment to address in this run (when a person
   *  talks to the operator directly). The operator reads it and responds. */
  humanComment?: string;
  /** agent-reply trigger: the finished agent's FULL report, straight from the
   *  run store — the react prompt embeds it so the operator's next directive
   *  never depends on the timeline comment having survived. */
  agentReply?: string;
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

// ------------------------------------------------------ single-flight lease

/**
 * Process-level operator lease + trigger queue.
 *
 * The agent_runs row alone under-covers the lease: the SCRIPTED drive
 * coordinates before its row exists, and the CODEX plan executes after its row
 * is already `finished` — in both windows a concurrent trigger used to
 * double-drive (double assignment, double prompts). Worse, a coalesced trigger
 * was simply DROPPED: a human's "@operator …" landing while a run was in
 * flight was never answered.
 *
 * The lease is held from runOperator entry until the mode's coordination truly
 * ends (real: run completion; codex: plan executed; scripted: drive returned).
 * A trigger arriving while held is QUEUED (newest wins — the operator re-reads
 * the full task anyway, so the latest trigger subsumes older ones) and fired
 * exactly once on release.
 */
interface OperatorLeaseState {
  held: Map<
    string,
    {
      runId: string | null;
      backend: RealBackend;
      autonomy: OperatorAutonomy;
      /** Task ref carried for the waiting-flag settle on release. */
      projectSlug: string;
      taskKey: string;
      dataRoot?: string;
    }
  >;
  pending: Map<string, RunOperatorInput>;
}

const LEASE_KEY = Symbol.for("viberr.operatorLease");

function leaseState(): OperatorLeaseState {
  const cache = globalThis as unknown as Record<symbol, OperatorLeaseState | undefined>;
  let state = cache[LEASE_KEY];
  if (!state) {
    state = { held: new Map(), pending: new Map() };
    cache[LEASE_KEY] = state;
  }
  return state;
}

function leaseKeyFor(projectSlug: string, taskKey: string): string {
  return `${projectSlug}/${taskKey}`;
}

/**
 * Release the task's lease and fire the newest queued trigger, if any.
 * IDEMPOTENT per acquisition (adversarial-review #5/#7): `token` is the exact
 * lease-entry object captured when this drive acquired the lease. We only
 * delete/queue-fire when the currently-held entry IS that token — so a
 * second/late release (e.g. the scripted path's inner finally AND the outer
 * catch both firing) can never evict a SUCCESSOR's freshly-acquired lease or
 * double-fire the queued run. A release whose token no longer matches is a
 * no-op.
 */
function releaseOperatorLease(
  db: Database.Database,
  key: string,
  token?: object,
): void {
  const state = leaseState();
  const current = state.held.get(key);
  if (token !== undefined && current !== token) return; // stale release — ignore
  state.held.delete(key);
  const queued = state.pending.get(key);
  if (!queued) {
    // Last drive for now: flip `waiting: agent` back to human once nothing is
    // live on the task (runOperator set it at drive start; a specialist the
    // operator prompted keeps its own completion-chain flip — the live check
    // stays out of its way).
    settleWaitingAfterOperator(db, current ?? leaseRefFromKey(key));
    return;
  }
  state.pending.delete(key);
  logger.info("operator lease released — firing the queued trigger", {
    key,
    trigger: queued.trigger ?? "manual",
  });
  void runOperator(db, queued).catch((error) => {
    logger.error("queued operator trigger failed", {
      key,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  });
}

/** Recover the task ref from a lease key (slugs are kebab-case — the first
 *  "/" is the separator). Fallback for releases with no held entry. */
function leaseRefFromKey(key: string): { projectSlug: string; taskKey: string } {
  const i = key.indexOf("/");
  return { projectSlug: key.slice(0, i), taskKey: key.slice(i + 1) };
}

/** After the last operator drive ends with no queued follow-up: if no run is
 *  still live on the task, flip `waiting: agent` → human. Fire-and-forget —
 *  a failed settle only leaves the board reading "working" until the next
 *  task mutation reprojects. */
function settleWaitingAfterOperator(
  db: Database.Database,
  ref: { projectSlug: string; taskKey: string; dataRoot?: string },
): void {
  void (async () => {
    try {
      const live = inFlightAgentRun(db, ref.projectSlug, ref.taskKey);
      if (live) return;
      const { clearWaitingToHuman } = await import(
        "~/server/tasks/task-actions.server"
      );
      const ctx: TaskMutationContext =
        ref.dataRoot !== undefined ? { dataRoot: ref.dataRoot } : {};
      await clearWaitingToHuman(db, ctx, ref.projectSlug, ref.taskKey);
    } catch (error) {
      logger.warn("settleWaitingAfterOperator failed", {
        taskKey: ref.taskKey,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  })();
}

/** Any queued/running run (operator, specialist or reviewer) on the task. */
function inFlightAgentRun(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
): boolean {
  const row = db
    .prepare(
      `SELECT id FROM agent_runs
       WHERE project_slug = ? AND task_key = ?
         AND state IN ('queued', 'running')
       LIMIT 1`,
    )
    .get(projectSlug, taskKey);
  return !!row;
}

/** Test-only: drop all leases/queued triggers (fresh state per test). */
export function resetOperatorLeasesForTests(): void {
  const state = leaseState();
  state.held.clear();
  state.pending.clear();
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
  // time. A trigger arriving while the lease is held — e.g. create-time
  // auto-invoke racing an "@operator …" comment — is QUEUED (newest wins) and
  // fired when the in-flight coordination truly ends, so no trigger is ever
  // silently dropped and no two drives overlap. The process lease covers the
  // scripted/codex windows the agent_runs row alone misses.
  const leaseKey = leaseKeyFor(input.projectSlug, input.taskKey);
  const lease = leaseState();
  const heldByProcess = lease.held.get(leaseKey);
  if (heldByProcess) {
    lease.pending.set(leaseKey, input);
    logger.info("operator run queued — one already in flight (process lease)", {
      taskKey: input.taskKey,
      trigger: input.trigger ?? "manual",
    });
    return {
      runId: heldByProcess.runId ?? "queued",
      backend: heldByProcess.backend,
      mode:
        heldByProcess.backend === "claude" && isBackendAvailable("claude")
          ? "real"
          : "scripted",
      autonomy: heldByProcess.autonomy,
    };
  }
  // Cross-boot backstop: a queued/running DB row without a process lease (e.g.
  // resumed after a restart) still coalesces; queue the trigger and drain it
  // when that run finishes.
  const inflight = inFlightOperatorRun(db, input.projectSlug, input.taskKey);
  if (inflight) {
    lease.pending.set(leaseKey, input);
    const { chainRunCompletion } = await import("./run-service.server");
    chainRunCompletion(inflight.id, () => releaseOperatorLease(db, leaseKey));
    logger.info("operator run queued — DB row already in flight", {
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

  // The lease-entry OBJECT is this drive's release token — every release for
  // this drive passes it, so a stale/duplicate release can never evict a
  // successor's lease (releaseOperatorLease is idempotent per token).
  const leaseToken = {
    runId: null as string | null,
    backend,
    autonomy: authority.autonomy,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  };
  lease.held.set(leaseKey, leaseToken);

  // Carry the run's identity on the ctx so that when an agent this operator
  // prompts replies, the reply-completion hook can re-invoke the operator to
  // REACT (read the reply → propose a state change). The reactDepth bounds that
  // chain (see OPERATOR_REACT_DEPTH_CAP).
  ctx.operatorRun = {
    backend,
    autonomy: authority.autonomy,
    reactDepth: input.reactDepth ?? 0,
  };

  // The operator is itself an agent working the task: the board should read
  // "working" for the duration of the drive, not "waiting on you" (the
  // specialist starters do the same). Settled back to human on lease release
  // once nothing is live (settleWaitingAfterOperator).
  const { markWaitingAgent } = await import("~/server/tasks/task-actions.server");
  await markWaitingAgent(db, ctx, input.projectSlug, input.taskKey);

  // Claude: real tool-driven operator (in-process MCP tools). Codex: no
  // in-process tool channel, so it runs a real STRUCTURED-OUTPUT operator (the
  // model emits a decision plan we execute through the same capability-gated
  // actions). The deterministic scripted drive is reachable ONLY inside the
  // R7-2 test gate; with no credential and the gate closed the real path runs
  // anyway — startRun fails it fast as an honest error run and the completion
  // hook escalates (no fabricated coordination). The real/codex
  // paths release the lease on run COMPLETION (chained callback); only a
  // SYNCHRONOUS throw before that reaches the outer catch. The scripted path is
  // synchronous, so it releases in its own finally — the outer catch must NOT
  // also release it (that double-release is the bug). Idempotent-per-token
  // release makes even an accidental double-release safe.
  try {
    if (backend === "claude" && isBackendAvailable("claude")) {
      return await startRealOperatorRun(db, ctx, input, authority, leaseKey, leaseToken);
    }
    if (backend === "codex" && isBackendAvailable("codex")) {
      return await startCodexOperatorRun(db, ctx, input, authority, leaseKey, leaseToken);
    }
    if (simulatedRuntimePermitted()) {
      try {
        return await runScriptedOperatorDrive(db, ctx, input, authority);
      } finally {
        // Scripted coordination is fully synchronous with this call.
        releaseOperatorLease(db, leaseKey, leaseToken);
      }
    }
    // R7-2 fail-fast: the backend is unavailable and no test engine is
    // permitted. Start the honest error run through the backend's own path —
    // its completion callback releases the lease and escalates the failure.
    return backend === "codex"
      ? await startCodexOperatorRun(db, ctx, input, authority, leaseKey, leaseToken)
      : await startRealOperatorRun(db, ctx, input, authority, leaseKey, leaseToken);
  } catch (error) {
    releaseOperatorLease(db, leaseKey, leaseToken);
    throw error;
  }
}

// ------------------------------------------------- codex (structured output)

/**
 * JSON schema constraining the codex operator's decision plan. OpenAI strict
 * structured output requires EVERY object to set additionalProperties:false and
 * list ALL properties in `required` — optional fields are expressed as nullable
 * (the model emits null when unused). The executor treats null/"" as absent.
 */
const OPERATOR_PLAN_TOOLS = [
  "post_comment",
  "open_packet",
  // Withdraw YOUR OWN open packet when it became moot (its asked-for input was
  // provided out-of-band, e.g. a human edited the goal). `reason` explains why.
  "resolve_packet",
  // Generic engagement actions (generic-agents phase 3): `delivers` selects
  // the engagement shape (true = the delivering builder; false = supporting,
  // e.g. verdict-capable review).
  "engage_agent",
  "run_agent",
  "prompt_agent",
  // Legacy aliases (pre-generic plans / model drift) — dispatched to the same
  // generic handlers with the delivers flag implied by the name.
  "assign_specialist",
  "run_specialist",
  "prompt_specialist",
  "assign_reviewer",
  "run_reviewer",
  "prompt_reviewer",
  "transition_stage",
  "accept_completion",
] as const;

const OPERATOR_PACKET_TYPES = ["input", "blocked"] as const;

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
            enum: OPERATOR_PLAN_TOOLS,
          },
          profileId: { type: ["string", "null"], description: "For engage_/run_/prompt_ agent actions, else null." },
          delivers: { type: ["boolean", "null"], description: "engage_agent/prompt_agent: true = the delivering builder (owns branch/PR, one per task); false = supporting (review). Else null." },
          toStageId: { type: ["string", "null"], description: "For transition_stage, else null." },
          packetType: { type: ["string", "null"], enum: ["input", "blocked", null], description: "For open_packet: 'blocked' when work is stuck, 'input' for a decision; else null." },
          text: { type: ["string", "null"], description: "For post_comment and prompt_/open_packet: the comment text, agent prompt, or packet title; else null." },
          reason: { type: ["string", "null"], description: "Short why — recommendation-card reasoning, or the packet body for open_packet." },
        },
        required: ["tool", "profileId", "delivers", "toStageId", "packetType", "text", "reason"],
      },
    },
  },
  required: ["reasoning", "actions"],
} as const;

/**
 * Runtime mirror of OPERATOR_PLAN_SCHEMA. Structured output constrains the
 * model, but persisted/provider output still crosses a trust boundary: reject
 * missing nullable fields, unknown tools, wrong types, and extra properties
 * before any governed action can run.
 */
const operatorPlanActionSchema = z.strictObject({
  tool: z.enum(OPERATOR_PLAN_TOOLS),
  profileId: z.string().nullable(),
  // Optional (not just nullable): legacy stored plans predate the field.
  delivers: z.boolean().nullable().optional(),
  toStageId: z.string().nullable(),
  packetType: z.enum(OPERATOR_PACKET_TYPES).nullable(),
  text: z.string().nullable(),
  reason: z.string().nullable(),
});

const operatorPlanRuntimeSchema = z.strictObject({
  reasoning: z.string(),
  actions: z.array(operatorPlanActionSchema),
});

type OperatorPlan = z.infer<typeof operatorPlanRuntimeSchema>;

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
  leaseKey: string,
  leaseToken: object,
): Promise<RunOperatorResult> {
  const snapshot = operatorSnapshot(db, ctx, input.projectSlug, input.taskKey, authority);
  const systemPrompt = buildOperatorSystemPrompt(authority, input.dataRoot);
  const prompt = buildCodexOperatorPrompt(
    snapshot,
    input.trigger ?? "manual",
    input.humanComment,
    input.agentReply,
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
    systemPrompt,
    outputSchema: OPERATOR_PLAN_SCHEMA,
    autonomous: true,
    actor: input.actor ?? OPERATOR_AUDIT_ACTOR,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  });

  // When the run finishes, parse its decision plan and execute it through the
  // capability-gated operator-actions (so codex honors the exact same RBAC +
  // autonomy as the Claude tool-driven operator). The lease is released only
  // AFTER the plan finished executing — the run row is already `finished`
  // while the plan runs, which is exactly the window the process lease covers.
  const held = leaseState().held.get(leaseKey);
  if (held) held.runId = runId;
  registerRunCompletion(runId, (finished) => {
    // Provider output is only executable after a clean terminal completion.
    // A failed/interrupted turn may have persisted a syntactically valid
    // partial agent_message before it stopped; never treat that as a plan.
    const completion =
      finished.state === "finished"
        ? executeCodexPlan(db, ctx, input, authority, finished.id)
        : finished.state === "error"
          ? escalateFailedOperatorRun(db, ctx, input, authority, finished.id)
          : Promise.resolve();
    void completion
      .catch((error) => {
        logger.error("codex operator completion handling failed", {
          taskKey: input.taskKey,
          err: error instanceof Error ? error : new Error(String(error)),
        });
      })
      .finally(() => releaseOperatorLease(db, leaseKey, leaseToken));
  }, db);

  logger.info("operator run started (codex structured output)", {
    taskKey: input.taskKey,
    runId,
    autonomy: authority.autonomy,
  });
  return { runId, backend: "codex", mode: "real", autonomy: authority.autonomy };
}

/** Parse the complete structured response and validate it before execution. */
function parseOperatorPlan(text: string): OperatorPlan | null {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  const parsed = operatorPlanRuntimeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Execute a finished codex operator run's decision plan (capability-gated). */
async function executeCodexPlan(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
  runId: string,
): Promise<void> {
  // This is machine-readable control data, not a timeline preview: use the
  // complete reply. replyTextForRun intentionally truncates at 1,200 chars and
  // appends prose, which corrupts otherwise-valid larger JSON plans.
  const text = fullReplyTextForRun(db, runId);
  const plan = text ? parseOperatorPlan(text) : null;
  if (!plan) {
    // An empty or unparseable plan is a HUMAN-VISIBLE failure, not a silent
    // no-op: nothing else covers an operator's own run (recovery only watches
    // specialist/reviewer runs), so without this the task simply sits with no
    // signal. Raise a blocked recovery packet through the operator's own gate.
    logger.warn("codex operator produced no usable plan — escalating", {
      taskKey: input.taskKey,
      runId,
      hadText: !!text,
    });
    await operatorOpenPacket(
      db,
      ctx,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        packetType: "blocked",
        title: "Operator turn produced no actionable plan",
        body: text
          ? "The coordinating run replied, but its output was not a valid decision plan. Coordination is paused until a human re-engages the operator or redirects the task."
          : "The coordinating run finished without producing any output. Coordination is paused until a human re-engages the operator or redirects the task.",
        options: defaultPacketOptions("blocked"),
      },
      authority,
    ).catch((error) => {
      logger.error("codex no-plan escalation failed", {
        taskKey: input.taskKey,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    });
    return;
  }
  // The plan's prose fields persist to the timeline / packets — repair
  // double-escaped `\n` sequences the model emitted inside its JSON strings
  // (finding #23: literal "\n" rendered verbatim in the UI).
  if (plan.reasoning) plan.reasoning = normalizeEscapedNewlines(plan.reasoning);
  for (const a of plan.actions) {
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
  for (const a of plan.actions) {
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
        // Generic engagement actions + legacy aliases → ONE dispatch. The
        // alias implies the delivers flag its name always meant.
        case "engage_agent":
        case "assign_specialist":
        case "assign_reviewer":
          if (a.profileId)
            await operatorEngageAgent(
              db,
              ctx,
              {
                ...base,
                profileId: a.profileId,
                delivers:
                  a.tool === "assign_specialist"
                    ? true
                    : a.tool === "assign_reviewer"
                      ? false
                      : (a.delivers ?? true),
                ...(a.reason ? { reason: a.reason } : {}),
              },
              authority,
            );
          break;
        case "run_agent":
        case "run_specialist":
        case "run_reviewer":
          await operatorRunAgent(
            db,
            ctx,
            {
              ...base,
              ...(a.profileId ? { profileId: a.profileId } : {}),
              ...(a.tool === "run_specialist"
                ? { delivers: true }
                : a.tool === "run_reviewer"
                  ? { delivers: false }
                  : a.delivers != null
                    ? { delivers: a.delivers }
                    : {}),
            },
            authority,
          );
          break;
        case "prompt_agent":
        case "prompt_specialist":
        case "prompt_reviewer":
          if (a.profileId)
            await operatorPromptAgentGeneric(
              db,
              ctx,
              {
                ...base,
                profileId: a.profileId,
                ...(a.text ? { directive: a.text } : {}),
                ...(a.tool === "prompt_specialist"
                  ? { delivers: true }
                  : a.tool === "prompt_reviewer"
                    ? { delivers: false }
                    : a.delivers != null
                      ? { delivers: a.delivers }
                      : {}),
              },
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
        case "resolve_packet":
          await operatorResolvePacket(
            db,
            ctx,
            { ...base, ...(a.reason ? { reason: a.reason } : a.text ? { reason: a.text } : {}) },
            authority,
          );
          break;
      }
    } catch (error) {
      // ABORT the remaining plan on a governed-action failure: executing later
      // actions against a state the failed one never produced compounds the
      // damage (e.g. an accept_completion after a failed transition). The
      // failure is narrated on the timeline so the board shows what stopped.
      logger.error("codex operator action failed — aborting the remaining plan", {
        taskKey: input.taskKey,
        tool: a.tool,
        err: error instanceof Error ? error : new Error(String(error)),
      });
      await operatorPostComment(
        db,
        ctx,
        {
          ...base,
          text: `Coordination stopped: the \`${a.tool}\` step failed (${error instanceof Error ? error.message : String(error)}). The remaining plan was not executed.`,
        },
        authority,
      ).catch(() => {});
      break;
    }
  }
}

// ------------------------------------------------------- real (tool-driven)

async function startRealOperatorRun(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
  leaseKey: string,
  leaseToken: object,
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
  const prompt = buildOperatorTurnPrompt(
    snapshot,
    input.trigger ?? "manual",
    input.humanComment,
    input.agentReply,
  );

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

  // The real operator coordinates DURING its run (in-proc MCP tools), so the
  // lease is held until the run reaches a terminal state. Chained (not
  // registered) so nothing can clobber it.
  const held = leaseState().held.get(leaseKey);
  if (held) held.runId = runId;
  const { chainRunCompletion } = await import("./run-service.server");
  chainRunCompletion(runId, (finished) => {
    releaseOperatorLease(db, leaseKey, leaseToken);
    // A real Claude operator run that ERRORS (crash / quota / auth / idle
    // timeout) was previously silent — the completion hook only released the
    // lease, so nothing reached the human (contrast the Codex no-plan
    // escalation and the specialist F8 path). Escalate it the same way (F-OP1).
    if (finished.state === "error") {
      void escalateFailedOperatorRun(db, ctx, input, authority, runId);
    }
  }, db);

  logger.info("operator run started (real)", {
    taskKey: input.taskKey,
    runId,
    autonomy: authority.autonomy,
  });
  return { runId, backend: "claude", mode: "real", autonomy: authority.autonomy };
}

/**
 * F-OP1: surface a failed real operator run to the human. Nothing else covers
 * an operator's OWN run (run-recovery only watches specialist/reviewer runs),
 * so without this a crashed/quota-limited/idle-timed-out operator run leaves the
 * task sitting with no timeline entry, packet, or notification. Raise a blocked
 * recovery packet through the operator's own gate, with quota/auth-aware copy.
 */
async function escalateFailedOperatorRun(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
  runId: string,
): Promise<void> {
  try {
    const { runFailureReason } = await import("~/server/tasks/agent-reply.server");
    const reason = runFailureReason(db, runId);
    const detail =
      reason?.kind === "quota"
        ? "the coordinating model is over its usage quota"
        : reason?.kind === "auth"
          ? "the coordinating model's credential was rejected"
          : reason?.kind === "unavailable"
            ? "the coordinating backend has no usable credential configured (the run was refused — no agent process started)"
            : "the coordinating run did not complete";
    logger.warn("real operator run failed — escalating", {
      taskKey: input.taskKey,
      runId,
      kind: reason?.kind ?? "unknown",
    });
    await operatorOpenPacket(
      db,
      ctx,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        packetType: "blocked",
        title: "Operator run failed — pick a recovery path",
        body:
          `The operator run did not complete — ${detail}. No coordination was ` +
          `performed. Retry on the other backend, fix the credential, or redirect ` +
          `the task.`,
        options: defaultPacketOptions("blocked"),
      },
      authority,
    );
  } catch (error) {
    logger.error("operator-run failure escalation failed", {
      taskKey: input.taskKey,
      runId,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
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
          // FILTER by stage eligibility (F1): re-prompting an engaged reviewer
          // whose profile isn't eligible for THIS stage would throw in
          // assertStageEligible and hard-halt the whole coordination turn — skip
          // the ineligible one instead (the snapshot precomputes eligibility).
          const eligibleHere = (id: string) => {
            const d = snap.deployedSpecialists.find((s) => s.id === id);
            return !d || d.eligibleForCurrentStage;
          };
          const revIds = (
            snap.reviewers.length
              ? snap.reviewers.map((r) => r.profileId)
              : [pickReviewer(snap)?.id].filter((x): x is string => !!x)
          ).filter(eligibleHere);
          if (revIds.length && gate(authority, "summon-reviewers") !== "deny") {
            for (const rev of revIds) {
              say(
                (
                  await operatorPromptAgentGeneric(
                    db,
                    ctx,
                    { projectSlug, taskKey, profileId: rev, delivers: false },
                    authority,
                  )
                ).message,
              );
            }
          }
          return;
        }
        if (snap.stage === workStageId || !workStageId) {
          // Only re-run the assigned specialist if it's ELIGIBLE for the current
          // stage (F1); otherwise fall back to an eligible pick (pickSpecialist
          // already filters by eligibility) so an assigned-but-now-ineligible
          // specialist doesn't throw and halt coordination.
          const assigned = snap.specialist
            ? snap.deployedSpecialists.find((s) => s.id === snap.specialist!.profileId)
            : undefined;
          const pick =
            assigned && assigned.eligibleForCurrentStage ? assigned : pickSpecialist(snap);
          if (pick && gate(authority, "assign-primary-specialist") !== "deny") {
            say(
              (
                await operatorPromptAgentGeneric(
                  db,
                  ctx,
                  { projectSlug, taskKey, profileId: pick.id, delivers: true },
                  authority,
                )
              ).message,
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

    // ONE timeline entry per operator turn (decision E): the coordination
    // actions themselves narrate the turn — the prompting comment, transition
    // events, and recommendation cards ARE the plan made visible. No standalone
    // "Plan: …" / "Read the report" pre-comments.
    if (isReact) {
      await react();
    } else {
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

/**
 * Pick an implementation specialist ELIGIBLE for the current stage (F1 — stage
 * eligibility is now real). Filters to specialists whose declared stages include
 * `snap.stage` (spanAll / no-stages count as eligible), then prefers an
 * implementation role. Returns null when no eligible specialist exists rather
 * than silently assigning one that can't work this stage.
 */
function pickSpecialist(snap: OperatorTaskSnapshot) {
  const specs = snap.deployedSpecialists.filter((s) =>
    specialistEligibleForStage(s, snap.stage),
  );
  // Capability-first (generic-agents D11): a DELIVERY-capable profile is the
  // structural signal for build work — no hardcoded ids. The legacy role
  // heuristics remain only as last-resort tie-breakers for deployments with no
  // capability grants at all.
  return (
    specs.find((s) => s.capabilities.delivery && !s.capabilities.verdict) ??
    specs.find((s) => s.capabilities.delivery) ??
    specs.find((s) => /develop|implement/i.test(s.role)) ??
    specs.find((s) => !s.capabilities.verdict && !/review/i.test(s.role)) ??
    specs[0] ??
    null
  );
}

/** Prefer a stage-eligible review specialist to engage before acceptance (F1). */
function pickReviewer(snap: OperatorTaskSnapshot) {
  const specs = snap.deployedSpecialists.filter(
    (s) =>
      specialistEligibleForStage(s, snap.stage) &&
      !snap.reviewers.some((r) => r.profileId === s.id) &&
      s.id !== snap.specialist?.profileId,
  );
  // Capability-first (D11): verdict capability IS what makes review-engaging a
  // profile meaningful — its verdicts gate acceptance (G2).
  return (
    specs.find((s) => s.capabilities.verdict) ??
    specs.find((s) => /review/i.test(s.role)) ??
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

// readKbBody now lives in ~/server/files/kb-injection.server (shared with the
// specialist runtime): recursive tree walk + all text-doc extensions, so
// imported/nested/non-.md KB docs actually reach the operator's context.

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
  // that exists in the store, same as skills. The KB_INJECTION_BUDGET is a GLOBAL
  // cap shared across ALL declared KBs (F9) — an agent with many KBs can't blow
  // the prompt with N × 24k; each KB draws from the remaining budget.
  let kbBudget = KB_INJECTION_BUDGET;
  for (const name of authority.kb) {
    if (kbBudget <= 0) break;
    const body = readKbBody(name, dataRoot, kbBudget);
    if (body) {
      parts.push(`\n\n---\n# ${name} (knowledge base)\n\n${body}`);
      kbBudget -= body.length;
    }
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
      "- Never write code, run shell commands, or touch the repository — those tools are withheld from you. Coordinate ONLY through the `mcp__viberr__*` governance tools (you may also read files and search to inform a decision).",
  );
  return parts.join("");
}

/**
 * The turn prompt for the CODEX structured-output operator. Persona + expertise
 * are supplied separately through Codex's supported `developer_instructions`
 * channel; this prompt contains only the live task snapshot and turn-specific
 * output instruction. Codex has no in-process SDK MCP channel, so it returns a
 * decision plan (constrained by OPERATOR_PLAN_SCHEMA) that we execute through
 * the same capability-gated actions.
 */
export function buildCodexOperatorPrompt(
  snapshot: OperatorTaskSnapshot,
  trigger: "create" | "transition" | "agent-reply" | "goal-updated" | "manual",
  humanComment?: string,
  agentReply?: string,
): string {
  // Same rationale as the claude turn prompt: the react decision carries the
  // agent's report verbatim so directives can quote concrete findings.
  const reportBlock =
    trigger === "agent-reply" && agentReply?.trim()
      ? `\n\n# The agent's report (verbatim${agentReply.length > 4000 ? ", first 4,000 chars" : ""})\n\n"""\n${agentReply.slice(0, 4000)}\n"""`
      : "";
  const decision = humanComment?.trim()
    ? `A human just addressed YOU directly with: "${humanComment.trim()}". RESPOND to them: put your reply to the human in \`reasoning\` (answer their question or acknowledge their instruction, grounded in the task state), and add any coordination actions their message warrants (prompt an agent, transition, etc.) — or none if a reply is all that's needed.`
    : trigger === "goal-updated"
      ? "A human just EDITED THE TASK GOAL (the snapshot's `goal` is the new one). If the open packet (snapshot `packet`) " +
        "asked for exactly this input (scope / goal / acceptance criteria) and the new goal now provides it, include a " +
        "`resolve_packet` action with a short `reason` — the packet is moot. Then continue coordination for the current " +
        "stage (prompt the right agent anchored on the NEW goal, or advance a pre-work stage). If the goal is still not " +
        "actionable, say what's missing in `reasoning` — do NOT open a duplicate packet."
      : trigger === "agent-reply"
      ? "An agent you prompted has just REPORTED BACK (its report is included above verbatim). React to it: " +
        "summarize what it reported (in `reasoning`), then PROPOSE THE NEXT STATE CHANGE — a transition_stage " +
        "toward review if the implementation looks complete, or accept_completion if the review is clean. If the " +
        "review REQUESTED CHANGES, re-prompt the specialist and QUOTE the reviewer's specific findings in the " +
        "action's `text` (the specialist does not see this report otherwise). Only re-prompt the same agent " +
        "(prompt_specialist/prompt_reviewer) if the work is clearly incomplete. Do not prompt just to repeat yourself."
      : "TRIGGER the agent for THIS stage and then STOP: use prompt_specialist (a working stage) or prompt_reviewer " +
        "(the review stage), putting a concrete task-related directive addressed to the agent (\"@dev implement …\") " +
        "in the action's `text`. Do NOT also propose the stage transition yet — you will be re-invoked to react once " +
        "the agent reports back. (You may advance a PRE-work stage like triage→ready if no implementation is needed there.)";
  return (
    "# This task\n\n" +
    "```json\n" +
    JSON.stringify(snapshot, null, 2) +
    "\n```" +
    reportBlock +
    "\n\n# Your decision\n\n" +
    "You cannot call tools. Instead, DECIDE the coordination actions to take now and return them as a plan. " +
    "Use the deployedSpecialists' profileId values for assign/prompt actions, and nextStages' ids for transitions. " +
    "SELECT the right agent by reading each profile's `desc` (its purpose) and `capabilities` " +
    "(delivery = builds and owns the branch/PR; verdict = its review verdicts gate acceptance; askHuman = can raise questions) — " +
    "never by guessing from names.\n\n" +
    decision +
    "\nRespect your capability policy + autonomy: under supervised autonomy, governed actions become recommendation cards; " +
    "under full autonomy they are performed. Reach Done only via accept_completion (full autonomy).\n\n" +
    "Return ONLY a JSON object of the form " +
    `{ "reasoning": "<a concise operator comment>", "actions": [ { "tool": "prompt_agent", "profileId": "…", "delivers": true, "text": "<task-related directive>", "reason": "…" }, { "tool": "transition_stage", "toStageId": "…", "reason": "…" } ] }. ` +
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
  trigger: "create" | "transition" | "agent-reply" | "goal-updated" | "manual",
  humanComment?: string,
  agentReply?: string,
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

  if (trigger === "goal-updated") {
    return (
      header +
      "A human just EDITED THE TASK GOAL (the goal above is the new one).\n\n" +
      "Do this now:\n" +
      "1. Call get_task — read the new goal and the open decision packet (`packet`), if any.\n" +
      "2. If your open packet asked for exactly this input (scope / goal / acceptance criteria) and the new goal now provides it, call resolve_decision_packet with a short reason — the packet is moot, do not leave it standing.\n" +
      "3. Then continue coordination for the current stage: prompt the right agent with a directive anchored on the NEW goal, or advance a pre-work stage if nothing needs to run here.\n" +
      "4. If the new goal is still not actionable, post ONE brief comment saying exactly what is missing — do NOT open a duplicate packet while one is already standing.\n\n" +
      "Respect your capability policy at every step. Keep comments concise."
    );
  }

  if (trigger === "agent-reply") {
    // Embed the report verbatim (capped): the operator's next directive must
    // carry the agent's actual findings even when the timeline comment was
    // dropped or trimmed.
    const reportBlock = agentReply?.trim()
      ? `The agent's report (verbatim${agentReply.length > 4000 ? ", first 4,000 chars" : ""}):\n"""\n${agentReply.slice(0, 4000)}\n"""\n\n`
      : "";
    return (
      header +
      "An agent you prompted has just REPORTED BACK.\n\n" +
      reportBlock +
      "Do this now:\n" +
      "1. Call get_task and read the live state (the report above is the agent's reply).\n" +
      "2. Post a brief comment summarizing what the agent reported.\n" +
      "3. Based on that report, PROPOSE THE NEXT STATE CHANGE:\n" +
      "   · if the implementation looks complete → transition_stage toward review (or recommend it under supervised);\n" +
      "   · if the review looks clean → accept_completion (or recommend acceptance under supervised);\n" +
      "   · if the review REQUESTED CHANGES → re-prompt the specialist and QUOTE the reviewer's specific findings in your directive (the specialist does not see this report otherwise — a directive that just says \"see the reviewer's comments\" hands it nothing);\n" +
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
