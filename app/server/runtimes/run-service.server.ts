import type { DatabaseSync } from "node:sqlite";
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
import { requireRunAgents } from "~/server/auth/project-authority.server";
import type { RunHandle, RunSpec, RuntimeAdapter } from "./adapter.server";
import { resolveRunEffort } from "./model-catalog.server";
import { publishRunStateChanged } from "./run-events.server";
import {
  projectRunsForTask,
  type ProjectedRunView,
} from "./run-projection.server";
import { createRunSink } from "./run-sink.server";
import {
  appendRawLine,
  getRun,
  insertRunLine,
  listRunLines,
  listRunLinesTail,
  nextSeq,
  patchRun,
  runLineStats,
  upsertRun,
  type AgentRunRow,
} from "./run-store.server";
import { probeSessionContinuity } from "./session-export.server";
import {
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  codexCliAuthDiagnostics,
  createAdapters,
  resetRegistryForTests,
  selectAdapter,
  setBackendAvailability,
  type AdapterSet,
  type RealBackend,
} from "./runtime-registry.server";
import { newId } from "~/shared/ids/new-id.server";

/**
 * The only module routes call
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
  db: DatabaseSync,
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
  db?: DatabaseSync,
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
  db?: DatabaseSync,
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

/** Test-only: reset live handles and install explicitly supplied adapters. */
export function configureRunServiceForTests(adapters: AdapterSet): void {
  resetRegistryForTests();
  setBackendAvailability("claude", true);
  setBackendAvailability("codex", true);
  const cache = globalThis as unknown as Record<symbol, ServiceState | undefined>;
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
  agentProfileId: string;
  prompt: string;
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
  /** Tool denylist confining a specialist run to its granted capabilities.
   *  Claude only (Codex has no denylist channel — see codex-runtime). */
  disallowedTools?: string[];
  /** The run's `execute-code-or-write-repo` grant is withheld — Codex enforces
   *  it with a read-only sandbox (P13-RT-02). Omit to let `startRun` derive it
   *  from `disallowedTools` (see `repoWriteWithheldFromDenylist`). */
  repoWriteWithheld?: boolean;
  /** JSON schema constraining the run's final output. Codex only — used by the
   *  structured-output operator AND every generic specialist/reviewer run's
   *  report_outcome envelope; the caller parses + executes/records it. */
  outputSchema?: unknown;
  /** Per-run environment overlay (e.g. GIT_CEILING_DIRECTORIES to confine a
   *  specialist's git to its workspace). Merged on top of the adapter env. */
  env?: Record<string, string>;
}

/** Runs started by the operator runtime itself (scheduling reactions). */
const OPERATOR_ACTOR: AuditActor = { userId: null, label: "operator" };

const DEFAULT_THREAD: Record<RunKind, string> = {
  operator: "op",
  primary: "primary",
  reviewer: "r0",
};

/**
 * The file-write built-ins `resolveSpecialistDisallowedTools` emits for a
 * WITHHELD `execute-code-or-write-repo` grant (specialist-tool-policy). They
 * are the one deny rule whose presence means "this profile may not write the
 * repo" — the other rules gate branch/push/PR, which a read-only sandbox would
 * over-block.
 */
const REPO_WRITE_DENY_MARKERS = ["Edit", "Write", "NotebookEdit"] as const;

/**
 * Whether a run's capability denylist says its repo-write grant is withheld.
 *
 * P13-RT-02: `disallowedTools` is computed for EVERY run from the same
 * `resolveSpecialistDisallowedTools` policy, backend-agnostically — it just had
 * no effect on Codex, which has no denylist channel. Deriving the flag from it
 * means the Codex read-only sandbox binds for exactly the profiles the matrix
 * already shows as withheld, with no second source of truth to drift. Callers
 * that know the grant directly may still pass `repoWriteWithheld` explicitly.
 */
export function repoWriteWithheldFromDenylist(
  disallowedTools?: readonly string[],
): boolean {
  if (!disallowedTools?.length) return false;
  const denied = new Set(disallowedTools);
  return REPO_WRITE_DENY_MARKERS.every((t) => denied.has(t));
}

/**
 * Starts a run: selects the requested provider adapter, inserts the queued
 * row, wires the sink and adapter callbacks, and kicks the adapter.
 *
 * R7-2: when the requested backend is UNAVAILABLE (and the test gate is
 * closed) there is no fabricated fallback stream anymore — the run row is
 * still created but FAILS FAST: one classified terminal `err` line + state
 * `error`. That routes the failure through the EXISTING error-run path
 * (completion callbacks fire immediately, `applyAgentCompletionEffects`
 * posts the typed blocked event and escalation packet via runFailureReason).
 * Returns the run id.
 */
export async function startRun(
  db: DatabaseSync,
  input: StartRunInput,
): Promise<{ runId: string }> {
  const state = getState();
  const threadId = input.threadId ?? DEFAULT_THREAD[input.kind];
  const runId = newId("run");
  const workdir =
    input.workdir ?? taskDir(input.projectSlug, input.taskKey, input.dataRoot);

  const selection = selectAdapter(input.backend, state.adapters);
  try {
    upsertRun(db, {
      id: runId,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      threadId,
      role: input.role,
      kind: input.kind,
      backend: input.backend,
      model: input.model,
      sdk: SDK_LABEL[input.backend] ?? "",
      sessionId: input.resumeSessionId ?? null,
      agentName: input.agentName ?? null,
      agentProfileId: input.agentProfileId,
      state: "queued",
    });
  } catch (err) {
    const errcode = (err as { errcode?: number } | null)?.errcode;
    if (
      input.kind === "primary" &&
      errcode === 2067 // SQLITE_CONSTRAINT_UNIQUE
    ) {
      throw new AppError({
        code: ERROR_CODES.CONFLICT,
        status: 409,
        userMessage:
          "A delivering agent run is already in progress on this task — wait for it to finish or interrupt it before starting another.",
      });
    }
    throw err;
  }

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
      resumed: Boolean(input.resumeSessionId),
      // R7-2 fail-fast marker: the run never spawned a backend process.
      ...(selection.kind === "unavailable" ? { failedUnavailable: true } : {}),
    },
  });

  const spec: RunSpec = {
    runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId,
    role: input.role,
    kind: input.kind,
    backend: input.backend,
    model: input.model,
    // P13-RT-08: normalize the effort tier for the RUN's backend here, the one
    // funnel every path goes through (specialist, operator, resume). It used to
    // run only on the D4 cross-backend retry, so a profile whose stored effort
    // came from the other backend's scale ("minimal" from Codex, "max" from
    // Claude) shipped a tier the target SDK does not accept. An unset effort
    // stays unset — the SDK default applies, as before.
    ...(input.effort?.trim()
      ? { effort: resolveRunEffort(input.backend, input.effort) }
      : {}),
    prompt: input.prompt,
    workdir,
    resumeSessionId: input.resumeSessionId ?? null,
    autonomous: input.autonomous ?? true,
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
    ...(input.disallowedTools && input.disallowedTools.length
      ? { disallowedTools: input.disallowedTools }
      : {}),
    // Codex has no denylist channel; the withheld repo-write grant becomes a
    // read-only sandbox instead (P13-RT-02). Explicit caller value wins.
    ...((input.repoWriteWithheld ??
      repoWriteWithheldFromDenylist(input.disallowedTools))
      ? { repoWriteWithheld: true }
      : {}),
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    ...(input.env && Object.keys(input.env).length ? { env: input.env } : {}),
  };

  if (selection.kind === "unavailable") {
    failRunUnavailable(db, spec);
    return { runId };
  }

  launch(db, spec, selection.adapter);
  return { runId };
}

/**
 * R7-2 fail-fast: finalize a run whose backend has no usable credential as an
 * honest `error` — one classified terminal err line (the copy is what
 * `runFailureReason` classifies as "unavailable") and no backend process.
 * Persisting through the regular sink keeps the SSE/log/state plumbing
 * identical to any other terminal run, so registered completion callbacks
 * fire immediately via the already-terminal path and the F8 escalation runs.
 */
function failRunUnavailable(db: DatabaseSync, spec: RunSpec): void {
  const sink = createRunSink(db, spec);
  sink.markRunning();
  const now = new Date().toISOString();
  const text = backendUnavailableMessage(spec.backend as RealBackend);
  sink.line({
    // An honest server-authored envelope — NOT a fabricated backend wire line.
    raw: JSON.stringify({ type: "error", source: "viberr", message: text }),
    display: { t: now.slice(11, 19), ev: "err", tag: "run·unavailable", text },
    facts: {},
    occurredAt: now,
  });
  sink.finalize({
    outcome: "error",
    effectiveBackend: spec.backend,
    sessionId: spec.resumeSessionId ?? null,
  });
}

/**
 * Actionable copy for a run refused because its backend has no credential.
 * State-aware for the codex CLI-auth trap: when the opt-in flag IS set but
 * `$CODEX_HOME/auth.json` is missing (the docker-compose volume-wipe case),
 * re-suggesting the flag is actively misleading — name the missing file and
 * the exact copy command instead. Availability re-probes live, so once the
 * file lands the next run works with no restart.
 */
export function backendUnavailableMessage(backend: RealBackend): string {
  if (backend === "claude") {
    return "Claude Code is unavailable — no usable credential is configured. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (or opt in with VIBERR_CLAUDE_USE_CLI_AUTH=1), or run this agent on another backend. No agent process was started.";
  }
  const diag = codexCliAuthDiagnostics();
  if (diag.optIn && !diag.authJsonExists) {
    return `Codex is unavailable — VIBERR_CODEX_USE_CLI_AUTH=1 is set, but the Codex CLI login file is missing at ${diag.authJsonPath}. Copy it from a logged-in machine (docker: \`docker compose cp ~/.codex/auth.json app:${diag.authJsonPath}\`) — the next run picks it up without a restart. Or set CODEX_ACCESS_TOKEN, CODEX_API_KEY or OPENAI_API_KEY, or run this agent on another backend. No agent process was started.`;
  }
  return "Codex is unavailable — no usable credential is configured. Set CODEX_ACCESS_TOKEN, CODEX_API_KEY or OPENAI_API_KEY (or opt in with VIBERR_CODEX_USE_CLI_AUTH=1), or run this agent on another backend. No agent process was started.";
}

// ------------------------------------------- continuity recovery (P13-D-2)

/**
 * The `err` tag that marks a run whose provider session was PROVEN gone. Two
 * readers depend on the `·session_missing` SUFFIX: `runFailureReason`
 * classifies the failure kind off it, and `runIdsWithMissingSession` uses it to
 * stop `latestSessionRun` re-selecting a dead session id forever. Both adapters
 * end their own tags with the same suffix (`run·error·session_missing`,
 * `error·session_missing`) when the SDK reports the vanished session first.
 */
const SESSION_MISSING_TAG = "run·session_missing";

/** What the user is told when provider-side history is gone. Never "review your
 *  authentication" — the credential is fine; the transcript is not. */
function sessionMissingMessage(backend: RealBackend, sessionId: string): string {
  const label = backend === "claude" ? "Claude Code" : "Codex";
  return `The ${label} session ${sessionId} no longer exists on this machine — its provider transcript is gone (retention sweep or a wiped runtime volume), so the conversation could not be resumed. The agent re-anchored on task.md and continued with a fresh session.`;
}

/**
 * Stamp the dead run with the continuity failure: one classified `err` line on
 * the run that owned the session id, in both the DB projection and the raw
 * .jsonl. This is the durable record — no column, no migration — that
 * `latestSessionRun` reads to skip the row, and the console shows it exactly
 * where the thread stopped.
 */
function recordSessionMissing(db: DatabaseSync, run: AgentRunRow): void {
  const now = new Date().toISOString();
  const text = sessionMissingMessage(run.backend, run.session_id ?? "");
  const raw = JSON.stringify({
    type: "error",
    source: "viberr",
    reason: "session_missing",
    session_id: run.session_id,
    message: text,
  });
  try {
    appendRawLine(run.backend, run.id, raw);
    insertRunLine(db, {
      runId: run.id,
      seq: nextSeq(db, run.id),
      occurredAt: now,
      raw,
      display: { t: now.slice(11, 19), ev: "err", tag: SESSION_MISSING_TAG, text },
    });
  } catch (error) {
    logger.error("session-missing marker persist failed", {
      runId: run.id,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * The canonical-anchor preamble a re-anchored turn carries. PRD-1: "If
 * provider-side history is unavailable or corrupted, the system degrades
 * gracefully from the canonical task file and current execution context."
 * The follow-up prompt alone assumes a conversation the agent no longer has, so
 * it is prefixed with what happened and where the truth lives.
 */
function continuityResetPreamble(backend: RealBackend): string {
  const label = backend === "claude" ? "Claude Code" : "Codex";
  return [
    `[continuity notice] Your previous ${label} session for this task is gone — the provider transcript no longer exists, so none of that conversation is in your context.`,
    `Re-anchor on the canonical task file (\`task.md\` in your working directory) and the repository state before you act. Treat the request below as a fresh instruction, and say so if it depends on context you can no longer see.`,
  ].join(" ");
}

/**
 * Note the continuity break on the task timeline. `note` (not `policy` or
 * `blocked`): nothing was violated and nothing is stuck — the turn ran, on a
 * fresh session. Best-effort: a task file we cannot write must never block the
 * run that is the actual recovery.
 */
async function noteContinuityReset(
  db: DatabaseSync,
  run: AgentRunRow,
  dataRoot?: string,
): Promise<void> {
  const ref = {
    projectSlug: run.project_slug,
    taskKey: run.task_key,
    ...(dataRoot ? { dataRoot } : {}),
  };
  const label = run.backend === "claude" ? "Claude Code" : "Codex";
  try {
    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "system", systemId: "runtime-continuity" },
        title: null,
        text: `Runtime continuity was lost: the ${label} session behind ${run.agent_name ?? run.role}'s thread no longer has a provider transcript, so it could not be resumed. The agent re-anchored on \`task.md\` and continued in a fresh session. Its earlier conversation context is gone; the run log it already produced is unchanged.`,
        toAgent: false,
        evidence: null,
      });
    });
    rebuildPath(db, resolveTaskFilePath(ref), dataRoot ? { dataRoot } : {});
  } catch (error) {
    logger.error("continuity-reset timeline note failed", {
      runId: run.id,
      taskKey: run.task_key,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/**
 * Resume an existing run's provider session with a follow-up prompt. Creates
 * a NEW run row (a fresh stream) that shares the session id, matching how
 * both CLIs emit a fresh full stream on resume (research §1.4 / §2.4).
 *
 * P13-D-2 (FR22 / NFR17): the stored session id is PROBED first. Provider
 * history is not durable — Claude Code sweeps transcripts after ~30 days, and
 * recreating `docker-data` takes `$CODEX_HOME/sessions` with it. Handing a dead
 * id to the SDK produced a generic "review its authentication and runtime
 * configuration" error, a blocked packet with no recovery option, and — because
 * `latestSessionRun` had no state filter — every later @mention re-selected the
 * same dead id, stranding that agent on that task forever. When the probe says
 * the transcript is gone the turn is NOT failed: it runs once as a fresh,
 * canonical-anchored run, the dead run is stamped `session_missing`, and the
 * timeline says continuity was lost. Only that fresh run failing is a failure.
 *
 * `workdir` lets the resumed run keep the ORIGINAL run's working directory
 * (the specialist-run clone at `<taskDir>/workspace/<repo>`) so the agent
 * still has its repo context on resume — without it the resumed run would
 * default to the bare task dir and lose the checkout. Returns the new run id.
 */
export async function resumeRun(
  db: DatabaseSync,
  input: {
    runId: string;
    prompt: string;
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
    agentProfileId?: string;
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
    /** Re-apply the outcome-envelope schema on resume so a resumed (e.g.
     *  @mention) Codex agent still emits the structured outcome (verdict /
     *  questions) instead of falling back to the fragile prose regex — and so
     *  ask_human can fire. Without it a resumed Codex reviewer silently lost
     *  its envelope, a fresh-vs-resume parity break (F7). */
    outputSchema?: unknown;
  },
): Promise<{ runId: string; continuityReset?: true }> {
  const prev = getRun(db, input.runId);
  if (!prev) throw AppError.notFound(`Run ${input.runId} not found.`);
  const backend: RealBackend = prev.backend;
  // A resume creates a NEW run row (a fresh stream) that shares the PROVIDER
  // session id. It must NOT reuse the prior thread_id — agent_runs is unique
  // on (project, task, thread), and the prior row still exists. Derive a fresh
  // thread id from the original so the picker still groups it recognizably.
  const resumeThreadId =
    prev.thread_id + "-r" + newId("t").replace("t_", "").slice(0, 6);

  // P13-D-2: probe before handing the id to the SDK. `unknown` (no transcript
  // store to look in) resumes exactly as before — absence proves nothing there.
  const continuity = probeSessionContinuity(backend, prev.session_id);
  if (continuity === "missing") {
    logger.warn("runtime continuity lost — re-anchoring on task.md", {
      runId: prev.id,
      taskKey: prev.task_key,
      backend,
      sessionId: prev.session_id,
    });
    recordSessionMissing(db, prev);
    await noteContinuityReset(db, prev, input.dataRoot);
    const fresh = await startRun(db, {
      projectSlug: prev.project_slug,
      taskKey: prev.task_key,
      threadId: resumeThreadId,
      role: prev.role,
      kind: prev.kind,
      backend,
      model: input.model ?? prev.model,
      ...(input.effort ? { effort: input.effort } : {}),
      agentName: input.agentName ?? prev.agent_name,
      agentProfileId: input.agentProfileId ?? prev.agent_profile_id,
      prompt: `${continuityResetPreamble(backend)}\n\n${input.prompt}`,
      // The whole point: no resumeSessionId. A fresh provider session.
      resumeSessionId: null,
      ...(input.workdir ? { workdir: input.workdir } : {}),
      ...(input.autonomous !== undefined ? { autonomous: input.autonomous } : {}),
      ...(input.dataRoot ? { dataRoot: input.dataRoot } : {}),
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.disallowedTools ? { disallowedTools: input.disallowedTools } : {}),
      ...(input.env ? { env: input.env } : {}),
      ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    });
    return { runId: fresh.runId, continuityReset: true };
  }

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
    ...(input.workdir ? { workdir: input.workdir } : {}),
    ...(input.autonomous !== undefined ? { autonomous: input.autonomous } : {}),
    ...(input.dataRoot ? { dataRoot: input.dataRoot } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    // Re-establish the run confinement the fresh-run path applies (XS-1).
    ...(input.disallowedTools ? { disallowedTools: input.disallowedTools } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    // F7: re-arm the outcome envelope on resume (Codex parity with fresh runs).
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
  });
}

/** Wires the sink + adapter callbacks and starts the adapter process/timer. */
function launch(db: DatabaseSync, spec: RunSpec, adapter: RuntimeAdapter): void {
  const state = getState();
  const sink = createRunSink(db, spec);

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
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; runId: string },
  actor: { userId: string; label: string },
): InterruptResult {
  const run = getRun(db, input.runId);
  if (!run || run.project_slug !== input.projectSlug || run.task_key !== input.taskKey) {
    throw AppError.notFound(`Run ${input.runId} not found on ${input.taskKey}.`);
  }

  // RBAC — the `run-agents` action (rbac.ts single source: admin|maintainer),
  // the same tier that opens runtime sessions, resolved through the ONE
  // authority path (project-authority.server) so the Policy display and this
  // guard can't drift — and org admins pass as the audited D2 override.
  const members = listProjectMembers(db, input.projectSlug);
  requireRunAgents(
    db,
    {
      slug: input.projectSlug,
      memberRoles: new Map(members.map((m) => [m.userId, m.role])),
      // Interrupt is a de-escalation (STOP a run), not a new mutation — the F17
      // archived gate blocks STARTING work; a run left in flight when a project
      // is archived must still be stoppable, so this path never gates on archived.
      archived: false,
    },
    actor,
    "interrupt this runtime session",
  );

  if (run.state !== "running" && run.state !== "queued") {
    // Idempotent no-op — the run already reached a terminal state.
    return { outcome: "already-terminal", run: projectOne(db, run) };
  }

  const state = getState();
  const handle = state.handles.get(input.runId);
  if (handle) {
    handle.interrupt();
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

/** All runs for a task as RunView[] + their D-11 log windows (task loader). */
export function listRunsForTask(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): ProjectedRunView[] {
  return projectRunsForTask(db, projectSlug, taskKey);
}

export interface RunLog {
  runId: string;
  threadId: string;
  state: AgentRunRow["state"];
  lines: { seq: number; occurredAt: string; raw: string; display: LogLine }[];
  headSeq: number;
  /** P13-D-11: the oldest seq in THIS page (-1 when the page is empty). */
  oldestSeq: number;
  /** P13-D-11: lines older than `oldestSeq` exist for this run. */
  hasMore: boolean;
}

/** Backward page size when the caller names none (P13-D-11). */
const RUN_LOG_PAGE_LINES = 200;

export interface RunLogQuery {
  /** Forward tail: lines with `seq > since` (the live-tail consumer). */
  since?: number;
  /** Backward page: the newest `limit` lines with `seq < before`. */
  before?: number;
  /** Page size. Selects backward mode on its own (`limit` with no `before` =
   *  this run's newest page — how the console steps to a PREVIOUS run in the
   *  group). A forward tail ignores it: it is already bounded by how far behind
   *  the consumer is. */
  limit?: number;
}

/**
 * A page of a run's log lines.
 *
 * Two modes, because D-11 made the console a paginated view of a bounded
 * loader window rather than the whole history:
 *   - forward  (`since`)  — the live tail after a `run.log-appended` event;
 *   - backward (`before`) — the newest `limit` lines older than a cursor, which
 *     is how the console walks back through history the loader did not ship.
 */
export function getRunLog(
  db: DatabaseSync,
  runId: string,
  query: number | RunLogQuery = -1,
): RunLog | null {
  const run = getRun(db, runId);
  if (!run) return null;
  const q: RunLogQuery = typeof query === "number" ? { since: query } : query;
  const backward = typeof q.before === "number" || typeof q.limit === "number";
  const lines: RunLog["lines"] = backward
    ? listRunLinesTail(db, runId, q.limit ?? RUN_LOG_PAGE_LINES, q.before).map(
        ({ seq, occurredAt, raw, display }) => ({ seq, occurredAt, raw, display }),
      )
    : listRunLines(db, runId, q.since ?? -1);
  const sinceSeq = q.since ?? -1;
  const head = lines.length ? lines[lines.length - 1]!.seq : sinceSeq;
  const oldestSeq = lines.length ? lines[0]!.seq : -1;
  const stats = runLineStats(db, runId);
  return {
    runId,
    threadId: run.thread_id,
    state: run.state,
    lines,
    headSeq: head,
    oldestSeq,
    // Older lines exist below this page. An EMPTY backward page means we
    // reached the start of this run (the console then steps to the previous
    // run id in the group's `logWindow.runIds`).
    hasMore: lines.length > 0 && oldestSeq > stats.minSeq,
  };
}

function projectOne(db: DatabaseSync, run: AgentRunRow): RunView {
  return projectRunsForTask(db, run.project_slug, run.task_key).find((r) => r.id === run.thread_id) ?? projectRunsForTask(db, run.project_slug, run.task_key)[0]!;
}
