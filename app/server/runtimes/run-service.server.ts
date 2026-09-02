import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  LogLine,
  RunKind,
  RunState,
  RunView,
} from "~/features/runtime/runtime-types";
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
import { getMaxConcurrentRuns } from "~/server/settings/instance-settings.server";
import {
  RUN_PHASE,
  type RunHandle,
  type RunMcpServers,
  type RunSpec,
  type RuntimeAdapter,
} from "./adapter.server";
import {
  defaultModelFor,
  foreignModelBackend,
  modelDisplayName,
  resolveRunEffort,
} from "./model-catalog.server";
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
  type InsertRunInput,
} from "./run-store.server";
import { probeSessionContinuity } from "./session-export.server";
import {
  resolveTaskFilePath,
  updateTaskFile,
  type TaskFileRef,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  claudeCliAuthDiagnostics,
  codexAuthMisconfiguration,
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
  /**
   * F26-1: run ids RESERVED (a `running`/`queued`-row committed to a live slot by
   * `reserveRun`) whose adapter has NOT launched yet — the workspace is still
   * cloning/preparing. A reserved run OCCUPIES a concurrency slot from the moment
   * it is granted until it either launches (moves into `handles`) or is abandoned,
   * so the cap must count it. Without this, every specialist dispatch (which always
   * reserves) bypassed the cap entirely: `handles.size` alone saw nothing during
   * the multi-minute clone window, so N delivering/reviewer runs all launched at
   * once regardless of the configured cap.
   */
  reserved: Set<string>;
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
   * FIFO of runs admitted past the concurrency cap: their DB row is `queued`
   * and their adapter has NOT been launched. The drain (run onExit) promotes
   * the oldest whose row is still `queued` when a live slot frees. In-process
   * only — a restart's orphan recovery finalizes any surviving `queued` row.
   */
  pending: PendingRun[];
  /** Reentrancy guard for `drainRunQueue` — a synchronously-exiting promoted run
   *  fires onExit (→ drain) during its own launch; the outer drain loop handles
   *  the freed slot, so the nested call returns immediately. */
  draining?: boolean;
}

/** A run waiting for a concurrency slot: launch it by calling `launch`. */
interface PendingRun {
  runId: string;
  launch: () => void;
}

/** Invoked once when a registered run reaches a terminal state. */
export type RunCompletionCallback = (finished: AgentRunRow) => void;

const SERVICE_KEY = Symbol.for("viberr.runService");

function getState(): ServiceState {
  const cache: Record<symbol, ServiceState | undefined> = globalThis;
  let state = cache[SERVICE_KEY];
  if (!state) {
    state = {
      handles: new Map(),
      reserved: new Set(),
      adapters: createAdapters(),
      completions: new Map(),
      pending: [],
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
      err: error instanceof Error ? error : new Error(String(error)),
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

/** Test-only: reset live handles and install explicitly supplied adapters. */
export function configureRunServiceForTests(adapters: AdapterSet): void {
  resetRegistryForTests();
  setBackendAvailability("claude", true);
  setBackendAvailability("codex", true);
  const cache: Record<symbol, ServiceState | undefined> = globalThis;
  cache[SERVICE_KEY] = {
    handles: new Map(),
    reserved: new Set(),
    adapters,
    completions: new Map(),
    pending: [],
  };
}

// ---------------------------------------------- start / resume

const SDK_LABEL = {
  claude: "Claude Agent SDK",
  codex: "Codex SDK",
} satisfies Record<RealBackend, string>;

/** The product's name for each backend, as every other human-facing string
 *  spells it ("Claude" / "Codex"). */
const BACKEND_LABEL = {
  claude: "Claude",
  codex: "Codex",
} satisfies Record<RealBackend, string>;

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
  /** See RunSpec.attachmentsWritableDir — set by specialist-run when the
   *  profile holds `attach-evidence-references`. */
  attachmentsWritableDir?: string | null;
  /** Override the data root (tests). */
  dataRoot?: string;
  /** Who caused the run (audit). Defaults to the operator system actor. */
  actor?: AuditActor;
  /** Custom instructions: Claude systemPrompt / Codex developer_instructions. */
  systemPrompt?: string;
  /** Portable HTTP/stdio MCPs, or Claude-only in-process SDK governance tools. */
  mcpServers?: RunMcpServers;
  /** Tool allowlist confining the run (operator → its governance tools only). */
  allowedTools?: string[];
  /** Tool denylist confining a specialist run to its granted capabilities.
   *  Claude only (Codex has no denylist channel — see codex-runtime). */
  disallowedTools?: string[];
  /** Granted skills mounted into the run workspace (`mountGrantedSkills`).
   *  Claude only — the SDK's native skills filter. See RunSpec.skills. */
  skills?: string[];
  /** The run's `execute-code-or-write-repo` grant is withheld — enforced on
   *  BOTH backends (parity ruling 2026-08-31): Claude via the denylist, Codex
   *  via the read-only sandbox (resolveCodexSandboxMode). Omit to let
   *  `startRun` derive it from `disallowedTools` (see
   *  `repoWriteWithheldFromDenylist`). */
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
  const cap = getMaxConcurrentRuns(db);
  if (cap !== 0 && liveCount(state) >= cap) {
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
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return null;
  }
  // The reserved row now holds a concurrency slot until `startRun` adopts it (→
  // handles) or `abandon()` releases it.
  state.reserved.add(runId);
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
          err: error instanceof Error ? error : new Error(String(error)),
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
          err: error instanceof Error ? error : new Error(String(error)),
        });
      } finally {
        // A freed slot may let a run parked behind the cap start now.
        drainRunQueue(db);
      }
    },
  };
}

/** Runs started by the operator runtime itself (scheduling reactions). */
const OPERATOR_ACTOR: AuditActor = { userId: null, label: "operator" };

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
 * already shows as withheld, with no second source of truth to drift. It
 * drives the Codex read-only sandbox again since ruling 101 (R22 had removed
 * that sandbox; the parity ruling restored it for withheld runs, with the
 * evidence carve-out disclosed as advisory). Callers that know the grant
 * directly may still pass `repoWriteWithheld` explicitly.
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
export function withMcpAutoApproval(
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
  /** R7-2 fail-fast marker: the run never spawned a backend process. */
  failedUnavailable?: true;
};

/**
 * What a `node:sqlite` write throws: an Error carrying the raw SQLite result
 * code on an `errcode` property its declared type does not mention. Decoding it
 * (rather than asserting a hand-written type onto the thrown value) keeps the
 * unique-violation branch off anything the driver did not actually report —
 * anything that fails this parse is rethrown untouched.
 */
const sqliteErrorSchema = z.object({ errcode: z.number(), message: z.string() });

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
 * Returns the run id.
 */
export async function startRun(
  db: DatabaseSync,
  input: StartRunInput,
): Promise<{ runId: string }> {
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
  const foreignBackend = foreignModelBackend(input.backend, input.model);
  const model = foreignBackend ? defaultModelFor(input.backend) : input.model;
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

  const selection = selectAdapter(input.backend, state.adapters);
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

  const details: RunStartedAudit = {
    threadId,
    backend: input.backend,
    role: input.role,
    kind: input.kind,
    resumed: Boolean(input.resumeSessionId),
  };
  if (selection.kind === "unavailable") details.failedUnavailable = true;

  // Governed action: opening a runtime session is audited (BUILD-PLAN
  // Phase 10 / contracts — run start + interrupt both leave audit rows).
  recordAudit(db, {
    action: "runtime.run.started",
    actor: input.actor ?? OPERATOR_ACTOR,
    subjectKind: "run",
    subjectId: runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details,
  });

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
  if (input.attachmentsWritableDir) {
    spec.attachmentsWritableDir = input.attachmentsWritableDir;
  }
  if (input.mcpServers) spec.mcpServers = input.mcpServers;
  if (allowedTools) spec.allowedTools = allowedTools;
  if (input.disallowedTools && input.disallowedTools.length) {
    spec.disallowedTools = input.disallowedTools;
  }
  if (input.skills && input.skills.length) spec.skills = input.skills;
  // Records the withheld repo-write grant on the spec: Claude's denylist binds
  // it, and since ruling 101 the Codex read-only sandbox does too
  // (resolveCodexSandboxMode; the evidence carve-out is the disclosed
  // exception). Explicit caller value wins.
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
  if (input.env && Object.keys(input.env).length) spec.env = input.env;

  if (selection.kind === "unavailable") {
    // F26-1: a reserved run that fails here never launches — release its slot
    // and let a run parked behind the cap take it.
    if (reservation) {
      state.reserved.delete(reservation.runId);
      drainRunQueue(db);
    }
    failRunUnavailable(db, spec, reservation?.startedAt);
    return { runId };
  }

  const launchOpts: Parameters<typeof launch>[3] = {};
  if (reservation) launchOpts.startedAt = reservation.startedAt;
  if (modelSubstitution) launchOpts.notice = modelSubstitution;
  const launchThunk = () => launch(db, spec, selection.adapter, launchOpts);
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
  } else {
    admitRun(db, runId, launchThunk);
  }
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
function failRunUnavailable(
  db: DatabaseSync,
  spec: RunSpec,
  startedAt?: string,
): void {
  const sink = createRunSink(db, spec);
  // R21-4: a run that was RESERVED kept the human waiting through its workspace
  // preparation — its clock started there, not here.
  sink.markRunning(startedAt);
  const now = new Date().toISOString();
  const text = backendUnavailableMessage(spec.backend);
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
    // D2: the CLI-auth opt-in is now validated, so the refusal can name the
    // dir it checked instead of re-suggesting the flag that is already set.
    const claude = claudeCliAuthDiagnostics();
    if (claude.optIn && claude.verified === "refuted") {
      return `Claude Code is unavailable: VIBERR_CLAUDE_USE_CLI_AUTH=1 is set, but \`${claude.configDir}\` holds no \`claude\` login (no ${claude.credentialsPath}, and the CLI has never run against that config dir). Point CLAUDE_CONFIG_DIR at the logged-in dir, or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN, or run this agent on another backend. No agent process was started.`;
    }
    return "Claude Code is unavailable: no usable credential is configured. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (or opt in with VIBERR_CLAUDE_USE_CLI_AUTH=1), or run this agent on another backend. No agent process was started.";
  }
  const diag = codexCliAuthDiagnostics();
  // D1: the source==run-home misconfiguration must be named FIRST. The generic
  // copy below tells the operator to copy their login INTO Viberr's own run
  // home, which in this state cements the misconfiguration instead of fixing it.
  const misconfigured = codexAuthMisconfiguration(diag);
  if (misconfigured) {
    return `Codex is unavailable. ${misconfigured} No agent process was started.`;
  }
  if (diag.optIn && !diag.authJsonExists) {
    return `Codex is unavailable: VIBERR_CODEX_USE_CLI_AUTH=1 is set, but the Codex CLI login file is missing at ${diag.authJsonPath}. Copy it from a logged-in machine (docker: \`docker compose cp ~/.codex/auth.json app:${diag.authJsonPath}\`) and the next run picks it up without a restart. Or set CODEX_ACCESS_TOKEN, CODEX_API_KEY or OPENAI_API_KEY, or run this agent on another backend. No agent process was started.`;
  }
  return "Codex is unavailable: no usable credential is configured. Set CODEX_ACCESS_TOKEN, CODEX_API_KEY or OPENAI_API_KEY (or opt in with VIBERR_CODEX_USE_CLI_AUTH=1), or run this agent on another backend. No agent process was started.";
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
  const label = backend === "claude" ? "Claude" : "Codex";
  return `The ${label} session ${sessionId} no longer exists on this machine. Its provider transcript is gone (retention sweep or a wiped runtime volume), so the conversation could not be resumed. The agent re-anchored on task.md and continued with a fresh session.`;
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
function continuityResetPreamble(backend: RealBackend, kind?: string): string {
  const label = backend === "claude" ? "Claude" : "Codex";
  // Ruling 99: a controller turn has no task.md — its anchors are the recent
  // conversation digest its turn prompt carries and the live tool reads.
  if (kind === "controller") {
    return [
      `[continuity notice] Your previous ${label} session for this conversation is gone — the provider transcript no longer exists, so none of the earlier exchange is in your context.`,
      `The recent-conversation digest in the prompt below and your tools are your anchors. Say so if the request depends on context you can no longer see.`,
    ].join(" ");
  }
  return [
    `[continuity notice] Your previous ${label} session for this task is gone — the provider transcript no longer exists, so none of that conversation is in your context.`,
    `Re-anchor on the canonical task file (\`task.md\` in your working directory) and the repository state before you act. Treat the request below as a fresh instruction, and say so if it depends on context you can no longer see.`,
  ].join(" ");
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
  dataRoot?: string,
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
  const label = run.backend === "claude" ? "Claude" : "Codex";
  try {
    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "continuity",
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
  try {
    await updateTaskFile(ref, (parsed) => {
      parsed.frontmatter.waiting = "human";
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "continuity",
        actor: { kind: "system", systemId: "runtime-continuity" },
        title: null,
        text: `The ${run.agent_name ?? run.role} run finished, but applying its completion effects (its reply, any verdict, the delivery reconcile, and re-engaging the operator) failed, so none of them landed. This task is not being worked right now. Run recovery replays the effects on the next restart; you can also re-run the agent. The run log it already produced is unchanged.`,
        toAgent: false,
        evidence: null,
      });
    });
    rebuildPath(db, resolveTaskFilePath(ref), dataRoot ? { dataRoot } : {});
  } catch (error) {
    logger.error("completion-effects-lost timeline note failed", {
      runId: run.id,
      taskKey: run.task_key,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/** The follow-up turn `resumeRun` starts on an existing run's session. */
export interface ResumeRunInput {
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
  /** Re-apply the granted skills mounted into the workspace on resume. The
   *  workspace (and its mount) survives between runs, but the SDK options do
   *  not: without this a resumed @mention run would enable NO skill while its
   *  persona — built by the same `resolveResumeConfinement` — already left the
   *  bodies out for native delivery, so the agent would silently lose its
   *  granted craft mid-thread (the XS-1 fresh-vs-resume parity class). */
  skills?: string[];
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
  systemPrompt?: string;
  /** Re-apply the outcome-envelope schema on resume so a resumed (e.g.
   *  @mention) Codex agent still emits the structured outcome (verdict /
   *  questions) instead of falling back to the fragile prose regex — and so
   *  ask_human can fire. Without it a resumed Codex reviewer silently lost
   *  its envelope, a fresh-vs-resume parity break (F7). */
  outputSchema?: unknown;
  /** C02-R3 (pass 32): re-apply the task's attachments drop on resume. It is
   *  the Codex sandbox's ONLY extra writable root (and the evidence carve-out
   *  in `resolveCodexSandboxMode` keys off it): a resumed evidence-granted
   *  Codex run used to lose `additionalDirectories` — its persona still said
   *  "copy files into attachments/" while the sandbox blocked the copy — and a
   *  write-withheld one dropped to read-only, the F22-03 defect back on the
   *  @mention path. Same fresh-vs-resume parity class as XS-1/F7. */
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
  if (input.effort) target.effort = input.effort;
  if (input.workdir) target.workdir = input.workdir;
  if (input.autonomous !== undefined) target.autonomous = input.autonomous;
  if (input.dataRoot) target.dataRoot = input.dataRoot;
  if (input.actor) target.actor = input.actor;
  if (input.disallowedTools) target.disallowedTools = input.disallowedTools;
  if (input.skills) target.skills = input.skills;
  if (input.allowedTools) target.allowedTools = input.allowedTools;
  if (input.env) target.env = input.env;
  if (input.mcpServers) target.mcpServers = input.mcpServers;
  if (input.systemPrompt) target.systemPrompt = input.systemPrompt;
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
    const freshTurn: StartRunInput = {
      projectSlug: prev.project_slug,
      taskKey: prev.task_key,
      threadId: resumeThreadId,
      role: prev.role,
      kind: prev.kind,
      backend,
      model: input.model ?? prev.model,
      agentName: input.agentName ?? prev.agent_name,
      agentProfileId: input.agentProfileId ?? prev.agent_profile_id,
      prompt: `${continuityResetPreamble(backend, prev.kind)}\n\n${input.prompt}`,
      // The whole point: no resumeSessionId. A fresh provider session.
      resumeSessionId: null,
    };
    carryResumeOptions(freshTurn, input);
    const fresh = await startRun(db, freshTurn);
    return { runId: fresh.runId, continuityReset: true };
  }

  const resumedTurn: StartRunInput = {
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

/**
 * Admit a run for launch under the instance concurrency cap.
 *
 * The live count is `handles.size + reserved.size` (see {@link liveCount}) — the
 * ground truth of how many runs hold a slot right now, with no separate counter
 * to leak or drift. When the cap (getMaxConcurrentRuns) is 0 the gate is off and
 * every run launches immediately (the historical behavior, so an untouched
 * deployment is unchanged). Otherwise a run that would exceed the cap is PARKED:
 * its DB row stays `queued` (that is the state startRun already inserts for a
 * non-reserved run) and its launch thunk waits in `state.pending`, promoted by
 * `drainRunQueue` when a live slot frees.
 */
function admitRun(db: DatabaseSync, runId: string, launchThunk: () => void): void {
  const state = getState();
  const cap = getMaxConcurrentRuns(db);
  if (cap === 0 || liveCount(state) < cap) {
    launchThunk();
    return;
  }
  state.pending.push({ runId, launch: launchThunk });
  logger.info("run queued behind the concurrency cap", {
    runId,
    live: liveCount(state),
    cap,
    queuedAhead: state.pending.length - 1,
  });
}

/**
 * Promote queued runs while a live slot is free. Called from every run's onExit
 * (a finished run frees its slot) and after an interrupt. A pending run whose
 * row is no longer `queued` (interrupted / errored while waiting) is DROPPED —
 * it must never spring to life. The cap is re-read each pass so an admin lowering
 * it mid-drain is honored; `handles.size` grows as each promoted run launches,
 * so the loop is self-limiting.
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
      if (cap !== 0 && liveCount(state) >= cap) return;
      const next = state.pending.shift();
      if (!next) return;
      const row = getRun(db, next.runId);
      if (!row || row.state !== "queued") continue; // stopped while waiting
      next.launch();
    }
  } finally {
    state.draining = false;
  }
}

/** A point-in-time view of the run concurrency gate. */
export interface RunConcurrencySnapshot {
  /** Configured cap (0 = unlimited). */
  cap: number;
  /** Runs holding a slot right now — live adapters plus reserved-but-not-yet-
   *  launched runs (still preparing their workspace). This is what the cap gates
   *  against, so it is what the admin card must show. */
  live: number;
  /** Runs parked behind the cap right now. */
  queued: number;
}

/** How many runs are executing vs waiting on a slot right now — for the admin
 *  concurrency card and diagnostics. */
export function runConcurrencySnapshot(db: DatabaseSync): RunConcurrencySnapshot {
  const state = getState();
  return {
    cap: getMaxConcurrentRuns(db),
    live: liveCount(state),
    queued: state.pending.length,
  };
}

/** Wires the sink + adapter callbacks and starts the adapter process/timer. */
function launch(
  db: DatabaseSync,
  spec: RunSpec,
  adapter: RuntimeAdapter,
  opts: {
    /** The RESERVED run's original instant (R21-4) — absent for a run that was
     *  not reserved, which then starts its clock here. */
    startedAt?: string;
    /** F21-13: a disclosure line to open the run log with. */
    notice?: string;
  } = {},
): void {
  const state = getState();
  const sink = createRunSink(db, spec);

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
        const now = Date.now();
        if (phase === lastPhase && now - lastPhaseWriteMs < PHASE_MIN_INTERVAL_MS) {
          return;
        }
        lastPhase = phase;
        lastPhaseWriteMs = now;
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
      // This run's slot is now free — promote the oldest queued run behind the
      // concurrency cap. Before the completion callback, so a chain of queued
      // runs keeps flowing even if the callback throws.
      try {
        drainRunQueue(db);
      } catch (error) {
        logger.error("run queue drain failed", {
          runId: spec.runId,
          err: error instanceof Error ? error : new Error(String(error)),
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
            err: error instanceof Error ? error : new Error(String(error)),
          });
          // C4: the completion effects are lost — stamp the task so it isn't
          // stuck on "agent working" with no live run until the next restart.
          if (finished) void noteCompletionEffectsLost(db, finished);
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
export async function interruptRun(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; runId: string; dataRoot?: string },
  actor: { userId: string; label: string },
): Promise<InterruptResult> {
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
  // Review F6 (pass 32): the live-handle arm below stamps `interrupted_by` at
  // once but leaves `state = running` until the adapter's onExit lands. A
  // second click in that window (the button re-enables as soon as the action
  // returns) must not write a second audit row and a second timeline note.
  if (run.interrupted_by) {
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
    actor,
    subjectKind: "run",
    subjectId: input.runId,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { threadId: run.thread_id, backend: run.backend, role: run.role },
  });
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
  const backend = run.backend === "claude" ? "Claude" : "Codex";
  try {
    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "human", userId: actor.userId, nameHint: actor.label },
        title: null,
        text: `Interrupted the ${backend} run \`${run.id}\` (${run.agent_name ?? run.role}). The thread stays resumable; re-run the agent to continue.`,
        toAgent: false,
        evidence: null,
      });
    });
    rebuildPath(db, resolveTaskFilePath(ref), dataRoot ? { dataRoot } : {});
  } catch (error) {
    logger.error("interrupt timeline note failed", {
      runId: run.id,
      taskKey: run.task_key,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
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
  if (!run) return null;
  const backward = query.before !== undefined || query.limit !== undefined;
  const lines: RunLog["lines"] = backward
    ? listRunLinesTail(db, runId, query.limit ?? RUN_LOG_PAGE_LINES, query.before).map(
        ({ seq, occurredAt, raw, display }) => ({ seq, occurredAt, raw, display }),
      )
    : listRunLines(db, runId, query.since ?? -1, query.forwardLimit);
  const sinceSeq = query.since ?? -1;
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
