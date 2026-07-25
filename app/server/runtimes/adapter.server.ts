import type { LogLine, RunBackend, RunKind } from "~/features/runtime/runtime-types";
import type { EnvelopeFacts } from "./wire-format.server";

/**
 * Common runtime-adapter interface. Each backend implements it; run-service is the only
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
  /** The requested provider backend. */
  backend: "claude" | "codex";
  model: string;
  /** Reasoning/effort level for the run (claude: options.effort · codex:
   *  modelReasoningEffort). Optional — the SDK uses its default when absent. */
  effort?: string;
  /** The instruction. */
  prompt: string;
  /** Absolute working directory for the spawned CLI. */
  workdir: string;
  /** Resume an existing provider session, if any. */
  resumeSessionId?: string | null;
  /** Whether the run should be autonomous (Claude bypassPermissions / Codex
   *  danger-full-access for coding specialists). */
  autonomous?: boolean;
  /** Custom system prompt (operator persona + expertise skill). Claude uses
   *  its systemPrompt option; Codex maps it to developer_instructions. */
  systemPrompt?: string;
  /** MCP servers keyed by name. Portable HTTP/stdio configs work on both
   *  backends; Claude additionally supports in-process SDK servers such as the
   *  operator's `{ viberr: createSdkMcpServer(...) }`. */
  mcpServers?: Record<string, unknown>;
  /** Claude-only allowlist for automatic tool approval. */
  allowedTools?: string[];
  /** Denylist confining a specialist run to its granted capabilities (e.g. a
   *  specialist without push rights cannot run `git push`). Deny rules bind
   *  even under bypassPermissions. Claude only. */
  disallowedTools?: string[];
  /** The run's `execute-code-or-write-repo` grant is WITHHELD (mode `off` or
   *  `human`). Codex enforces it with a read-only sandbox — a physical block,
   *  strictly stronger than Claude's tool denylist (P13-RT-02). Deliberately
   *  NOT folded into `autonomous`, which also drives Claude's `permissionMode`
   *  (flipping that would hang a server run on an unanswerable approval). */
  repoWriteWithheld?: boolean;
  /** The run's `use-web-search-fetch` grant is WITHHELD. Claude removes the
   *  WebFetch/WebSearch tools via `disallowedTools`; Codex, which has no
   *  denylist channel, disables its own web search through `webSearchMode`
   *  (P14-RT-06). Network stays reachable either way — declared MCP servers and
   *  the workspace's own tooling are not the egress this capability governs. */
  webSearchWithheld?: boolean;
  /** JSON schema constraining the run's final output. Codex only (it has no
   *  in-process tool channel). Used by BOTH the structured-output operator (a
   *  decision plan the caller parses + executes) AND every generic specialist/
   *  reviewer run (the report_outcome envelope — verdict/questions). */
  outputSchema?: unknown;
  /** Per-run environment overlay, merged ON TOP of the adapter's base env for
   *  THIS run only. `GIT_CEILING_DIRECTORIES` prevents accidental parent-repo
   *  discovery; it is not a filesystem or process isolation boundary. */
  env?: Record<string, string>;
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
  /** The backend actually used. */
  effectiveBackend: RunBackend;
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
  /** Send SIGINT. Idempotent. Interrupter attribution is stamped onto the run
   *  row by the service (interruptRun), not passed here. */
  interrupt(): void;
}

export interface RuntimeAdapter {
  readonly backend: RunBackend;
  /** Begin a run; drives callbacks; returns a handle for interrupt. */
  start(spec: RunSpec, cb: RunCallbacks): RunHandle;
}
