import type Database from "better-sqlite3";
import type {
  LogLine,
  RunKind,
  RunView,
  SpecialistRunPurpose,
} from "~/features/runtime/runtime-types";
import {
  recordAudit,
  withProjectAuditAuthority,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { taskDir } from "~/server/files/file-store-root.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { listProjectMembers } from "~/server/projections/board-query.server";
import { logger } from "~/server/logging/logger.server";
import { authorizeProjectAction } from "~/shared/rbac";
import type { UserRole } from "~/shared/mapping/user.server";
import type { RunExit, RunHandle, RunSpec } from "./adapter.server";
import { publishRunStateChanged } from "./run-events.server";
import { projectRunsForTask } from "./run-projection.server";
import { createRunSink } from "./run-sink.server";
import {
  getRun,
  listRunLines,
  patchRun,
  upsertRun,
  type AgentRunRow,
} from "./run-store.server";
import {
  advanceRunCompletionPhase,
  projectCompletionAdmissionOpen,
  RUN_COMPLETION_PHASE,
  withProjectCompletionEffect,
} from "./run-completion-state.server";
import {
  createAdapters,
  recordBackendRunResult,
  resetRegistryForTests,
  selectAdapter,
  setBackendAvailability,
  type AdapterDeps,
  type AdapterSet,
  type RealBackend,
} from "./runtime-registry.server";
import type { SimulatedScript } from "./simulated-runtime.server";
import { newId } from "~/shared/ids/new-id.server";

/**
 * Run lifecycle service (BUILD-PLAN Phase 8 §3). The only module routes call
 * for runtime work:
 *   startRun / resumeRun / interruptRun / listRunsForTask / getRunLog
 *
 * - Elapsed derives from started_at (client clock); tokens/cost come from
 *   real usage envelopes only (the sink folds them in — no fabrication).
 * - Interrupt is admin|maintainer (contracts §3.2): writes `interrupted`
 *   state + an audit event; idempotent-safe (a non-running run is a friendly
 *   no-op, not an error).
 * - Concurrency: multiple runs per task stream concurrently (VIB-151 has 3).
 *   Live handles are held in a process-global registry keyed by run id so
 *   interrupt reaches the running adapter across requests.
 */

// ---------------------------------------------- live handle registry

interface ServiceState {
  handles: Map<
    string,
    {
      handle: RunHandle;
      db: Database.Database;
      projectSlug: string;
      termination: Promise<void>;
      dispose(): void;
    }
  >;
  adapters: AdapterSet;
  /**
   * In-process run-completion callbacks keyed by run id. `launch()`'s onExit
   * invokes the callback (after `sink.finalize`) with the finished run row,
   * then deletes it. This is how task-actions posts an agent's reply back as
   * a comment when a resumed/started reply run finishes — run-service stays
   * decoupled (it invokes an OPAQUE callback and never imports task-actions).
   *
   * Callbacks live only in this process, while terminal effect checkpoints,
   * launch context, and task incarnation are durable on agent_runs. Boot
   * recovery resumes any incomplete specialist/reviewer effects and raises a
   * human boundary for ambiguous operator effects.
   */
  completions: Map<string, RunCompletionCallback>;
  /** Cleanup which must run on every termination path, including lifecycle
   * stops that deliberately discard normal completion callbacks. */
  terminationFinalizers: Map<string, Set<() => void>>;
  /**
   * Ordered, retained completion work for runs which have already exited.
   * A provider can finish synchronously before its caller gets the run id, and
   * some consumers (notably the durable operator dispatcher) subscribe only
   * after `startRun()` returns. Keeping this short-lived barrier lets those
   * late consumers run AFTER the completion effects which own the run.
   */
  completionEffects: Map<
    string,
    {
      db: Database.Database;
      projectSlug: string;
      promise: Promise<void>;
      cancelled: boolean;
      controller: AbortController;
      gcTimer: ReturnType<typeof setTimeout> | null;
    }
  >;
}

export interface RunCompletionContext {
  /** True once project/run teardown revoked this completion chain. Long-running
   * governed effects check it between mutations so stale work cannot spill
   * into an archived or same-slug replacement project. */
  isCancelled(): boolean;
  /** Aborts subprocess-backed completion work (notably server-owned Git push)
   * when archive/delete revokes the run lifecycle. */
  signal: AbortSignal;
}

/** Invoked once when a registered run reaches a terminal state. */
export type RunCompletionCallback = (
  finished: AgentRunRow,
  context: RunCompletionContext,
) => void | Promise<void>;

const SERVICE_KEY = Symbol.for("viberr.runService");

function getState(): ServiceState {
  const cache = globalThis as unknown as Record<
    symbol,
    ServiceState | undefined
  >;
  let state = cache[SERVICE_KEY];
  if (!state) {
    state = {
      handles: new Map(),
      adapters: createAdapters(),
      completions: new Map(),
      terminationFinalizers: new Map(),
      completionEffects: new Map(),
    };
    cache[SERVICE_KEY] = state;
  }
  // Older cached states (hot-reload / tests) may predate the completions map.
  if (!state.completions) state.completions = new Map();
  if (!state.terminationFinalizers) state.terminationFinalizers = new Map();
  if (!state.completionEffects) state.completionEffects = new Map();
  return state;
}

function runTerminationFinalizers(state: ServiceState, runId: string): void {
  const finalizers = state.terminationFinalizers.get(runId);
  if (!finalizers) return;
  state.terminationFinalizers.delete(runId);
  for (const finalize of finalizers) {
    try {
      finalize();
    } catch (error) {
      logger.warn("run termination finalizer failed", {
        runId,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}

function settleRunTerminationFinalizers(
  state: ServiceState,
  runId: string,
): void {
  const effect = state.completionEffects.get(runId);
  if (!effect) {
    runTerminationFinalizers(state, runId);
    return;
  }
  void effect.promise.finally(() => {
    runTerminationFinalizers(state, runId);
  });
}

/** Register cleanup which survives completion-callback cancellation. */
export function registerRunTerminationFinalizer(
  db: Database.Database,
  runId: string,
  finalize: () => void,
): void {
  const state = getState();
  const row = getRun(db, runId);
  const finalizers = state.terminationFinalizers.get(runId) ?? new Set();
  finalizers.add(finalize);
  state.terminationFinalizers.set(runId, finalizers);
  if (!row || (row.state !== "queued" && row.state !== "running")) {
    settleRunTerminationFinalizers(state, runId);
  }
}

const COMPLETION_EFFECT_RETENTION_MS = 60_000;

function clearCompletionEffect(state: ServiceState, runId: string): void {
  const effect = state.completionEffects.get(runId);
  if (!effect) return;
  effect.cancelled = true;
  effect.controller.abort();
  if (effect.gcTimer) clearTimeout(effect.gcTimer);
  state.completionEffects.delete(runId);
}

/** Append one terminal effect to the per-run promise chain. Every error is
 * contained here because provider exits have no request boundary to receive a
 * rejection. The settled barrier is retained briefly to close the
 * start/subscribe gap for an instant adapter. */
function appendCompletionEffect(
  state: ServiceState,
  db: Database.Database,
  finished: AgentRunRow,
  cb: RunCompletionCallback,
): Promise<void> {
  const prior = state.completionEffects.get(finished.id);
  if (prior?.gcTimer) clearTimeout(prior.gcTimer);

  // Reuse one mutable chain record so lifecycle cancellation also suppresses
  // callbacks which were appended before the newest observer replaced the
  // promise. Replacing the record would orphan an earlier queued microtask.
  const effect = prior ?? {
    db,
    projectSlug: finished.project_slug,
    promise: Promise.resolve(),
    cancelled: false,
    controller: new AbortController(),
    gcTimer: null as ReturnType<typeof setTimeout> | null,
  };
  effect.gcTimer = null;
  const previousPromise = effect.promise;
  const appendedPromise = previousPromise
    .catch(() => {
      // The prior link already logged its own error. A later observer must
      // still run so dispatch capacity and lifecycle cleanup cannot wedge.
    })
    .then(async () => {
      if (!effect.cancelled) {
        await withProjectCompletionEffect(
          db,
          finished.project_slug,
          async () => {
            await cb(finished, {
              isCancelled: () => effect.cancelled,
              signal: effect.controller.signal,
            });
          },
        );
      }
    })
    .catch((error) => {
      logger.error("run completion callback failed", {
        runId: finished.id,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    });
  effect.promise = appendedPromise;
  state.completionEffects.set(finished.id, effect);
  void appendedPromise.then(() => {
    if (
      state.completionEffects.get(finished.id) !== effect ||
      effect.promise !== appendedPromise
    ) {
      return;
    }
    effect.gcTimer = setTimeout(() => {
      if (
        state.completionEffects.get(finished.id) === effect &&
        effect.promise === appendedPromise
      ) {
        state.completionEffects.delete(finished.id);
      }
    }, COMPLETION_EFFECT_RETENTION_MS);
    effect.gcTimer.unref?.();
  });
  return appendedPromise;
}

/**
 * Register a one-shot completion callback for a run id. `launch()` fires it
 * after the run's sink finalizes, then removes it. Idempotent-safe: a second
 * registration for the same run id overwrites the first (last writer wins).
 */
export function registerRunCompletion(
  db: Database.Database,
  runId: string,
  cb: RunCompletionCallback,
): void {
  const state = getState();
  const row = getRun(db, runId);
  if (row && row.state !== "queued" && row.state !== "running") {
    void appendCompletionEffect(state, db, row, cb);
    return;
  }
  // JavaScript cannot interleave an adapter exit between the synchronous row
  // read and this registration, so a live row cannot escape this hook.
  state.completions.set(runId, cb);
}

/**
 * CHAIN a completion callback after whatever is already registered for the run
 * (or as the only callback when none is). Unlike registerRunCompletion this
 * never clobbers: the existing callback fires first, then `cb`. Used by the
 * operator coalesce-queue — a trigger that lands while an operator run is in
 * flight must fire AFTER that run's own completion work, not replace it.
 */
export function chainRunCompletion(
  runId: string,
  cb: RunCompletionCallback,
): void {
  const state = getState();
  const existing = state.completions.get(runId);
  state.completions.set(runId, async (finished, context) => {
    try {
      await existing?.(finished, context);
    } finally {
      await cb(finished, context);
    }
  });
}

/** Chain a callback for a live run, or invoke it immediately when the row is
 * already terminal. This closes the start/subscribe gap for instant simulated
 * runs: their adapter may finish before the dispatcher has received the newly
 * created run id. JavaScript execution is single-threaded between the row read
 * and callback registration, so a non-terminal row cannot complete in that
 * synchronous interval. */
export function chainRunCompletionOrInvoke(
  db: Database.Database,
  runId: string,
  cb: RunCompletionCallback,
): void {
  const state = getState();
  const row = getRun(db, runId);
  if (row && row.state !== "queued" && row.state !== "running") {
    void appendCompletionEffect(state, db, row, cb);
    return;
  }
  chainRunCompletion(runId, cb);
}

/** Test-only: reset live handles + swap in test adapters (or SDK-fake deps). */
export function configureRunServiceForTests(
  adaptersOrDeps?: AdapterSet | AdapterDeps,
): void {
  // Deterministic: force both real backends unavailable so runs use the
  // simulated engine regardless of any ambient credential in the dev `.env`
  // (e.g. a CLAUDE_CODE_OAUTH_TOKEN). A test that wants the real path injects
  // a fake adapter AND calls setBackendAvailability(backend, true) after this.
  resetRegistryForTests();
  setBackendAvailability("claude", false);
  setBackendAvailability("codex", false);
  const cache = globalThis as unknown as Record<
    symbol,
    ServiceState | undefined
  >;
  const previous = cache[SERVICE_KEY];
  if (previous) {
    for (const active of previous.handles.values()) active.dispose();
    for (const runId of previous.terminationFinalizers.keys()) {
      runTerminationFinalizers(previous, runId);
    }
    previous.handles.clear();
    previous.completions.clear();
    for (const runId of previous.completionEffects.keys()) {
      clearCompletionEffect(previous, runId);
    }
  }
  const adapters =
    adaptersOrDeps && "simulated" in adaptersOrDeps
      ? (adaptersOrDeps as AdapterSet)
      : createAdapters((adaptersOrDeps as AdapterDeps) ?? {});
  cache[SERVICE_KEY] = {
    handles: new Map(),
    adapters,
    completions: new Map(),
    terminationFinalizers: new Map(),
    completionEffects: new Map(),
  };
}

/**
 * Test/store lifecycle hook: detach every callback owned by `db` before the
 * database is closed. Interrupt is best-effort, but persistence callbacks are
 * disabled first so an asynchronous provider cannot write into a dead store.
 */
export function disposeRunsForDatabaseForTests(db: Database.Database): void {
  const state = getState();
  for (const [runId, active] of state.handles) {
    if (active.db !== db) continue;
    active.dispose();
    state.handles.delete(runId);
    state.completions.delete(runId);
  }
  for (const [runId, effect] of state.completionEffects) {
    if (effect.db === db) clearCompletionEffect(state, runId);
  }
}

/** Stop and detach all live callbacks owned by a project before deletion. */
export function disposeRunsForProject(
  db: Database.Database,
  projectSlug: string,
): void {
  const state = getState();
  for (const [runId, active] of state.handles) {
    if (active.db !== db || active.projectSlug !== projectSlug) continue;
    active.dispose();
    state.completions.delete(runId);
  }
  for (const [runId, effect] of state.completionEffects) {
    if (effect.db === db && effect.projectSlug === projectSlug) {
      clearCompletionEffect(state, runId);
    }
  }
}

/**
 * Wait for providers which were interrupted during project teardown to
 * acknowledge exit. Canonical archive/delete must not continue while an SDK
 * process can still write its run workspace. The lifecycle caller decides
 * whether an unchanged active project may safely reopen admission on timeout;
 * an archived/deleted/replaced lifecycle must remain revoked.
 */
export async function waitForProjectRunTermination(
  db: Database.Database,
  projectSlug: string,
  timeoutMs: number | null = 5_000,
): Promise<boolean> {
  const pending = [...getState().handles.values()]
    .filter((active) => active.db === db && active.projectSlug === projectSlug)
    .map((active) => active.termination);
  if (pending.length === 0) return true;
  if (timeoutMs === null) {
    await Promise.allSettled(pending);
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const terminated = Promise.allSettled(pending).then(() => true as const);
  const result = await Promise.race([terminated, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

/**
 * Stop and detach one exact run after its owning lifecycle object disappeared.
 * This is intentionally keyed only by run id: archive/delete can race launch,
 * and a project with the same slug may already have been recreated by the time
 * the launcher notices it lost ownership. The database row may also have been
 * purged already, so a matching live handle/completion is sufficient to stop.
 */
export function stopRunForLifecycle(
  db: Database.Database,
  runId: string,
  options: { recoveryStep?: string } = {},
): boolean {
  const state = getState();
  const registered = state.handles.get(runId);
  const active = registered?.db === db ? registered : undefined;
  const row = db.open ? getRun(db, runId) : null;
  const hadCompletion = state.completions.delete(runId);
  const hadCompletionEffect = state.completionEffects.has(runId);
  if (hadCompletionEffect) clearCompletionEffect(state, runId);
  let stopped = hadCompletion || hadCompletionEffect;
  const hadFinalizer = state.terminationFinalizers.has(runId);
  if (hadFinalizer) stopped = true;

  if (active) {
    active.dispose();
    stopped = true;
  } else if (hadFinalizer) {
    settleRunTerminationFinalizers(state, runId);
  }

  if (row && (row.state === "queued" || row.state === "running")) {
    patchRun(db, runId, {
      state: "interrupted",
      finishedAt: new Date().toISOString(),
      phase: null,
      step: options.recoveryStep ?? null,
    });
    publishRunStateChanged({
      projectSlug: row.project_slug,
      taskKey: row.task_key,
      runId,
      threadId: row.thread_id,
      state: "interrupted",
    });
    stopped = true;
  }

  // A deliberate launch/lifecycle rejection discards the normal completion
  // callback. If its exact authority context was already registered, close
  // the durable checkpoint too so a later run is not permanently excluded
  // from the workspace. Orphan recovery is different: it intentionally keeps
  // the checkpoint pending until the boot-recovery packet is durable.
  if (
    row &&
    !options.recoveryStep &&
    (row.kind === "primary" || row.kind === "reviewer")
  ) {
    advanceRunCompletionPhase(db, runId, RUN_COMPLETION_PHASE.complete);
  }

  return stopped;
}

/** Stop all queued/running sessions when a project becomes archived. */
export function stopProjectRuns(
  db: Database.Database,
  projectSlug: string,
): number {
  const rows = db
    .prepare(
      `SELECT id, task_key, thread_id FROM agent_runs
       WHERE project_slug = ? AND state IN ('queued', 'running')`,
    )
    .all(projectSlug) as { id: string; task_key: string; thread_id: string }[];
  disposeRunsForProject(db, projectSlug);
  const now = new Date().toISOString();
  for (const row of rows) {
    patchRun(db, row.id, {
      state: "interrupted",
      finishedAt: now,
      phase: null,
      step: null,
    });
    publishRunStateChanged({
      projectSlug,
      taskKey: row.task_key,
      runId: row.id,
      threadId: row.thread_id,
      state: "interrupted",
    });
  }
  return rows.length;
}

// ---------------------------------------------- start / resume

const SDK_LABEL: Record<string, string> = {
  claude: "Claude Agent SDK",
  codex: "Codex SDK",
};

export interface StartRunInput {
  /** Preallocated durable identity. Used only by operator-reaction recovery so
   * a crash before adapter launch still leaves an idempotency marker. */
  runId?: string;
  projectSlug: string;
  taskKey: string;
  /** Exact canonical task lifecycle which authorized this launch. */
  expectedTaskIncarnation?: string;
  /** Thread id within the task ("op" | "primary" | "c0"). Defaulted per kind. */
  threadId?: string;
  role: string;
  kind: RunKind;
  backend: RealBackend;
  model: string;
  /** Reasoning/effort level (claude options.effort · codex
   *  modelReasoningEffort). Optional — the SDK default applies when absent. */
  effort?: string;
  /** The deployed agent's display name persisted on the run (Agent-logs
   *  picker label). Null → the projection falls back to the backend name. */
  agentName?: string | null;
  /** The deployed profile id persisted on the run (per-agent grouping key). */
  agentProfileId?: string | null;
  /** Persisted semantic intent for specialist completion/recovery effects. */
  runPurpose?: SpecialistRunPurpose;
  /** Immutable canonical evidence reviewed when a governance review began. */
  reviewEvidenceFingerprint?: string | null;
  /** Exact repository head checked out for that review. */
  reviewHeadSha?: string | null;
  /** Specialist run whose completion caused this operator reaction. */
  completionSourceRunId?: string | null;
  /** Automatic dispatch claim which owns this operator run. */
  operatorDispatchId?: string | null;
  /** Exact intelligent-routing intent that authorized this specialist launch.
   * Deterministic/human resumes deliberately omit it. */
  sourceIntentId?: string | null;
  prompt: string;
  /** Optional scripted stream (simulated backend / seed resumer). */
  script?: SimulatedScript;
  /** Resume an existing provider session. */
  resumeSessionId?: string | null;
  autonomous?: boolean;
  /** Override the run working directory (defaults to the task dir). Used by
   *  the specialist-run flow to point a run at a freshly-cloned repo. */
  workdir?: string;
  /** Override the data root (tests). */
  dataRoot?: string;
  /** Who caused the run (audit). Defaults to the operator system actor. */
  actor?: AuditActor;
  /** Custom instructions: Claude systemPrompt / Codex developer_instructions. */
  systemPrompt?: string;
  /** Portable HTTP/stdio MCPs, or Claude-only in-process SDK governance tools. */
  mcpServers?: Record<string, unknown>;
  /** Tool allowlist confining the run (operator → its governance tools only). */
  allowedTools?: string[];
  /** Tool denylist confining a specialist run to its granted capabilities. */
  disallowedTools?: string[];
  /** JSON schema constraining the run's final output (Codex structured-output
   *  operator — the caller parses + executes the emitted decision plan). */
  outputSchema?: unknown;
  /** Per-run environment overlay (e.g. GIT_CEILING_DIRECTORIES to confine a
   *  specialist's git to its workspace). Merged on top of the adapter env. */
  env?: Record<string, string>;
  /** Force the simulated engine regardless of backend credential. The operator
   *  scripted-drive uses this to stream a narration run for a backend that has
   *  no in-process tools (Codex) or when Claude is unavailable — the real work
   *  is done by the operator-actions calls, this run is the log of it. */
  simulate?: boolean;
}

/** Runs started by the operator runtime itself (scheduling reactions). */
const OPERATOR_ACTOR: AuditActor = { userId: null, label: "operator" };

const DEFAULT_THREAD: Record<RunKind, string> = {
  operator: "op",
  primary: "primary",
  reviewer: "r0",
};

/**
 * Starts a run: selects the adapter (real if the CLI is available, else the
 * simulated engine with simulated=1), inserts the queued row, wires the sink
 * and adapter callbacks, and kicks the adapter. Returns the run id.
 */
export async function startRun(
  db: Database.Database,
  input: StartRunInput,
): Promise<{ runId: string; simulated: boolean }> {
  if (!projectCompletionAdmissionOpen(db, input.projectSlug)) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage:
        "This project is changing lifecycle state; no new agent run can start.",
      kind: "user",
    });
  }
  const canonicalProject = readProjectFile({
    projectSlug: input.projectSlug,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  });
  if (!canonicalProject || canonicalProject.parsed.frontmatter.archived) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage: "This project does not currently own new agent runs.",
      kind: "user",
    });
  }
  const state = getState();
  const threadId = input.threadId ?? DEFAULT_THREAD[input.kind];
  const runId = input.runId ?? newId("run");
  const workdir =
    input.workdir ?? taskDir(input.projectSlug, input.taskKey, input.dataRoot);
  const canonicalTask = readTaskFile({
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  });
  const taskIncarnation = canonicalTask?.parsed.frontmatter.createdAt ?? null;
  if (!taskIncarnation) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage:
        "This task has no stable lifecycle identity; refresh or recreate it before starting an agent.",
      kind: "user",
    });
  }
  if (
    input.expectedTaskIncarnation !== undefined &&
    taskIncarnation !== input.expectedTaskIncarnation
  ) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage:
        "This task was replaced while the agent launch was being prepared.",
      kind: "user",
    });
  }

  const { simulated: detected } = selectAdapter(input.backend, state.adapters);
  const simulated = input.simulate === true ? true : detected;

  upsertRun(db, {
    id: runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId,
    role: input.role,
    kind: input.kind,
    backend: input.backend,
    simulated,
    model: input.model,
    sdk: SDK_LABEL[input.backend] ?? "",
    sessionId: input.resumeSessionId ?? null,
    agentName: input.agentName ?? null,
    agentProfileId: input.agentProfileId ?? null,
    runPurpose: input.runPurpose ?? null,
    reviewEvidenceFingerprint: input.reviewEvidenceFingerprint ?? null,
    reviewHeadSha: input.reviewHeadSha ?? null,
    completionSourceRunId: input.completionSourceRunId ?? null,
    taskIncarnation,
    operatorDispatchId: input.operatorDispatchId ?? null,
    sourceIntentId: input.sourceIntentId ?? null,
    operatorEffectState: input.kind === "operator" ? "pending" : null,
    state: "queued",
  });

  // Governed action: opening a runtime session is audited (BUILD-PLAN
  // Phase 10 / contracts — run start + interrupt both leave audit rows).
  recordAudit(db, {
    action: "runtime.run.started",
    actor: input.actor ?? OPERATOR_ACTOR,
    subjectKind: "run",
    subjectId: runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      threadId,
      backend: input.backend,
      role: input.role,
      kind: input.kind,
      simulated,
      resumed: Boolean(input.resumeSessionId),
      completionSourceRunId: input.completionSourceRunId ?? null,
      sourceIntentId: input.sourceIntentId ?? null,
    },
  });

  const spec: RunSpec & { script?: SimulatedScript } = {
    runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId,
    role: input.role,
    kind: input.kind,
    backend: input.backend,
    model: input.model,
    ...(input.effort ? { effort: input.effort } : {}),
    prompt: input.prompt,
    workdir,
    ...(input.dataRoot ? { dataRoot: input.dataRoot } : {}),
    resumeSessionId: input.resumeSessionId ?? null,
    autonomous: input.autonomous ?? true,
    script: input.script,
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
    ...(input.disallowedTools && input.disallowedTools.length
      ? { disallowedTools: input.disallowedTools }
      : {}),
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    ...(input.env && Object.keys(input.env).length ? { env: input.env } : {}),
  };

  launch(db, spec, simulated);
  return { runId, simulated };
}

/**
 * Resume an existing run's provider session with a follow-up prompt. Creates
 * a NEW run row (a fresh stream) that shares the session id, matching how
 * both CLIs emit a fresh full stream on resume (research §1.4 / §2.4).
 *
 * `workdir` lets the resumed run keep the ORIGINAL run's working directory
 * (the specialist-run clone at `<taskDir>/workspace/<repo>`) so the agent
 * still has its repo context on resume — without it the resumed run would
 * default to the bare task dir and lose the checkout. Returns the new run id.
 */
export async function resumeRun(
  db: Database.Database,
  input: {
    runId: string;
    prompt: string;
    script?: SimulatedScript;
    /** Reuse the original run's clone workdir (defaults to the task dir). */
    workdir?: string;
    /** Override the model for the resumed turns (defaults to the prior run's).
     *  Lets a comment-resume pick up the agent profile's CURRENT model. */
    model?: string;
    /** Reasoning effort for the resumed turns (defaults to none). */
    effort?: string;
    /** Carry/override the agent identity onto the resumed run so it groups
     *  with the prior run in the Agent-logs picker. Defaults to the prior
     *  row's agent_name/agent_profile_id. */
    agentName?: string | null;
    agentProfileId?: string | null;
    runPurpose?: SpecialistRunPurpose;
    reviewEvidenceFingerprint?: string | null;
    reviewHeadSha?: string | null;
    autonomous?: boolean;
    dataRoot?: string;
    actor?: AuditActor;
    /** Re-apply the specialist's capability tool denylist on resume. Without
     *  this a resumed (e.g. @mention) specialist runs UNCONFINED — the exact
     *  confinement the fresh-run path establishes is silently dropped (XS-1). */
    disallowedTools?: string[];
    /** Re-apply the per-run env overlay (GIT_CEILING_DIRECTORIES workspace
     *  confinement) on resume. */
    env?: Record<string, string>;
    /** Re-apply the specialist's declared MCP servers on resume (Claude). */
    mcpServers?: Record<string, unknown>;
    /** Re-apply the persona/system prompt on resume (Claude). */
    systemPrompt?: string;
    /** Exact task lifecycle which owns both the prior session and this resume. */
    expectedTaskIncarnation?: string;
  },
): Promise<{ runId: string; simulated: boolean }> {
  const prev = getRun(db, input.runId);
  if (!prev) throw AppError.notFound(`Run ${input.runId} not found.`);
  const currentTask = readTaskFile({
    projectSlug: prev.project_slug,
    taskKey: prev.task_key,
    ...(input.dataRoot !== undefined ? { dataRoot: input.dataRoot } : {}),
  });
  const currentTaskIncarnation =
    currentTask?.parsed.frontmatter.createdAt ?? null;
  const expectedTaskIncarnation =
    input.expectedTaskIncarnation ?? currentTaskIncarnation;
  if (
    !expectedTaskIncarnation ||
    currentTaskIncarnation !== expectedTaskIncarnation ||
    prev.task_incarnation !== expectedTaskIncarnation
  ) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage:
        "That provider session belongs to an older task lifecycle and cannot be resumed.",
      kind: "user",
    });
  }
  if (prev.backend === "simulated") {
    // Purely-simulated runs resume as simulated too.
  }
  const backend: RealBackend = prev.backend === "codex" ? "codex" : "claude";
  // A resume creates a NEW run row (a fresh stream) that shares the PROVIDER
  // session id. It must NOT reuse the prior thread_id — agent_runs is unique
  // on (project, task, thread), and the prior row still exists. Derive a fresh
  // thread id from the original so the picker still groups it recognizably.
  const resumeThreadId =
    prev.thread_id + "-r" + newId("t").replace("t_", "").slice(0, 6);
  return startRun(db, {
    projectSlug: prev.project_slug,
    taskKey: prev.task_key,
    expectedTaskIncarnation,
    threadId: resumeThreadId,
    role: prev.role,
    kind: prev.kind,
    backend,
    // Prefer the caller's model (the agent's current profile) over the stale
    // model on the prior run row — editing an agent to a new model must apply
    // when its session is resumed via a comment.
    model: input.model ?? prev.model,
    ...(input.effort ? { effort: input.effort } : {}),
    // Carry the prior run's agent identity so the resume groups under the same
    // Agent-logs entry (one entry per agent, across every resume). A caller can
    // override (e.g. a comment-resume that knows the current profile name).
    agentName: input.agentName ?? prev.agent_name,
    agentProfileId: input.agentProfileId ?? prev.agent_profile_id,
    ...((input.runPurpose ?? prev.run_purpose)
      ? { runPurpose: input.runPurpose ?? prev.run_purpose! }
      : {}),
    reviewEvidenceFingerprint:
      input.reviewEvidenceFingerprint !== undefined
        ? input.reviewEvidenceFingerprint
        : prev.review_evidence_fingerprint,
    reviewHeadSha:
      input.reviewHeadSha !== undefined
        ? input.reviewHeadSha
        : prev.review_head_sha,
    prompt: input.prompt,
    resumeSessionId: prev.session_id,
    ...(input.script ? { script: input.script } : {}),
    ...(input.workdir ? { workdir: input.workdir } : {}),
    ...(input.autonomous !== undefined ? { autonomous: input.autonomous } : {}),
    ...(input.dataRoot ? { dataRoot: input.dataRoot } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    // Re-establish the run confinement the fresh-run path applies (XS-1).
    ...(input.disallowedTools
      ? { disallowedTools: input.disallowedTools }
      : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
  });
}

/** Wires the sink + adapter callbacks and starts the adapter process/timer. */
function launch(
  db: Database.Database,
  spec: RunSpec & { script?: SimulatedScript },
  simulated: boolean,
): void {
  const state = getState();
  const sink = createRunSink(db, spec);
  const adapter = simulated
    ? state.adapters.simulated
    : state.adapters[spec.backend as RealBackend];

  // Mark running immediately (queued → running).
  sink.markRunning();

  // Every adapter callback fires asynchronously (timers, SDK streams), so all
  // persistence inside them must be caught-and-logged — a throw here has no
  // request context and would surface as an unhandled exception on a timer
  // (crashing the process in prod, failing the suite when a test's DB closes
  // before an in-flight run settles). sink.line self-catches; guard the
  // phase/finalize paths the same way.
  let exitedSynchronously = false;
  let disposed = false;
  let resolveTermination!: () => void;
  const termination = new Promise<void>((resolve) => {
    resolveTermination = resolve;
  });
  const onExit = (exit: RunExit) => {
    exitedSynchronously = true;
    resolveTermination();
    if (disposed) {
      state.handles.delete(spec.runId);
      settleRunTerminationFinalizers(state, spec.runId);
      return;
    }
    // A real provider result is the cheapest honest health probe we have.
    // Never infer validity from credential presence, and never let simulated
    // runs or human interrupts affect provider health.
    if (
      !exit.simulated &&
      (exit.effectiveBackend === "claude" ||
        exit.effectiveBackend === "codex") &&
      exit.outcome !== "interrupted"
    ) {
      recordBackendRunResult(
        exit.effectiveBackend,
        exit.outcome === "finished" ? "success" : "failure",
      );
    }
    let terminalPersisted = false;
    try {
      sink.finalize(exit);
      terminalPersisted = true;
    } catch (error) {
      logger.error("run finalize persist failed", {
        runId: spec.runId,
        err: error instanceof Error ? error : new Error(String(error)),
      });
      // Never run governed completion effects against a row still claiming to
      // be live. A direct conservative fallback makes provider/finalizer
      // failures durable even if the richer sink path failed after launch.
      try {
        patchRun(db, spec.runId, {
          state: "error",
          finishedAt: new Date().toISOString(),
          phase: null,
          step: null,
        });
        terminalPersisted = true;
      } catch (fallbackError) {
        logger.error("run terminal fallback persist failed", {
          runId: spec.runId,
          err:
            fallbackError instanceof Error
              ? fallbackError
              : new Error(String(fallbackError)),
        });
      }
    }
    state.handles.delete(spec.runId);
    if (!terminalPersisted) {
      settleRunTerminationFinalizers(state, spec.runId);
      return;
    }
    // Fire a one-shot completion callback (opaque to run-service — the
    // reply-comment wiring lives in task-actions). Reads the finalized row
    // so the callback sees the terminal state + folded session/usage facts.
    const cb = state.completions.get(spec.runId);
    if (cb) {
      state.completions.delete(spec.runId);
      try {
        const finished = getRun(db, spec.runId);
        if (
          finished &&
          finished.state !== "queued" &&
          finished.state !== "running"
        ) {
          void appendCompletionEffect(state, db, finished, cb);
        }
      } catch (error) {
        logger.error("run completion callback failed", {
          runId: spec.runId,
          err: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
    settleRunTerminationFinalizers(state, spec.runId);
  };

  let handle: RunHandle;
  try {
    handle = adapter.start(spec, {
      onLine: (line) => {
        if (!disposed) sink.line(line);
      },
      onPhase: (phase, step) => {
        if (disposed) return;
        try {
          sink.phase(phase, step);
        } catch (error) {
          logger.error("run phase persist failed", {
            runId: spec.runId,
            err: error instanceof Error ? error : new Error(String(error)),
          });
        }
      },
      onExit,
    });
  } catch (error) {
    logger.error("runtime adapter failed during launch", {
      runId: spec.runId,
      backend: spec.backend,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    onExit({
      outcome: "error",
      effectiveBackend: simulated ? "simulated" : spec.backend,
      simulated,
      sessionId: null,
    });
    return;
  }
  // Test/fallback adapters may complete inside start(). Do not resurrect a
  // handle after onExit already removed it.
  if (!exitedSynchronously) {
    state.handles.set(spec.runId, {
      handle,
      db,
      projectSlug: spec.projectSlug,
      termination,
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          handle.interrupt("system", "store shutdown");
        } catch {
          // Best-effort teardown; callbacks are already detached.
        }
      },
    });
  }
}

// ---------------------------------------------- interrupt

export interface InterruptResult {
  /** interrupted | already-terminal (idempotent no-op). */
  outcome: "interrupted" | "already-terminal";
  run: RunView | null;
}

export interface InterruptAcknowledgementResult {
  /** `interrupting` means the provider has not acknowledged termination yet. */
  outcome: "interrupted" | "already-terminal" | "interrupting";
  run: RunView | null;
}

/**
 * Interrupt a run. RBAC: admin|maintainer (contracts §3.2 — opening /
 * interrupting runtime sessions). Writes `interrupted` state + an audit
 * event. Idempotent-safe: interrupting a non-running run returns a friendly
 * `already-terminal`, never an error.
 */
export function interruptRun(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string; runId: string },
  actor: { userId: string; label: string; orgRole?: UserRole },
): InterruptResult {
  const run = getRun(db, input.runId);
  if (
    !run ||
    run.project_slug !== input.projectSlug ||
    run.task_key !== input.taskKey
  ) {
    throw AppError.notFound(
      `Run ${input.runId} not found on ${input.taskKey}.`,
    );
  }

  // RBAC — the `run-agents` action (rbac.ts single source: admin|maintainer),
  // the same tier that opens runtime sessions. Consult ACTION_ROLES, never a
  // hardcoded role string, so the Policy display and this guard can't drift
  // (pass-4 XS-10).
  const members = listProjectMembers(db, input.projectSlug);
  const role = members.find((m) => m.userId === actor.userId)?.role ?? null;
  const authority = authorizeProjectAction(role, actor.orgRole, "run-agents");
  if (!authority.allowed) {
    throw new AppError({
      code: ERROR_CODES.FORBIDDEN,
      status: 403,
      userMessage:
        "Interrupting a runtime session requires the admin or maintainer role.",
      kind: "user",
    });
  }

  if (run.state !== "running" && run.state !== "queued") {
    // Idempotent no-op — the run already reached a terminal state.
    return { outcome: "already-terminal", run: projectOne(db, run) };
  }

  const state = getState();
  const active = state.handles.get(input.runId);
  if (active) {
    active.handle.interrupt(actor.userId, actor.label);
    // Keep the handle registered until the adapter's onExit callback removes
    // it. Dropping it here made a still-running provider look detached and
    // prevented a second interrupt while acknowledgement was pending.
    // The adapter's onExit → sink.finalize sets the interrupted state; stamp
    // the interrupter here so it lands regardless of the adapter's timing.
    patchRun(db, input.runId, { interruptedBy: actor.userId });
  } else {
    // No live process (e.g. after a restart, or a seeded run) — write the
    // terminal state directly.
    patchRun(db, input.runId, {
      state: "interrupted",
      finishedAt: new Date().toISOString(),
      interruptedBy: actor.userId,
      phase: null,
      step: null,
    });
    publishRunStateChanged({
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      runId: input.runId,
      threadId: run.thread_id,
      state: "interrupted",
    });
  }

  recordAudit(db, {
    action: "runtime.run.interrupted",
    actor: withProjectAuditAuthority(actor, authority.source),
    subjectKind: "run",
    subjectId: input.runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      threadId: run.thread_id,
      backend: run.backend,
      role: run.role,
    },
  });
  logger.info("run interrupted", { runId: input.runId, by: actor.userId });

  const after = getRun(db, input.runId);
  return { outcome: "interrupted", run: after ? projectOne(db, after) : null };
}

/**
 * Request interruption, then wait for the exact run row to acknowledge a
 * terminal state. The route uses this instead of announcing success as soon
 * as a signal is sent. A slow provider returns `interrupting`; SSE will still
 * deliver the eventual terminal transition and the UI reports only a pending
 * request in the meantime.
 */
export async function interruptRunAndWait(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string; runId: string },
  actor: { userId: string; label: string; orgRole?: UserRole },
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<InterruptAcknowledgementResult> {
  const requested = interruptRun(db, input, actor);
  if (requested.outcome === "already-terminal") return requested;

  const timeoutMs = options.timeoutMs ?? 3_000;
  const pollMs = options.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const row = getRun(db, input.runId);
    if (!row) return { outcome: "interrupting", run: null };
    if (row.state !== "running" && row.state !== "queued") {
      return { outcome: "interrupted", run: projectOne(db, row) };
    }
    if (Date.now() >= deadline) {
      return { outcome: "interrupting", run: projectOne(db, row) };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

// ---------------------------------------------- reads

/** All runs for a task as RunView[] (task-detail loader). */
export function listRunsForTask(
  db: Database.Database,
  projectSlug: string,
  taskKey: string,
): RunView[] {
  return projectRunsForTask(db, projectSlug, taskKey);
}

export interface RunLog {
  runId: string;
  threadId: string;
  state: AgentRunRow["state"];
  lines: { seq: number; occurredAt: string; raw: string; display: LogLine }[];
  headSeq: number;
}

/** Tail of a run's log lines since `sinceSeq` (for the dedicated consumer). */
export function getRunLog(
  db: Database.Database,
  runId: string,
  sinceSeq = -1,
): RunLog | null {
  const run = getRun(db, runId);
  if (!run) return null;
  const lines = listRunLines(db, runId, sinceSeq);
  const head = lines.length ? lines[lines.length - 1]!.seq : sinceSeq;
  return {
    runId,
    threadId: run.thread_id,
    state: run.state,
    lines,
    headSeq: head,
  };
}

function projectOne(db: Database.Database, run: AgentRunRow): RunView {
  return (
    projectRunsForTask(db, run.project_slug, run.task_key).find(
      (r) => r.id === run.thread_id,
    ) ?? projectRunsForTask(db, run.project_slug, run.task_key)[0]!
  );
}
