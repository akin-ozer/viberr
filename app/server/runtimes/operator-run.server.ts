import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import {
  getDataRoot,
  agentProfilesDir,
  skillDirPath,
} from "~/server/files/file-store-root.server";
import {
  KB_INJECTION_BUDGET,
  readKbBody,
} from "~/server/files/kb-injection.server";
import { splitFrontmatter } from "~/server/files/frontmatter.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import type { LogLine } from "~/features/runtime/runtime-types";
import { newId } from "~/shared/ids/new-id.server";
import {
  gate,
  operatorAcceptCompletion,
  operatorAssessReadiness,
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
import { fullReplyTextForRun } from "~/server/tasks/agent-reply.server";
import type { TaskMutationContext } from "~/server/tasks/task-actions.server";
import {
  isBackendAvailable,
  type RealBackend,
} from "./runtime-registry.server";
import {
  registerRunCompletion,
  startRun,
  stopRunForLifecycle,
} from "./run-service.server";
import { patchRun, upsertRun } from "./run-store.server";
import { buildScript } from "./simulated-runtime.server";
import {
  advanceRunCompletionPhase,
  projectCompletionAdmissionOpen,
  RUN_COMPLETION_PHASE,
  sourceLinkedOperatorReactionReady,
  withProjectCompletionEffect,
} from "./run-completion-state.server";

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
 *   neither backend available → SCRIPTED drive: the same operator-actions are
 *     called deterministically in code (the board still advances honestly), and
 *     a simulated run streams the narrative to the agent logs.
 */

const OPERATOR_AUDIT_ACTOR: AuditActor = { userId: null, label: "operator" };

type OpenSystemRecovery =
  typeof import("~/server/tasks/task-recovery.server").openSystemRecovery;
let operatorRecoveryWriterForTests: OpenSystemRecovery | null = null;
let scriptedOperatorHookForTests:
  | ((db: Database.Database, input: RunOperatorInput) => void | Promise<void>)
  | null = null;
let scriptedOperatorBeforeNarrationHookForTests:
  | ((db: Database.Database, input: RunOperatorInput) => void | Promise<void>)
  | null = null;
let operatorLaunchHookForTests:
  | ((db: Database.Database, input: RunOperatorInput) => void | Promise<void>)
  | null = null;

/** Focused fault-injection seam: completion durability tests must prove a
 * failed recovery write leaves operator_effect_state pending. */
export function configureOperatorRecoveryWriterForTests(
  writer: OpenSystemRecovery | null,
): void {
  operatorRecoveryWriterForTests = writer;
}

export function configureScriptedOperatorHookForTests(
  hook:
    | ((db: Database.Database, input: RunOperatorInput) => void | Promise<void>)
    | null,
): void {
  scriptedOperatorHookForTests = hook;
}

/** Fault seam after governed scripted actions but before startRun materializes
 * narration. The durable run/effect marker must already exist here. */
export function configureScriptedOperatorBeforeNarrationHookForTests(
  hook:
    | ((db: Database.Database, input: RunOperatorInput) => void | Promise<void>)
    | null,
): void {
  scriptedOperatorBeforeNarrationHookForTests = hook;
}

/** Fault seam after the durable operator reservation and lease acquisition but
 * before any provider launch. This exercises the synchronous launch-recovery
 * path without depending on provider-adapter error handling. */
export function configureOperatorLaunchHookForTests(
  hook:
    | ((db: Database.Database, input: RunOperatorInput) => void | Promise<void>)
    | null,
): void {
  operatorLaunchHookForTests = hook;
}

async function openOperatorSystemRecovery(
  ...args: Parameters<OpenSystemRecovery>
): Promise<Awaited<ReturnType<OpenSystemRecovery>>> {
  const writer =
    operatorRecoveryWriterForTests ??
    (await import("~/server/tasks/task-recovery.server")).openSystemRecovery;
  return writer(...args);
}

export interface RunOperatorInput {
  projectSlug: string;
  taskKey: string;
  /** Canonical task `createdAt` captured by a caller before it performs any
   * asynchronous prerequisite (for example, persisting an `@operator`
   * comment). When supplied, admission is valid only for that exact task
   * incarnation; a delete/recreate may never retarget the old intent. */
  expectedTaskIncarnation?: string;
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
  /** Durable automatic dispatch that is attempting to own this run. Unlike
   * human/reaction triggers, a dispatch must never coalesce onto another run:
   * the dispatcher keeps its own row queued and retries after the task lease
   * becomes available. */
  dispatchId?: string;
  /** Specialist run whose clean completion caused this reaction. Exactly one
   * source-linked operator run may exist, making boot replay idempotent. */
  completionSourceRunId?: string;
}

export interface RunOperatorResult {
  runId: string;
  backend: RealBackend;
  /** "real" = LLM tool-driven · "scripted" = deterministic drive. */
  mode: "real" | "scripted";
  autonomy: OperatorAutonomy;
  /** `started` is the only result a durable dispatch may claim as its own.
   * `coalesced` is reserved for ordinary/manual triggers; `busy` tells the
   * dispatcher to leave its durable row queued without borrowing a foreign
   * run id or placing work in the process-local pending map. */
  disposition: "started" | "coalesced" | "busy";
}

/** A queued/running operator run for the same task, if one is already in flight. */
function inFlightOperatorRun(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
  taskIncarnation: string,
): { id: string; backend: RealBackend } | null {
  const row = db
    .prepare(
      `SELECT id, backend FROM agent_runs
       WHERE project_slug = ? AND task_key = ? AND kind = 'operator'
         AND task_incarnation = ?
         AND state IN ('queued', 'running')
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(projectSlug, taskKey, taskIncarnation) as
    { id: string; backend: string } | undefined;
  return row ? { id: row.id, backend: row.backend as RealBackend } : null;
}

interface OperatorReactionReservation {
  runId: string;
  threadId: string;
}

function sourceLinkedOperatorRun(
  db: Database.Database,
  sourceRunId: string,
): { id: string; backend: RealBackend; simulated: number } | null {
  return (
    (db
      .prepare(
        `SELECT id, backend, simulated FROM agent_runs
         WHERE kind = 'operator' AND completion_source_run_id = ?
         LIMIT 1`,
      )
      .get(sourceRunId) as
      { id: string; backend: RealBackend; simulated: number } | undefined) ??
    null
  );
}

/** Persist every operator run/effect identity before any scripted action or
 * provider launch. Source-linked rows additionally provide reaction
 * idempotency. A crash from this point is ambiguous and recovered, never
 * replayed as if it were safely pre-launch. */
function reserveOperatorRun(
  db: Database.Database,
  input: RunOperatorInput,
  authority: OperatorAuthority,
  taskIncarnation: string,
): OperatorReactionReservation {
  const runId = newId("run");
  const threadId = "op-" + newId("t").replace("t_", "").slice(0, 8);
  upsertRun(db, {
    id: runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId,
    role: "Operator",
    kind: "operator",
    backend: authority.backend,
    simulated: !isBackendAvailable(authority.backend),
    model: authority.model,
    sdk: authority.backend === "codex" ? "Codex SDK" : "Claude Agent SDK",
    agentName: authority.name,
    agentProfileId: "operator",
    completionSourceRunId: input.completionSourceRunId,
    taskIncarnation,
    operatorDispatchId: input.dispatchId ?? null,
    operatorEffectState: "pending",
    state: "queued",
  });
  return { runId, threadId };
}

// ------------------------------------------------------ single-flight lease

/**
 * Process-level operator lease + durable trigger mailbox.
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
 * A trigger arriving while held is persisted (newest wins — the operator
 * re-reads the full task anyway, so the latest trigger subsumes older ones)
 * and drained on release or boot recovery.
 */
interface OperatorLeaseToken {
  runId: string | null;
  backend: RealBackend;
  autonomy: OperatorAutonomy;
  cancelled: boolean;
  projectSlug: string;
  taskKey: string;
  taskIncarnation: string;
  dataRoot?: string;
}

interface OperatorLeaseState {
  held: Map<string, OperatorLeaseToken>;
  /** Prevent a release callback and boot recovery from draining the same task
   * concurrently inside one process. The work itself lives in SQLite. */
  draining: Set<string>;
}

const LEASE_KEY = Symbol.for("viberr.operatorLease");

function leaseState(): OperatorLeaseState {
  const cache = globalThis as unknown as Record<
    symbol,
    OperatorLeaseState | undefined
  >;
  let state = cache[LEASE_KEY];
  if (!state) {
    state = { held: new Map(), draining: new Set() };
    cache[LEASE_KEY] = state;
  }
  // Dev HMR may retain the pre-durable process-global object.
  state.draining ??= new Set();
  return state;
}

function leaseKeyFor(
  projectSlug: string,
  taskKey: string,
  taskIncarnation: string,
): string {
  return `${projectSlug}/${taskKey}@${taskIncarnation}`;
}

/** Read the canonical lifecycle token only while both projections and files
 * still agree that this task belongs to an active project. */
function activeTaskIncarnation(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
  dataRoot?: string,
): string | null {
  if (!projectCompletionAdmissionOpen(db, projectSlug)) return null;
  const projectedProject = db
    .prepare(`SELECT archived FROM projects WHERE slug = ?`)
    .get(projectSlug) as { archived: number } | undefined;
  if (!projectedProject || projectedProject.archived === 1) return null;
  const project = readProjectFile({
    projectSlug,
    ...(dataRoot !== undefined ? { dataRoot } : {}),
  });
  if (!project || project.parsed.frontmatter.archived === true) return null;
  const projectedTask = db
    .prepare(
      `SELECT 1 FROM task_projections WHERE project_slug = ? AND task_key = ?`,
    )
    .get(projectSlug, taskKey);
  if (!projectedTask) return null;
  const task = readTaskFile({
    projectSlug,
    taskKey,
    ...(dataRoot !== undefined ? { dataRoot } : {}),
  });
  return task?.parsed.frontmatter.createdAt || null;
}

interface OperatorPendingTriggerRow {
  project_slug: string;
  task_key: string;
  task_incarnation: string;
  coalescing_key: string;
  trigger: NonNullable<RunOperatorInput["trigger"]>;
  backend: RealBackend | null;
  autonomy: OperatorAutonomy | null;
  react_depth: number | null;
  human_comment: string | null;
  source_run_id: string | null;
  actor_json: string | null;
  data_root: string | null;
  generation: string;
}

const pendingAuditActorSchema = z
  .object({
    userId: z.string().nullable(),
    label: z.string(),
    auditAuthoritySource: z.literal("org_admin_override").optional(),
  })
  .strict();

/** Atomically replace the task's waiting instruction. The operator always
 * re-reads canonical task state, so the newest trigger subsumes older context
 * while preserving the latest human comment/source identity exactly. */
function pendingTriggerCoalescingKey(input: RunOperatorInput): string {
  return input.completionSourceRunId
    ? `source:${input.completionSourceRunId}`
    : "ordinary";
}

function upsertPendingOperatorTrigger(
  db: Database.Database,
  input: RunOperatorInput,
  taskIncarnation: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO operator_pending_triggers
       (project_slug, task_key, task_incarnation, coalescing_key, trigger,
        backend, autonomy, react_depth, human_comment, source_run_id,
        actor_json, data_root, generation, sequence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             (SELECT coalesce(max(sequence), 0) + 1 FROM operator_pending_triggers),
             ?, ?)
     ON CONFLICT(project_slug, task_key, coalescing_key) DO UPDATE SET
       task_incarnation = excluded.task_incarnation,
       trigger = excluded.trigger,
       backend = excluded.backend,
       autonomy = excluded.autonomy,
       react_depth = excluded.react_depth,
       human_comment = excluded.human_comment,
       source_run_id = excluded.source_run_id,
       actor_json = excluded.actor_json,
       data_root = excluded.data_root,
       generation = excluded.generation,
       sequence = excluded.sequence,
       updated_at = excluded.updated_at`,
  ).run(
    input.projectSlug,
    input.taskKey,
    taskIncarnation,
    pendingTriggerCoalescingKey(input),
    input.trigger ?? "manual",
    input.backend ?? null,
    input.autonomy ?? null,
    input.reactDepth ?? null,
    input.humanComment ?? null,
    input.completionSourceRunId ?? null,
    input.actor ? JSON.stringify(input.actor) : null,
    input.dataRoot ?? null,
    newId("opt"),
    now,
    now,
  );
}

function deletePendingOperatorGeneration(
  db: Database.Database,
  row: OperatorPendingTriggerRow,
): boolean {
  return (
    db
      .prepare(
        `DELETE FROM operator_pending_triggers
          WHERE project_slug = ? AND task_key = ?
            AND coalescing_key = ? AND generation = ?`,
      )
      .run(row.project_slug, row.task_key, row.coalescing_key, row.generation)
      .changes > 0
  );
}

function pendingTriggerInput(
  row: OperatorPendingTriggerRow,
  fallbackDataRoot?: string,
): RunOperatorInput | null {
  let actor: AuditActor | undefined;
  if (row.actor_json !== null) {
    try {
      const parsed = pendingAuditActorSchema.safeParse(
        JSON.parse(row.actor_json),
      );
      if (!parsed.success) return null;
      actor = parsed.data;
    } catch {
      return null;
    }
  }
  const dataRoot = row.data_root ?? fallbackDataRoot;
  return {
    projectSlug: row.project_slug,
    taskKey: row.task_key,
    expectedTaskIncarnation: row.task_incarnation,
    trigger: row.trigger,
    ...(row.backend !== null ? { backend: row.backend } : {}),
    ...(row.autonomy !== null ? { autonomy: row.autonomy } : {}),
    ...(row.react_depth !== null ? { reactDepth: row.react_depth } : {}),
    ...(row.human_comment !== null ? { humanComment: row.human_comment } : {}),
    ...(row.source_run_id !== null
      ? { completionSourceRunId: row.source_run_id }
      : {}),
    ...(actor !== undefined ? { actor } : {}),
    ...(dataRoot !== undefined ? { dataRoot } : {}),
  };
}

/** Canonical files and projections must both still own the target. This makes
 * an archive/delete that races boot or a release callback win deterministically
 * even while the file watcher is between its own lifecycle steps. */
function pendingTriggerTargetActive(
  db: Database.Database,
  row: OperatorPendingTriggerRow,
  fallbackDataRoot?: string,
): boolean {
  const dataRoot = row.data_root ?? fallbackDataRoot;
  return (
    activeTaskIncarnation(db, row.project_slug, row.task_key, dataRoot) ===
    row.task_incarnation
  );
}

export interface DrainPendingOperatorTriggersOptions {
  /** Omit both to drain every task during boot. */
  projectSlug?: string;
  taskKey?: string;
  /** Fallback for historical/default-root rows; newly queued custom-root work
   * carries its own data root in the durable row. */
  dataRoot?: string;
}

/** Launch each durable generation at most once per drain snapshot. Deletion is
 * compare-and-delete by generation: a concurrent newer instruction remains in
 * the mailbox and the successor lease will drain it later. */
export async function drainPendingOperatorTriggers(
  db: Database.Database,
  options: DrainPendingOperatorTriggersOptions = {},
): Promise<void> {
  if (!db.open) return;
  const hasProject = options.projectSlug !== undefined;
  const hasTask = options.taskKey !== undefined;
  if (hasProject !== hasTask) {
    throw new Error(
      "Pending operator drain requires both projectSlug and taskKey, or neither.",
    );
  }
  const rows = (
    hasProject
      ? db
          .prepare(
            `SELECT project_slug, task_key, task_incarnation, coalescing_key, trigger, backend, autonomy,
                  react_depth, human_comment, source_run_id, actor_json,
                  data_root, generation
             FROM operator_pending_triggers
            WHERE project_slug = ? AND task_key = ?
            ORDER BY sequence ASC, coalescing_key ASC`,
          )
          .all(options.projectSlug, options.taskKey)
      : db
          .prepare(
            `SELECT project_slug, task_key, task_incarnation, coalescing_key, trigger, backend, autonomy,
                  react_depth, human_comment, source_run_id, actor_json,
                  data_root, generation
             FROM operator_pending_triggers
            ORDER BY sequence ASC, project_slug ASC, task_key ASC, coalescing_key ASC`,
          )
          .all()
  ) as OperatorPendingTriggerRow[];

  for (const row of rows) {
    if (!db.open) return;
    const key = leaseKeyFor(
      row.project_slug,
      row.task_key,
      row.task_incarnation,
    );
    const state = leaseState();
    if (state.draining.has(key)) continue;
    state.draining.add(key);
    let completedScriptedDrive = false;
    try {
      if (!pendingTriggerTargetActive(db, row, options.dataRoot)) {
        deletePendingOperatorGeneration(db, row);
        continue;
      }
      const input = pendingTriggerInput(row, options.dataRoot);
      if (!input) {
        deletePendingOperatorGeneration(db, row);
        logger.error("discarded malformed durable operator trigger", {
          projectSlug: row.project_slug,
          taskKey: row.task_key,
        });
        continue;
      }

      logger.info("draining durable operator trigger", {
        projectSlug: row.project_slug,
        taskKey: row.task_key,
        trigger: row.trigger,
      });
      const launched = await runOperator(db, input);
      if (launched.disposition === "busy") {
        // Durable manual/reaction rows never carry dispatchId, but retain the
        // row if a future caller introduces another admission reason.
        continue;
      }
      if (
        row.source_run_id !== null &&
        sourceLinkedOperatorReactionReady(db, row.source_run_id)
      ) {
        // The specialist completion callback already returned when it placed
        // this source reaction behind another lease. Once drain has obtained a
        // durable source-linked owner, acknowledge the handoff live instead of
        // leaving completion_phase stranded until the next boot.
        advanceRunCompletionPhase(
          db,
          row.source_run_id,
          RUN_COMPLETION_PHASE.complete,
        );
      }
      const consumed = deletePendingOperatorGeneration(db, row);
      if (!consumed && launched.disposition === "started") {
        const successor = db
          .prepare(
            `SELECT generation FROM operator_pending_triggers
              WHERE project_slug = ? AND task_key = ? AND coalescing_key = ?`,
          )
          .get(row.project_slug, row.task_key, row.coalescing_key) as
          { generation: string } | undefined;
        if (!successor) {
          // Lifecycle purge won after eligibility but before launch ownership
          // was consumed. Revoke this exact run; never sweep a same-slug
          // replacement project.
          const held = state.held.get(key);
          if (held?.runId === launched.runId) {
            held.cancelled = true;
            state.held.delete(key);
          }
          stopRunForLifecycle(db, launched.runId);
        }
      }
      completedScriptedDrive =
        launched.disposition === "started" && launched.mode === "scripted";
    } catch (error) {
      logger.error("durable operator trigger failed and remains queued", {
        projectSlug: row.project_slug,
        taskKey: row.task_key,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    } finally {
      state.draining.delete(key);
      if (completedScriptedDrive && db.open) {
        const successor = db
          .prepare(
            `SELECT 1 FROM operator_pending_triggers
              WHERE project_slug = ? AND task_key = ?`,
          )
          .get(row.project_slug, row.task_key);
        // A scripted drive releases before runOperator resolves, so its nested
        // release drain observed `draining`. Wake the newer generation now.
        if (successor) {
          void drainPendingOperatorTriggers(db, {
            projectSlug: row.project_slug,
            taskKey: row.task_key,
            ...(options.dataRoot !== undefined
              ? { dataRoot: options.dataRoot }
              : {}),
          });
        }
      }
    }
  }
}

/** Archive/delete intentionally purge waiting instructions rather than retain
 * them as history: restoring or recreating a project must not resurrect an old
 * human comment or specialist reaction. */
export function cancelPendingOperatorTriggersForProject(
  db: Database.Database,
  projectSlug: string,
): number {
  if (!db.open) return 0;
  return db
    .prepare(`DELETE FROM operator_pending_triggers WHERE project_slug = ?`)
    .run(projectSlug).changes;
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
  token: OperatorLeaseToken,
): void {
  const state = leaseState();
  const current = state.held.get(key);
  if (current !== token) return; // stale release — ignore
  state.held.delete(key);
  if (!db.open) return;
  void drainPendingOperatorTriggers(db, {
    projectSlug: token.projectSlug,
    taskKey: token.taskKey,
    ...(token.dataRoot !== undefined ? { dataRoot: token.dataRoot } : {}),
  });
}

function revokeOperatorLaunch(
  db: Database.Database,
  key: string,
  token: OperatorLeaseToken,
  runId: string | null,
): void {
  token.cancelled = true;
  const state = leaseState();
  if (state.held.get(key) === token) state.held.delete(key);
  if (runId) stopRunForLifecycle(db, runId);
}

function clearOperatorLeaseState(matches: (key: string) => boolean): number {
  const state = leaseState();
  let cleared = 0;
  for (const key of state.held.keys()) {
    if (!matches(key)) continue;
    const held = state.held.get(key);
    if (held) held.cancelled = true;
    if (state.held.delete(key)) cleared += 1;
  }
  return cleared;
}

/** Test-only: simulate a fresh process. Durable triggers intentionally remain
 * in SQLite so restart tests can prove boot replay. */
export function resetOperatorLeasesForTests(): void {
  clearOperatorLeaseState(() => true);
  leaseState().draining.clear();
}

/** Cancel every process-local operator lease for a project.
 * Archive/delete call this before detaching runtime handles. Token-checked
 * late releases then become harmless no-ops and cannot resurrect work. */
export function clearOperatorLeasesForProject(projectSlug: string): number {
  const prefix = `${projectSlug}/`;
  return clearOperatorLeaseState((key) => key.startsWith(prefix));
}

export async function runOperator(
  db: Database.Database,
  input: RunOperatorInput,
): Promise<RunOperatorResult> {
  const taskIncarnation = activeTaskIncarnation(
    db,
    input.projectSlug,
    input.taskKey,
    input.dataRoot,
  );
  if (!taskIncarnation) {
    throw new Error(
      `Operator target ${input.projectSlug}/${input.taskKey} is missing, archived, or has no canonical incarnation.`,
    );
  }
  if (
    input.expectedTaskIncarnation !== undefined &&
    input.expectedTaskIncarnation !== taskIncarnation
  ) {
    throw new Error(
      `Operator target ${input.projectSlug}/${input.taskKey} changed before admission.`,
    );
  }
  const ctx: TaskMutationContext = {
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
    expectedTaskIncarnation: taskIncarnation,
  };
  const authority = resolveOperatorAuthority(ctx, input.projectSlug, {
    ...(input.backend ? { backend: input.backend } : {}),
    ...(input.autonomy ? { autonomy: input.autonomy } : {}),
  });
  const backend = authority.backend;
  if (input.completionSourceRunId && input.trigger !== "agent-reply") {
    throw new Error(
      "completionSourceRunId is valid only for an agent-reply operator reaction.",
    );
  }
  if (input.completionSourceRunId) {
    const existing = sourceLinkedOperatorRun(db, input.completionSourceRunId);
    if (existing) {
      return {
        runId: existing.id,
        backend: existing.backend,
        mode: existing.simulated === 1 ? "scripted" : "real",
        autonomy: authority.autonomy,
        disposition: "coalesced",
      };
    }
  }

  // Single-flight per task (NFR16, B6): one operator coordinates a task at a
  // time. A trigger arriving while the lease is held — e.g. create-time
  // auto-invoke racing an "@operator …" comment — is QUEUED (newest wins) and
  // fired when the in-flight coordination truly ends, so no trigger is ever
  // silently dropped and no two drives overlap. The process lease covers the
  // scripted/codex windows the agent_runs row alone misses.
  const leaseKey = leaseKeyFor(
    input.projectSlug,
    input.taskKey,
    taskIncarnation,
  );
  const lease = leaseState();
  const heldByProcess = lease.held.get(leaseKey);
  if (heldByProcess) {
    if (input.dispatchId) {
      logger.info("automatic operator dispatch waiting for the task lease", {
        taskKey: input.taskKey,
        dispatchId: input.dispatchId,
      });
      return {
        runId: "queued",
        backend: heldByProcess.backend,
        mode: isBackendAvailable(heldByProcess.backend) ? "real" : "scripted",
        autonomy: heldByProcess.autonomy,
        disposition: "busy",
      };
    }
    upsertPendingOperatorTrigger(db, input, taskIncarnation);
    logger.info(
      "operator run durably queued — one already in flight (process lease)",
      {
        taskKey: input.taskKey,
        trigger: input.trigger ?? "manual",
      },
    );
    return {
      runId: heldByProcess.runId ?? "queued",
      backend: heldByProcess.backend,
      mode: isBackendAvailable(heldByProcess.backend) ? "real" : "scripted",
      autonomy: heldByProcess.autonomy,
      disposition: "coalesced",
    };
  }
  // Cross-boot backstop: a queued/running DB row without a process lease (e.g.
  // resumed after a restart) still coalesces; queue the trigger and drain it
  // when that run finishes.
  const inflight = inFlightOperatorRun(
    db,
    input.projectSlug,
    input.taskKey,
    taskIncarnation,
  );
  if (inflight) {
    if (input.dispatchId) {
      logger.info("automatic operator dispatch waiting for an in-flight run", {
        taskKey: input.taskKey,
        dispatchId: input.dispatchId,
        runId: inflight.id,
      });
      return {
        runId: "queued",
        backend: inflight.backend,
        mode: isBackendAvailable(inflight.backend) ? "real" : "scripted",
        autonomy: authority.autonomy,
        disposition: "busy",
      };
    }
    upsertPendingOperatorTrigger(db, input, taskIncarnation);
    const recoveryToken = {
      runId: inflight.id,
      backend: inflight.backend,
      autonomy: authority.autonomy,
      cancelled: false,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      taskIncarnation,
      ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
    };
    lease.held.set(leaseKey, recoveryToken);
    const { chainRunCompletionOrInvoke } = await import("./run-service.server");
    chainRunCompletionOrInvoke(db, inflight.id, () =>
      releaseOperatorLease(db, leaseKey, recoveryToken),
    );
    logger.info("operator run durably queued — DB row already in flight", {
      taskKey: input.taskKey,
      runId: inflight.id,
      trigger: input.trigger ?? "manual",
    });
    return {
      runId: inflight.id,
      backend: inflight.backend,
      mode: isBackendAvailable(inflight.backend) ? "real" : "scripted",
      autonomy: authority.autonomy,
      disposition: "coalesced",
    };
  }

  // The lease-entry OBJECT is this drive's release token — every release for
  // this drive passes it, so a stale/duplicate release can never evict a
  // successor's lease (releaseOperatorLease is idempotent per token).
  const leaseToken = {
    runId: null as string | null,
    backend,
    autonomy: authority.autonomy,
    cancelled: false,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    taskIncarnation,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  };
  lease.held.set(leaseKey, leaseToken);

  let reactionReservation: OperatorReactionReservation | null = null;
  try {
    reactionReservation = reserveOperatorRun(
      db,
      input,
      authority,
      taskIncarnation,
    );
  } catch (error) {
    // A second process may have won the unique source-id reservation between
    // the initial read and this insert. Return that durable owner rather than
    // surfacing a false failure or launching duplicate work.
    const existing = input.completionSourceRunId
      ? sourceLinkedOperatorRun(db, input.completionSourceRunId)
      : null;
    if (!existing) {
      releaseOperatorLease(db, leaseKey, leaseToken);
      throw error;
    }
    releaseOperatorLease(db, leaseKey, leaseToken);
    return {
      runId: existing.id,
      backend: existing.backend,
      mode: existing.simulated === 1 ? "scripted" : "real",
      autonomy: authority.autonomy,
      disposition: "coalesced",
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

  // Close the admission gap before any scripted governed action or provider
  // launch. The post-start comparison below closes the second half of the
  // handshake when archive/delete/recreation happens inside adapter.start().
  if (
    activeTaskIncarnation(
      db,
      input.projectSlug,
      input.taskKey,
      input.dataRoot,
    ) !== taskIncarnation
  ) {
    revokeOperatorLaunch(
      db,
      leaseKey,
      leaseToken,
      reactionReservation?.runId ?? null,
    );
    throw new Error(
      `Operator target ${input.projectSlug}/${input.taskKey} changed during admission.`,
    );
  }

  // Claude: real tool-driven operator (in-process MCP tools). Codex: no
  // in-process tool channel, so it runs a real STRUCTURED-OUTPUT operator (the
  // model emits a decision plan we execute through the same capability-gated
  // actions). Neither available → deterministic scripted drive. The real/codex
  // paths release the lease on run COMPLETION (chained callback); only a
  // SYNCHRONOUS throw before that reaches the outer catch. The scripted path is
  // synchronous, so it releases in its own finally — the outer catch must NOT
  // also release it (that double-release is the bug). Idempotent-per-token
  // release makes even an accidental double-release safe.
  let launched: RunOperatorResult;
  try {
    await operatorLaunchHookForTests?.(db, input);
    if (backend === "claude" && isBackendAvailable("claude")) {
      launched = await startRealOperatorRun(
        db,
        ctx,
        input,
        authority,
        leaseKey,
        leaseToken,
        reactionReservation,
      );
    } else if (backend === "codex" && isBackendAvailable("codex")) {
      launched = await startCodexOperatorRun(
        db,
        ctx,
        input,
        authority,
        leaseKey,
        leaseToken,
        reactionReservation,
      );
    } else {
      try {
        launched = await withProjectCompletionEffect(
          db,
          input.projectSlug,
          () =>
            runScriptedOperatorDrive(
              db,
              ctx,
              input,
              authority,
              reactionReservation,
            ),
        );
      } finally {
        // Scripted coordination is fully synchronous with this call.
        releaseOperatorLease(db, leaseKey, leaseToken);
      }
    }
  } catch (error) {
    try {
      if (reactionReservation && db.open) {
        patchRun(db, reactionReservation.runId, {
          state: "error",
          finishedAt: new Date().toISOString(),
          phase: null,
          step: null,
        });
        if (
          activeTaskIncarnation(
            db,
            input.projectSlug,
            input.taskKey,
            input.dataRoot,
          ) !== taskIncarnation
        ) {
          patchRun(db, reactionReservation.runId, {
            operatorEffectState: "recovery",
          });
        } else {
          await escalateFailedOperatorRun(
            db,
            ctx,
            input,
            reactionReservation.runId,
          );
          patchRun(db, reactionReservation.runId, {
            operatorEffectState: "recovery",
          });
        }
      }
    } finally {
      // Recovery persistence is deliberately allowed to fail so boot can
      // converge a pending effect. It must never retain the in-process lease.
      releaseOperatorLease(db, leaseKey, leaseToken);
    }
    throw error;
  }

  if (
    activeTaskIncarnation(
      db,
      input.projectSlug,
      input.taskKey,
      input.dataRoot,
    ) !== taskIncarnation
  ) {
    revokeOperatorLaunch(db, leaseKey, leaseToken, launched.runId);
    logger.warn("operator launch lost its task incarnation", {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      runId: launched.runId,
    });
    throw new Error(
      `Operator target ${input.projectSlug}/${input.taskKey} changed during launch.`,
    );
  }
  return launched;
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
  "assess_readiness",
  "open_packet",
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
      description:
        "A concise operator comment: observed → changed → recommended → decision required.",
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
          profileId: {
            type: ["string", "null"],
            description: "For assign_/run_/prompt_ actions, else null.",
          },
          backend: {
            type: ["string", "null"],
            enum: ["claude", "codex", null],
            description:
              "For assign_/prompt_ routing actions, the backend from the selected candidate row; else null.",
          },
          toStageId: {
            type: ["string", "null"],
            description: "For transition_stage, else null.",
          },
          packetType: {
            type: ["string", "null"],
            enum: ["input", "blocked", null],
            description:
              "For open_packet: 'blocked' when work is stuck, 'input' for a decision; else null.",
          },
          readiness: {
            type: ["string", "null"],
            enum: ["ready", "input_required", null],
            description: "For assess_readiness, else null.",
          },
          text: {
            type: ["string", "null"],
            description:
              "For post_comment and prompt_/open_packet: the comment text, agent prompt, or packet title; else null.",
          },
          reason: {
            type: ["string", "null"],
            description:
              "Short why — required and non-empty for assign_/prompt_ routing choices; recommendation-card reasoning or the packet body elsewhere.",
          },
        },
        required: [
          "tool",
          "profileId",
          "backend",
          "toStageId",
          "packetType",
          "readiness",
          "text",
          "reason",
        ],
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
const operatorPlanActionSchema = z
  .object({
    tool: z.enum(OPERATOR_PLAN_TOOLS),
    profileId: z.string().nullable(),
    backend: z.enum(["claude", "codex"]).nullable(),
    toStageId: z.string().nullable(),
    packetType: z.enum(OPERATOR_PACKET_TYPES).nullable(),
    readiness: z.enum(["ready", "input_required"]).nullable(),
    text: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .strict()
  .superRefine((action, refinement) => {
    if (
      action.tool !== "assign_specialist" &&
      action.tool !== "prompt_specialist" &&
      action.tool !== "assign_reviewer" &&
      action.tool !== "prompt_reviewer"
    ) {
      return;
    }
    if (!action.profileId) {
      refinement.addIssue({
        code: "custom",
        path: ["profileId"],
        message: "A routed action requires an exact profileId.",
      });
    }
    if (!action.backend) {
      refinement.addIssue({
        code: "custom",
        path: ["backend"],
        message: "A routed action requires the selected candidate backend.",
      });
    }
  });

const operatorPlanRuntimeSchema = z
  .object({
    reasoning: z.string(),
    actions: z.array(operatorPlanActionSchema),
  })
  .strict();

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
        {
          kind: "block_on_policy",
          title: "Update the policy / credential and unblock",
          recommended: true,
        },
        {
          kind: "redirect",
          title: "Redirect the specialist with new guidance",
        },
        { kind: "hold_runtime_debug", title: "Hold for runtime debugging" },
      ]
    : [
        {
          kind: "request_edit",
          title: "Send back to the specialist for changes",
          recommended: true,
        },
        { kind: "redirect", title: "Reassign or redirect the work" },
      ];
}

/** A fresh, repo-free cwd for one operator turn. Operators coordinate through
 * Viberr actions; they never need the task directory (which may sit inside the
 * app checkout). A unique directory also prevents Codex from inheriting files
 * left by an earlier turn. */
function createOperatorWorkdir(
  projectSlug: string,
  taskKey: string,
  dataRoot?: string,
): { workdir: string; env: Record<string, string> } {
  const parent = path.join(
    getDataRoot(dataRoot),
    "runtimes",
    "operator-workspaces",
    projectSlug,
    taskKey,
  );
  const workdir = path.join(parent, newId("opw"));
  mkdirSync(workdir, { recursive: true });
  return {
    workdir,
    // The ceiling is the strict parent of cwd, so git cannot walk upward and
    // discover Viberr's own checkout even if a backend ignores the prompt.
    env: { GIT_CEILING_DIRECTORIES: parent },
  };
}

async function startCodexOperatorRun(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
  leaseKey: string,
  leaseToken: OperatorLeaseToken,
  reservation: OperatorReactionReservation | null,
): Promise<RunOperatorResult> {
  const snapshot = operatorSnapshot(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    authority,
  );
  const systemPrompt = buildOperatorSystemPrompt(authority, input.dataRoot);
  const prompt = buildCodexOperatorPrompt(
    snapshot,
    input.trigger ?? "manual",
    input.humanComment,
  );
  const isolated = createOperatorWorkdir(
    input.projectSlug,
    input.taskKey,
    input.dataRoot,
  );

  const { runId } = await startRun(db, {
    ...(reservation ? { runId: reservation.runId } : {}),
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId:
      reservation?.threadId ?? "op-" + newId("t").replace("t_", "").slice(0, 8),
    role: "Operator",
    kind: "operator",
    backend: "codex",
    model: authority.model,
    ...(authority.effort ? { effort: authority.effort } : {}),
    agentName: authority.name,
    agentProfileId: "operator",
    completionSourceRunId: input.completionSourceRunId ?? null,
    operatorDispatchId: input.dispatchId ?? null,
    prompt,
    systemPrompt,
    outputSchema: OPERATOR_PLAN_SCHEMA,
    // The structured-output operator needs no shell/repository mutation.
    autonomous: false,
    workdir: isolated.workdir,
    env: isolated.env,
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
  registerRunCompletion(db, runId, async (finished, completion) => {
    // Provider output is only executable after a clean terminal completion.
    // A failed/interrupted turn may have persisted a syntactically valid
    // partial agent_message before it stopped; never treat that as a plan.
    let effectState: "pending" | "applied" | "recovery" = "pending";
    try {
      if (finished.state === "finished") {
        const outcome = await executeCodexPlan(
          db,
          ctx,
          input,
          authority,
          finished.id,
          () =>
            completion.isCancelled() ||
            leaseToken.cancelled ||
            activeTaskIncarnation(
              db,
              input.projectSlug,
              input.taskKey,
              input.dataRoot,
            ) !== leaseToken.taskIncarnation,
        );
        effectState = outcome === "cancelled" ? "recovery" : "applied";
      } else if (finished.state === "error") {
        if (
          !completion.isCancelled() &&
          !leaseToken.cancelled &&
          activeTaskIncarnation(
            db,
            input.projectSlug,
            input.taskKey,
            input.dataRoot,
          ) === leaseToken.taskIncarnation
        ) {
          await escalateFailedOperatorRun(db, ctx, input, finished.id);
          effectState = "applied";
        } else {
          effectState = "recovery";
        }
      }
    } catch (error) {
      if (!db.open) return;
      logger.error("codex operator completion handling failed", {
        taskKey: input.taskKey,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    } finally {
      if (
        completion.isCancelled() ||
        leaseToken.cancelled ||
        activeTaskIncarnation(
          db,
          input.projectSlug,
          input.taskKey,
          input.dataRoot,
        ) !== leaseToken.taskIncarnation
      ) {
        effectState = "recovery";
      }
      if (db.open) {
        patchRun(db, runId, { operatorEffectState: effectState });
      }
      releaseOperatorLease(db, leaseKey, leaseToken);
    }
  });

  logger.info("operator run started (codex structured output)", {
    taskKey: input.taskKey,
    runId,
    autonomy: authority.autonomy,
  });
  return {
    runId,
    backend: "codex",
    mode: "real",
    autonomy: authority.autonomy,
    disposition: "started",
  };
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
  isCancelled: () => boolean = () => false,
): Promise<"applied" | "cancelled"> {
  if (isCancelled() || !db.open) return "cancelled";
  const readinessOnly =
    operatorSnapshot(db, ctx, input.projectSlug, input.taskKey, authority)
      .readiness !== "ready";
  // This is machine-readable control data, not a timeline preview: use the
  // complete reply. replyTextForRun intentionally truncates at 1,200 chars and
  // appends prose, which corrupts otherwise-valid larger JSON plans.
  const text = fullReplyTextForRun(db, runId);
  const plan = text ? parseOperatorPlan(text) : null;
  if (!plan) {
    if (isCancelled() || !db.open) return "cancelled";
    // An empty or unparseable plan is a HUMAN-VISIBLE failure, not a silent
    // no-op: nothing else covers an operator's own run (recovery only watches
    // specialist/reviewer runs), so without this the task simply sits with no
    // signal. Raise a system-owned recovery packet independent of the
    // operator's own `generate-packets` capability.
    logger.warn("codex operator produced no usable plan — escalating", {
      taskKey: input.taskKey,
      runId,
      hadText: !!text,
    });
    await openOperatorSystemRecovery(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        code: "operator_plan_invalid",
        occurrenceId: runId,
        title: "Operator turn produced no actionable plan",
        body: text
          ? "The coordinating run replied, but its output was not a valid decision plan. Coordination is paused until a human re-engages the operator or redirects the task."
          : "The coordinating run finished without producing any output. Coordination is paused until a human re-engages the operator or redirects the task.",
        observations: [{ k: "Run", v: runId, code: true }],
      },
      ctx,
    );
    return "applied";
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
    if (isCancelled() || !db.open) return "cancelled";
    await operatorPostComment(
      db,
      ctx,
      { ...base, text: plan.reasoning },
      authority,
    );
    postedComments.add(commentKey(plan.reasoning));
  }
  if (readinessOnly) {
    if (isCancelled() || !db.open) return "cancelled";
    // The set of executable actions is frozen at turn start, matching Claude's
    // toolkit. A readiness verdict is a complete turn: later assignment or
    // transition actions in the same model response are ignored server-side.
    const assessment = plan.actions.find(
      (action) => action.tool === "assess_readiness",
    );
    if (assessment?.readiness && assessment.reason) {
      await operatorAssessReadiness(
        db,
        ctx,
        {
          ...base,
          verdict: assessment.readiness,
          rationale: assessment.reason,
          ...(assessment.readiness === "input_required" && assessment.text
            ? { missingInformation: assessment.text }
            : {}),
        },
        authority,
      );
    } else {
      await operatorPostComment(
        db,
        ctx,
        {
          ...base,
          text: "Coordination stopped: readiness was unresolved and this turn did not return a valid readiness assessment. No assignment, run, prompt, or transition was executed.",
        },
        authority,
      );
    }
    return "applied";
  }
  for (const a of plan.actions) {
    if (isCancelled() || !db.open) return "cancelled";
    try {
      switch (a.tool) {
        case "assess_readiness":
          if (a.readiness && a.reason)
            await operatorAssessReadiness(
              db,
              ctx,
              {
                ...base,
                verdict: a.readiness,
                rationale: a.reason,
                ...(a.readiness === "input_required" && a.text
                  ? { missingInformation: a.text }
                  : {}),
              },
              authority,
            );
          break;
        case "post_comment":
          if (a.text && !postedComments.has(commentKey(a.text))) {
            await operatorPostComment(
              db,
              ctx,
              { ...base, text: a.text },
              authority,
            );
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
          if (a.profileId && a.backend)
            await operatorAssignSpecialist(
              db,
              ctx,
              {
                ...base,
                profileId: a.profileId,
                backend: a.backend,
                reason: a.reason ?? "",
              },
              authority,
            );
          break;
        case "run_specialist":
          await operatorRunSpecialist(db, ctx, base, authority);
          break;
        case "prompt_specialist":
          if (a.profileId && a.backend)
            await operatorPromptSpecialist(
              db,
              ctx,
              {
                ...base,
                profileId: a.profileId,
                backend: a.backend,
                ...(a.text ? { directive: a.text } : {}),
                reason: a.reason ?? "",
              },
              authority,
            );
          break;
        case "assign_reviewer":
          if (a.profileId && a.backend)
            await operatorAssignReviewer(
              db,
              ctx,
              {
                ...base,
                profileId: a.profileId,
                backend: a.backend,
                reason: a.reason ?? "",
              },
              authority,
            );
          break;
        case "run_reviewer":
          if (a.profileId)
            await operatorRunReviewer(
              db,
              ctx,
              { ...base, profileId: a.profileId },
              authority,
            );
          break;
        case "prompt_reviewer":
          if (a.profileId && a.backend)
            await operatorPromptReviewer(
              db,
              ctx,
              {
                ...base,
                profileId: a.profileId,
                backend: a.backend,
                ...(a.text ? { directive: a.text } : {}),
                reason: a.reason ?? "",
              },
              authority,
            );
          break;
        case "transition_stage":
          if (a.toStageId)
            await operatorTransitionStage(
              db,
              ctx,
              {
                ...base,
                toStageId: a.toStageId,
                ...(a.reason ? { reason: a.reason } : {}),
              },
              authority,
            );
          break;
        case "accept_completion":
          await operatorAcceptCompletion(db, ctx, base, authority);
          break;
      }
    } catch (error) {
      // ABORT the remaining plan on a governed-action failure: executing later
      // actions against a state the failed one never produced compounds the
      // damage (e.g. an accept_completion after a failed transition). The
      // failure is narrated on the timeline so the board shows what stopped.
      logger.error(
        "codex operator action failed — aborting the remaining plan",
        {
          taskKey: input.taskKey,
          tool: a.tool,
          err: error instanceof Error ? error : new Error(String(error)),
        },
      );
      if (isCancelled() || !db.open) return "cancelled";
      await operatorPostComment(
        db,
        ctx,
        {
          ...base,
          text: `Coordination stopped: the \`${a.tool}\` step failed (${error instanceof Error ? error.message : String(error)}). The remaining plan was not executed.`,
        },
        authority,
      ).catch((commentError) => {
        logger.error("codex action-failure comment failed", {
          taskKey: input.taskKey,
          err:
            commentError instanceof Error
              ? commentError
              : new Error(String(commentError)),
        });
      });
      if (isCancelled() || !db.open) return "cancelled";
      await openOperatorSystemRecovery(
        db,
        {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          code: "operator_action_failed",
          occurrenceId: `${runId}:${a.tool}`,
          title: "Operator plan stopped on a failed action",
          body:
            `The operator's \`${a.tool}\` action failed after earlier plan steps may already have applied. ` +
            "The remaining plan was not executed. Review the timeline and choose whether to retry or redirect.",
          observations: [
            { k: "Run", v: runId, code: true },
            { k: "Failed action", v: a.tool, code: true },
            {
              k: "Failure",
              v: error instanceof Error ? error.message : String(error),
              code: false,
            },
          ],
        },
        ctx,
      );
      return "applied";
    }
  }
  return "applied";
}

// ------------------------------------------------------- real (tool-driven)

async function startRealOperatorRun(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  authority: OperatorAuthority,
  leaseKey: string,
  leaseToken: OperatorLeaseToken,
  reservation: OperatorReactionReservation | null,
): Promise<RunOperatorResult> {
  const snapshot = operatorSnapshot(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    authority,
  );
  const systemPrompt = buildOperatorSystemPrompt(authority, input.dataRoot);
  const toolkit = buildOperatorToolkit({
    db,
    ctx,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    authority,
    expectedTaskIncarnation: leaseToken.taskIncarnation,
    isCancelled: () => leaseToken.cancelled,
  });
  const prompt = buildOperatorTurnPrompt(
    snapshot,
    input.trigger ?? "manual",
    input.humanComment,
  );

  const { runId } = await startRun(db, {
    ...(reservation ? { runId: reservation.runId } : {}),
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId:
      reservation?.threadId ?? "op-" + newId("t").replace("t_", "").slice(0, 8),
    role: "Operator",
    kind: "operator",
    backend: "claude",
    model: authority.model,
    ...(authority.effort ? { effort: authority.effort } : {}),
    agentName: authority.name,
    agentProfileId: "operator",
    completionSourceRunId: input.completionSourceRunId ?? null,
    operatorDispatchId: input.dispatchId ?? null,
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
  const { chainRunCompletionOrInvoke } = await import("./run-service.server");
  chainRunCompletionOrInvoke(db, runId, async (finished, completion) => {
    let effectState: "pending" | "applied" | "recovery" = "pending";
    try {
      // A real Claude operator run that ERRORS (crash / quota / auth / idle
      // timeout) was previously silent — the completion hook only released the
      // lease, so nothing reached the human (contrast the Codex no-plan
      // escalation and the specialist F8 path). Escalate it the same way (F-OP1).
      if (finished.state === "error") {
        if (
          db.open &&
          !completion.isCancelled() &&
          !leaseToken.cancelled &&
          activeTaskIncarnation(
            db,
            input.projectSlug,
            input.taskKey,
            input.dataRoot,
          ) === leaseToken.taskIncarnation
        ) {
          await escalateFailedOperatorRun(db, ctx, input, runId);
          effectState = "applied";
        }
      }
      if (
        finished.state === "finished" &&
        !completion.isCancelled() &&
        !leaseToken.cancelled &&
        activeTaskIncarnation(
          db,
          input.projectSlug,
          input.taskKey,
          input.dataRoot,
        ) === leaseToken.taskIncarnation
      ) {
        effectState = "applied";
      }
    } catch (error) {
      if (db.open) {
        logger.error("claude operator completion handling failed", {
          taskKey: input.taskKey,
          err: error instanceof Error ? error : new Error(String(error)),
        });
      }
    } finally {
      if (
        completion.isCancelled() ||
        leaseToken.cancelled ||
        activeTaskIncarnation(
          db,
          input.projectSlug,
          input.taskKey,
          input.dataRoot,
        ) !== leaseToken.taskIncarnation
      ) {
        effectState = "recovery";
      }
      if (db.open) {
        patchRun(db, runId, { operatorEffectState: effectState });
      }
      releaseOperatorLease(db, leaseKey, leaseToken);
    }
  });

  logger.info("operator run started (real)", {
    taskKey: input.taskKey,
    runId,
    autonomy: authority.autonomy,
  });
  return {
    runId,
    backend: "claude",
    mode: "real",
    autonomy: authority.autonomy,
    disposition: "started",
  };
}

/**
 * F-OP1: surface a failed real operator run to the human. Nothing else covers
 * an operator's OWN run (run-recovery only watches specialist/reviewer runs),
 * so without this a crashed/quota-limited/idle-timed-out operator run leaves the
 * task sitting with no timeline entry, packet, or notification. Raise a blocked
 * recovery packet through the operator's own gate, with quota/auth-aware copy.
 */
export async function escalateFailedOperatorRun(
  db: Database.Database,
  ctx: TaskMutationContext,
  input: RunOperatorInput,
  runId: string,
): Promise<void> {
  try {
    const { runFailureReason } =
      await import("~/server/tasks/agent-reply.server");
    const reason = runFailureReason(db, runId);
    const detail =
      reason?.kind === "quota"
        ? "the coordinating model is over its usage quota"
        : reason?.kind === "auth"
          ? "the coordinating model's credential was rejected"
          : "the coordinating run did not complete";
    logger.warn("real operator run failed — escalating", {
      taskKey: input.taskKey,
      runId,
      kind: reason?.kind ?? "unknown",
    });
    await openOperatorSystemRecovery(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        code: "operator_run_failed",
        occurrenceId: runId,
        title: "Operator run failed — pick a recovery path",
        body:
          `The operator run did not complete — ${detail}. No coordination was ` +
          `performed. Retry on the other backend, fix the credential, or redirect ` +
          `the task.`,
        observations: [
          { k: "Run", v: runId, code: true },
          { k: "Failure", v: detail, code: false },
        ],
      },
      ctx,
    );
  } catch (error) {
    logger.error("operator-run failure escalation failed", {
      taskKey: input.taskKey,
      runId,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    throw error;
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
  reservation: OperatorReactionReservation | null,
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
    await scriptedOperatorHookForTests?.(db, input);

    // COORDINATE the current stage: prompt its agent (reviewer at the review
    // stage, specialist at the work stage), advancing through any pre-work
    // stages first. Stops once it has prompted an agent (now waiting for that
    // agent to report) or hit a recommend boundary under supervised autonomy.
    const coordinate = async () => {
      for (let step = 0; step < 8; step++) {
        snap = operatorSnapshot(db, ctx, projectSlug, taskKey, authority);
        if (snap.stage === doneStageId) return;
        if (snap.readiness !== "ready") {
          const assessment = await operatorAssessReadiness(
            db,
            ctx,
            {
              projectSlug,
              taskKey,
              verdict: "input_required",
              rationale:
                "No intelligent backend is available to verify that the canonical goal contains concrete implementation intent; deterministic fallback will not invent or approve scope.",
              missingInformation:
                "Confirm the concrete product or repository outcome and its verification boundary, then run an intelligent operator backend.",
            },
            authority,
          );
          say(assessment.message);
          return;
        }
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
          const eligibleReviewers = snap.reviewers.filter((reviewer) =>
            eligibleHere(reviewer.profileId),
          );
          const candidates = snap.routingCandidates.reviewer;
          if (eligibleReviewers.length === 0) {
            const result = await operatorOpenPacket(
              db,
              ctx,
              {
                projectSlug,
                taskKey,
                packetType: candidates.length === 0 ? "blocked" : "input",
                title:
                  candidates.length === 0
                    ? "No hard-eligible reviewer is available"
                    : "An intelligent reviewer-routing decision is required",
                body:
                  candidates.length === 0
                    ? "Every reviewer candidate failed a hard stage or MCP compatibility constraint."
                    : `The deterministic fallback will not select among ${candidates.length} eligible reviewer${candidates.length === 1 ? "" : "s"}. Run Claude/Codex Operator or assign a reviewer explicitly.`,
                options: defaultPacketOptions(
                  candidates.length === 0 ? "blocked" : "input",
                ),
              },
              authority,
            );
            say(result.message);
            return;
          }
          if (
            eligibleReviewers.length &&
            gate(authority, "summon-reviewers") !== "deny"
          ) {
            for (const reviewer of eligibleReviewers) {
              say(
                (
                  await operatorRunReviewer(
                    db,
                    ctx,
                    {
                      projectSlug,
                      taskKey,
                      profileId: reviewer.profileId,
                    },
                    authority,
                  )
                ).message,
              );
            }
          }
          return;
        }
        if (snap.stage === workStageId || !workStageId) {
          // A prior explicit human/intelligent assignment may be continued.
          // With no eligible binding, deterministic fallback stops at a human
          // packet; it never turns candidate facts into a ranking decision.
          const candidates = snap.routingCandidates.primary;
          const assigned = snap.specialist
            ? snap.deployedSpecialists.find(
                (s) => s.id === snap.specialist!.profileId,
              )
            : undefined;
          // A binding is resumable only when its exact profile/backend also
          // survives the routing hard filters. Stage eligibility alone is not
          // enough: for example, a Codex binding may be unable to enforce the
          // profile's withheld capabilities. In that case the deterministic
          // fallback must stop for an intelligent re-route instead of trying a
          // run that admission will reject.
          const assignedCandidate = snap.specialist
            ? candidates.find(
                (candidate) =>
                  candidate.profileId === snap.specialist!.profileId &&
                  candidate.backend === snap.specialist!.backend,
              )
            : undefined;
          if (
            !assigned ||
            !assigned.eligibleForCurrentStage ||
            !assignedCandidate
          ) {
            const result = await operatorOpenPacket(
              db,
              ctx,
              {
                projectSlug,
                taskKey,
                packetType: candidates.length === 0 ? "blocked" : "input",
                title:
                  candidates.length === 0
                    ? "No hard-eligible specialist is available"
                    : "An intelligent specialist-routing decision is required",
                body:
                  candidates.length === 0
                    ? "Every specialist candidate failed a hard stage or MCP compatibility constraint."
                    : `The deterministic fallback will not select among ${candidates.length} eligible specialist${candidates.length === 1 ? "" : "s"}. Run Claude/Codex Operator or assign a specialist explicitly.`,
                options: defaultPacketOptions(
                  candidates.length === 0 ? "blocked" : "input",
                ),
              },
              authority,
            );
            say(result.message);
            return;
          }
          const pick =
            assigned && assigned.eligibleForCurrentStage ? assigned : undefined;
          if (pick && gate(authority, "assign-primary-specialist") !== "deny") {
            say(
              (
                await operatorRunSpecialist(
                  db,
                  ctx,
                  {
                    projectSlug,
                    taskKey,
                  },
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
        const t = await operatorTransitionStage(
          db,
          ctx,
          { projectSlug, taskKey, toStageId: nid },
          authority,
        );
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
        say(
          (
            await operatorAcceptCompletion(
              db,
              ctx,
              { projectSlug, taskKey },
              authority,
            )
          ).message,
        );
        return;
      }
      const nid = snap.nextStages[0]?.id;
      if (!nid) {
        say(
          "No further governed transition from here — handing back to humans.",
        );
        return;
      }
      const t = await operatorTransitionStage(
        db,
        ctx,
        { projectSlug, taskKey, toStageId: nid },
        authority,
      );
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
    throw error;
  }

  await scriptedOperatorBeforeNarrationHookForTests?.(db, input);

  lines.push({
    t: "",
    ev: "result",
    tag: "result",
    text: "operator pass complete",
    stats: {
      subtype: "success",
      dur: 1200,
      api: 900,
      turns: 1,
      cost: 0,
      in: 0,
      cached: 0,
      out: 0,
    },
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
    ...(reservation ? { runId: reservation.runId } : {}),
    projectSlug,
    taskKey,
    threadId:
      reservation?.threadId ?? "op-" + newId("t").replace("t_", "").slice(0, 8),
    role: "Operator",
    kind: "operator",
    backend: authority.backend,
    model: authority.model,
    agentName: authority.name,
    agentProfileId: "operator",
    completionSourceRunId: input.completionSourceRunId ?? null,
    operatorDispatchId: input.dispatchId ?? null,
    prompt: `Supervise ${taskKey} toward its next boundary.`,
    script,
    simulate: true,
    actor: input.actor ?? OPERATOR_AUDIT_ACTOR,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  });

  // Scripted coordination executes synchronously before its narration run is
  // materialized. Reaching this point proves all governed effects (or their
  // narrated failure boundary) have settled durably.
  patchRun(db, runId, { operatorEffectState: "applied" });

  logger.info("operator run started (scripted)", {
    taskKey,
    runId,
    autonomy: authority.autonomy,
  });
  return {
    runId,
    backend: authority.backend,
    mode: "scripted",
    autonomy: authority.autonomy,
    disposition: "started",
  };
}

// ------------------------------------------------------- system prompt

/** Baked-in fallback persona when the store has no operator definition file. */
const FALLBACK_OPERATOR_DEFINITION = `You are the Operator: the coordinator for one Viberr task. You never write code and you never close a task unless full autonomy grants it. You are given the "viberr" governance tools and the Viberr app-expertise skill. Always call get_task first, then drive the task toward its next boundary using your tools, respecting your capability policy: perform direct actions, post recommendations for recommend-only actions and stop, and never attempt human-reserved actions. Keep every comment concise — each action appears on the human-visible board.`;

/** Read the shipped operator agent definition (body only), or the fallback. */
function readOperatorDefinition(dataRoot?: string): string {
  try {
    const file = path.join(
      agentProfilesDir(dataRoot),
      "..",
      "definitions",
      "operator.md",
    );
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
  const skills = authority.skills.length
    ? authority.skills
    : ["viberr-app-expertise"];
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
      "- If readiness is not `ready`, call assess_readiness FIRST and STOP. Mark ready only when the canonical goal names a concrete outcome and verification boundary. Otherwise keep input_required and ask for missing intent. Never invent a product/repository change.\n" +
      "- When routing, choose ONLY from the hard-eligible routingCandidates for that purpose. Compare declared scope, skills, KBs, MCP fit/health, backend health, current workload, and observed cost. You make the final decision; Viberr provides no score. Always give a concrete reason so the decision is persisted and auditable.\n" +
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
  trigger: "create" | "transition" | "agent-reply" | "manual",
  humanComment?: string,
): string {
  const decision =
    snapshot.readiness !== "ready"
      ? "READINESS GATE: return exactly one assess_readiness action and no assignment, run, prompt, or transition. " +
        "Use ready only if the canonical goal itself states a concrete outcome and verification boundary; otherwise use input_required and name the missing intent. Never invent a repository change."
      : humanComment?.trim()
        ? `A human just addressed YOU directly with: "${humanComment.trim()}". RESPOND to them: put your reply to the human in \`reasoning\` (answer their question or acknowledge their instruction, grounded in the task state), and add any coordination actions their message warrants (prompt an agent, transition, etc.) — or none if a reply is all that's needed.`
        : trigger === "agent-reply"
          ? "An agent you prompted has just REPORTED BACK (its latest reply is in recentTimeline). React to it: " +
            "summarize what it reported (in `reasoning`), then PROPOSE THE NEXT STATE CHANGE — a transition_stage " +
            "toward review if the implementation looks complete, or accept_completion if the review is clean. Only " +
            "re-prompt the same agent (prompt_specialist/prompt_reviewer) if the work is clearly incomplete. Do not " +
            "prompt just to repeat yourself."
          : "TRIGGER the agent for THIS stage and then STOP: use prompt_specialist (a working stage) or prompt_reviewer " +
            '(the review stage), putting a concrete task-related directive addressed to the agent ("@dev implement …") ' +
            "in the action's `text`. Do NOT also propose the stage transition yet — you will be re-invoked to react once " +
            "the agent reports back. Choose the profileId + backend pair only from the matching hard-eligible routingCandidates list after comparing " +
            "scope, skills, KB/MCP fit, backend health, workload, and observed cost. Put your concrete selection explanation in reason.";
  return (
    "# This task\n\n" +
    "```json\n" +
    JSON.stringify(snapshot, null, 2) +
    "\n```\n\n" +
    "# Your decision\n\n" +
    "You cannot call tools. Instead, DECIDE the coordination actions to take now and return them as a plan. " +
    "Use an exact profileId + backend pair from routingCandidates for assign/prompt actions, and nextStages' ids for transitions.\n\n" +
    decision +
    "\nRespect your capability policy + autonomy: under supervised autonomy, governed actions become recommendation cards; " +
    "under full autonomy they are performed. Reach Done only via accept_completion (full autonomy).\n\n" +
    "Return ONLY a JSON object of the form " +
    `{ "reasoning": "<a concise operator comment>", "actions": [ { "tool": "prompt_specialist", "profileId": "…", "backend": "claude", "text": "<task-related directive>", "reason": "why this exact profile/backend candidate fits the supplied context" } ] }. ` +
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

  // A human is talking to you directly (@operator). Answer them even when a
  // preceding crashed turn left readiness blocked; otherwise durable replay
  // technically launches but silently drops the message from the prompt.
  if (humanComment?.trim()) {
    const readinessBoundary =
      snapshot.readiness === "ready"
        ? "If their message calls for a coordination action you're allowed to take (prompt an agent, engage a reviewer, recommend/perform a transition), do it and say so. If it does not, just respond."
        : `Readiness is ${snapshot.readiness}. Respond first. If the message supplies the missing intent, call assess_readiness exactly once; otherwise explain the remaining input needed. STOP without assigning, prompting, or transitioning while readiness is not ready.`;
    return (
      header +
      `A human just addressed YOU directly with: "${humanComment.trim()}"\n\n` +
      "Do this now:\n" +
      "1. Call get_task to read the live state, your policy, and the allowed next stages.\n" +
      "2. Post a `post_comment` that RESPONDS to the human's message — answer their question or acknowledge their instruction, grounded in the task's real state.\n" +
      `3. ${readinessBoundary}\n` +
      "Respect your capability policy. Keep it concise and directly responsive."
    );
  }

  if (snapshot.readiness !== "ready") {
    return (
      header +
      `Readiness is ${snapshot.readiness}. Do this now:\n` +
      "1. Call get_task and inspect the canonical goal.\n" +
      "2. Call assess_readiness exactly once. Mark ready only when the goal states a concrete outcome and verification boundary.\n" +
      "3. If intent is missing, keep input_required and name what the human must add.\n" +
      "4. STOP. Do not assign, run, prompt, or transition in the same turn. Never invent a product or repository change."
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
    "3. Compare the exact profileId + backend rows in the matching hard-eligible routingCandidates by declared scope, skills, KB/MCP fit, backend health, workload, and observed cost. YOU make the final choice; Viberr does not score candidates.\n" +
    "4. TRIGGER the chosen agent with a concrete, goal-grounded directive and a persisted routing reason:\n" +
    "   · a working stage (before review) → prompt_specialist(profileId, prompt) — assigns the\n" +
    '     specialist, posts your "@name …" prompt to it, and starts its run on your directive;\n' +
    "   · the review stage → prompt_reviewer(profileId, prompt) — engages + prompts + runs a reviewer.\n" +
    "   Write the prompt about THIS task (its goal and what to do at this stage), not a generic 'go'.\n" +
    "5. Then STOP and wait — do NOT propose the stage transition yet. When the agent reports back you\n" +
    "   will be re-invoked to read its report and propose the next state change.\n" +
    "   Never ask an agent to choose or invent work outside the canonical goal.\n\n" +
    "Respect your capability policy at every step. Keep comments concise."
  );
}
