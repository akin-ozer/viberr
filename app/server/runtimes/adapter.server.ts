import type { LogLine, RunBackend, RunKind } from "~/features/runtime/runtime-types";
import type { EnvelopeFacts } from "./wire-format.server";

/**
 * Common runtime-adapter interface (BUILD-PLAN Phase 8). Each backend
 * (claude / codex / simulated) implements it; the run-service is the only
 * caller. Adapters do NOT touch the DB, files or the broker directly — they
 * emit lines/exit through callbacks and the run-service (via a RunSink)
 * persists (raw .jsonl append + DB row with computed display_json) THEN
 * publishes `run.log-appended` and `run.state-changed`.
 */

/** What the service asks an adapter to run. */
export interface RunSpec {
  /** Stable run id (agent_runs.id). */
  runId: string;
  projectSlug: string;
  taskKey: string;
  /** Thread id within the task ("op" | "primary" | "c0"). */
  threadId: string;
  role: string;
  kind: RunKind;
  /** The requested backend — kept for glyph fidelity even on fallback. */
  backend: "claude" | "codex";
  model: string;
  /** The instruction. */
  prompt: string;
  /** Absolute working directory for the spawned CLI. */
  workdir: string;
  /** Resume an existing provider session, if any. */
  resumeSessionId?: string | null;
  /** Whether the run should be autonomous (acceptEdits / workspace-write). */
  autonomous?: boolean;
}

/** One emitted line: the raw envelope + its projected display line + facts. */
export interface EmittedLine {
  /** Exact wire envelope, single-line JSON (persisted as raw_json). */
  raw: string;
  /** Projected display line (null when the envelope carries no console row). */
  display: LogLine | null;
  /** Facts to fold into the run row (session id, usage, cost, turns). */
  facts: EnvelopeFacts;
  /** UTC ISO occurrence time. */
  occurredAt: string;
}

/** How the run ended (from the stream, not the exit code — see research §1.6). */
export interface RunExit {
  /** finished | error | interrupted (queued/running never appear here). */
  outcome: "finished" | "error" | "interrupted";
  /** The real backend actually used (== requested, or "simulated" on fallback). */
  effectiveBackend: RunBackend;
  /** True when a real backend fell back to the simulated engine. */
  simulated: boolean;
  /** Provider session id captured during the run, if any. */
  sessionId?: string | null;
}

/** Callbacks the adapter drives; the service wires persistence behind them. */
export interface RunCallbacks {
  onLine: (line: EmittedLine) => void;
  onExit: (exit: RunExit) => void;
  /** Optional live phase/step update for the run strip (no persisted line). */
  onPhase?: (phase: string | null, step: string | null) => void;
}

/** A running handle the service can interrupt. */
export interface RunHandle {
  runId: string;
  /** Send SIGINT (real) / stop the timer (simulated). Idempotent. */
  interrupt(byUserId: string, byLabel: string): void;
}

export interface RuntimeAdapter {
  readonly backend: RunBackend;
  /** Begin a run; drives callbacks; returns a handle for interrupt. */
  start(spec: RunSpec, cb: RunCallbacks): RunHandle;
}
