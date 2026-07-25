import type { LogLine } from "~/features/runtime/runtime-types";
import type {
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
  backend?: RealBackend;
  occurredAt?: string[];
  sessionId?: string;
  keepRunning?: boolean;
  outcome?: "finished" | "error";
}

const queued: Record<RealBackend, FakeRun[]> = { claude: [], codex: [] };

/**
 * Every `RunSpec` the fake adapters were started with, in order. Lets a test
 * assert what a code path actually SENT to the runtime — the prompt, the
 * denylist, the mounted MCP servers — instead of only what it returned. Reset by
 * `installFakeRuntime`.
 */
const startedSpecs: RunSpec[] = [];

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
  configureRunServiceForTests({
    claude: createFakeAdapter("claude"),
    codex: createFakeAdapter("codex"),
  });
}

function createFakeAdapter(backend: RealBackend): RuntimeAdapter {
  return {
    backend,
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
      emit(spec, callbacks, line, sessionId, occurredAt);
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
): void {
  callbacks.onLine({
    raw: JSON.stringify({ type: "test", backend: spec.backend, line }),
    display: line,
    facts: lineFacts(spec, line, sessionId),
    occurredAt,
  });
}

function lineFacts(spec: RunSpec, line: LogLine, sessionId: string): EmittedLine["facts"] {
  const usage = line.usage ??
    (line.stats
      ? {
          input_tokens: line.stats.in ?? 0,
          cached_input_tokens: line.stats.cached ?? 0,
          output_tokens: line.stats.out ?? 0,
        }
      : undefined);
  return {
    sessionId,
    model: spec.model,
    ...(usage ? { usage } : {}),
    ...(line.stats?.cost !== undefined ? { costUsd: line.stats.cost } : {}),
    ...(line.stats?.turns !== undefined ? { turns: line.stats.turns } : {}),
    ...(line.ev === "result" ? { isResult: true } : {}),
    ...(line.ev === "err" ||
    (line.ev === "result" && line.stats?.subtype && line.stats.subtype !== "success")
      ? { isError: true }
      : {}),
  };
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
