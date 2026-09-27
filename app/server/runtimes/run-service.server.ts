import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  LogLine,
  RunKind,
  RunLiveFacts,
  RunState,
  RunView,
} from "~/features/runtime/runtime-types";
import {
  OPERATOR_AUDIT_ACTOR,
  recordAudit,
  SYSTEM_ACTOR,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { taskDir } from "~/server/files/file-store-root.server";
import { listProjectMembers } from "~/server/projections/board-query.server";
import { logger } from "~/server/logging/logger.server";
import {
  bindCorrelation,
  carryCorrelation,
  forkCorrelation,
} from "~/server/logging/request-context.server";
import { requireRunAgents } from "~/server/auth/project-authority.server";
import {
  canInterruptControllerRun,
  controllerRunRoute,
} from "~/server/controller/controller-conversations.server";
import {
  coordinationLane,
  getMaxConcurrentRuns,
  getMaxRunSpendUsd,
} from "~/server/settings/instance-settings.server";
import {
  RUN_PHASE,
  type CompactOutcome,
  type RunCallbacks,
  type RunHandle,
  type RunMcpServers,
  type RunSpec,
  type RunExit,
  type RuntimeAdapter,
} from "./adapter.server";
import {
  modelDisplayName,
  resolveRunEffort,
  substituteRunModel,
} from "./model-catalog.server";
import { publishRunStateChanged } from "./run-events.server";
import {
  projectRunsForTask,
  SDK_LABEL,
  runLiveFacts,
  type ConsoleShipping,
  type ProjectedRunView,
} from "./run-projection.server";
import { createRunSink, runPersistDrained } from "./run-sink.server";
import {
  appendRawLine,
  getRun,
  hasRunLinesBefore,
  insertRunLine,
  listRunLines,
  listRunLinesTail,
  nextSeq,
  patchRun,
  upsertRun,
  type AgentRunRow,
  type InsertRunInput,
} from "./run-store.server";
import {
  codexRolloutRunStats,
  probeSessionContinuity,
  sessionContextTokens,
  type SessionContinuity,
} from "./session-export.server";
import {
  resolveTaskFilePath,
  updateTaskFile,
  type TaskFileRef,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  createAdapters,
  selectAdapter,
  type AdapterSet,
  type RealBackend,
} from "./runtime-registry.server";
import {
  runCredentialFor,
  type RunCredential,
} from "./backend-credentials.server";
import {
  NO_PROCESS,
  principalRefusalMessage,
  type RunPrincipalRefusal,
} from "./run-principal.server";
import {
  runMarkerEnv,
  compactionRunId,
  reapRunProcesses,
} from "./run-processes.server";
import { removeSkillPlugin, type SkillPlugin } from "./skill-mount.server";
import { encodeActorRef } from "~/server/files/actor-ref.server";
import {
  bindRunToMcpGateway,
  closeRunMcpGatewayCalls,
  revokeRunMcpGateway,
} from "~/server/mcp-proxy/gateway.server";
import {
  COMPACT_AT_COMPLETION_TOKENS,
  contextWindowEnv,
  resumeVerdict,
} from "./context-policy.server";
import type { RunPrompt } from "./prompt-prefix.server";
import { claudeMcpToolName, type McpToolDenial } from "~/shared/mcp-tools";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import { wholeThousands } from "~/shared/text/thousands";
import { countLabel } from "~/shared/text/plural";

import { newId } from "~/shared/ids/new-id.server";
import { errorMessage, toError } from "~/shared/errors";
import { agentLaunchFor } from "./agent-isolation.server";

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
  /** Live adapters by run id, each with the lane its slot counts in. */
  handles: Map<string, LiveSlot>;
  /**
   * F26-1: run ids RESERVED (a `running`/`queued`-row committed to a live slot by
   * `reserveRun`) whose adapter has NOT launched yet — the workspace is still
   * cloning/preparing. A reserved run OCCUPIES a concurrency slot from the moment
   * it is granted until it either launches (moves into `handles`) or is abandoned,
   * so the cap must count it. Without this, every specialist dispatch (which always
   * reserves) bypassed the cap entirely: `handles.size` alone saw nothing during
   * the multi-minute clone window, so N delivering/reviewer runs all launched at
   * once regardless of the configured cap. Keyed to the lane the slot counts
   * in (ruling 152(b)), like `handles`.
   */
  reserved: Map<string, RunLane>;
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
  /**
   * U39-30: one-shot callbacks for a run whose answer is complete while a
   * completion compaction (ruling 376) still holds its settle back. Fired
   * just before that compaction, only for a run that finished, and dropped
   * at settle whether or not it fired. In-process only, like `completions`.
   */
  answered: Map<string, RunAnsweredCallback>;
  /**
   * Runs admitted past the concurrency cap: their DB row is `queued` and their
   * adapter has NOT been launched. The drain (run onExit) promotes the oldest
   * whose row is still `queued` when a live slot frees. In-process only — a
   * restart's orphan recovery finalizes any surviving `queued` row.
   *
   * Ruling 152(b): two FIFOs, one per lane. `coordination` holds operator and
   * controller turns, admitted up to `cap + coordinationLane(cap)` and promoted
   * first; `delivery` holds every other kind under the cap itself.
   */
  pending: PendingQueues;
  /** Reentrancy guard for `drainRunQueue` — a synchronously-exiting promoted run
   *  fires onExit (→ drain) during its own launch; the outer drain loop handles
   *  the freed slot, so the nested call returns immediately. */
  draining?: boolean;
}

/** A live adapter and the admission lane its slot is counted in. */
interface LiveSlot {
  handle: RunHandle;
  lane: RunLane;
}

/** A run waiting for a concurrency slot: launch it by calling `launch`. */
interface PendingRun {
  runId: string;
  launch: () => void;
  /** The data root `startRun` was given, for the note the promotion writes on
   *  the task (ruling 311): the drain runs from another run's onExit or the
   *  org-settings action, neither of which knows it. */
  dataRoot?: string;
}

/** The two admission lanes of ruling 152(b). */
type RunLane = "coordination" | "delivery";

interface PendingQueues {
  coordination: PendingRun[];
  delivery: PendingRun[];
}

function emptyQueues(): PendingQueues {
  return { coordination: [], delivery: [] };
}

/** Which lane a run kind is admitted through: the operator's and the
 *  controller's turns are coordination, everything else is delivery. */
function laneOf(kind: RunKind): RunLane {
  return kind === "operator" || kind === "controller" ? "coordination" : "delivery";
}

/**
 * Ruling 152(b): may a run in `lane` take a slot right now? Cap 0 is the gate
 * off. Otherwise the instance holds at most `cap + coordinationLane(cap)` runs
 * in total, and at most `cap` of them are delivery runs: the copy's "up to N
 * agent runs at once" is the delivery count, so an operator turn that is live
 * never costs a build its slot, while the operator may borrow a cap slot no
 * build is using. Both counts come from the held slots themselves (`handles`
 * and `reserved` carry their lane), never from a counter that could drift.
 *
 * The lane's own slots are unconditional: a coordination turn goes as long as
 * fewer than `lane` of them are held, which is the ruling's promise that a
 * decision never queues behind the builds it is about. BEYOND the lane a
 * coordination turn only borrows, and only a cap slot no build is using: a
 * parked delivery run is a build waiting for exactly that slot. Without the
 * borrow check the coordination bound (`cap + lane`) strictly contains the
 * delivery one, so every freed slot was re-lent to the next parked coordination
 * turn and a build waited for as long as coordination kept arriving — with
 * fourteen operator turns pending (G35-5) the cap's own runs never ran.
 */
function canAdmit(state: ServiceState, cap: number, lane: RunLane): boolean {
  if (cap === 0) return true;
  const laneSize = coordinationLane(cap);
  if (lane === "coordination" && coordinationLiveCount(state) < laneSize) return true;
  if (liveCount(state) >= cap + laneSize) return false;
  if (lane === "delivery") return deliveryLiveCount(state) < cap;
  return state.pending.delivery.length === 0;
}

/** Invoked once when a registered run reaches a terminal state. */
export type RunCompletionCallback = (finished: AgentRunRow) => void;

/** U39-30: told that a run's answer is complete and in its lines. */
export type RunAnsweredCallback = (runId: string) => void;

const SERVICE_KEY = Symbol.for("viberr.runService");

function getState(): ServiceState {
  const cache: Record<symbol, ServiceState | undefined> = globalThis;
  let state = cache[SERVICE_KEY];
  if (!state) {
    state = {
      handles: new Map(),
      reserved: new Map(),
      adapters: createAdapters(),
      completions: new Map(),
      answered: new Map(),
      pending: emptyQueues(),
    };
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
      err: toError(error),
    });
    // C4: the effects (reply/verdict/reconcile/react + waiting flip) are lost —
    // surface it so the board doesn't show "agent working" until a restart.
    void noteCompletionEffectsLost(db, run);
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

/**
 * Test-only: reset live handles and install explicitly supplied adapters.
 *
 * It no longer forces availability: since ruling 127 "available" is a fact
 * about a PERSON, so a test that wants a run to reach its adapter seeds a
 * credential row for that run's principal (`connectFakeBackend` in
 * `test-support/`). Installing the fakes here still fails the runtime closed —
 * nothing in the suite can construct a real adapter — which is what this was
 * ever for.
 */
export function configureRunServiceForTests(adapters: AdapterSet): void {
  const cache: Record<symbol, ServiceState | undefined> = globalThis;
  cache[SERVICE_KEY] = {
    handles: new Map(),
    reserved: new Map(),
    adapters,
    completions: new Map(),
    answered: new Map(),
    pending: emptyQueues(),
  };
}

// ---------------------------------------------- start / resume

export interface StartRunInput {
  projectSlug: string;
  taskKey: string;
  /** Thread id within the task ("op" | "primary" | "r0"). Defaulted per kind. */
  threadId?: string;
  role: string;
  kind: RunKind;
  backend: RealBackend;
  /**
   * Ruling 127: whose accounts this run bills — the task owner for a task run,
   * the asker for a controller turn. Required, and `null` ONLY for a run being
   * recorded as REFUSED (no principal could be resolved). A null principal
   * never spawns a process: `startRun` writes the honest error run instead.
   */
  credentialUserId: string | null;
  /** Why there is no principal, when the caller already resolved that. Its
   *  sentence (`principalRefusalMessage`) is what the error run's line, the
   *  packet body and the disabled control all render, so a person cannot be
   *  told three different stories about one refusal. */
  principalRefusal?: RunPrincipalRefusal;
  /** Ruling 316: this dispatch withheld the run's VERDICT channel, so a reply
   *  with no envelope verdict is an answer rather than a silence the prose
   *  fallback should repair. Stored on the run row. */
  verdictWithheld?: boolean;
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
  /** See RunSpec.attachmentsWritableDir — set by specialist-run when the
   *  profile holds `attach-evidence-references`. */
  attachmentsWritableDir?: string | null;
  /** Override the data root (tests). */
  dataRoot?: string;
  /** Who caused the run (audit). Defaults to the operator system actor. */
  actor?: AuditActor;
  /** Custom instructions: Claude systemPrompt / Codex developer_instructions —
   *  a static/dynamic split (ruling 370) or a plain string. */
  systemPrompt?: RunPrompt;
  /** Ruling 371/373: the anchor the run is handed back after a compaction
   *  (see `RunSpec.compactAnchor`). */
  compactAnchor?: string;
  /** U39-30: told the run's answer is written, before the completion
   *  compaction that holds its settle back. The completion callback still
   *  fires afterwards; this never fires for a run that is not compacted at
   *  completion, or that did not finish. Registered before the run launches,
   *  so a run cannot finish ahead of it. */
  onAnswered?: RunAnsweredCallback;
  /** Portable HTTP/stdio MCPs, or Claude-only in-process SDK governance tools. */
  mcpServers?: RunMcpServers;
  /** Tool allowlist confining the run (operator → its governance tools only). */
  allowedTools?: string[];
  /** Tool denylist confining a specialist run to its granted capabilities.
   *  Claude only (Codex has no denylist channel — see codex-runtime). */
  disallowedTools?: string[];
  /** Ruling 176: the org servers' marked write tools this run withholds (see
   *  `RunSpec.mcpToolDenials`), as the MCP resolver returned them. */
  mcpToolDenials?: McpToolDenial[];
  /** Granted skills mounted for the run (`mountGrantedSkills`). Claude only —
   *  the SDK's native skills filter. See RunSpec.skills. */
  skills?: string[];
  /** Ruling 180: the plugin directory carrying `skills`; removed when the run
   *  settles. See RunSpec.skillPlugin. */
  skillPlugin?: SkillPlugin;
  /** The run's `execute-code-or-write-repo` grant is withheld. Claude's tool
   *  denylist binds it; on Codex it is ADVISORY since ruling 185 removed the
   *  OS sandbox — the prompt omits the delivery steps and the server-owned
   *  delivery gate refuses them (`codexRepoWriteAdvisory` renders that
   *  wherever the enforcement is shown). Omit to let `startRun` derive it from
   *  `disallowedTools` (see `repoWriteWithheldFromDenylist`). */
  repoWriteWithheld?: boolean;
  /** The run's `use-web-search-fetch` grant is withheld — Codex enforces it by
   *  disabling its web search (P14-RT-06). Omit to let `startRun` derive it from
   *  `disallowedTools` (see `webSearchWithheldFromDenylist`). */
  webSearchWithheld?: boolean;
  /** JSON schema constraining the run's final output. Codex only — used by the
   *  structured-output operator AND every generic specialist/reviewer run's
   *  report_outcome envelope; the caller parses + executes/records it. */
  outputSchema?: unknown;
  /** Per-run environment overlay (e.g. GIT_CEILING_DIRECTORIES to confine a
   *  specialist's git to its workspace). Merged on top of the adapter env. */
  env?: Record<string, string>;
  /** R21-4: the row this run ALREADY has, from `reserveRun` — the caller showed
   *  a live "Preparing workspace" strip while it cloned. `startRun` then adopts
   *  that row (id, thread, started_at) instead of minting a second one. */
  reservation?: RunReservation;
  /** Ruling 372: set by `resumeRun` on the fresh turn it starts instead of a
   *  replay, so the run's start audit records why the session was not resumed. */
  continuityReset?: ContinuityLossReason;
}

// ------------------------------------------------------- run reservation

/**
 * A run row that exists (and renders on the Live-run strip) BEFORE its provider
 * process does — R21-4 / OBS-8.
 *
 * A cold task-repo clone took 3-12 minutes live on a 113 MB repository, and for
 * that whole window the task page showed no run at all: empty timeline, no
 * strip, nothing moving. The work IS underway, so the honest fix is a real run
 * row in `running` state whose phase says what the server is doing.
 *
 * The reservation OWNS the row until `startRun` adopts it: a caller that throws
 * mid-preparation must `abandon()` it, or the row stays `running` forever and
 * (for a delivering run) holds the single-flight slot until boot finalization.
 */
export interface RunReservation {
  runId: string;
  threadId: string;
  /** The instant the row went `running` — carried onto the launched run. */
  startedAt: string;
  /** Update the visible phase/step while preparing. */
  phase(phase: string, step: string | null): void;
  /** Preparation failed: finalize the row as `error` so nothing is stranded. */
  abandon(reason: string): void;
}

export interface ReserveRunInput {
  projectSlug: string;
  taskKey: string;
  threadId: string;
  role: string;
  kind: RunKind;
  backend: RealBackend;
  /** Ruling 127: the principal `startRun` will bill when it adopts this row —
   *  persisted here too so a reservation that is abandoned mid-preparation
   *  still records whose account the run was going to use. */
  credentialUserId: string | null;
  model: string;
  agentName?: string | null;
  agentProfileId: string;
  /** The phase to show immediately (the caller is already working). */
  phase: string;
  step?: string | null;
}

/** The states a reserved row may still be adopted (or abandoned) from — every
 *  other state is a terminal outcome some other writer already recorded. */
const RESERVATION_LIVE_STATES: readonly RunState[] = ["queued", "running"];

/**
 * Refuse to go on when the reserved row is no longer this run's to take.
 *
 * C4-opres: `reserveRun` writes a `running` row minutes before the provider
 * process exists, and that row is interruptible from the moment it renders — the
 * Live-run strip's Stop button acts on exactly it. `interruptRun` then stamps
 * `interrupted` (its no-live-handle arm: there is no adapter yet), and the
 * adoption upsert, written for a row it believed only it could touch, REVIVED
 * that run: state back to `running`, a provider process spawned, and a human's
 * stop silently undone. Preparation checks here, and `startRun` checks again
 * immediately before adopting, so the window closes on both sides.
 *
 * Throws `AppError` — a run that cannot start, which every caller already
 * handles as a run-start failure (the route answers 409; `startAgentRun`
 * releases the reservation and rethrows).
 */
export function assertRunReservationLive(db: DatabaseSync, runId: string): void {
  const row = getRun(db, runId);
  if (row && RESERVATION_LIVE_STATES.includes(row.state)) return;
  throw new AppError({
    code: ERROR_CODES.CONFLICT,
    status: 409,
    userMessage: row
      ? "That run was stopped while its workspace was being prepared, so it was not started. Start a new run when you want it to go ahead."
      : "That run's record disappeared while its workspace was being prepared, so it was not started. Start a new run.",
  });
}

/**
 * Claim a run row up front so the task page has something live to render while
 * the server prepares the workspace. Never throws for display reasons — a
 * reservation that cannot be written degrades to today's behavior (no strip),
 * which must not be able to block a run from starting.
 */
/**
 * Translate a SQLITE_CONSTRAINT_UNIQUE from the two single-flight partial
 * indexes (`idx_agent_runs__one_delivering`, F10-05, and
 * `idx_agent_runs__one_live_per_support`, dispatch-rework hunt 2026-08-29)
 * into the 409 the JS preflights already speak — or null when the error is
 * something else. ONE translator for both write paths (reserveRun + startRun),
 * so a race that slips past a preflight during its awaits is refused
 * atomically with the same message either way.
 */
function singleFlightConflict(
  kind: ReserveRunInput["kind"],
  sqlite: { errcode: number; message: string } | null,
): AppError | null {
  if (!sqlite || sqlite.errcode !== 2067) return null;
  // Three unique indexes share errcode 2067 on this table; only the two
  // single-flight ones speak 409. Discriminate on the violated columns the
  // message names — mapping a thread-id collision (a caller bug) to "a run is
  // already in progress" would send someone hunting a run that isn't there.
  const message = sqlite.message;
  if (
    kind === "primary" &&
    message.includes("agent_runs.task_key") &&
    !message.includes("agent_runs.thread_id") &&
    !message.includes("agent_runs.agent_profile_id")
  ) {
    return new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage:
        "A delivering agent run is already in progress on this task. Wait for it to finish or interrupt it before starting another.",
    });
  }
  if (kind === "reviewer" && message.includes("agent_runs.agent_profile_id")) {
    return new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage:
        "This agent already has a run in progress on this task — wait for it to finish or interrupt it before starting another.",
    });
  }
  return null;
}

export function reserveRun(
  db: DatabaseSync,
  input: ReserveRunInput,
): RunReservation | null {
  const state = getState();
  // F26-1: a reservation COMMITS a live slot (a reserved run bypasses the later
  // `admitRun` gate and launches directly, holding its slot from clone to spawn).
  // So it must be granted UNDER the cap. When no slot is free, decline the
  // reservation (return null): the caller then starts the run through the normal
  // non-reserved path, where `startRun` parks it as `queued` behind the cap. The
  // only cost is no live "Preparing" strip during that run's clone — the rare
  // cap-full case — instead of the cap being silently exceeded on every dispatch.
  // Ruling 152(b): an operator's reservation is measured against its lane's
  // bound (cap + lane), so a full delivery cap does not demote its clone to the
  // stripless queued path either.
  const cap = getMaxConcurrentRuns(db);
  const lane = laneOf(input.kind);
  if (!canAdmit(state, cap, lane)) {
    return null;
  }
  const runId = newId("run");
  const startedAt = new Date().toISOString();
  try {
    upsertRun(db, {
      id: runId,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      threadId: input.threadId,
      role: input.role,
      kind: input.kind,
      backend: input.backend,
      model: input.model,
      sdk: SDK_LABEL[input.backend] ?? "",
      agentName: input.agentName ?? null,
      agentProfileId: input.agentProfileId,
      credentialUserId: input.credentialUserId,
      state: "running",
      phase: input.phase,
      step: input.step ?? null,
      startedAt,
    });
  } catch (error) {
    // A single-flight constraint violation is not a display degradation — it
    // is the OTHER dispatch winning the race. Refuse loudly here (the caller's
    // preflight was blind during its awaits) instead of degrading to an
    // unreserved start that would pay for a clone and then 409 anyway — or,
    // before the supporting index existed, silently double-run.
    const parsed = sqliteErrorSchema.safeParse(error);
    const conflict = singleFlightConflict(input.kind, parsed.success ? parsed.data : null);
    if (conflict) throw conflict;
    logger.warn("run reservation could not be written — preparing invisibly", {
      taskKey: input.taskKey,
      err: toError(error),
    });
    return null;
  }
  // The reserved row now holds a concurrency slot until `startRun` adopts it (→
  // handles) or `abandon()` releases it.
  state.reserved.set(runId, lane);
  const publish = (state: "running" | "error") => {
    publishRunStateChanged({
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      runId,
      threadId: input.threadId,
      state,
    });
  };
  publish("running");
  return {
    runId,
    threadId: input.threadId,
    startedAt,
    phase(phase, step) {
      try {
        patchRun(db, runId, { phase, step });
      } catch (error) {
        logger.warn("run preparation phase could not be persisted", {
          runId,
          err: toError(error),
        });
      }
    },
    abandon(reason) {
      // F26-1: release the committed slot whatever the row's final state — a
      // reserved run that never launches must not keep occupying the cap.
      state.reserved.delete(runId);
      try {
        // C4-opres: never demote a row another writer already finalized. A
        // human's interrupt landing during preparation IS this run's outcome
        // (and is why the preparation threw); stamping `error` over it would
        // erase the recorded intervention — the same precedence rule the sink
        // enforces at finalize (B-FD7).
        const current = getRun(db, runId);
        if (current && !RESERVATION_LIVE_STATES.includes(current.state)) return;
        patchRun(db, runId, {
          state: "error",
          phase: null,
          step: null,
          finishedAt: new Date().toISOString(),
        });
        publish("error");
      } catch (error) {
        logger.error("reserved run could not be abandoned", {
          runId,
          reason,
          err: toError(error),
        });
      } finally {
        // A freed slot may let a run parked behind the cap start now.
        drainRunQueue(db);
      }
    },
  };
}

const DEFAULT_THREAD = {
  operator: "op",
  primary: "primary",
  reviewer: "r0",
  // Ruling 99: controller conversation turns (task_key = the conversation id).
  controller: "controller",
} satisfies Record<RunKind, string>;

/**
 * The file-write built-ins `resolveSpecialistDisallowedTools` emits for a
 * WITHHELD `execute-code-or-write-repo` grant (specialist-tool-policy). They
 * are the one deny rule whose presence means "this profile may not write the
 * repo" — the other rules gate branch/push/PR, narrower withholdings the flag
 * must not conflate with "may not write" (the read-only sandbox this once
 * drove, removed by R22, would have over-blocked them).
 */
const REPO_WRITE_DENY_MARKERS = ["Edit", "Write", "NotebookEdit"] as const;

/**
 * Whether a run's capability denylist says its repo-write grant is withheld.
 *
 * P13-RT-02: `disallowedTools` is computed for EVERY run from the same
 * `resolveSpecialistDisallowedTools` policy, backend-agnostically — it just had
 * no effect on Codex, which has no denylist channel. Deriving the flag from it
 * means the spec records the withholding for exactly the profiles the matrix
 * already shows as withheld, with no second source of truth to drift. It no
 * longer drives a sandbox: ruling 101 bound it through Codex's read-only mode,
 * and ruling 185 removed the OS sandbox, so on Codex the withholding is
 * advisory. What it still decides is the admin-marked MCP write tools a run
 * loses (ruling 176) and the `repoWriteWithheld` the spec records. Callers
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
 * The web tools `resolveSpecialistDisallowedTools` emits for a WITHHELD
 * `use-web-search-fetch` grant — the same derive-from-the-denylist trick
 * `repoWriteWithheldFromDenylist` uses, so the two backends enforce the grant
 * the matrix shows without a second source of truth.
 */
const WEB_SEARCH_DENY_MARKERS = ["WebFetch", "WebSearch"] as const;

/** Whether a run's capability denylist says its web-egress grant is withheld. */
export function webSearchWithheldFromDenylist(
  disallowedTools?: readonly string[],
): boolean {
  if (!disallowedTools?.length) return false;
  const denied = new Set(disallowedTools);
  return WEB_SEARCH_DENY_MARKERS.every((t) => denied.has(t));
}

/**
 * Auto-approve every MOUNTED MCP server that the caller did not already name.
 *
 * D4: `allowedTools` is the APPROVAL list (P14-KM-12) — an `mcp__*` tool with
 * no entry stalls on a permission prompt no human is there to answer. The
 * operator toolkit built its own list; the specialist path passed NONE, so a
 * profile's granted org MCPs (and the in-process `viberr_agent` toolkit —
 * post_comment / ask_human / report_outcome) were only ever usable because
 * every run happens to be autonomous and therefore `bypassPermissions`. That
 * made a permission MODE load-bearing for a capability GRANT: the first
 * non-autonomous or non-bypass run would silently lose the whole toolkit.
 * Deriving the entries here — the one funnel every path goes through (fresh,
 * operator, resume), the same place the effort tier is normalized — means no
 * caller can forget them, and a resume cannot drop them.
 *
 * A server the caller already named (`mcp__x`, or per-tool `mcp__x__y`) is left
 * alone: the operator deliberately lists its governance tools ONE BY ONE so the
 * approval list mirrors its capability policy, and a blanket `mcp__viberr`
 * would paper over that curation.
 *
 * Takes the mounted server NAMES, not the config bag: an approval entry is
 * derived from a server's key alone, and nothing here may depend on how a
 * declaration is shaped.
 */
function withMcpAutoApproval(
  allowedTools: readonly string[] | undefined,
  mcpServerNames: readonly string[],
): string[] | undefined {
  const named = allowedTools ?? [];
  const additions = mcpServerNames.flatMap((name) =>
    named.some((t) => t === `mcp__${name}` || t.startsWith(`mcp__${name}__`))
      ? []
      : [`mcp__${name}`],
  );
  const merged = [...named, ...additions];
  return merged.length ? merged : undefined;
}

/** The `runtime.run.started` audit payload. */
type RunStartedAudit = {
  threadId: string;
  backend: RealBackend;
  role: string;
  kind: RunKind;
  resumed: boolean;
  /** Ruling 127: whose account this run bills. Null on a refused run — the
   *  audit row then says, permanently, that nobody was billed. */
  credentialUserId: string | null;
  /** R7-2 fail-fast marker: the run never spawned a backend process. */
  failedUnavailable?: true;
  /** Ruling 372: this is the fresh turn `resumeRun` started INSTEAD of a
   *  replay, and why (`stale_large_session`, `transcript_gone`,
   *  `transcript_damaged`, `owner_changed`). */
  continuityReset?: ContinuityLossReason;
};

/**
 * What a `node:sqlite` write throws: an Error carrying the raw SQLite result
 * code on an `errcode` property its declared type does not mention. Decoding it
 * (rather than asserting a hand-written type onto the thrown value) keeps the
 * unique-violation branch off anything the driver did not actually report —
 * anything that fails this parse is rethrown untouched.
 */
const sqliteErrorSchema = z.object({ errcode: z.number(), message: z.string() });

/**
 * Ruling 263 (pass 37, F37-93): what a start DID, for the doors that report it.
 *
 * `startRun` has three endings and used to return the same `{ runId }` for all
 * three, so every caller that wanted to tell a person what happened had to
 * either guess or say "started" and be wrong twice. A refused run is a row that
 * records why no process will exist; a queued one is parked behind the
 * concurrency cap and starts when a slot frees. Neither is a run that started.
 */
export type RunStartOutcome = "started" | "queued" | "refused";

export interface RunStartResult {
  runId: string;
  outcome: RunStartOutcome;
  /** The whole sentence a refused run recorded; null for the other two. */
  refusal: string | null;
}

/** F21-13: the `meta` tag on the run's model-substitution disclosure line.
 *  A durable classified tag (no column, no migration), like `run·line_lost`. */
export const MODEL_SUBSTITUTED_TAG = "run·model_substituted";

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
 * Returns the run id and, since ruling 263, what actually happened to it.
 */
export async function startRun(
  db: DatabaseSync,
  input: StartRunInput,
): Promise<RunStartResult> {
  const state = getState();
  // R21-4: a reserved row already carries this run's identity — adopt it whole
  // (id AND thread) so the strip the human has been watching becomes this run
  // rather than a second row appearing beside it.
  const reservation = input.reservation ?? null;
  // C4-opres: the row must still be THIS run's to take. Nothing between this
  // check and the adoption write below awaits, and one process owns the data
  // root (db/writer-lock), so no other writer can slip a terminal state in
  // between — the refusal IS the guard the upsert would otherwise need.
  if (reservation) assertRunReservationLive(db, reservation.runId);
  const threadId =
    reservation?.threadId ?? input.threadId ?? DEFAULT_THREAD[input.kind];
  const runId = reservation?.runId ?? newId("run");
  const workdir =
    input.workdir ?? taskDir(input.projectSlug, input.taskKey, input.dataRoot);

  // F21-13 (run half): a model id belonging to the OTHER backend used to reach
  // the adapter untouched — `resolveClaudeModel` didn't recognize it, returned
  // undefined, and the SDK ran its own default. The agents page said
  // `gpt-5.6-terra`, the run was Sonnet, and nothing anywhere said so. Substitute
  // the backend's default (Codex would otherwise 400 on a Claude id) and
  // DISCLOSE it: the row stores what actually ran, and the run log opens with a
  // line naming the swap. The save-time rejection is the primary fix
  // (agent-profile-actions.server.ts); this is the net under it, for profiles
  // saved before that guard and for any path that builds a spec by hand.
  // F36-8 (pass 36): the swap has ONE home, `substituteRunModel` — the
  // specialist dispatch hands the profile's ORIGINAL id through and names the
  // same answer on its timeline event, so this notice fires for a
  // cross-backend retry too (it used to pre-swap, and the log never said).
  const { model, foreignBackend } = substituteRunModel(input.backend, input.model);
  const modelSubstitution = foreignBackend
    ? `The agent's model **${modelDisplayName(foreignBackend, input.model)}** ` +
      `(\`${input.model}\`) is a ${BACKEND_LABEL[foreignBackend]} model and cannot run on ` +
      `${BACKEND_LABEL[input.backend]}, so this run used \`${model}\` instead. ` +
      "Pick a model from this backend's list on the agent profile."
    : null;
  if (modelSubstitution) {
    logger.warn("run model is foreign to its backend — substituted", {
      runId,
      taskKey: input.taskKey,
      backend: input.backend,
      requestedModel: input.model,
      ranModel: model,
    });
  }

  // Ruling 127: the credential comes BEFORE the adapter. A run with no
  // principal — or one whose principal has not connected this backend — is
  // refused here, and the refusal is the run's whole outcome: an honest error
  // row and no process. Resolved before the row is written so a caller bug
  // (an env key colliding with a credential key) throws instead of stranding
  // a `running` row.
  const credential = resolveRunCredential(db, input);
  const runRow: InsertRunInput = {
    id: runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId,
    role: input.role,
    kind: input.kind,
    backend: input.backend,
    // The model that will ACTUALLY run (F21-13) — a run header naming a model
    // the provider never saw is the lie this closes.
    model,
    sdk: SDK_LABEL[input.backend] ?? "",
    sessionId: input.resumeSessionId ?? null,
    agentName: input.agentName ?? null,
    agentProfileId: input.agentProfileId,
    credentialUserId: input.credentialUserId,
    // Ruling 369: the kind of credential the run bills, which decides the
    // cache TTL the resume policy assumes for its session (ruling 372).
    credentialKind: credential.ok ? credential.credential.kind : null,
    // Ruling 507: WHICH of the principal's accounts it bills — the one active
    // when the credential was resolved. Boot recovery hands an orphaned Codex
    // run's refreshed sign-in back to this account and to no other.
    credentialAccountId: credential.ok ? credential.credential.accountId : null,
    // Ruling 316: kept on the row so the completion path can tell an answer
    // from a silence long after the dispatch is gone.
    verdictWithheld: input.verdictWithheld === true,
    // A reserved row is ALREADY running (that is the point) — re-stamping it
    // `queued` would blink the strip off between preparation and the spawn, and
    // would throw away the clock the human has been watching.
    state: reservation ? "running" : "queued",
  };
  if (reservation) {
    runRow.phase = RUN_PHASE.starting;
    runRow.startedAt = reservation.startedAt;
  }
  try {
    upsertRun(db, runRow);
  } catch (err) {
    const parsed = sqliteErrorSchema.safeParse(err);
    const conflict = singleFlightConflict(input.kind, parsed.success ? parsed.data : null);
    if (conflict) throw conflict;
    throw err;
  }

  // D4: every mounted MCP server is auto-approved here, not per caller.
  const allowedTools = withMcpAutoApproval(
    input.allowedTools,
    Object.keys(input.mcpServers ?? {}),
  );

  // Each optional below is set ONLY when present — an absent key means "SDK
  // default", which an explicit `undefined` would not.
  const spec: RunSpec = {
    runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    threadId,
    role: input.role,
    kind: input.kind,
    backend: input.backend,
    model,
    prompt: input.prompt,
    workdir,
    resumeSessionId: input.resumeSessionId ?? null,
    autonomous: input.autonomous ?? true,
  };
  // Ruling 507: the home of the account this run bills. Claude already has it
  // as `CLAUDE_CONFIG_DIR` on the credential env; the Codex adapter's private
  // home copies the account's sign-in from here and hands it back here.
  if (credential.ok) spec.accountHome = credential.credential.accountHome;
  // P13-RT-08: normalize the effort tier for the RUN's backend here, the one
  // funnel every path goes through (specialist, operator, resume). It used to
  // run only on the D4 cross-backend retry, so a profile whose stored effort
  // came from the other backend's scale ("minimal" from Codex, "max" from
  // Claude) shipped a tier the target SDK does not accept. An unset effort
  // stays unset — the SDK default applies, as before.
  if (input.effort?.trim()) {
    spec.effort = resolveRunEffort(input.backend, input.effort);
  }
  if (input.systemPrompt) spec.systemPrompt = input.systemPrompt;
  if (input.compactAnchor) spec.compactAnchor = input.compactAnchor;
  if (input.attachmentsWritableDir) {
    spec.attachmentsWritableDir = input.attachmentsWritableDir;
  }
  if (input.mcpServers) spec.mcpServers = input.mcpServers;
  if (allowedTools) spec.allowedTools = allowedTools;
  // Ruling 176: a marked write tool is denied by name AFTER the auto-approval
  // above, which keeps its `mcp__<server>` allow entry (D4) — a deny rule wins
  // over it, even under bypassPermissions. Only servers this run mounts: a
  // denial for a server that never started names nothing.
  const mcpToolDenials = (input.mcpToolDenials ?? []).filter(
    (denial) => denial.tools.length > 0 && Object.hasOwn(input.mcpServers ?? {}, denial.server),
  );
  const denied = [
    ...(input.disallowedTools ?? []),
    ...mcpToolDenials.flatMap((denial) =>
      denial.tools.map((tool) => claudeMcpToolName(denial.server, tool)),
    ),
  ];
  if (denied.length) spec.disallowedTools = denied;
  if (mcpToolDenials.length) spec.mcpToolDenials = mcpToolDenials;
  if (input.skills && input.skills.length) spec.skills = input.skills;
  if (input.skillPlugin) spec.skillPlugin = input.skillPlugin;
  // Records the withheld repo-write grant on the spec: Claude's denylist binds
  // it; on Codex it is advisory (ruling 185 removed the OS sandbox) and the
  // delivery gate is the boundary. Explicit caller value wins.
  if (
    input.repoWriteWithheld ??
    repoWriteWithheldFromDenylist(input.disallowedTools)
  ) {
    spec.repoWriteWithheld = true;
  }
  // Same for web egress: withheld ⇒ Codex runs with its web search disabled,
  // the channel the operator already uses (P14-RT-06).
  if (
    input.webSearchWithheld ??
    webSearchWithheldFromDenylist(input.disallowedTools)
  ) {
    spec.webSearchWithheld = true;
  }
  if (input.outputSchema) spec.outputSchema = input.outputSchema;
  // Ruling 175: the instance's spending cap rides every run from here, the one
  // funnel every builder goes through (specialist, operator, controller,
  // resume, scheduled, recovery), so no path can start a run without it.
  // Codex ignores it: its SDK has no budget option.
  const spendCap = getMaxRunSpendUsd(db);
  if (spendCap !== null) spec.maxSpendUsd = spendCap;
  // Ruling 127: the credential's env (the principal's home, plus their pasted
  // key when they have one) is the BASE; the caller's per-run overlay (the
  // specialist's GIT_* workspace confinement) goes on top. `resolveRunCredential`
  // has already refused a caller overlay that names a credential key, so the
  // spread order cannot silently decide whose account pays.
  // A refused run never spawns anything, so it carries no credential env — the
  // spec is still built in full because `failRunUnavailable` persists through
  // the same sink every other run uses.
  const runEnv: Record<string, string> = credential.ok
    ? { ...credential.credential.env }
    : {};
  Object.assign(runEnv, input.env);
  // Ruling 371/373: the context window for this kind, from the one home for
  // the number (`context-policy.server.ts`), set here — the one funnel every
  // run goes through — so no path can start a specialist or controller run
  // without it, and after the caller's overlay so nothing renames it.
  Object.assign(runEnv, contextWindowEnv(input.backend, input.kind));
  // Ruling 460: the run executes as its principal's own OS user. Decided here,
  // the one funnel every run goes through, so no path can start a process as
  // the server's user while this server launches agents; and it never falls
  // back to it — a launch that cannot be prepared refuses the run below.
  let launchRefusal: string | null = null;
  if (credential.ok && input.credentialUserId) {
    try {
      const agent = agentLaunchFor(
        db,
        input.credentialUserId,
        credential.credential.homeDir,
        input.dataRoot,
        // Ruling 507: the account's own home and what it links to, which the
        // server may have created since the backend home was handed over.
        credential.credential.ownDirs,
      );
      if (agent) {
        spec.agent = agent;
        // The server's own $HOME is not the agent's to write (npm's cache, a
        // `git config --global`): each person's agents get their own.
        if (agent.home) runEnv.HOME = agent.home;
      }
    } catch (error) {
      launchRefusal =
        error instanceof AppError
          ? error.userMessage
          : `The agent could not be started as its person's own user (ruling 460): ${errorMessage(error)}. Nothing ran.`;
    }
  }
  // Ruling 174: every process the run starts carries its id, so the settle
  // sweep can find what it left behind (`run-processes.server.ts`). Set last:
  // no caller overlay may rename a run's processes. A refused run spawns
  // nothing and carries none.
  if (credential.ok) Object.assign(runEnv, runMarkerEnv(runId));
  if (Object.keys(runEnv).length) spec.env = runEnv;

  // The reasons no process may start, decided on the finished spec: the
  // credential (ruling 127) and the launch as the principal's own user
  // (ruling 460) — each an honest `run·unavailable` error row. Ruling 182's
  // sandbox refusal is gone with the sandbox itself (ruling 185): a Codex run
  // is never OS-confined by the CLI, so there is no such host condition.
  const refusal: string | null = credential.ok ? launchRefusal : credential.message;

  const details: RunStartedAudit = {
    threadId,
    backend: input.backend,
    role: input.role,
    kind: input.kind,
    resumed: Boolean(input.resumeSessionId),
    credentialUserId: input.credentialUserId,
  };
  if (refusal !== null) details.failedUnavailable = true;
  if (input.continuityReset) details.continuityReset = input.continuityReset;

  // Governed action: opening a runtime session is audited (BUILD-PLAN
  // Phase 10 / contracts — run start + interrupt both leave audit rows).
  recordAudit(db, {
    action: "runtime.run.started",
    // No actor: the operator runtime started the run itself (a scheduling
    // reaction).
    actor: input.actor ?? OPERATOR_AUDIT_ACTOR,
    subjectKind: "run",
    subjectId: runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details,
  });

  const refuse = (message: string): RunStartResult => {
    // F26-1: a reserved run that fails here never launches — release its slot
    // and let a run parked behind the cap take it.
    if (reservation) {
      state.reserved.delete(reservation.runId);
      drainRunQueue(db);
    }
    failRunUnavailable(db, spec, message, reservation?.startedAt);
    // Ruling 180: a refused run never spawns, so its plugin has no reader.
    removeSkillPlugin(spec.skillPlugin);
    return { runId, outcome: "refused", refusal: message };
  };
  if (!credential.ok) return refuse(credential.message);
  if (refusal !== null) return refuse(refusal);

  // Ruling 461: a server with a stored credential is mounted through Viberr's
  // MCP gateway; the run's own token goes on its config here, the one funnel
  // every run takes, and is revoked on every path that ends it (the settle,
  // an interrupt with or without a live handle, a queued run that is dropped,
  // a launch that throws). A refused run above never gets one.
  if (spec.mcpServers) {
    spec.mcpServers = bindRunToMcpGateway({
      db,
      runId,
      servers: spec.mcpServers,
      toolDenials: mcpToolDenials,
      actor: mcpGatewayAuditActor(input),
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      isLive: () => {
        const row = getRun(db, runId);
        return row?.state === "running" || row?.state === "queued";
      },
    });
  }

  // U39-30: before the launch, so the run cannot answer ahead of its hook.
  if (input.onAnswered) state.answered.set(runId, input.onAnswered);
  const launchOpts: Parameters<typeof launch>[4] = {};
  if (reservation) launchOpts.startedAt = reservation.startedAt;
  if (modelSubstitution) launchOpts.notice = modelSubstitution;
  if (input.dataRoot) launchOpts.dataRoot = input.dataRoot;
  const adapter = selectAdapter(input.backend, state.adapters);
  const secrets = credential.credential.secrets;
  const launchThunk = () => launch(db, spec, adapter, secrets, launchOpts);
  // A RESERVED run already rendered "Preparing workspace" as a `running` row and
  // committed its slot at reserve time (counted in `state.reserved` under the cap,
  // F26-1) — it launches directly rather than being demoted back to `queued`
  // (which would blink the strip and confuse the drain's queued-row check). The
  // slot moves from `reserved` to `handles` in the same synchronous step, so the
  // live count never dips and no parked run can race into this run's slot. Every
  // other run (operator/reviewer/resume-less start with no reservation) is admitted
  // under the cap: launched now if a slot is free, else parked in `queued`.
  if (reservation) {
    state.reserved.delete(reservation.runId);
    launchThunk();
    return { runId, outcome: "started", refusal: null };
  }
  const admitted = admitRun(db, runId, launchThunk, input.kind, input.dataRoot);
  return { runId, outcome: admitted ? "started" : "queued", refusal: null };
}

/**
 * Ruling 461: who a call to an admin-marked MCP write tool through the gateway
 * is audited as — the agent itself on a specialist run (the ref its toolkit
 * writes carry), the operator on an operator run, and on a controller turn the
 * person whose turn it is, as the controller's instrument (the actor the turn
 * already starts under).
 */
function mcpGatewayAuditActor(input: StartRunInput): AuditActor {
  if (input.kind === "operator") return OPERATOR_AUDIT_ACTOR;
  if (input.kind === "controller") return input.actor ?? OPERATOR_AUDIT_ACTOR;
  return {
    userId: null,
    label: encodeActorRef({
      kind: "agent",
      backend: input.backend,
      profileId: input.agentProfileId,
      roleHint: input.role,
    }),
  };
}

/** What `startRun` got when it asked for its principal's credential. */
type ResolvedRunCredential =
  | { ok: true; credential: RunCredential }
  /** No process may start; `message` is the whole sentence the run records. */
  | { ok: false; message: string };

/**
 * Ruling 127: the credential of the ONE person this run bills, or the sentence
 * explaining why there is none.
 *
 * Three ways a run has no credential, and all three end in an honest error run
 * rather than a thrown 500 — the run row IS the report, and its completion
 * callbacks (escalation packet, timeline event, waiting flip) are what a human
 * actually sees:
 *
 *  - the caller resolved no principal at all (`credentialUserId: null`) and
 *    passed the refusal that says why (unowned task, dead owner, backend not
 *    connected for the owner);
 *  - `runCredentialFor` refuses for a principal that WAS resolved — the
 *    sign-in file vanished between resolve and start, or the sealed key can no
 *    longer be opened;
 *  - a caller bug: `input.env` names a key the credential owns. That one
 *    THROWS, because silently letting either side win would decide whose
 *    account pays for the run.
 */
function resolveRunCredential(
  db: DatabaseSync,
  input: StartRunInput,
): ResolvedRunCredential {
  // The caller's own refusal wins, and is checked FIRST. It was produced by
  // `run-principal` with the whole picture — who owns the task, whether that
  // person still exists — and re-deriving an answer here would tell a second
  // story about one refusal. (A `no-credential` refusal still carries the
  // owner's id, so the run records whose account it would have billed; that is
  // why this cannot key off `credentialUserId` alone.)
  if (input.principalRefusal) {
    return {
      ok: false,
      message: backendUnavailableMessage(input.backend, {
        kind: "refusal",
        refusal: input.principalRefusal,
      }),
    };
  }
  // Falsy, not strictly-null: an empty string is not a user id either, and a
  // caller bug must reach a human as the honest refusal run rather than as a
  // SQLite binding crash three frames down.
  if (!input.credentialUserId) {
    return { ok: false, message: missingPrincipalMessage(input.backend) };
  }
  let credential: RunCredential;
  try {
    credential = runCredentialFor(
      db,
      input.credentialUserId,
      input.backend,
      input.dataRoot,
    );
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return {
      ok: false,
      message: backendUnavailableMessage(input.backend, {
        kind: "detail",
        detail: error.userMessage,
      }),
    };
  }
  const collisions = Object.keys(input.env ?? {}).filter(
    (key) => key in credential.env,
  );
  if (collisions.length) {
    throw AppError.internal(
      `run env overlay collides with the credential env: ${collisions.join(", ")}`,
    );
  }
  return { ok: true, credential };
}

/**
 * The fallback when a caller passed `credentialUserId: null` without saying
 * why. Every caller in the product resolves a principal first
 * (`run-principal.server.ts`) and passes its refusal, so this is a bug guard —
 * but a bug guard that still tells the human something true and actionable
 * instead of an empty run log.
 */
function missingPrincipalMessage(backend: RealBackend): string {
  return (
    `${BACKEND_LABEL[backend]} runs bill a person's own account, and this run was started ` +
    `without one. Own the task (Assign me) and run the agent again. ${NO_PROCESS}`
  );
}

/**
 * R7-2 fail-fast: finalize a run that never got a credential as an honest
 * `error` — one classified terminal err line (the tag is what
 * `runFailureReason` classifies as "unavailable") and no backend process.
 * Persisting through the regular sink keeps the SSE/log/state plumbing
 * identical to any other terminal run, so registered completion callbacks
 * fire immediately via the already-terminal path and the F8 escalation runs.
 */
function failRunUnavailable(
  db: DatabaseSync,
  spec: RunSpec,
  text: string,
  startedAt?: string,
): void {
  // A refused run holds no credential, so there is nothing per-run to redact —
  // the sink's own env sweep and token patterns still apply.
  const sink = createRunSink(db, spec);
  // R21-4: a run that was RESERVED kept the human waiting through its workspace
  // preparation — its clock started there, not here.
  sink.markRunning(startedAt);
  const now = new Date().toISOString();
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
 * The sentence a run refused for want of a credential records — the ONE builder
 * the error run's `run·unavailable` line, the blocked packet's body and the
 * disabled dispatch control all read.
 *
 * Ruling 127 replaced the deployment-wide answer this used to give (which named
 * `ANTHROPIC_API_KEY`, `CODEX_HOME` and a pair of CLI-auth opt-ins that no
 * longer exist) with a PERSON: a run bills a person, so the only honest
 * refusal names that person and where THEY connect the backend. The two shapes
 * are the resolver's refusal (`principalRefusalMessage`) and, when the
 * principal resolved but their credential did not survive to spawn time, that
 * credential's own health detail.
 */
type RunUnavailability =
  | { kind: "refusal"; refusal: RunPrincipalRefusal }
  /** A full sentence from the credential store (`UserBackendHealth.detail`, or
   *  the un-openable-key refusal `runCredentialFor` raises). */
  | { kind: "detail"; detail: string };

function backendUnavailableMessage(
  backend: RealBackend,
  cause: RunUnavailability,
): string {
  return cause.kind === "refusal"
    ? principalRefusalMessage(cause.refusal, backend)
    : `${cause.detail} ${NO_PROCESS}`;
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

/** Ruling 207(j): WHY a resume did not reach its session. The causes look
 *  identical downstream and read completely differently to a human: one is a
 *  storage fault worth investigating, the others are decisions viberr made.
 *  Ruling 372 added `stale_large_session`: the transcript exists and Viberr
 *  chose not to replay it — idle past its cache TTL and above the replay
 *  threshold, so a resume would re-write the whole history as one cache
 *  write. */
export type ContinuityLossReason =
  | "transcript_gone"
  /** Ruling 434: the transcript is there and the CLI refuses it (a Codex
   *  rollout whose head is torn). A fault, like `transcript_gone`, and marked
   *  the same way so the dead session is never selected again. */
  | "transcript_damaged"
  | "owner_changed"
  | "stale_large_session";

/** Ruling 372: the tag of the meta line a set-aside session's last run gets.
 *  Not `·session_missing` on purpose: `runIdsWithMissingSession` must not skip
 *  the row (the session is intact and a later small resume may use it), and
 *  no failure classifier may read a decision as a fault. */
const SESSION_STALE_TAG = "run·session_stale";

/** Ruling 372: the size and age the verdict was taken on, for the sentences. */
export interface StaleSessionFacts {
  contextTokens: number;
  idleMs: number;
  ttlMs: number;
}

function humanDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "an unknown time";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return countLabel(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${countLabel(hours, "hour")}${rest ? ` ${countLabel(rest, "minute")}` : ""}`;
}

/** What the user is told when a session could not be resumed. Never "review your
 *  authentication" — the credential is fine. */
function sessionMissingMessage(
  backend: RealBackend,
  sessionId: string,
  reason: ContinuityLossReason,
): string {
  const label = BACKEND_LABEL[backend];
  if (reason === "owner_changed") {
    return `The ${label} session ${sessionId} belongs to the account that owned this task before the seat changed hands, so it could not be resumed under the current owner's credential (ruling 127). Nothing is wrong with the credential, and the transcript is not gone — it is simply not this principal's to read. The agent re-anchored on task.md and continued with a fresh session.`;
  }
  if (reason === "transcript_damaged") {
    return `The ${label} session ${sessionId} could not be resumed: its provider transcript is damaged. The rollout does not start with the session's metadata, and the CLI refuses to resume it without that. Nothing is wrong with the credential. The agent re-anchored on task.md and continued with a fresh session.`;
  }
  return `The ${label} session ${sessionId} no longer exists on this machine. Its provider transcript is gone (retention sweep or a wiped runtime volume), so the conversation could not be resumed. The agent re-anchored on task.md and continued with a fresh session.`;
}

/**
 * Stamp the dead run with the continuity failure: one classified `err` line on
 * the run that owned the session id, in both the DB projection and the raw
 * .jsonl. This is the durable record — no column, no migration — that
 * `latestSessionRun` reads to skip the row, and the console shows it exactly
 * where the thread stopped.
 */
function recordSessionMissing(
  db: DatabaseSync,
  run: AgentRunRow,
  reason: ContinuityLossReason,
  stale?: StaleSessionFacts,
): void {
  const now = new Date().toISOString();
  const label = BACKEND_LABEL[run.backend];
  // Ruling 372: a set-aside session is a DECISION, recorded as a meta line
  // under its own tag — the session is intact, nothing failed.
  const text =
    reason === "stale_large_session" && stale
      ? `The ${label} session ${run.session_id ?? ""} was not resumed on purpose: it was ${humanDuration(stale.idleMs)} idle, past the ${humanDuration(stale.ttlMs)} its prompt cache is assumed to live, and ${wholeThousands(stale.contextTokens)} tokens large, so replaying it would have re-written the whole history as one cache write. The agent started a fresh session anchored on task.md and its last report; the transcript is intact.`
      : sessionMissingMessage(run.backend, run.session_id ?? "", reason);
  const raw = JSON.stringify({
    type: reason === "stale_large_session" ? "notice" : "error",
    source: "viberr",
    reason: reason === "stale_large_session" ? "session_stale" : "session_missing",
    session_id: run.session_id,
    message: text,
    ...stale,
  });
  try {
    appendRawLine(run.backend, run.id, raw);
    insertRunLine(db, {
      runId: run.id,
      seq: nextSeq(db, run.id),
      occurredAt: now,
      raw,
      display:
        reason === "stale_large_session"
          ? { t: now.slice(11, 19), ev: "meta", tag: SESSION_STALE_TAG, text }
          : { t: now.slice(11, 19), ev: "err", tag: SESSION_MISSING_TAG, text },
    });
  } catch (error) {
    logger.error("session-missing marker persist failed", {
      runId: run.id,
      err: toError(error),
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
function continuityResetPreamble(
  backend: RealBackend,
  kind?: string,
  /** Ruling 372: a set-aside session says so, and carries the last report. */
  stale?: { facts: StaleSessionFacts; lastReport: string | null },
): string {
  const label = BACKEND_LABEL[backend];
  // Ruling 99: a controller turn has no task.md — its anchors are the recent
  // conversation digest its turn prompt carries and the live tool reads.
  if (kind === "controller") {
    return stale
      ? [
          `[continuity notice] Your previous ${label} session for this conversation was set aside on purpose: it had been idle ${humanDuration(stale.facts.idleMs)} and grown to ${wholeThousands(stale.facts.contextTokens)} tokens, so replaying it would have re-written the whole history. None of the earlier exchange is in your context.`,
          `The recent-conversation digest in the prompt below carries the last stored turns, and your tools are your anchors. Say so if the request depends on context you can no longer see.`,
        ].join(" ")
      : [
          `[continuity notice] Your previous ${label} session for this conversation is gone — the provider transcript no longer exists, so none of the earlier exchange is in your context.`,
          `The recent-conversation digest in the prompt below and your tools are your anchors. Say so if the request depends on context you can no longer see.`,
        ].join(" ");
  }
  if (stale) {
    return [
      `[continuity notice] Your previous ${label} session for this task was set aside on purpose: it had been idle ${humanDuration(stale.facts.idleMs)} and grown to ${wholeThousands(stale.facts.contextTokens)} tokens, so replaying it would have re-written the whole history as one cache write. None of that conversation is in your context.`,
      `Re-anchor on the canonical task file (\`task.md\` in your working directory) and the repository state before you act. Treat the request below as a fresh instruction, and say so if it depends on context you can no longer see.`,
      stale.lastReport
        ? `Your last report on this task, for orientation (the task record and the repository are the truth if they disagree):\n\n${stale.lastReport}`
        : "",
    ]
      .filter((part) => part !== "")
      .join(" ");
  }
  return [
    `[continuity notice] Your previous ${label} session for this task is gone — the provider transcript no longer exists, so none of that conversation is in your context.`,
    `Re-anchor on the canonical task file (\`task.md\` in your working directory) and the repository state before you act. Treat the request below as a fresh instruction, and say so if it depends on context you can no longer see.`,
  ].join(" ");
}

/** Ruling 372: how much of the prior run's last report the fresh turn carries. */
const LAST_REPORT_CHARS = 6_000;

/**
 * Ruling 372: the prior run's last reply — the newest agent-text line of its
 * console — clipped, so a fresh session set aside on purpose still knows what
 * the agent last said it did. Null when the run wrote no reply.
 */
function lastReportOf(db: DatabaseSync, runId: string): string | null {
  const tail = listRunLinesTail(db, runId, 400);
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const line = tail[i]!.display;
    if (line.ev !== "text" || !line.text.trim()) continue;
    const text = line.text.trim();
    return text.length > LAST_REPORT_CHARS ? `${text.slice(0, LAST_REPORT_CHARS - 1)}…` : text;
  }
  return null;
}

/**
 * Note the continuity break on the task timeline. G8: a `continuity` typed
 * event (amber warning tone), NOT a neutral `note` — nothing was violated (not
 * `policy`) and nothing is stuck (not `blocked`), but context WAS lost and a
 * supervisor scanning the timeline/stream must get a cue, which a neutral note
 * buried mid-timeline never gave (PRD Journey 4: "a continuity warning appears
 * on the task"). Best-effort: a task file we cannot write must never block the
 * run that is the actual recovery.
 */
async function noteContinuityReset(
  db: DatabaseSync,
  run: AgentRunRow,
  reason: ContinuityLossReason,
  dataRoot?: string,
  stale?: StaleSessionFacts,
): Promise<void> {
  // Ruling 99: a controller conversation has no task file to note on — its
  // per-turn digest is the recovery, and the run row's session_missing stamp
  // remains the durable record.
  if (run.kind === "controller") return;
  const ref: TaskFileRef = {
    projectSlug: run.project_slug,
    taskKey: run.task_key,
  };
  if (dataRoot) ref.dataRoot = dataRoot;
  const label = BACKEND_LABEL[run.backend];
  try {
    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "continuity",
        actor: { kind: "system", systemId: "runtime-continuity" },
        title: null,
        // Ruling 207(j): the owner-change branch decides continuity BEFORE any
        // filesystem is consulted (see resumeRun), so the transcript is intact
        // in the previous owner's home. Reporting that as "no provider
        // transcript … retention sweep or a wiped runtime volume" sent an admin
        // hunting a storage fault that does not exist, and hid the one fact
        // that explains it.
        text:
          reason === "stale_large_session" && stale
            ? // Ruling 372: a decision, said as one — the session is intact.
              `Started a fresh session: the previous ${label} session behind ${run.agent_name ?? run.role}'s thread was ${wholeThousands(stale.contextTokens)} tokens and ${humanDuration(stale.idleMs)} old, past the ${humanDuration(stale.ttlMs)} its prompt cache is assumed to live, so replaying it would have re-written the whole history as one cache write. The agent re-anchored on \`task.md\` and its last report and continued in a fresh session; the earlier transcript is intact and the run log it produced is unchanged.`
            : reason === "owner_changed"
            ? `Runtime continuity was reset: this task's runs bill its owner (ruling 127), and the ${label} session behind ${run.agent_name ?? run.role}'s thread belongs to the account that held the seat before it changed hands — so it could not be resumed from here. The transcript is not missing; it is not this principal's to read. The agent re-anchored on \`task.md\` and continued in a fresh session; the run log it already produced is unchanged.`
            : reason === "transcript_damaged"
            ? // Ruling 434: there, and refused. Not a sweep, and not the credential.
              `Runtime continuity was lost: the ${label} session behind ${run.agent_name ?? run.role}'s thread has a damaged provider transcript. Its rollout does not start with the session's metadata, which the CLI needs to resume it. The agent re-anchored on \`task.md\` and continued in a fresh session. Its earlier conversation context is gone; the run log it already produced is unchanged.`
            : `Runtime continuity was lost: the ${label} session behind ${run.agent_name ?? run.role}'s thread no longer has a provider transcript, so it could not be resumed. The agent re-anchored on \`task.md\` and continued in a fresh session. Its earlier conversation context is gone; the run log it already produced is unchanged.`,
        toAgent: false,
        evidence: null,
      });
    });
    rebuildPath(db, resolveTaskFilePath(ref), dataRoot ? { dataRoot } : {});
  } catch (error) {
    logger.error("continuity-reset timeline note failed", {
      runId: run.id,
      taskKey: run.task_key,
      err: toError(error),
    });
  }
}

/**
 * C4 (pass 23): a run finished, but its completion CALLBACK threw — so the reply,
 * verdict, delivery reconcile, operator re-engagement AND the waiting-state flip
 * were all lost, leaving the task reading `waiting: agent` with no live run: the
 * board shows "agent working" forever, until boot recovery replays the effects on
 * the NEXT restart. Stamp the task with a visible continuity warning and flip it
 * to `waiting: human` so the board stops lying about a run that already ended and
 * a supervisor can act (re-run the agent) without waiting for a restart. Recovery
 * still replays on restart; this makes the gap visible in the meantime.
 * Best-effort: a task file we cannot write must never mask the original failure.
 */
export async function noteCompletionEffectsLost(
  db: DatabaseSync,
  run: AgentRunRow,
  dataRoot?: string,
): Promise<void> {
  const ref: TaskFileRef = {
    projectSlug: run.project_slug,
    taskKey: run.task_key,
  };
  if (dataRoot) ref.dataRoot = dataRoot;
  // Ruling 207(a): the marker that makes the sentence below TRUE. The same
  // write flips `waiting` to "human" — honest, nothing is running — and boot
  // recovery selects on `t.waiting = 'agent'`, so the note promised a replay
  // its own write had just made unreachable. Recovery now also matches a run
  // carrying this row, which is the module's existing idiom: it already keys
  // idempotency and its crash-loop cap on audit rows, not on task state.
  recordAudit(db, {
    action: "run.completion.effects_lost",
    actor: SYSTEM_ACTOR,
    subjectKind: "task",
    subjectId: run.task_key,
    projectSlug: run.project_slug,
    taskKey: run.task_key,
    details: { runId: run.id, kind: run.kind },
  });
  // F37-67: what this note may promise depends on what the boot sweep will
  // actually do with this run, so it asks the sweep's own rule rather than
  // asserting one. The only shape that produces this note is
  // `applyAgentCompletionEffects` REJECTING, and that function records the
  // reply (with any verdict, atomically) in its step 1 before the delivery
  // reconcile and the operator react that can fail after it. When step 1 did
  // land, "none of them landed" is false about the one effect a person can see,
  // and `recoverUnreactedAgentRuns` excludes the run forever on the very audit
  // row step 1 wrote — so the replay sentence named a mechanism that had
  // already decided not to run. Both sentences now follow the fact.
  const { completionReplayWillRun } = await import("./run-recovery.server");
  let willReplay = false;
  try {
    willReplay = await completionReplayWillRun(db, run);
  } catch (error) {
    // A predicate that cannot be read must not cost the note itself. Staying
    // false is the safe side: it promises nothing and points at the one action
    // a person can always take.
    logger.warn("completion-replay predicate failed", {
      runId: run.id,
      err: toError(error),
    });
  }
  const agent = run.agent_name ?? run.role;
  const text = willReplay
    ? `The ${agent} run finished, but applying its completion effects (its reply, any verdict, the delivery reconcile, and re-engaging the operator) failed, so none of them landed. This task is not being worked right now. Run recovery replays the effects on the next restart; you can also re-run the agent. The run log it already produced is unchanged.`
    : `The ${agent} run finished, but applying its completion effects failed partway. Anything already written above stands; what did not run is the delivery reconcile and re-engaging the operator. This task is not being worked right now, and boot recovery will not pick this run up, so nothing changes on its own: re-run the agent to carry on. The run log it already produced is unchanged.`;
  try {
    await updateTaskFile(ref, (parsed) => {
      parsed.frontmatter.waiting = "human";
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "continuity",
        actor: { kind: "system", systemId: "runtime-continuity" },
        title: null,
        text,
        toAgent: false,
        evidence: null,
      });
    });
    rebuildPath(db, resolveTaskFilePath(ref), dataRoot ? { dataRoot } : {});
  } catch (error) {
    logger.error("completion-effects-lost timeline note failed", {
      runId: run.id,
      taskKey: run.task_key,
      err: toError(error),
    });
  }
}

/** The follow-up turn `resumeRun` starts on an existing run's session. */
export interface ResumeRunInput {
  runId: string;
  prompt: string;
  /**
   * Ruling 127: whose accounts the RESUMED turn bills — the task owner as of
   * NOW, not whoever the original run billed. `resumeRun` re-resolves nothing
   * itself; the caller passes the principal it resolved.
   *
   * The consequence is deliberate and documented in agents-and-runtime.md
   * §3.6: a task whose owner changed since the original run reads as a missing
   * provider session and takes the existing continuity-reset path — one fresh
   * run re-anchored on `task.md`, with the timeline saying context was lost.
   * `resumeRun` decides that from the CHANGE itself (this id against the prior
   * run's `credential_user_id`), not from probing the new owner's home: a home
   * with no transcript store yet answers `unknown`, which means "resume as
   * before" and would hand the SDK a session id that only exists in somebody
   * else's home. The alternative (reading the previous owner's home) would
   * resume one person's conversation inside another person's account.
   */
  credentialUserId: string | null;
  /** Why there is no principal for this resume (see `StartRunInput`). */
  principalRefusal?: RunPrincipalRefusal;
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
  /** Ruling 176: re-apply the org servers' withheld write tools on resume, or
   *  a resumed read-only agent would get back the tools its fresh run lacked. */
  mcpToolDenials?: McpToolDenial[];
  /** Re-apply the granted skills mounted for the resumed run. A resume
   *  re-mounts (ruling 180: one plugin per run), but the SDK options do not
   *  carry over: without this a resumed @mention run would enable NO skill
   *  while its persona — built by the same `resolveResumeConfinement` —
   *  already left the bodies out for native delivery, so the agent would
   *  silently lose its granted craft mid-thread (the XS-1 fresh-vs-resume
   *  parity class). */
  skills?: string[];
  /** Ruling 180: the resumed run's own plugin directory (see `skills`). */
  skillPlugin?: SkillPlugin;
  /** Re-apply the run's tool APPROVAL list on resume. D4: the type used to
   *  omit this while accepting every other half of the run's tool policy, so
   *  a caller that curated an allowlist (the operator does) silently lost it
   *  the moment its session was resumed. Mounted MCP servers are still
   *  auto-approved by `startRun` either way. */
  allowedTools?: string[];
  /** Re-apply the per-run env overlay (GIT_CEILING_DIRECTORIES workspace
   *  confinement) on resume. */
  env?: Record<string, string>;
  /** Re-apply the specialist's declared MCP servers on resume (Claude). */
  mcpServers?: RunMcpServers;
  /** Re-apply the persona/system prompt on resume (Claude). */
  systemPrompt?: RunPrompt;
  /** Ruling 371: re-apply the compaction anchor on resume, or a resumed run
   *  would lose it mid-thread (the XS-1 fresh-vs-resume parity class). */
  compactAnchor?: string;
  /** U39-30: see `StartRunInput.onAnswered`. */
  onAnswered?: RunAnsweredCallback;
  /** Ruling 372: the instant the resume is decided at. Tests pin it; the
   *  product passes nothing and the service reads its clock ONCE here. */
  nowIso?: string;
  /** Re-apply the outcome-envelope schema on resume so a resumed (e.g.
   *  @mention) Codex agent still emits the structured outcome (verdict /
   *  questions) instead of falling back to the fragile prose regex — and so
   *  ask_human can fire. Without it a resumed Codex reviewer silently lost
   *  its envelope, a fresh-vs-resume parity break (F7). */
  outputSchema?: unknown;
  /** C02-R3 (pass 32): re-apply the task's attachments drop on resume, so a
   *  resumed run's persona and its writable set still agree. It no longer
   *  widens any sandbox (ruling 185 removed Codex's; Claude never had one) —
   *  it is the path the persona names, and the prompt must not promise a drop
   *  the run was not told about. Same fresh-vs-resume parity class as
   *  XS-1/F7. */
  attachmentsWritableDir?: string;
}

/**
 * Copy the caller's per-turn overrides onto a resumed run's input, key for key.
 * An option the caller did NOT pass must stay ABSENT: `startRun` reads key
 * PRESENCE (an absent effort keeps the SDK default, an absent `disallowedTools`
 * derives the withheld-grant flags), so writing an explicit `undefined` here
 * would change what the run gets. Both resume paths — the continuity-reset
 * fresh run and the session resume — carry the identical set; that is the
 * fresh-vs-resume parity XS-1 and F7 were about.
 */
function carryResumeOptions(target: StartRunInput, input: ResumeRunInput): void {
  if (input.principalRefusal) target.principalRefusal = input.principalRefusal;
  if (input.effort) target.effort = input.effort;
  if (input.workdir) target.workdir = input.workdir;
  if (input.autonomous !== undefined) target.autonomous = input.autonomous;
  if (input.dataRoot) target.dataRoot = input.dataRoot;
  if (input.actor) target.actor = input.actor;
  if (input.disallowedTools) target.disallowedTools = input.disallowedTools;
  if (input.mcpToolDenials) target.mcpToolDenials = input.mcpToolDenials;
  if (input.skills) target.skills = input.skills;
  if (input.skillPlugin) target.skillPlugin = input.skillPlugin;
  if (input.allowedTools) target.allowedTools = input.allowedTools;
  if (input.env) target.env = input.env;
  if (input.mcpServers) target.mcpServers = input.mcpServers;
  if (input.systemPrompt) target.systemPrompt = input.systemPrompt;
  if (input.compactAnchor) target.compactAnchor = input.compactAnchor;
  if (input.onAnswered) target.onAnswered = input.onAnswered;
  if (input.outputSchema) target.outputSchema = input.outputSchema;
  if (input.attachmentsWritableDir) {
    target.attachmentsWritableDir = input.attachmentsWritableDir;
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
  input: ResumeRunInput,
): Promise<{ runId: string; continuityReset?: true; continuityLossReason?: ContinuityLossReason }> {
  const prev = getRun(db, input.runId);
  if (!prev) throw AppError.notFound(`Run ${input.runId} not found.`);
  const backend: RealBackend = prev.backend;
  // A resume creates a NEW run row (a fresh stream) that shares the PROVIDER
  // session id. It must NOT reuse the prior thread_id — agent_runs is unique
  // on (project, task, thread), and the prior row still exists. Derive a fresh
  // thread id from the original so the picker still groups it recognizably.
  const resumeThreadId =
    prev.thread_id + "-r" + newId("t").replace("t_", "").slice(0, 6);

  // Ruling 127: an OWNER CHANGE decides continuity on its own, before any
  // filesystem is consulted. The probe below reads the principal's own runtime
  // home, and a home whose transcript store does not exist yet — the new owner
  // connected the backend but has never had a run on this server, so
  // `claude-home/projects/` was never created — answers `unknown`, whose
  // contract is "absence proves nothing, resume as before". That would hand
  // the SDK the PREVIOUS owner's session id inside the new owner's home and
  // fail at the vendor ("No conversation found with session ID …"), which is
  // exactly the dead-id class P13-D-2 exists to prevent. When the seat has
  // changed hands since the run being resumed, the prior transcript is by
  // construction in somebody else's home: a known miss, not an unknown one.
  const ownerChanged =
    input.credentialUserId !== null &&
    prev.credential_user_id !== null &&
    prev.credential_user_id !== input.credentialUserId;
  // P13-D-2: probe before handing the id to the SDK. `unknown` (no transcript
  // store to look in) resumes exactly as before — absence proves nothing there.
  // Ruling 127: the transcript lives in the PRINCIPAL's own runtime home, so
  // the probe has to be told whose. A resume with no principal (the task lost
  // its owner) has no home to look in and no run to start either — it falls
  // through to `startRun`, which records the refusal.
  const continuity: SessionContinuity = ownerChanged
    ? "missing"
    : probeSessionContinuity(
        backend,
        input.credentialUserId,
        prev.session_id,
        input.dataRoot,
      );
  // Ruling 372: a session that is BOTH idle past its cache TTL AND larger than
  // the replay threshold is never replayed — the whole history would be one
  // cache write (298k, 911k and 929k on this instance). The size is what a
  // resume would replay: the last call's prompt, from the row when the sink
  // recorded it, else from the provider's own transcript (a row that predates
  // the column, a session another run extended). The TTL follows the
  // credential kind the prior run billed. A controller turn takes the same
  // rule; its per-turn digest carries the last stored turns.
  const nowIso = input.nowIso ?? new Date().toISOString();
  const stale =
    continuity === "present"
      ? (() => {
          const contextTokens =
            prev.last_prompt_tokens > 0
              ? prev.last_prompt_tokens
              : sessionContextTokens(backend, input.credentialUserId, prev.session_id, input.dataRoot);
          const verdict = resumeVerdict({
            backend,
            credentialKind: prev.credential_kind,
            finishedAt: prev.finished_at,
            nowIso,
            contextTokens,
          });
          return verdict.fresh
            ? { contextTokens: verdict.contextTokens, idleMs: verdict.idleMs, ttlMs: verdict.ttlMs }
            : null;
        })()
      : null;
  if (continuity === "missing" || continuity === "damaged" || stale) {
    const lossReason: ContinuityLossReason = stale
      ? "stale_large_session"
      : ownerChanged
        ? "owner_changed"
        : continuity === "damaged"
          ? "transcript_damaged"
          : "transcript_gone";
    logger.warn(
      stale
        ? "stale large session set aside — starting fresh on task.md and the last report"
        : "runtime continuity lost — re-anchoring on task.md",
      {
        runId: prev.id,
        taskKey: prev.task_key,
        backend,
        sessionId: prev.session_id,
        ...stale,
      },
    );
    recordSessionMissing(db, prev, lossReason, stale ?? undefined);
    await noteContinuityReset(db, prev, lossReason, input.dataRoot, stale ?? undefined);
    const preamble = continuityResetPreamble(
      backend,
      prev.kind,
      stale ? { facts: stale, lastReport: lastReportOf(db, prev.id) } : undefined,
    );
    const freshTurn: StartRunInput = {
      projectSlug: prev.project_slug,
      taskKey: prev.task_key,
      threadId: resumeThreadId,
      role: prev.role,
      kind: prev.kind,
      backend,
      credentialUserId: input.credentialUserId,
      model: input.model ?? prev.model,
      agentName: input.agentName ?? prev.agent_name,
      agentProfileId: input.agentProfileId ?? prev.agent_profile_id,
      prompt: `${preamble}\n\n${input.prompt}`,
      // The whole point: no resumeSessionId. A fresh provider session.
      resumeSessionId: null,
      // Ruling 372: the fresh row says WHY it is fresh, in its start audit.
      continuityReset: lossReason,
    };
    carryResumeOptions(freshTurn, input);
    const fresh = await startRun(db, freshTurn);
    return { runId: fresh.runId, continuityReset: true, continuityLossReason: lossReason };
  }

  const resumedTurn: StartRunInput = {
    projectSlug: prev.project_slug,
    taskKey: prev.task_key,
    threadId: resumeThreadId,
    role: prev.role,
    kind: prev.kind,
    backend,
    credentialUserId: input.credentialUserId,
    // Prefer the caller's model (the agent's current profile) over the stale
    // model on the prior run row — editing an agent to a new model must apply
    // when its session is resumed via a comment.
    model: input.model ?? prev.model,
    // Carry the prior run's agent identity so the resume groups under the same
    // Agent-logs entry (one entry per agent, across every resume). A caller can
    // override (e.g. a comment-resume that knows the current profile name).
    agentName: input.agentName ?? prev.agent_name,
    agentProfileId: input.agentProfileId ?? prev.agent_profile_id,
    prompt: input.prompt,
    resumeSessionId: prev.session_id,
  };
  carryResumeOptions(resumedTurn, input);
  return startRun(db, resumedTurn);
}

// ---------------------------------------------- concurrency gate

/**
 * Runs occupying a concurrency slot right now: LIVE adapters (`handles`) plus
 * runs RESERVED but not yet launched (`reserved`, still cloning/preparing —
 * F26-1). A reserved run has committed to running, so it counts against the cap
 * exactly like a live one; counting only `handles` let every reserving dispatch
 * (all specialist runs) slip past the cap during its multi-minute clone.
 */
function liveCount(state: ServiceState): number {
  return state.handles.size + state.reserved.size;
}

/** How many of the held slots are delivery runs (ruling 152(b)): the count the
 *  cap itself bounds. */
function deliveryLiveCount(state: ServiceState): number {
  let n = 0;
  for (const slot of state.handles.values()) if (slot.lane === "delivery") n += 1;
  for (const lane of state.reserved.values()) if (lane === "delivery") n += 1;
  return n;
}

/** How many of the held slots are coordination turns (ruling 152(b)): the count
 *  the lane bounds. Anything past `coordinationLane(cap)` is a borrowed cap
 *  slot, which the next parked build takes back ({@link canAdmit}). */
function coordinationLiveCount(state: ServiceState): number {
  return liveCount(state) - deliveryLiveCount(state);
}

/**
 * Admit a run for launch under the instance concurrency cap.
 *
 * The live count is `handles.size + reserved.size` (see {@link liveCount}) — the
 * ground truth of how many runs hold a slot right now, with no separate counter
 * to leak or drift. When the cap (getMaxConcurrentRuns) is 0 the gate is off and
 * every run launches immediately (the historical behavior, so an untouched
 * deployment is unchanged). Otherwise a run that would exceed its lane's bound
 * ({@link canAdmit}: at most `cap` delivery runs and `cap + lane` runs in all,
 * the lane for operator and controller turns, ruling 152(b)) is PARKED: its DB
 * row stays `queued` (that is the state startRun already inserts for a
 * non-reserved run) and its launch thunk waits in the lane's queue, promoted by
 * `drainRunQueue` when a live slot frees.
 */
/** True when the run launched now; false when it was parked behind the cap
 *  (ruling 263: the caller reports which, instead of saying "started" for
 *  both). */
function admitRun(
  db: DatabaseSync,
  runId: string,
  launchThunk: () => void,
  kind: RunKind,
  dataRoot?: string,
): boolean {
  const state = getState();
  const cap = getMaxConcurrentRuns(db);
  const lane = laneOf(kind);
  if (canAdmit(state, cap, lane)) {
    launchThunk();
    return true;
  }
  const queue = state.pending[lane];
  // Ruling 458(d): a parked run is launched later by whichever run frees the
  // slot, inside that run's correlation. It carries the correlation of the
  // request that started it instead, so its records name that request and user.
  queue.push({ runId, launch: carryCorrelation(launchThunk), dataRoot });
  logger.info("run queued behind the concurrency cap", {
    runId,
    lane,
    live: liveCount(state),
    cap,
    coordinationLane: coordinationLane(cap),
    queuedAhead: queue.length - 1,
  });
  return false;
}

/**
 * Promote queued runs while a live slot is free. Called from every run's onExit
 * (a finished run frees its slot) and after an interrupt. A pending run whose
 * row is no longer `queued` (interrupted / errored while waiting) is DROPPED —
 * it must never spring to life. The cap is re-read each pass so an admin lowering
 * it mid-drain is honored; `handles.size` grows as each promoted run launches,
 * so the loop is self-limiting.
 *
 * Ruling 152(b): the coordination queue is drained first; a delivery run is
 * promoted only when no coordination run can go and the cap itself has room.
 * So a freed slot goes to the operator turn that was parked behind the builds
 * before the next build — until coordination holds its whole lane, when the
 * freed slot is a borrowed cap slot and {@link canAdmit} hands it to the parked
 * build instead.
 */
export function drainRunQueue(db: DatabaseSync): void {
  const state = getState();
  // A synchronously-exiting promoted run re-enters this via its onExit; the
  // outer loop already accounts for the freed slot, so the nested call yields.
  if (state.draining) return;
  state.draining = true;
  try {
    for (;;) {
      const cap = getMaxConcurrentRuns(db);
      const next = nextPromotable(state, cap);
      if (!next) return;
      const row = getRun(db, next.runId);
      if (!row || row.state !== "queued") {
        // Stopped while waiting: it never starts, so its gateway token dies.
        revokeRunMcpGateway(next.runId);
        continue;
      }
      next.launch();
      // Ruling 311, the other half: the timeline said "Queued … Nothing is
      // streaming yet", and this is the one place that stops being true.
      void noteRunStarted(db, row, next.dataRoot);
    }
  } finally {
    state.draining = false;
  }
}

/** The oldest parked run whose lane has room right now, coordination first;
 *  null when neither lane can admit (or nothing waits). Shifts it off its queue. */
function nextPromotable(state: ServiceState, cap: number): PendingRun | null {
  const lanes: readonly RunLane[] = ["coordination", "delivery"];
  for (const lane of lanes) {
    const queue = state.pending[lane];
    if (queue.length === 0) continue;
    if (!canAdmit(state, cap, lane)) continue;
    return queue.shift() ?? null;
  }
  return null;
}

/** A point-in-time view of the run concurrency gate. */
export interface RunConcurrencySnapshot {
  /** Configured cap (0 = unlimited). */
  cap: number;
  /** Ruling 152(b): the extra slots operator and controller turns may take
   *  beyond the cap (one per four of it, minimum one; 0 when the cap is 0). */
  lane: number;
  /** Runs holding a slot right now — live adapters plus reserved-but-not-yet-
   *  launched runs (still preparing their workspace). This is what the cap gates
   *  against, so it is what the admin card must show. */
  live: number;
  /** Runs parked behind the cap right now, both lanes together. */
  queued: number;
}

/** How many runs are executing vs waiting on a slot right now — for the admin
 *  concurrency card and diagnostics. */
export function runConcurrencySnapshot(db: DatabaseSync): RunConcurrencySnapshot {
  const state = getState();
  const cap = getMaxConcurrentRuns(db);
  return {
    cap,
    lane: coordinationLane(cap),
    live: liveCount(state),
    queued: state.pending.coordination.length + state.pending.delivery.length,
  };
}

/** Wires the sink + adapter callbacks and starts the adapter process/timer. */
function launch(
  db: DatabaseSync,
  spec: RunSpec,
  adapter: RuntimeAdapter,
  /** Ruling 127: the plaintext credentials THIS run's child env carries. The
   *  sink redacts them from every persisted line — they belong to one person
   *  and the run console is visible to every project member. */
  secrets: readonly string[],
  opts: {
    /** The RESERVED run's original instant (R21-4) — absent for a run that was
     *  not reserved, which then starts its clock here. */
    startedAt?: string;
    /** F21-13: a disclosure line to open the run log with. */
    notice?: string;
    /** The data root the run's task lives under: where the finalize reads a
     *  Codex run's rollout (ruling 369(c)). Absent means the instance's own
     *  root. */
    dataRoot?: string;
  } = {},
): void {
  const state = getState();
  const sink = createRunSink(db, spec, { secrets });

  // Set when onExit fires DURING adapter.start() (synchronous exit / spawn
  // crash) so we skip tracking a handle for an already-terminal run.
  let exited = false;

  // Mark running immediately (queued → running). A run that was RESERVED before
  // its workspace was prepared (R21-4) keeps the instant it was reserved, so the
  // strip's Elapsed covers the clone the human already sat through.
  sink.markRunning(opts.startedAt);

  // F21-13: the substitution disclosure is the FIRST line of the run log, so a
  // human reading the console sees it before the agent's own output — the run
  // header's model is the substituted one, and this says why.
  if (opts.notice) {
    const now = new Date().toISOString();
    sink.line({
      raw: JSON.stringify({
        type: "notice",
        source: "viberr",
        reason: "model_substituted",
        message: opts.notice,
      }),
      display: {
        t: now.slice(11, 19),
        ev: "meta",
        tag: MODEL_SUBSTITUTED_TAG,
        text: opts.notice,
      },
      facts: {},
      occurredAt: now,
    });
  }

  // R21-4: phase writes are throttled — a chatty run emits one per stream
  // message, and the strip only ever renders the latest. A CHANGED phase is
  // always written immediately (the transitions are the informative part);
  // step-only churn within the same phase is rate-limited to one write/second.
  let lastPhase: string | null = null;
  let lastPhaseWriteMs = 0;
  const PHASE_MIN_INTERVAL_MS = 1_000;
  // Ruling 348: a step the window suppresses is written when the window closes,
  // not dropped. The update that matters most arrives inside the window — a
  // tool that answers within a second of being invoked — and a Codex run then
  // emits nothing until its reasoning item completes, so a dropped write would
  // leave the finished call on the strip for the whole silent stretch.
  let deferred: { phase: string | null; step: string | null } | null = null;
  let deferredTimer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  const writePhase = (phase: string | null, step: string | null) => {
    lastPhase = phase;
    lastPhaseWriteMs = Date.now();
    sink.phase(phase, step);
  };
  const flushDeferred = () => {
    deferredTimer = null;
    const pending = deferred;
    deferred = null;
    if (!pending || settled) return;
    try {
      writePhase(pending.phase, pending.step);
    } catch (error) {
      logger.error("run phase persist failed", {
        runId: spec.runId,
        err: toError(error),
      });
    }
  };

  // Every adapter callback fires asynchronously (timers, SDK streams), so all
  // persistence inside them must be caught-and-logged — a throw here has no
  // request context and would surface as an unhandled exception on a timer
  // (crashing the process in prod, failing the suite when a test's DB closes
  // before an in-flight run settles). sink.line self-catches; guard the
  // phase/finalize paths the same way.
  const callbacks: RunCallbacks = {
    onLine: (line) => sink.line(line),
    onPhase: (phase, step) => {
      try {
        const now = Date.now();
        if (phase === lastPhase && now - lastPhaseWriteMs < PHASE_MIN_INTERVAL_MS) {
          deferred = { phase, step };
          if (!deferredTimer) {
            deferredTimer = setTimeout(
              flushDeferred,
              PHASE_MIN_INTERVAL_MS - (now - lastPhaseWriteMs),
            );
            deferredTimer.unref?.();
          }
          return;
        }
        deferred = null;
        writePhase(phase, step);
      } catch (error) {
        logger.error("run phase persist failed", {
          runId: spec.runId,
          err: toError(error),
        });
      }
    },
    onExit: (exit) => {
      // A step deferred by the throttle never lands on a settled row.
      settled = true;
      if (deferredTimer) clearTimeout(deferredTimer);
      deferredTimer = null;
      deferred = null;
      // The handle is tracked only for a run still in flight, so the flag is
      // set here, synchronously, exactly as before ruling 376 made the rest
      // of the exit asynchronous.
      exited = true;
      // Ruling 376: the exit may compact the session first, a provider round
      // trip; everything after the exit — the finalize, the slot, the
      // completion contract — waits for it, so no resume of the same session
      // starts under a compaction still in flight.
      void settleRun(exit);
    },
  };
  // Ruling 458(d): the run's own work (its adapter stream, the sink, the settle
  // and the completion callbacks) logs under its runId and taskKey, plus the
  // request and user behind it. It gets its OWN copy of the correlation: every
  // continuation of a request shares one object, and a run's completion can
  // start the next run in the same lineage (operator → specialist → reviewer),
  // so binding in place would re-stamp the earlier run's later records with
  // the newest id. A run started from another run's completion logs under that
  // run's ids until its own launch binds its own. Outside a request (boot
  // recovery, a watcher- or timer-started run) nothing is bound; those records
  // carry their own ids.
  let handle: RunHandle;
  try {
    handle = forkCorrelation(() => {
      bindCorrelation({ runId: spec.runId, taskKey: spec.taskKey });
      return adapter.start(spec, callbacks);
    });
  } catch (error) {
    // Ruling 461: an adapter that throws before it runs anything leaves no
    // process to settle, so the run's gateway token is revoked here.
    revokeRunMcpGateway(spec.runId);
    throw error;
  }
  // Only track the handle if the run is still in flight. A synchronously-exiting
  // adapter (or a spawn-time crash) fires onExit DURING adapter.start(), which
  // deletes the not-yet-set handle; setting it here afterward would leave a
  // stale handle for an already-finished run — making `fireIfAlreadyTerminal`
  // (and interrupt) think a dead run is live. Guard on the exit flag.
  if (!exited) state.handles.set(spec.runId, { handle, lane: laneOf(spec.kind) });

  async function settleRun(exit: RunExit): Promise<void> {
      // Ruling 461: the process that held the run's gateway token has exited,
      // so the token calls nothing from now on. It is revoked once the
      // completion compaction below is done (or at once when there is none):
      // that request replays the session with the run's own MCP servers, and
      // a server it cannot list is a different prefix that misses the cache
      // ruling 376 compacts to read (R-gateway-4, 2026-09-25).
      closeRunMcpGatewayCalls(spec.runId);
      try {
        // Ruling 369: a Codex run's per-call prompt sizes and compactions are
        // in the rollout the CLI wrote, never in its SDK stream; read once the
        // CLI has exited, off the principal's own home.
        // A shutdown drain (F21-24): nothing below can be read or written; the
        // finalize alone says so, once.
        const drained = runPersistDrained(db);
        const row = drained ? null : getRun(db, spec.runId);
        const rolloutStats = () =>
          !drained && exit.effectiveBackend === "codex" && exit.sessionId
            ? codexRolloutRunStats(
                row?.credential_user_id ?? null,
                exit.sessionId,
                row?.started_at ?? null,
                opts.dataRoot,
              )
            : null;
        let stats = rolloutStats();
        if (stats && stats.calls > 0) sink.foldRolloutStats(stats);
        // Ruling 376: a session larger than the completion threshold is
        // compacted now, while its prefix is still in the provider's cache.
        // Never after an interrupt (the person asked for the spending to
        // stop), never without a session, never on a backend that cannot,
        // and never as a failure of the run.
        const replaySize = drained
          ? 0
          : exit.effectiveBackend === "codex"
            ? (stats?.lastPromptTokens ?? 0)
            : (getRun(db, spec.runId)?.last_prompt_tokens ?? 0);
        if (
          adapter.compact &&
          exit.sessionId &&
          exit.outcome !== "interrupted" &&
          replaySize > COMPACT_AT_COMPLETION_TOKENS
        ) {
          // U39-30: the answer is written; only the housekeeping is left.
          // Live on ax-clone a controller turn's compaction held its reply off
          // the page for 27 seconds, and ruling 371 measured one at 131.
          const answered = getState().answered.get(spec.runId);
          getState().answered.delete(spec.runId);
          if (answered && exit.outcome === "finished") {
            try {
              answered(spec.runId);
            } catch (error) {
              logger.error("run answered callback failed", {
                runId: spec.runId,
                err: toError(error),
              });
            }
          }
          const compactionsBefore = stats?.compactionEvents.length ?? 0;
          let outcome: CompactOutcome;
          try {
            outcome = await adapter.compact(spec, exit.sessionId, {
              onLine: (line) => sink.line(line),
              onPhase: (phase, step) => writePhase(phase, step),
            });
          } finally {
            revokeRunMcpGateway(spec.runId);
          }
          logger.info("run compaction at completion", {
            runId: spec.runId,
            backend: exit.effectiveBackend,
            replaySize,
            ...outcome,
          });
          // The epilogue's process carries its own marker (the settle sweep
          // must not reap it mid-compaction); it is reaped here, once done.
          void reapRunProcesses({ runIds: [compactionRunId(spec.runId)] }).catch((error) => {
            logger.warn("compaction epilogue reap failed", {
              runId: spec.runId,
              err: toError(error),
            });
          });
          if (exit.effectiveBackend === "codex") {
            // The rollout is the truth on Codex, whatever the app-server said:
            // its reply carries no sizes, and a compaction it did not announce
            // in time (live, 2026-09-21) is still on disk. The rollout's
            // newest compaction, when there is a new one, is this one.
            stats = rolloutStats();
            const event = stats?.compactionEvents.at(-1) ?? null;
            if (stats && stats.compactionEvents.length > compactionsBefore && event) {
              const occurredAt = new Date().toISOString();
              // Ruling 414: the CLI writes this compaction's own size line
              // between its two spellings, so the rollout has measured it.
              // Ruling 403: when it has not (a marker with nothing after it),
              // the figure is unknown rather than zero. Say so.
              const post =
                event.postTokens === null
                  ? "a summary"
                  : `${wholeThousands(event.postTokens)} tokens`;
              sink.line({
                raw: JSON.stringify({ type: "compacted", source: "viberr", trigger: "completion", ...event }),
                display: {
                  t: occurredAt.slice(11, 19),
                  ev: "meta",
                  tag: "run·compacted·completion",
                  text: `context compacted at the end of the run · ${wholeThousands(event.preTokens)} → ${post}`,
                },
                facts: { compaction: { trigger: "completion", ...event } },
                occurredAt,
              });
              sink.foldRolloutStats(stats);
            }
          }
        }
        revokeRunMcpGateway(spec.runId);
        sink.finalize(exit);
      } catch (error) {
        revokeRunMcpGateway(spec.runId);
        logger.error("run finalize persist failed", {
          runId: spec.runId,
          err: toError(error),
        });
      }
      state.handles.delete(spec.runId);
      // U39-30: an answered callback the settle never needed goes with it.
      state.answered.delete(spec.runId);
      // Ruling 180: the settled run's skill plugin goes with it — the CLI
      // that read it has exited, and nothing else names the path.
      removeSkillPlugin(spec.skillPlugin);
      // This run's slot is now free — promote the oldest queued run behind the
      // concurrency cap. Before the completion callback, so a chain of queued
      // runs keeps flowing even if the callback throws.
      try {
        drainRunQueue(db);
      } catch (error) {
        logger.error("run queue drain failed", {
          runId: spec.runId,
          err: toError(error),
        });
      }
      // Fire a one-shot completion callback (opaque to run-service — the
      // reply-comment wiring lives in task-actions). Reads the finalized row
      // so the callback sees the terminal state + folded session/usage facts.
      const cb = state.completions.get(spec.runId);
      if (cb) {
        state.completions.delete(spec.runId);
        let finished: AgentRunRow | null = null;
        try {
          finished = getRun(db, spec.runId);
          if (finished) cb(finished);
        } catch (error) {
          logger.error("run completion callback failed", {
            runId: spec.runId,
            err: toError(error),
          });
          // C4: the completion effects are lost — stamp the task so it isn't
          // stuck on "agent working" with no live run until the next restart.
          if (finished) void noteCompletionEffectsLost(db, finished);
        }
      }
  }
}

// ---------------------------------------------- interrupt

export interface InterruptResult {
  /** interrupted | already-terminal (idempotent no-op). */
  outcome: "interrupted" | "already-terminal";
  run: RunView | null;
}

/**
 * The interrupt itself — the live-handle arm and the no-handle arm — shared by
 * the human interrupt (`interruptRun`) and the closure interrupt
 * (`interruptRunOnClosure`, ruling 177). `actorUserId` is stamped into
 * `interrupted_by`; `auditActor`/`auditDetails` shape the audit row.
 */
function stopRunProcess(
  db: DatabaseSync,
  run: AgentRunRow,
  input: { projectSlug: string; taskKey: string; runId: string },
  actorUserId: string,
  auditActor: { userId: string; label: string } | typeof SYSTEM_ACTOR,
  auditDetails: {
    reason?: "task-closed" | "conversation-deleted";
    cause?: "accept" | "force-accept" | "archive";
    closedBy?: string;
    deletedBy?: string;
  } = {},
): void {
  const state = getState();
  const slot = state.handles.get(input.runId);
  // Ruling 461: an interrupted run's gateway token stops working at once,
  // whether a process is still winding down (the settle revokes it again) or
  // there is none to settle (a queued or reserved run, or one a restart left).
  revokeRunMcpGateway(input.runId);
  if (slot) {
    slot.handle.interrupt();
    state.handles.delete(input.runId);
    // The adapter's onExit → sink.finalize sets the interrupted state; stamp
    // the interrupter here so it lands regardless of the adapter's timing.
    patchRun(db, input.runId, { interruptedBy: actorUserId });
  } else {
    // No live process (e.g. after a restart, or a seeded run) — write the
    // terminal state directly.
    patchRun(db, input.runId, {
      state: "interrupted",
      finishedAt: new Date().toISOString(),
      interruptedBy: actorUserId,
      phase: null,
      step: null,
    });
    publishRunStateChanged({
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      runId: input.runId,
      threadId: run.thread_id,
      state: "interrupted",
      controller: controllerRunRoute(db, run),
    });
    // The run reached its terminal state with no adapter to report it, so the
    // completion callback the starter registered would never fire: `launch`'s
    // onExit is its only other trigger, and there is no process to exit. A
    // reserved specialist run's completion effects, and a queued controller
    // turn's settle (which releases the conversation's lease and records that
    // the turn was stopped), were both lost that way — the page then read
    // "working" until a restart replayed recovery. Same precondition as the
    // spawn-crash race: terminal state, no live handle, so fire it now.
    fireIfAlreadyTerminal(db, input.runId);
    // F28-R1: a run interrupted while still RESERVED (its workspace clone is in
    // flight, so no live handle exists yet) must release its committed
    // concurrency slot NOW. Otherwise the slot stays counted against the cap —
    // starving every other dispatch — until the ABANDONED clone finishes on its
    // own, up to CLONE_TIMEOUT (~15 min). The reserve→clone path still aborts
    // cleanly at its post-clone `assertRunReservationLive` check, and the later
    // `reservation.abandon()` finds the row already `interrupted` (its
    // precedence guard won't demote it) and the slot already freed (the delete
    // is idempotent) — so no double-release and no launch-after-interrupt.
    if (state.reserved.delete(input.runId)) {
      drainRunQueue(db);
    }
  }

  recordAudit(db, {
    action: "runtime.run.interrupted",
    actor: auditActor,
    subjectKind: "run",
    subjectId: input.runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { threadId: run.thread_id, backend: run.backend, role: run.role, ...auditDetails },
  });
}

/**
 * Interrupt a run. RBAC: admin|maintainer (contracts §3.2 — opening /
 * interrupting runtime sessions). Writes `interrupted` state + an audit
 * event. Idempotent-safe: interrupting a non-running run returns a friendly
 * `already-terminal`, never an error.
 */
export async function interruptRun(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; runId: string; dataRoot?: string },
  actor: { userId: string; label: string },
): Promise<InterruptResult> {
  const run = getRun(db, input.runId);
  if (!run || run.project_slug !== input.projectSlug || run.task_key !== input.taskKey) {
    throw AppError.notFound(`Run ${input.runId} not found on ${input.taskKey}.`);
  }

  if (run.kind === "controller") {
    // Ruling 99: a controller turn has no project to be a member of. It is
    // stoppable by the two people who may read it — the conversation's owner,
    // whose turn and whose Claude account it is, and a live org admin — and
    // the refusal is 404-shaped like every other non-owner answer about a
    // conversation, so "not yours" and "never existed" stay indistinguishable.
    if (!canInterruptControllerRun(db, run, { id: actor.userId })) {
      throw AppError.notFound(`Run ${input.runId} not found on ${input.taskKey}.`);
    }
  } else {
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
  }

  if (run.state !== "running" && run.state !== "queued") {
    // Idempotent no-op — the run already reached a terminal state.
    return { outcome: "already-terminal", run: projectOne(db, run) };
  }
  // Review F6 (pass 32): the live-handle arm below stamps `interrupted_by` at
  // once but leaves `state = running` until the adapter's onExit lands. A
  // second click in that window (the button re-enables as soon as the action
  // returns) must not write a second audit row and a second timeline note.
  if (run.interrupted_by) {
    return { outcome: "already-terminal", run: projectOne(db, run) };
  }

  stopRunProcess(db, run, input, actor.userId, actor);
  logger.info("run interrupted", { runId: input.runId, by: actor.userId });

  // The response is complete BEFORE the best-effort note: every DB read for the
  // result happens here, so a caller that does not await (test cleanup after
  // its DB closed) can never surface "database is not open" as an unhandled
  // rejection from the tail — `noteInterrupt` catches its own failures.
  const after = getRun(db, input.runId);
  const result: InterruptResult = {
    outcome: "interrupted",
    run: after ? projectOne(db, after) : null,
  };
  await noteInterrupt(db, run, actor, input.dataRoot);
  return result;
}

/**
 * Ruling 177 (pass 36, F36-5): a task that closes — accepted, force-accepted or
 * archived — ends its live runs. No RBAC: the person's authority was spent on
 * the closure itself (acceptance is owner-or-maintainer, archive is
 * maintainer+), and the interrupt is that act's consequence, audited under the
 * SYSTEM actor with the cause and the person who closed the task in the
 * details. The caller writes the one timeline note naming every run; this
 * function writes none. Idempotent like `interruptRun`.
 */
export function interruptRunOnClosure(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; runId: string },
  closure: { cause: "accept" | "force-accept" | "archive"; byUserId: string },
): "interrupted" | "already-terminal" | "not-found" {
  const run = getRun(db, input.runId);
  if (!run || run.project_slug !== input.projectSlug || run.task_key !== input.taskKey) {
    return "not-found";
  }
  if (run.kind === "controller") return "not-found";
  if (run.state !== "running" && run.state !== "queued") return "already-terminal";
  if (run.interrupted_by) return "already-terminal";
  stopRunProcess(db, run, input, closure.byUserId, SYSTEM_ACTOR, {
    reason: "task-closed",
    cause: closure.cause,
    closedBy: closure.byUserId,
  });
  logger.info("run interrupted — the task closed", {
    runId: input.runId,
    cause: closure.cause,
    by: closure.byUserId,
  });
  return "interrupted";
}

/**
 * Ruling 525: a controller conversation that is deleted ends its live turns
 * first, so nothing answers into it and nothing it was about to apply is
 * applied. No authority check here: the person's was spent on the deletion
 * (`deleteControllerConversation`), and the stop is that act's consequence,
 * audited under the SYSTEM actor with the person who deleted it in the
 * details, the shape a closing task's stop has (ruling 177). Idempotent like
 * `interruptRun`: a turn someone already stopped is left to finish stopping.
 */
export function interruptRunOnConversationDeletion(
  db: DatabaseSync,
  runId: string,
  deletedBy: string,
): "interrupted" | "already-terminal" | "not-found" {
  const run = getRun(db, runId);
  if (!run || run.kind !== "controller") return "not-found";
  if (run.state !== "running" && run.state !== "queued") return "already-terminal";
  if (run.interrupted_by) return "already-terminal";
  stopRunProcess(
    db,
    run,
    { projectSlug: run.project_slug, taskKey: run.task_key, runId },
    deletedBy,
    SYSTEM_ACTOR,
    { reason: "conversation-deleted", deletedBy },
  );
  logger.info("run interrupted — its conversation was deleted", { runId, by: deletedBy });
  return "interrupted";
}

/**
 * D32-18 (pass 32): a human interrupt wrote the audit row and the run row, and
 * NOTHING on the task's timeline — the record showed the transition, then
 * silence, and the next reader could not tell the run was stopped by a person.
 * A note authored by that person, naming the run, is the canonical trace.
 * Best-effort like the continuity note: a task file we cannot write never
 * masks the interrupt itself. Controller runs have no task file (ruling 99).
 */
async function noteInterrupt(
  db: DatabaseSync,
  run: AgentRunRow,
  actor: { userId: string; label: string },
  dataRoot?: string,
): Promise<void> {
  if (run.kind === "controller") return;
  const ref: TaskFileRef = { projectSlug: run.project_slug, taskKey: run.task_key };
  if (dataRoot) ref.dataRoot = dataRoot;
  const backend = BACKEND_LABEL[run.backend];
  try {
    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "human", userId: actor.userId, nameHint: actor.label },
        title: null,
        // Ruling 207(g): "the thread stays resumable" is true only when a
        // provider session was ever reported. `reserveRun` writes a `running`
        // row minutes before any provider process exists, and that row is what
        // the Live-run strip's Stop button acts on — the deliberate
        // minutes-long window a person actually presses Stop in. A run with no
        // `session_id` is skipped by `latestSessionRun` (agent-reply.server.ts),
        // so "re-run the agent to continue" hands back a fresh agent with no
        // memory of the turn it stopped, silently re-spending the budget.
        text: run.session_id
          ? `Interrupted the ${backend} run \`${run.id}\` (${run.agent_name ?? run.role}). The thread stays resumable; re-run the agent to continue.`
          : `Interrupted the ${backend} run \`${run.id}\` (${run.agent_name ?? run.role}) before ${backend} reported a session, so there is no thread to resume. Re-running the agent starts a fresh one, re-anchored on \`task.md\`.`,
        toAgent: false,
        evidence: null,
      });
    });
    rebuildPath(db, resolveTaskFilePath(ref), dataRoot ? { dataRoot } : {});
  } catch (error) {
    logger.error("interrupt timeline note failed", {
      runId: run.id,
      taskKey: run.task_key,
      err: toError(error),
    });
  }
}

/**
 * Ruling 311, the other half. `runDispatchLine` now records a run parked
 * behind the concurrent-run cap as "Queued … starts when a slot frees. Nothing
 * is streaming yet" — and a parked run is promoted in exactly one place,
 * `drainRunQueue`, whose `launch()` patches the run row and publishes SSE and
 * writes nothing on the task. So the durable record every person, operator and
 * later run reads said "Nothing is streaming yet" for the run's whole life
 * after admission: the mirror image of the sentence 311 fixed, and the same
 * shape (a transition the row knew, absent from the timeline). One note at the
 * transition, naming the run. Only the promotion path writes it — a run
 * admitted at once was never "queued" on the timeline, and its dispatch line
 * already said "Started". Best-effort like `noteInterrupt`: a task file we
 * cannot write never blocks the launch. Controller turns have no task file
 * (ruling 99).
 */
async function noteRunStarted(
  db: DatabaseSync,
  run: AgentRunRow,
  dataRoot?: string,
): Promise<void> {
  if (run.kind === "controller") return;
  const ref: TaskFileRef = { projectSlug: run.project_slug, taskKey: run.task_key };
  if (dataRoot) ref.dataRoot = dataRoot;
  const backend = BACKEND_LABEL[run.backend];
  try {
    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "system", systemId: "run-queue" },
        title: "Run started",
        text: `The queued ${backend} run \`${run.id}\` for the ${run.agent_name ?? run.role} agent got a slot and started — streaming to the agent logs.`,
        toAgent: false,
        evidence: null,
      });
    });
    rebuildPath(db, resolveTaskFilePath(ref), dataRoot ? { dataRoot } : {});
  } catch (error) {
    logger.error("run-started timeline note failed", {
      runId: run.id,
      taskKey: run.task_key,
      err: toError(error),
    });
  }
}

// ---------------------------------------------- reads

/** All runs for a task as RunView[] + their D-11 log windows (task loader).
 *  `console` says how much of each window to carry (ruling 457). */
export function listRunsForTask(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
  options: { console?: ConsoleShipping } = {},
): ProjectedRunView[] {
  return projectRunsForTask(db, projectSlug, taskKey, options);
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
  /** Ruling 457 (LIVE-1): the run row's moving facts as of this read, so the
   *  Live run strip follows the console's tail instead of a revalidation. */
  facts: RunLiveFacts;
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
  /** C02-R12 (pass 32): a bound for the FORWARD read, pushed into the SELECT.
   *  The console's live tail never needs one (it is bounded by its own
   *  cursor), but `viberr_ops.read_run_log` pages forward for a model and
   *  used to materialize every line after `since` before slicing. Ignored in
   *  backward mode (`limit` is that page's size). */
  forwardLimit?: number;
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
  query: RunLogQuery = {},
): RunLog | null {
  const run = getRun(db, runId);
  return run ? runLogPage(db, run, query) : null;
}

/**
 * `getRunLog` for a caller that already read the run row — the run-log route
 * reads it for its membership gate, and the live tail calls that route once
 * per streamed line per viewer (ruling 457, LIVE-9).
 */
export function runLogPage(db: DatabaseSync, run: AgentRunRow, query: RunLogQuery): RunLog {
  const runId = run.id;
  const backward = query.before !== undefined || query.limit !== undefined;
  const lines: RunLog["lines"] = backward
    ? listRunLinesTail(db, runId, query.limit ?? RUN_LOG_PAGE_LINES, query.before).map(
        ({ seq, occurredAt, raw, display }) => ({ seq, occurredAt, raw, display }),
      )
    : listRunLines(db, runId, query.since ?? -1, query.forwardLimit);
  const sinceSeq = query.since ?? -1;
  const head = lines.length ? lines[lines.length - 1]!.seq : sinceSeq;
  const oldestSeq = lines.length ? lines[0]!.seq : -1;
  return {
    runId,
    threadId: run.thread_id,
    state: run.state,
    lines,
    headSeq: head,
    oldestSeq,
    // Older lines exist below this page. An EMPTY backward page means we
    // reached the start of this run (the console then steps to the previous
    // run id in the group's `logWindow.runIds`). One index probe, not a count
    // of the run's lines (ruling 457).
    hasMore: lines.length > 0 && hasRunLinesBefore(db, runId, oldestSeq),
    facts: runLiveFacts(run),
  };
}

/**
 * The grouped view this run belongs to.
 *
 * P14-RT-11: matching `r.id === run.thread_id` was wrong for every run that is
 * not its group's REPRESENTATIVE — a group's id is the representative's thread
 * id (run-projection), so interrupting an older resume while a newer row existed
 * fell through to `[0]!`, returning an unrelated agent's view (and throwing
 * outright when the projection was empty). `logWindow.runIds` lists every row in
 * the group, which is the membership test this always wanted. Null when the run
 * has no projected group — `InterruptResult.run` is nullable and the interrupt
 * itself has already been performed and audited.
 */
function projectOne(db: DatabaseSync, run: AgentRunRow): RunView | null {
  const groups = projectRunsForTask(db, run.project_slug, run.task_key);
  return groups.find((r) => r.logWindow.runIds.includes(run.id)) ?? null;
}
