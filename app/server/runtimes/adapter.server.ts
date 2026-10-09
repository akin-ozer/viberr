import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type {
  JsonValue,
  LogLine,
  RunBackend,
  RunKind,
} from "~/features/runtime/runtime-types";
import type { SpecialistMcpServerConfig } from "~/server/tasks/specialist-mcp.server";
import type { McpToolDenial } from "~/shared/mcp-tools";
import type { SkillPlugin } from "./skill-mount.server";
import type { AgentLaunch } from "./agent-isolation.server";
import type { ClaudeResultUsage, EnvelopeFacts } from "./wire-format.server";
import type { RunPrompt } from "./prompt-prefix.server";
import {
  POST_TURN_TRANSPORT_TAG,
  postTurnTransportText,
} from "~/shared/run-failure";

/**
 * Common runtime-adapter interface. Each backend implements it; run-service is the only
 * caller. Adapters do NOT touch the DB, files or the broker directly — they
 * emit lines/exit through callbacks and the run-service (via a RunSink)
 * persists (raw .jsonl append + DB row with computed display_json) THEN
 * publishes `run.log-appended` and `run.state-changed`.
 */

/** The MCP servers a run mounts, keyed by declared name: the portable
 *  HTTP/stdio configs `resolveSpecialistMcpServersDetailed` builds (both backends)
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
  /** Thread id within the task ("op" | "primary" | "r0"). */
  threadId: string;
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
  /** Ruling 165(c): the totals the resumed Claude session last reported, read
   *  from its run log by `startRun`. The adapter takes the run's share from
   *  them when this process holds nothing for the session, which
   *  is every resumed session's first run after a restart. */
  resumedSessionReported?: ClaudeResultUsage;
  /** Ruling 159: the CLI will restore the resumed session's cost state (it was
   *  the last session run where this run works, under this account), so the
   *  spending cap, which the CLI measures against that restored total, is
   *  raised by it. False or absent: the run's own spend starts from zero. */
  costStateRestored?: boolean;
  /** Whether the run should be autonomous (Claude bypassPermissions / Codex
   *  danger-full-access for coding specialists). */
  autonomous?: boolean;
  /** The run's system prompt: a static/dynamic split (ruling 169,
   *  `PromptPrefix`) or a plain string. Claude renders the split by kind —
   *  the operator as a `string[]` with the SDK's dynamic boundary, the
   *  controller as a recorded custom prompt, a specialist as the preset's
   *  static append with the dynamic tail on the first user message; Codex
   *  joins the same text into `developer_instructions`. */
  systemPrompt?: RunPrompt;
  /** Ruling 170: what the run is told the moment its context has been
   *  compacted — the task anchor (task.md path, branch, PR, knowledge bases)
   *  or the controller's conversation anchor. Claude injects it through a
   *  `SessionStart` hook on the `compact` source; Codex keeps its per-task
   *  facts in `developer_instructions`, which survive compaction on their own,
   *  so this is not sent there. */
  compactAnchor?: string;
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
  /** Ruling 188: per mounted org server, the admin-marked write tools this
   *  run withholds, by the server's own tool names. `startRun` has already
   *  added the Claude `mcp__<server>__<tool>` names to `disallowedTools`;
   *  Codex, which has no denylist channel, sends them as that server's
   *  `disabled_tools`. */
  mcpToolDenials?: McpToolDenial[];
  /** Ruling 190: the servers in `mcpServers` a Codex run may start without:
   *  those mounted although their last probe failed or is stale, which the
   *  run's prompt already names as possibly missing. Codex marks every other
   *  server `required`. Claude ignores it. */
  mcpOptional?: string[];
  /** The task's attachments directory, when this run's profile holds
   *  `attach-evidence-references` — where the agent copies files to "post a
   *  file on the task thread" (ruling 78). Neither adapter has to widen
   *  anything for it: Claude runs at bypassPermissions, and every Codex
   *  thread starts `danger-full-access` (ruling 144), which already writes it
   *  (the `--add-dir` it once rode went with the `workspace-write` sandbox).
   *  Ruling 217(d): on Claude it also keeps the file tools a withheld repo-write
   *  grant denies, confined to it and the temp directory by a hook. */
  attachmentsWritableDir?: string | null;
  /** Ruling 199: the run's working directory when its task has no checkout (a
   *  board with no repository), which its workspace contract calls the task's
   *  scratch. Ruling 217(d)'s hook lets the confined file tools write it too.
   *  Absent on a board with a repository, even when the clone failed. */
  scratchDir?: string | null;
  /** The GRANTED skills Viberr mounted for this run (`mountGrantedSkills`),
   *  by exact name. Claude only: the adapter turns these into the SDK's native
   *  skills context filter (qualified by the plugin below), so the model gets
   *  each skill's metadata up front and its full body only when it invokes the
   *  Skill tool. Empty/absent ⇒ the run enables NO skill and the `Skill` tool
   *  stays denied. Codex has no native equivalent (its skills channel is
   *  severed outright — codex-runtime LV-13), so a Codex run's granted skills
   *  ride the system prompt as text and this stays empty. */
  skills?: string[];
  /** Ruling 185 (pass 36): the LOCAL PLUGIN that carries `skills`, built
   *  beside the checkout (`<checkout>/../.viberr-plugins/<runId>/`). The
   *  Claude adapter passes it as `plugins: [{ type: "local", path }]` and
   *  qualifies each skill as `<name>:<skill>` for the filter; run-service
   *  removes the directory when the run settles. Absent whenever `skills` is. */
  skillPlugin?: SkillPlugin;
  /** The run's `execute-code-or-write-repo` grant is WITHHELD (mode `off` or
   *  `human`). Claude enforces it via the tool denylist. On Codex it is
   *  ADVISORY (ruling 183), with no OS sandbox: no adapter reads this
   *  flag to confine the run, and the prompt plus the server-owned delivery
   *  gate carry the withholding (`codexRepoWriteAdvisory` renders that).
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
  /** Ruling 159: the instance's spending cap for this run in USD, when one is
   *  set (Instance settings → Max spend per Claude run). Claude hands it to the SDK
   *  as `maxBudgetUsd`; Codex has no budget option and ignores it, which the
   *  run-inputs disclosure states. */
  maxSpendUsd?: number;
  /** Per-run environment overlay, merged ON TOP of the adapter's base env for
   *  THIS run only. `GIT_CEILING_DIRECTORIES` prevents accidental parent-repo
   *  discovery; it is not a filesystem or process isolation boundary. */
  env?: Record<string, string>;
  /** Ruling 139: the OS user this run's processes run as — its credential
   *  principal's agent uid — and the launcher that runs them as it. Set by
   *  `startRun` whenever this server launches agents; absent (the host dev
   *  server, the test harness) the CLI spawns as the server's own user. */
  agent?: AgentLaunch;
  /** Ruling 141(c): the run's own temporary directory (`<root>/<runId>`), made
   *  when it launches and named to its processes as `TMPDIR`, `TMP` and `TEMP`
   *  in `env`; run-service removes it once the run has settled. Absent before
   *  the launch and on a run whose directory could not be made. */
  tmpDir?: string;
  /** Ruling 138: the vendor home of the ACCOUNT this run bills (the person's
   *  active one when it started). Claude reads it as `CLAUDE_CONFIG_DIR` from
   *  `env`; the Codex adapter's private home (ruling 145) takes the account's
   *  `auth.json` from here and writes the refreshed one back here, and nowhere
   *  else. Absent on a refused run and in adapter tests that build a spec by
   *  hand, where the shared `CODEX_HOME` stands in, as before the ruling. */
  accountHome?: string;
  /** Ruling 251: the channel a controller turn takes its person's steering
   *  messages through while it works. Only controller turns carry it, and they
   *  run on Claude (ruling 247), whose adapter reads it from two hooks: at every
   *  step boundary it asks for what is waiting, and when the model has written
   *  its final answer it closes it. */
  steering?: RunSteering;
}

/**
 * Ruling 251: steering, from the run's side. The host holds the messages the
 * person sent while the run works; the adapter only asks for them at a step
 * boundary and says when asking has stopped.
 */
export interface RunSteering {
  /** At a step boundary (every tool call of a batch answered, before the next
   *  model request): what the model reads now, or null with nothing waiting.
   *  What it returns has been read: the host marks those messages steered. */
  take(): SteeringDelivery | null;
  /** The model has written its final answer, so nothing handed in from here
   *  on reaches this run; the host sends what is still waiting to the next
   *  turn. */
  close(): void;
}

/** What one step boundary hands the model. */
export interface SteeringDelivery {
  /** The messages, framed for the model. */
  text: string;
  /** How many messages it carries (the console line counts them). */
  count: number;
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

/**
 * Ruling 155(d): the line a run carries when its transport died AFTER the agent's
 * work stood finished — a completed Codex turn with nothing in flight behind
 * it, or Claude's single terminal non-error result.
 *
 * Deliberately not a failure line. `runFailureReason` reads the last `err` line
 * as a run's cause, and this run has no cause: it finished. The drop is still
 * written down, because hiding it would be its own lie, but it is written as
 * what it is — a fact about the socket, not a verdict on the work.
 */
export function postTurnTransportLine(detail: string): EmittedLine {
  const occurredAt = new Date().toISOString();
  return {
    raw: JSON.stringify({
      type: "transport",
      source: "viberr",
      after: "turn.completed",
      message: detail,
    }),
    display: {
      t: occurredAt.slice(11, 19),
      ev: "meta",
      tag: POST_TURN_TRANSPORT_TAG,
      text: postTurnTransportText(detail),
    },
    facts: {},
    occurredAt,
  };
}

/** A console line Viberr writes itself, stamped now: no wire envelope, no facts. */
export function viberrLine(display: Omit<LogLine, "t">): EmittedLine {
  const occurredAt = new Date().toISOString();
  return { raw: "", display: { t: occurredAt.slice(11, 19), ...display }, facts: {}, occurredAt };
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
   * Both adapters now drive it (see `RUN_PHASE` + `stepUpdateForLine`); the
   * service throttles the writes.
   */
  onPhase?: (phase: string | null, step: string | null) => void;
}

/** The phase vocabulary both adapters emit; declared with the client-safe run
 *  types, because the controller page names the phase too (ruling 11). */
export { RUN_PHASE } from "~/features/runtime/runtime-types";

/**
 * Ruling 175: the step a FINISHED specialist run carries, beside the phase
 * `RUN_PHASE.compacting`, for as long as its session is being compacted after
 * it. The run service writes and clears it. It is the durable record that a
 * compaction is in flight on a row that is terminal: boot recovery finishes
 * what a restart cut, and the workspace reclaim counts the run as still
 * holding its folder.
 */
export const COMPACTING_AFTER_RUN_STEP = "after the run ended";

/**
 * Ruling 175: the step of a `queued` run that waits for its session, which is
 * still being compacted after the run that left it, and not for a slot. The
 * console's footer prints it in place of the cap's reason, and the restart
 * note says it of a run a restart found waiting so.
 */
export const SESSION_SETTLING_STEP = "waiting for the summary of its last run";

/** Longest `step` we persist — the strip truncates at ~44ch and the column is
 *  a live hint, not a transcript. */
const STEP_MAX = 120;

function clampStep(step: string): string {
  const flat = step.replace(/\s+/g, " ").trim();
  return flat.length > STEP_MAX ? `${flat.slice(0, STEP_MAX - 1)}…` : flat;
}


/** What one emitted line says about the run's live step. */
export type StepUpdate =
  /** The run invoked a tool: name it, with its input. */
  | { kind: "tool"; step: string }
  /** The tool the step names has answered; the model is composing again. */
  | { kind: "answered" };

const ANSWERED_PREFIX = "composing · ";
const ANSWERED_SUFFIX = " answered";

/**
 * Ruling 166: the step once the tool it names has answered. The step used to
 * stick unchanged from the tool's invocation to the NEXT invocation, so the
 * strip read `Working · get_github_state · {…}` for as long as the model
 * thought after that call came back — measured over the last 40 controller
 * turns before this changed: 76 such stretches longer than 20 s on 26 of the
 * 40 runs, 53 minutes in all, the longest 138 s, every one of them a finished
 * tool shown as the thing the run was doing. "composing" is what the server
 * knows: the result landed and no tool has been invoked since. Idempotent, so
 * a second result line (a subagent's, a Codex error row after its start row)
 * cannot stack the prefix; the tool's own text is trimmed before the suffix
 * so the word "answered" survives the 120-char cap.
 */
export function answeredStep(step: string): string {
  if (step.startsWith(ANSWERED_PREFIX)) return step;
  const room = STEP_MAX - ANSWERED_PREFIX.length - ANSWERED_SUFFIX.length;
  const inner = step.length > room ? `${step.slice(0, room - 1)}…` : step;
  return `${ANSWERED_PREFIX}${inner}${ANSWERED_SUFFIX}`;
}

/**
 * The step update one emitted run line carries, or null when the line says
 * nothing about what the run is doing right now.
 *
 * Derived from the PROJECTED display line, which both adapters already compute
 * — so the two backends produce the same shape ("Bash · npm test") from very
 * different envelopes, and neither adapter re-parses the wire format for this.
 */
export function stepUpdateForLine(line: EmittedLine): StepUpdate | null {
  // A succeeding Codex MCP call projects no row at all on completion; the
  // fact rides on the facts instead (ruling 166).
  if (line.facts.toolAnswered) return { kind: "answered" };
  const display = line.display;
  if (!display) return null;
  // The result rows carry no tool name, but they say the tool is done: Claude's
  // `tool_result` (ok or error) and Codex's completed command output.
  if (display.tag === "tool_result" || display.tag === "aggregated_output") {
    return { kind: "answered" };
  }
  // TOOL lines only. Both backends project a tool invocation as `ev: "tool"`
  // with a `name` (claude `tool_use`, codex `command_execution` / `mcp_tool_call`
  // / `web_search`), so one rule covers both. Command OUTPUT (`ev: "out"`) is
  // deliberately excluded: it carries no tool name and would put the tail of
  // whatever a build printed into the strip.
  if (display.ev !== "tool") return null;
  const name = display.name?.trim();
  const text = display.text.trim();
  const named = name && text ? `${name} · ${text}` : name || text;
  if (!named) return null;
  const step = clampStep(named);
  // Codex projects a web search on completion only, so it is answered as it is
  // named.
  return { kind: "tool", step: display.tag === "web_search" ? answeredStep(step) : step };
}

/** A running handle the service can interrupt. */
export interface RunHandle {
  runId: string;
  /** Stop the run: a cooperative interrupt first, then the adapter's abort
   *  ladder tears the process group down, and the settle sweep reaps whatever
   *  the run started (ruling 142). Idempotent. Interrupter attribution is
   *  stamped onto the run row by the service (interruptRun), not passed here. */
  interrupt(): void;
}

/** What a completion compaction (ruling 174) reports back to the run service. */
export type CompactOutcome =
  | { compacted: true; preTokens: number | null; postTokens: number | null }
  | { compacted: false; reason: string };

/** The callbacks a completion compaction drives: the same line sink and
 *  phase writer as the run it closes; no exit, it returns its outcome. */
export type CompactCallbacks = Pick<RunCallbacks, "onLine" | "onPhase"> & {
  /** Ruling 175: aborted when the run service stops waiting for the
   *  compaction (`COMPLETION_COMPACT_DEADLINE_MS`). An adapter that can stop
   *  its request stops it; the service sweeps the compaction's process by its
   *  marker either way and drops what is said after. */
  signal?: AbortSignal;
};

export interface RuntimeAdapter {
  readonly backend: RunBackend;
  /** Begin a run; drives callbacks; returns a handle for interrupt. */
  start(spec: RunSpec, cb: RunCallbacks): RunHandle;
  /**
   * Ruling 174: compact the session `sessionId` a run of `spec` just left,
   * while its prompt cache is warm. The request must share the run's prefix
   * (tools, system prompt, servers), so an adapter builds it from the same
   * spec it started the run with. Emits its lines through `cb.onLine` (a
   * `compaction` fact with trigger `completion`, the cost as `costAddUsd`)
   * and resolves with what happened; it never throws for a provider refusal.
   * Optional so a test's throwing or capturing stub stays a valid adapter; a
   * backend without it simply keeps its large sessions for ruling 173.
   */
  compact?(spec: RunSpec, sessionId: string, cb: CompactCallbacks): Promise<CompactOutcome>;
}
