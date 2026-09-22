import type { LogLine } from "~/features/runtime/runtime-types";
import type {
  CompactCallbacks,
  CompactOutcome,
  EmittedLine,
  RunCallbacks,
  RunHandle,
  RunSpec,
  RuntimeAdapter,
} from "~/server/runtimes/adapter.server";
import { configureRunServiceForTests } from "~/server/runtimes/run-service.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";

export interface FakeRun {
  lines: LogLine[];
  /** Ruling 376: facts a test wants on a line beyond what its `usage` or
   *  `stats` imply (a `cache` fact that sets the run's last prompt, say),
   *  merged into the line at the same index. */
  extraFacts?: (EmittedLine["facts"] | undefined)[];
  backend?: RealBackend;
  occurredAt?: string[];
  sessionId?: string;
  keepRunning?: boolean;
  outcome?: "finished" | "error";
}

/** The runs a test queued, per backend, consumed oldest-first by the adapters. */
interface QueuedRuns {
  claude: FakeRun[];
  codex: FakeRun[];
}

const queued: QueuedRuns = { claude: [], codex: [] };

/**
 * Every `RunSpec` the fake adapters were started with, in order. Lets a test
 * assert what a code path actually SENT to the runtime — the prompt, the
 * denylist, the mounted MCP servers — instead of only what it returned. Reset by
 * `installFakeRuntime`.
 */
const startedSpecs: RunSpec[] = [];

/** Ruling 376: what the fake answers a completion compaction with, per
 *  backend, consumed oldest-first; nothing queued means "not compacted". */
/** A queued answer, plus what the "provider" does when asked (a test appends
 *  the compaction to a rollout there, as the real app-server would). */
interface QueuedCompaction {
  outcome: CompactOutcome;
  onCompact?: () => void;
}
interface QueuedCompactions {
  claude: QueuedCompaction[];
  codex: QueuedCompaction[];
}
const queuedCompactions: QueuedCompactions = { claude: [], codex: [] };
const compactedSpecs: { spec: RunSpec; sessionId: string }[] = [];

export function queueFakeCompaction(
  backend: RealBackend,
  outcome: CompactOutcome,
  onCompact?: () => void,
): void {
  const queued: QueuedCompaction = { outcome };
  if (onCompact) queued.onCompact = onCompact;
  queuedCompactions[backend].push(queued);
}

/** The compactions the fake was asked for, oldest first. */
export function compactedRunSpecs(): readonly { spec: RunSpec; sessionId: string }[] {
  return compactedSpecs;
}

/** The specs the fake runtime received, oldest first. */
export function startedRunSpecs(): readonly RunSpec[] {
  return startedSpecs;
}

/** The most recent spec, or undefined when nothing has run. */
export function lastRunSpec(): RunSpec | undefined {
  return startedSpecs[startedSpecs.length - 1];
}

export function queueFakeRun(run: FakeRun, backend = run.backend ?? "claude"): void {
  queued[backend].push(run);
}

export function installFakeRuntime(): void {
  queued.claude.length = 0;
  queued.codex.length = 0;
  startedSpecs.length = 0;
  queuedCompactions.claude.length = 0;
  queuedCompactions.codex.length = 0;
  compactedSpecs.length = 0;
  configureRunServiceForTests({
    claude: createFakeAdapter("claude"),
    codex: createFakeAdapter("codex"),
  });
}

function createFakeAdapter(backend: RealBackend): RuntimeAdapter {
  return {
    backend,
    async compact(spec: RunSpec, sessionId: string, cb: CompactCallbacks): Promise<CompactOutcome> {
      compactedSpecs.push({ spec, sessionId });
      const queued = queuedCompactions[backend].shift();
      queued?.onCompact?.();
      const outcome: CompactOutcome = queued?.outcome ?? {
        compacted: false,
        reason: "no compaction queued",
      };
      cb.onPhase?.("Compacting context", "at the end of the run");
      const occurredAt = new Date().toISOString();
      // What the Claude adapter emits: the boundary as this run's fact. The
      // Codex adapter emits NOTHING on success, because the app-server's reply
      // carries no sizes and the run service reads the compaction off the
      // rollout instead; a fake that emitted here would note it a second time
      // (ruling 414).
      if (outcome.compacted && backend === "claude") {
        cb.onLine({
          raw: JSON.stringify({ type: "test", backend, compaction: outcome }),
          display: {
            t: occurredAt.slice(11, 19),
            ev: "meta",
            tag: "run·compacted·completion",
            text: "context compacted at the end of the run",
          },
          facts: {
            compaction: {
              trigger: "completion",
              preTokens: outcome.preTokens,
              postTokens: outcome.postTokens,
            },
            costAddUsd: 0.5,
          },
          occurredAt,
        });
      }
      return outcome;
    },
    start(spec, callbacks) {
      startedSpecs.push(spec);
      return playFakeRun(spec, callbacks, queued[backend].shift());
    },
  };
}

function playFakeRun(
  spec: RunSpec,
  callbacks: RunCallbacks,
  queuedRun?: FakeRun,
): RunHandle {
  const sessionId = queuedRun?.sessionId ?? spec.resumeSessionId ?? `fake-${spec.runId}`;
  const lines = queuedRun?.lines ?? defaultLines(spec.backend, spec.prompt);
  let stopped = false;

  queueMicrotask(() => {
    if (stopped) return;
    for (const [index, line] of lines.entries()) {
      if (stopped) return;
      const occurredAt = queuedRun?.occurredAt?.[index] ?? new Date().toISOString();
      emit(spec, callbacks, line, sessionId, occurredAt, queuedRun?.extraFacts?.[index]);
    }
    if (!queuedRun?.keepRunning && !stopped) {
      stopped = true;
      callbacks.onExit({
        outcome: queuedRun?.outcome ?? inferOutcome(lines),
        effectiveBackend: spec.backend,
        sessionId,
      });
    }
  });

  return {
    runId: spec.runId,
    interrupt() {
      if (stopped) return;
      stopped = true;
      callbacks.onExit({
        outcome: "interrupted",
        effectiveBackend: spec.backend,
        sessionId,
      });
    },
  };
}

function emit(
  spec: RunSpec,
  callbacks: RunCallbacks,
  line: LogLine,
  sessionId: string,
  occurredAt: string,
  extraFacts?: EmittedLine["facts"],
): void {
  callbacks.onLine({
    raw: JSON.stringify({ type: "test", backend: spec.backend, line }),
    display: line,
    facts: { ...lineFacts(spec, line, sessionId), ...extraFacts },
    occurredAt,
  });
}

function lineFacts(spec: RunSpec, line: LogLine, sessionId: string): EmittedLine["facts"] {
  const usage = line.usage
    ? {
        input_tokens: line.usage.input_tokens,
        cached_input_tokens: line.usage.cached_input_tokens,
        output_tokens: line.usage.output_tokens,
        outputEstimated: false,
      }
    : (line.stats
      ? {
          input_tokens: line.stats.in ?? 0,
          cached_input_tokens: line.stats.cached ?? 0,
          output_tokens: line.stats.out ?? 0,
          outputEstimated: false,
        }
      : undefined);
  // Absence is the signal the fold reads (a fact the envelope did not carry is
  // left alone), so each key is set only when this line actually reports it.
  const facts: EmittedLine["facts"] = { sessionId, model: spec.model };
  if (usage) facts.usage = usage;
  if (line.stats?.cost !== undefined) facts.costUsd = line.stats.cost;
  if (line.stats?.turns !== undefined) facts.turns = line.stats.turns;
  if (line.ev === "result") facts.isResult = true;
  if (
    line.ev === "err" ||
    (line.ev === "result" && line.stats?.subtype && line.stats.subtype !== "success")
  ) {
    facts.isError = true;
  }
  return facts;
}

function inferOutcome(lines: LogLine[]): "finished" | "error" {
  const last = lines.at(-1);
  return last?.ev === "err" ||
    (last?.ev === "result" && last.stats?.subtype && last.stats.subtype !== "success")
    ? "error"
    : "finished";
}

/**
 * The reply a queue-less fake run emits.
 *
 * It used to echo the WHOLE prompt as the agent's message, which made every
 * test's cost scale with prompt length — and the completion pipeline then wrote
 * that entire prompt into the task file as an agent comment, re-parsed it, and
 * fanned out any `@handle` it happened to contain. P14-RT-02 grew fresh-run
 * prompts by ~600 chars (the asker's words + name), which is exactly the kind of
 * change that should not move test timings at all. A short, deterministic reply
 * that still carries the task key keeps the pipeline exercised without the
 * coupling. Tests needing specific reply text queue their own lines.
 */
function defaultLines(backend: RealBackend, prompt: string): LogLine[] {
  const key = /\b([A-Z][A-Z0-9]{1,5}-\d+)\b/.exec(prompt)?.[1] ?? "the task";
  const reply = `Looked at ${key} and reported back.`;
  return backend === "codex"
    ? [
        { t: "", ev: "init", tag: "thread.started", text: "test thread" },
        { t: "", ev: "text", tag: "agent_message", text: reply },
        { t: "", ev: "result", tag: "turn.completed", text: "done" },
      ]
    : [
        { t: "", ev: "init", tag: "system·init", text: "test session" },
        { t: "", ev: "text", tag: "assistant", text: reply },
        { t: "", ev: "result", tag: "result", text: "done" },
      ];
}
