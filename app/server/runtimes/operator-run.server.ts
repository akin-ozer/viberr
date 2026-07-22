import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import {
  agentProfilesDir,
  skillDirPath,
} from "~/server/files/file-store-root.server";
import { KB_INJECTION_BUDGET, readKbBody } from "~/server/files/kb-injection.server";
import { splitFrontmatter } from "~/server/files/frontmatter.server";
import { logger } from "~/server/logging/logger.server";
import { newId } from "~/shared/ids/new-id.server";
import {
  operatorAcceptCompletion,
  operatorEngageAgent,
  operatorOpenPacket,
  operatorPostComment,
  operatorSetGoal,
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
import {
  DEFAULT_GOAL,
  type TaskMutationContext,
} from "~/server/tasks/task-actions.server";
import type { RealBackend } from "./runtime-registry.server";
import { registerRunCompletion, startRun } from "./run-service.server";

/**
 * Runs the operator through Claude or Codex. The operator is given its persona
 * (agent
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
 *   no credential → startRun records an honest error; the completion hook
 *     escalates a blocked recovery packet.
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
  autonomy: OperatorAutonomy;
}

/** A queued/running operator run for the same task, if one is already in flight. */
function inFlightOperatorRun(
  db: DatabaseSync,
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
 * The lease is held from runOperator entry through provider completion and,
 * for Codex, structured-plan execution.
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
 * second or late release can never evict a successor's freshly-acquired lease or
 * double-fire the queued run. A release whose token no longer matches is a
 * no-op.
 */
function releaseOperatorLease(
  db: DatabaseSync,
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
  db: DatabaseSync,
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
        { dataRoot: ref.dataRoot };
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
  db: DatabaseSync,
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
  db: DatabaseSync,
  input: RunOperatorInput,
): Promise<RunOperatorResult> {
  const ctx: TaskMutationContext = {
    dataRoot: input.dataRoot,
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
  // silently dropped and no two drives overlap. The process lease also covers
  // Codex plan execution after the provider run finishes.
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
    dataRoot: input.dataRoot,
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

  // Claude uses in-process governance tools. Codex emits a structured plan
  // that the completion callback executes through the same governed actions.
  try {
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
  // Draft the task GOAL when it is still the unspecified triage placeholder
  // (`text` = the drafted goal). Fills only an unspecified goal.
  "set_goal",
  // Generic engagement actions (generic-agents phase 3): `delivers` selects
  // the engagement shape (true = the delivering builder; false = supporting,
  // e.g. verdict-capable review).
  "engage_agent",
  "run_agent",
  "prompt_agent",
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
  delivers: z.boolean().nullable(),
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
  db: DatabaseSync,
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
    dataRoot: input.dataRoot,
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
  return { runId, backend: "codex", autonomy: authority.autonomy };
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
  db: DatabaseSync,
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
  // Actions narrate themselves. Only a reply-only plan needs its reasoning
  // copied to the timeline.
  if (plan.actions.length === 0 && plan.reasoning) {
    await operatorPostComment(db, ctx, { ...base, text: plan.reasoning }, authority);
  }
  for (const a of plan.actions) {
    try {
      switch (a.tool) {
        case "post_comment":
          if (a.text) {
            await operatorPostComment(db, ctx, { ...base, text: a.text }, authority);
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
        case "engage_agent":
          if (a.profileId && a.delivers !== null)
            await operatorEngageAgent(
              db,
              ctx,
              {
                ...base,
                profileId: a.profileId,
                delivers: a.delivers,
                ...(a.reason ? { reason: a.reason } : {}),
              },
              authority,
            );
          break;
        case "run_agent":
          await operatorRunAgent(
            db,
            ctx,
            {
              ...base,
              ...(a.profileId ? { profileId: a.profileId } : {}),
              ...(a.delivers != null ? { delivers: a.delivers } : {}),
            },
            authority,
          );
          break;
        case "prompt_agent":
          if (a.profileId)
            await operatorPromptAgentGeneric(
              db,
              ctx,
              {
                ...base,
                profileId: a.profileId,
                ...(a.text ? { directive: a.text } : {}),
                ...(a.delivers != null ? { delivers: a.delivers } : {}),
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
        case "set_goal":
          // `text` carries the drafted goal.
          if (a.text)
            await operatorSetGoal(
              db,
              ctx,
              { ...base, goal: a.text, ...(a.reason ? { reason: a.reason } : {}) },
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
  db: DatabaseSync,
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
    dataRoot: input.dataRoot,
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
  return { runId, backend: "claude", autonomy: authority.autonomy };
}

/**
 * F-OP1: surface a failed real operator run to the human. Nothing else covers
 * an operator's OWN run (run-recovery only watches specialist/reviewer runs),
 * so without this a crashed/quota-limited/idle-timed-out operator run leaves the
 * task sitting with no timeline entry, packet, or notification. Raise a blocked
 * recovery packet through the operator's own gate, with quota/auth-aware copy.
 */
async function escalateFailedOperatorRun(
  db: DatabaseSync,
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
  // Load every declared skill that exists in the store.
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
    "\n\n---\n# Live authority\n\n" +
      `Autonomy: **${authority.autonomy}**.\n\n` +
      "Capability policy (capabilityId: mode):\n" +
      policyLines +
      "\n\nUse only the governance tools offered for this run. Tool results enforce the policy; stop after a recommendation. Reach Done only through `accept_completion`.",
  );
  return parts.join("");
}

/** The task goal is still the unspecified triage placeholder (or blank) — the
 * operator must draft it (set_goal) before prompting any agent against it. */
function goalIsUnspecified(goal: string): boolean {
  const g = goal.trim();
  return g === "" || g === DEFAULT_GOAL.trim();
}

type OperatorTrigger = NonNullable<RunOperatorInput["trigger"]>;

function agentReportBlock(trigger: OperatorTrigger, agentReply?: string): string {
  if (trigger !== "agent-reply" || !agentReply?.trim()) return "";
  const report = agentReply.slice(0, 4000);
  const suffix = agentReply.length > report.length ? " (first 4,000 chars)" : "";
  return `\n\n# Agent report${suffix}\n\n\`\`\`text\n${report}\n\`\`\``;
}

/** The turn-specific instruction shared by both operator backends. */
function operatorTurnInstruction(
  snapshot: OperatorTaskSnapshot,
  trigger: OperatorTrigger,
  humanComment?: string,
): string {
  if (humanComment?.trim()) {
    return (
      `A human addressed you directly: "${humanComment.trim()}" Respond from the live task state, ` +
      "then take only the coordination action it warrants. If none is needed, leave one concise reply."
    );
  }
  if (trigger === "goal-updated") {
    return (
      "The goal was edited. If it now supplies the input requested by the open packet, resolve that packet as moot. " +
      "Continue the current stage using the new goal. If it is still not actionable, state the missing input once; do not open a duplicate packet."
    );
  }
  if (trigger === "agent-reply") {
    return (
      "React to the report above. Move completed implementation toward review; accept a clean review through `accept_completion`. " +
      "If review requests changes, move back to the work stage and `prompt_agent` the delivering profile with the concrete findings. " +
      "Re-prompt the same profile only when its work is incomplete, never merely to repeat the report."
    );
  }

  const scope = goalIsUnspecified(snapshot.goal)
    ? "The goal is unspecified. First use `set_goal` to add concrete scope and acceptance criteria, or request genuinely missing scope with one decision packet. "
    : "";
  return (
    scope +
    "Advance an eligible pre-work `auto` transition. At a work stage, choose the deployed profile by description and capabilities, " +
    "then call `prompt_agent` with a concrete directive and `delivers: true` for implementation or `false` for supporting review. Stop after the handoff."
  );
}

/** Codex cannot call the in-process tools, so it returns a constrained plan. */

export function buildCodexOperatorPrompt(
  snapshot: OperatorTaskSnapshot,
  trigger: OperatorTrigger,
  humanComment?: string,
  agentReply?: string,
): string {
  return (
    "# Task snapshot\n\n```json\n" +
    JSON.stringify(snapshot, null, 2) +
    "\n```" + agentReportBlock(trigger, agentReply) +
    "\n\n# Your decision\n\n" +
    "You cannot call tools. Return the schema-constrained action plan that the server should execute. Use only profile ids and stage ids from the snapshot. " +
    "Select profiles by `desc` and `capabilities`, not their names.\n\n" +
    operatorTurnInstruction(snapshot, trigger, humanComment) +
    "\n\nUse `reasoning` for a concise human-visible reply only when the actions do not already narrate the turn; otherwise use an empty string. " +
    "Give governed actions a short `reason`. Return only the JSON plan."
  );
}

/** Claude receives the same decision rule plus live tool access. */
export function buildOperatorTurnPrompt(
  snapshot: OperatorTaskSnapshot,
  trigger: OperatorTrigger,
  humanComment?: string,
  agentReply?: string,
): string {
  return (
    `You are operating ${snapshot.key}, "${snapshot.title}", at stage "${snapshot.stageName}".\n` +
    `Goal: ${snapshot.goal}\n\nCall \`get_task\` first; its live state and offered tools are authoritative.` +
    agentReportBlock(trigger, agentReply) +
    "\n\n" +
    operatorTurnInstruction(snapshot, trigger, humanComment)
  );
}
