import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type {
  JsonValue,
  LogLine,
  RunBackend,
  RunKind,
} from "~/features/runtime/runtime-types";
import type { SpecialistMcpServerConfig } from "~/server/tasks/specialist-mcp.server";
import type { EnvelopeFacts } from "./wire-format.server";

/**
 * Common runtime-adapter interface. Each backend implements it; run-service is the only
 * caller. Adapters do NOT touch the DB, files or the broker directly — they
 * emit lines/exit through callbacks and the run-service (via a RunSink)
 * persists (raw .jsonl append + DB row with computed display_json) THEN
 * publishes `run.log-appended` and `run.state-changed`.
 */

/** The MCP servers a run mounts, keyed by declared name: the portable
 *  HTTP/stdio configs `resolveSpecialistMcpServers` builds (both backends)
 *  plus Claude-only in-process SDK instances such as the operator's
 *  `{ viberr: createSdkMcpServer(...) }`. The one shape every producer emits
 *  and `StartRunInput`/`ResumeRunInput`/`ResumeConfinement` enforce. */
export type RunMcpServers = Record<
  string,
  McpSdkServerConfigWithInstance | SpecialistMcpServerConfig
>;

/**
 * One declaration as it reaches an ADAPTER, which is a wider contract than
 * `RunMcpServers[string]` by exactly one arm.
 *
 * Every governed producer reaches an adapter through `StartRunInput` /
 * `ResumeRunInput`, which enforce `RunMcpServers` — the first two arms. The
 * third exists because each adapter's own tolerance tests hand it a
 * deliberately MALFORMED declaration to prove the backend degrades safely
 * (codex zod-drops a bad entry rather than crashing the run; claude forwards it
 * to the SDK, which owns the verdict). That arm is a concrete JSON object
 * rather than an escape hatch, so it still cannot smuggle in a value that has
 * no wire representation, and neither adapter reads a field off this type: the
 * codex side re-parses with `codexMcpServerSchema`, the claude side never
 * inspects a declaration at all.
 */
export type RunMcpServerDeclaration =
  | McpSdkServerConfigWithInstance
  | SpecialistMcpServerConfig
  | Record<string, JsonValue>;

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
   *  operator's `{ viberr: createSdkMcpServer(...) }`.
   *
   *  Typed as `RunMcpServerDeclaration`, not `RunMcpServers`: every governed
   *  caller reaches this through `StartRunInput`/`ResumeRunInput`, which DO
   *  enforce that union — but the adapters' own tolerance tests hand this field
   *  deliberately malformed configs to prove each backend degrades safely
   *  (codex zod-drops a bad declaration instead of crashing the run). */
  mcpServers?: Record<string, RunMcpServerDeclaration>;
  /** Claude-only allowlist for automatic tool approval. */
  allowedTools?: string[];
  /** Denylist confining a specialist run to its granted capabilities (e.g. a
   *  specialist without push rights cannot run `git push`). Deny rules bind
   *  even under bypassPermissions. Claude only. */
  disallowedTools?: string[];
  /** The task's attachments directory, when this run's profile holds
   *  `attach-evidence-references` — Codex `workspace-write` sandboxes add it as
   *  an additional writable directory so the agent can copy files there ("post
   *  a file on the task thread"). Claude runs at bypassPermissions and need no
   *  widening; `danger-full-access` can already write it (R22: no run is
   *  read-only anymore). */
  attachmentsWritableDir?: string | null;
  /** The GRANTED skills Viberr mounted into this run's workspace
   *  (`mountGrantedSkills`), by exact name. Claude only: the adapter turns these
   *  into the SDK's native skills context filter, so the model gets each skill's
   *  metadata up front and its full body only when it invokes the Skill tool.
   *  Empty/absent ⇒ the run enables NO skill and the `Skill` tool stays denied.
   *  Codex has no native equivalent (its skills channel is severed outright —
   *  codex-runtime LV-13), so a Codex run's granted skills ride the system
   *  prompt as text and this stays empty. */
  skills?: string[];
  /** The run's `execute-code-or-write-repo` grant is WITHHELD (mode `off` or
   *  `human`). Claude enforces it via the tool denylist; on Codex it is
   *  ADVISORY since R22 removed the read-only sandbox (the server-owned
   *  delivery gate is the real boundary) — no runtime consumes this flag for
   *  enforcement anymore; it rides the spec as the run's stated confinement.
   *  Deliberately NOT folded into `autonomous`, which also drives Claude's
   *  `permissionMode` (flipping that would hang a server run on an
   *  unanswerable approval). */
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
  /**
   * Live phase/step update for the run strip (no persisted line).
   *
   * R21-4 / G5 (FR28): this callback existed and was WIRED through
   * `run-service.launch` since the phase-6 build, but NO adapter ever called it
   * — so `agent_runs.phase`/`.step` stayed null for the entire life of every
   * run and the Live-run strip rendered two empty rows while an agent worked.
   * Both adapters now drive it (see `RUN_PHASE` + `phaseStepForLine`); the
   * service throttles the writes.
   */
  onPhase?: (phase: string | null, step: string | null) => void;
}

/**
 * The phase vocabulary both adapters emit, so the strip reads the same on
 * Claude and Codex. Deliberately tiny and literal — these are the four things
 * the server actually KNOWS about a run, not a narration of what the model is
 * "thinking".
 *
 * `preparing` is emitted by the RUN PIPELINE (before any adapter exists): a
 * cold task-repo clone can take minutes (OBS-8: 3+ min on a 113 MB repo) and
 * until it finished the task page showed no live row at all, which reads as a
 * dead app.
 */
export const RUN_PHASE = {
  preparing: "Preparing workspace",
  starting: "Starting",
  working: "Working",
  finishing: "Finishing",
} as const;

/** Longest `step` we persist — the strip truncates at ~44ch and the column is
 *  a live hint, not a transcript. */
const STEP_MAX = 120;

function clampStep(step: string): string {
  const flat = step.replace(/\s+/g, " ").trim();
  return flat.length > STEP_MAX ? `${flat.slice(0, STEP_MAX - 1)}…` : flat;
}

/**
 * The `step` line for one emitted run line, or null when the line says nothing
 * about what the run is doing right now.
 *
 * Derived from the PROJECTED display line, which both adapters already compute
 * — so the two backends produce the same shape ("Bash · npm test") from very
 * different envelopes, and neither adapter re-parses the wire format for this.
 */
export function phaseStepForLine(line: EmittedLine): string | null {
  const display = line.display;
  if (!display) return null;
  // TOOL lines only. Both backends project a tool invocation as `ev: "tool"`
  // with a `name` (claude `tool_use`, codex `command_execution` / `mcp_tool_call`
  // / `web_search`), so one rule covers both. Command OUTPUT (`ev: "out"`) is
  // deliberately excluded: it carries no tool name and would put the tail of
  // whatever a build printed into the strip.
  if (display.ev !== "tool") return null;
  const name = display.name?.trim();
  const text = display.text.trim();
  if (name && text) return clampStep(`${name} · ${text}`);
  if (name) return clampStep(name);
  if (text) return clampStep(text);
  return null;
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
