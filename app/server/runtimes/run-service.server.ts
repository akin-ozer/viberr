import type Database from "better-sqlite3";
import type { LogLine, RunKind, RunView } from "~/features/runtime/runtime-types";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { getDataRoot, taskDir } from "~/server/files/file-store-root.server";
import { listProjectMembers } from "~/server/projections/board-query.server";
import { logger } from "~/server/logging/logger.server";
import type { RunHandle, RunSpec } from "./adapter.server";
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
  createAdapters,
  resetRegistryForTests,
  selectAdapter,
  setBackendAvailability,
  type AdapterDeps,
  type AdapterSet,
  type RealBackend,
} from "./runtime-registry.server";
import { buildScript, type SimulatedScript } from "./simulated-runtime.server";
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
  handles: Map<string, RunHandle>;
  adapters: AdapterSet;
  /**
   * In-process run-completion callbacks keyed by run id. `launch()`'s onExit
   * invokes the callback (after `sink.finalize`) with the finished run row,
   * then deletes it. This is how task-actions posts an agent's reply back as
   * a comment when a resumed/started reply run finishes — run-service stays
   * decoupled (it invokes an OPAQUE callback and never imports task-actions).
   *
   * CAVEAT: callbacks live only in this process. A server restart mid-run
   * loses the pending callback, so the reply comment is not posted for a run
   * that finishes after a restart (acceptable — the transcript is still in
   * the agent logs). Documented in feature-agent-reply.md.
   */
  completions: Map<string, RunCompletionCallback>;
}

/** Invoked once when a registered run reaches a terminal state. */
export type RunCompletionCallback = (finished: AgentRunRow) => void;

const SERVICE_KEY = Symbol.for("viberr.runService");

function getState(): ServiceState {
  const cache = globalThis as unknown as Record<symbol, ServiceState | undefined>;
  let state = cache[SERVICE_KEY];
  if (!state) {
    state = { handles: new Map(), adapters: createAdapters(), completions: new Map() };
    cache[SERVICE_KEY] = state;
  }
  // Older cached states (hot-reload / tests) may predate the completions map.
  if (!state.completions) state.completions = new Map();
  return state;
}

/**
 * Register a one-shot completion callback for a run id. `launch()` fires it
 * after the run's sink finalizes, then removes it. Idempotent-safe: a second
 * registration for the same run id overwrites the first (last writer wins).
 */
export function registerRunCompletion(
  runId: string,
  cb: RunCompletionCallback,
): void {
  getState().completions.set(runId, cb);
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
  const cache = globalThis as unknown as Record<symbol, ServiceState | undefined>;
  const adapters =
    adaptersOrDeps && "simulated" in adaptersOrDeps
      ? (adaptersOrDeps as AdapterSet)
      : createAdapters((adaptersOrDeps as AdapterDeps) ?? {});
  cache[SERVICE_KEY] = { handles: new Map(), adapters, completions: new Map() };
}

// ---------------------------------------------- start / resume

const SDK_LABEL: Record<string, string> = {
  claude: "Claude Agent SDK",
  codex: "Codex SDK",
};

export interface StartRunInput {
  projectSlug: string;
  taskKey: string;
  /** Thread id within the task ("op" | "primary" | "c0"). Defaulted per kind. */
  threadId?: string;
  role: string;
  kind: RunKind;
  backend: RealBackend;
  model: string;
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
}

/** Runs started by the operator runtime itself (scheduling reactions). */
const OPERATOR_ACTOR: AuditActor = { userId: null, label: "operator" };

const DEFAULT_THREAD: Record<RunKind, string> = {
  operator: "op",
  primary: "primary",
  consultant: "c0",
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
  const state = getState();
  const threadId = input.threadId ?? DEFAULT_THREAD[input.kind];
  const runId = newId("run");
  const workdir =
    input.workdir ?? taskDir(input.projectSlug, input.taskKey, input.dataRoot);

  const { simulated } = selectAdapter(input.backend, state.adapters);

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
    prompt: input.prompt,
    workdir,
    resumeSessionId: input.resumeSessionId ?? null,
    autonomous: input.autonomous ?? true,
    script: input.script,
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
    autonomous?: boolean;
    dataRoot?: string;
    actor?: AuditActor;
  },
): Promise<{ runId: string; simulated: boolean }> {
  const prev = getRun(db, input.runId);
  if (!prev) throw AppError.notFound(`Run ${input.runId} not found.`);
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
    threadId: resumeThreadId,
    role: prev.role,
    kind: prev.kind,
    backend,
    model: prev.model,
    prompt: input.prompt,
    resumeSessionId: prev.session_id,
    ...(input.script ? { script: input.script } : {}),
    ...(input.workdir ? { workdir: input.workdir } : {}),
    ...(input.autonomous !== undefined ? { autonomous: input.autonomous } : {}),
    ...(input.dataRoot ? { dataRoot: input.dataRoot } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
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
  const adapter = simulated ? state.adapters.simulated : state.adapters[spec.backend as RealBackend];

  // Mark running immediately (queued → running).
  sink.markRunning();

  const handle = adapter.start(spec, {
    onLine: (line) => sink.line(line),
    onPhase: (phase, step) => sink.phase(phase, step),
    onExit: (exit) => {
      sink.finalize(exit);
      state.handles.delete(spec.runId);
      // Fire a one-shot completion callback (opaque to run-service — the
      // reply-comment wiring lives in task-actions). Reads the finalized row
      // so the callback sees the terminal state + folded session/usage facts.
      const cb = state.completions.get(spec.runId);
      if (cb) {
        state.completions.delete(spec.runId);
        try {
          const finished = getRun(db, spec.runId);
          if (finished) cb(finished);
        } catch (error) {
          logger.error("run completion callback failed", {
            runId: spec.runId,
            err: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    },
  });
  state.handles.set(spec.runId, handle);
}

// ---------------------------------------------- interrupt

export interface InterruptResult {
  /** interrupted | already-terminal (idempotent no-op). */
  outcome: "interrupted" | "already-terminal";
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
  actor: { userId: string; label: string },
): InterruptResult {
  const run = getRun(db, input.runId);
  if (!run || run.project_slug !== input.projectSlug || run.task_key !== input.taskKey) {
    throw AppError.notFound(`Run ${input.runId} not found on ${input.taskKey}.`);
  }

  // RBAC — admin|maintainer only.
  const members = listProjectMembers(db, input.projectSlug);
  const role = members.find((m) => m.userId === actor.userId)?.role;
  if (role !== "admin" && role !== "maintainer") {
    throw new AppError({
      code: ERROR_CODES.FORBIDDEN,
      status: 403,
      userMessage: "Interrupting a runtime session requires the admin or maintainer role.",
      kind: "user",
    });
  }

  if (run.state !== "running" && run.state !== "queued") {
    // Idempotent no-op — the run already reached a terminal state.
    return { outcome: "already-terminal", run: projectOne(db, run) };
  }

  const state = getState();
  const handle = state.handles.get(input.runId);
  if (handle) {
    handle.interrupt(actor.userId, actor.label);
    state.handles.delete(input.runId);
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
    actor,
    subjectKind: "run",
    subjectId: input.runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { threadId: run.thread_id, backend: run.backend, role: run.role },
  });
  logger.info("run interrupted", { runId: input.runId, by: actor.userId });

  const after = getRun(db, input.runId);
  return { outcome: "interrupted", run: after ? projectOne(db, after) : null };
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
  return { runId, threadId: run.thread_id, state: run.state, lines, headSeq: head };
}

function projectOne(db: Database.Database, run: AgentRunRow): RunView {
  return projectRunsForTask(db, run.project_slug, run.task_key).find((r) => r.id === run.thread_id) ?? projectRunsForTask(db, run.project_slug, run.task_key)[0]!;
}

// ---------------------------------------------- operator scheduling

/**
 * The operator-scheduling reaction Phase 5 left as a stand-in in setOwner.
 * When a quality-gated, unowned Ready task GAINS an owner, the operator
 * "schedules execution" — in Phase 8 that means starting a real operator
 * run. This is the generalized entry point the task action calls; it keeps
 * the exact operator event copy (written by setOwner) and additionally spins
 * up an operator runtime so the run strip / agent logs reflect the reaction.
 *
 * Kept intentionally best-effort: a runtime failure must never break the
 * ownership mutation (the file write already succeeded and the audit event
 * recorded the reaction). The seed already materializes operator runs for
 * the demo tasks, so this path only fires for freshly-scheduled work.
 */
export async function scheduleOperatorRun(
  db: Database.Database,
  input: { projectSlug: string; taskKey: string; ownerName: string; dataRoot?: string },
): Promise<{ runId: string } | null> {
  try {
    const existing = listRunsForTask(db, input.projectSlug, input.taskKey);
    if (existing.some((r) => r.op)) {
      // An operator thread already exists for the task — do not duplicate.
      return null;
    }
    const prompt =
      `Acceptance boundary now owned by ${input.ownerName}. Schedule execution ` +
      `against the quality-gated scope for ${input.taskKey}: assign the primary ` +
      `specialist and supervise toward the next boundary.`;
    const script = buildOperatorScript(input.taskKey);
    const { runId } = await startRun(db, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      role: "Operator",
      kind: "operator",
      backend: "claude",
      model: "claude-sonnet-4-5",
      prompt,
      script,
      ...(input.dataRoot ? { dataRoot: input.dataRoot } : {}),
    });
    return { runId };
  } catch (error) {
    logger.error("operator run scheduling failed", {
      taskKey: input.taskKey,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return null;
  }
}

/** A short operator stream for a freshly scheduled task (simulated). */
function buildOperatorScript(taskKey: string): SimulatedScript {
  const sid = newId("op").replace("op_", "");
  const now = () => new Date().toISOString();
  const lines: LogLine[] = [
    { t: "", ev: "init", tag: "system·init", text: `operator runtime · anchored projects/*/tasks/${taskKey}/task.md` },
    { t: "", ev: "text", tag: "assistant", text: "Acceptance boundary owner confirmed. Scheduling execution against the quality-gated scope." },
    { t: "", ev: "text", tag: "assistant", text: "Assigned the primary specialist — supervising toward the next boundary." },
  ];
  return buildScript({
    lines,
    occurredAt: lines.map(() => now()),
    sessionId: sid,
    backend: "claude",
    model: "claude-sonnet-4-5",
    op: true,
    keepRunning: false,
    instant: true,
  });
}

export function getDataRootForRuns(dataRoot?: string): string {
  return getDataRoot(dataRoot);
}
