import type Database from "better-sqlite3";
import type { LogLine, RunKind, RunView } from "~/features/runtime/runtime-types";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { taskDir } from "~/server/files/file-store-root.server";
import { listProjectMembers } from "~/server/projections/board-query.server";
import { logger } from "~/server/logging/logger.server";
import { roleCan } from "~/shared/rbac";
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
 * If a run already reached a terminal state before its completion callback was
 * attached, `launch()`'s onExit already fired (and found no callback), so the
 * callback would never run. This is the spawn-crash race (F-SPAWN2): a run that
 * dies synchronously at launch — e.g. `spawn EBADF` — finalizes before the
 * caller can `registerRunCompletion`/`chainRunCompletion`, leaving the operator
 * escalation, reply, or lease-release silently dropped. A finalized run has NO
 * live handle (onExit deletes it), so "no handle + terminal state" reliably
 * means "already finalized"; fire the callback immediately and consume it.
 */
function fireIfAlreadyTerminal(
  db: Database.Database,
  runId: string,
): void {
  const state = getState();
  const cb = state.completions.get(runId);
  if (!cb) return;
  if (state.handles.has(runId)) return; // still in flight — onExit will fire it
  const run = getRun(db, runId);
  if (!run) return;
  if (run.state !== "finished" && run.state !== "error" && run.state !== "interrupted") {
    return;
  }
  state.completions.delete(runId);
  try {
    cb(run);
  } catch (error) {
    logger.error("run completion callback failed (immediate terminal fire)", {
      runId,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * Register a one-shot completion callback for a run id. `launch()` fires it
 * after the run's sink finalizes, then removes it. Idempotent-safe: a second
 * registration for the same run id overwrites the first (last writer wins).
 * If the run has ALREADY finalized (spawn-crash race), fire immediately.
 */
export function registerRunCompletion(
  runId: string,
  cb: RunCompletionCallback,
  db?: Database.Database,
): void {
  getState().completions.set(runId, cb);
  if (db) fireIfAlreadyTerminal(db, runId);
}

/**
 * CHAIN a completion callback after whatever is already registered for the run
 * (or as the only callback when none is). Unlike registerRunCompletion this
 * never clobbers: the existing callback fires first, then `cb`. Used by the
 * operator coalesce-queue — a trigger that lands while an operator run is in
 * flight must fire AFTER that run's own completion work, not replace it.
 * If the run has ALREADY finalized (spawn-crash race), fire immediately.
 */
export function chainRunCompletion(
  runId: string,
  cb: RunCompletionCallback,
  db?: Database.Database,
): void {
  const state = getState();
  const existing = state.completions.get(runId);
  state.completions.set(runId, (finished) => {
    try {
      existing?.(finished);
    } finally {
      cb(finished);
    }
  });
  if (db) fireIfAlreadyTerminal(db, runId);
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
  /** Reasoning/effort level (claude options.effort · codex
   *  modelReasoningEffort). Optional — the SDK default applies when absent. */
  effort?: string;
  /** The deployed agent's display name persisted on the run (Agent-logs
   *  picker label). Null → the projection falls back to the backend name. */
  agentName?: string | null;
  /** The deployed profile id persisted on the run (per-agent grouping key). */
  agentProfileId?: string | null;
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
  const state = getState();
  const threadId = input.threadId ?? DEFAULT_THREAD[input.kind];
  const runId = newId("run");
  const workdir =
    input.workdir ?? taskDir(input.projectSlug, input.taskKey, input.dataRoot);

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
    ...(input.effort ? { effort: input.effort } : {}),
    prompt: input.prompt,
    workdir,
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
    prompt: input.prompt,
    resumeSessionId: prev.session_id,
    ...(input.script ? { script: input.script } : {}),
    ...(input.workdir ? { workdir: input.workdir } : {}),
    ...(input.autonomous !== undefined ? { autonomous: input.autonomous } : {}),
    ...(input.dataRoot ? { dataRoot: input.dataRoot } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    // Re-establish the run confinement the fresh-run path applies (XS-1).
    ...(input.disallowedTools ? { disallowedTools: input.disallowedTools } : {}),
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
  const adapter = simulated ? state.adapters.simulated : state.adapters[spec.backend as RealBackend];

  // Set when onExit fires DURING adapter.start() (synchronous exit / spawn
  // crash) so we skip tracking a handle for an already-terminal run.
  let exited = false;

  // Mark running immediately (queued → running).
  sink.markRunning();

  // Every adapter callback fires asynchronously (timers, SDK streams), so all
  // persistence inside them must be caught-and-logged — a throw here has no
  // request context and would surface as an unhandled exception on a timer
  // (crashing the process in prod, failing the suite when a test's DB closes
  // before an in-flight run settles). sink.line self-catches; guard the
  // phase/finalize paths the same way.
  const handle = adapter.start(spec, {
    onLine: (line) => sink.line(line),
    onPhase: (phase, step) => {
      try {
        sink.phase(phase, step);
      } catch (error) {
        logger.error("run phase persist failed", {
          runId: spec.runId,
          err: error instanceof Error ? error : new Error(String(error)),
        });
      }
    },
    onExit: (exit) => {
      try {
        sink.finalize(exit);
      } catch (error) {
        logger.error("run finalize persist failed", {
          runId: spec.runId,
          err: error instanceof Error ? error : new Error(String(error)),
        });
      }
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
      exited = true;
    },
  });
  // Only track the handle if the run is still in flight. A synchronously-exiting
  // adapter (or a spawn-time crash) fires onExit DURING adapter.start(), which
  // deletes the not-yet-set handle; setting it here afterward would leave a
  // stale handle for an already-finished run — making `fireIfAlreadyTerminal`
  // (and interrupt) think a dead run is live. Guard on the exit flag.
  if (!exited) state.handles.set(spec.runId, handle);
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

  // RBAC — the `run-agents` action (rbac.ts single source: admin|maintainer),
  // the same tier that opens runtime sessions. Consult ACTION_ROLES, never a
  // hardcoded role string, so the Policy display and this guard can't drift
  // (pass-4 XS-10).
  const members = listProjectMembers(db, input.projectSlug);
  const role = members.find((m) => m.userId === actor.userId)?.role ?? null;
  if (!roleCan(role, "run-agents")) {
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
