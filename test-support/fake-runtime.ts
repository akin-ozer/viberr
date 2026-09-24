import { AsyncLocalStorage, createHook } from "node:async_hooks";
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
import {
  configureRunServiceForTests,
  type RunCompletionCallback,
} from "~/server/runtimes/run-service.server";
import type { AdapterSet, RealBackend } from "~/server/runtimes/runtime-registry.server";

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
  /** Hold the run's lines (and its exit) until this settles, so a test can
   *  attach callbacks to the run id first. Absent: the run plays at once. */
  gate?: Promise<void>;
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

/**
 * The work a run's end sets off, which a test cannot await: the run service
 * settles the run and fires its completion callbacks, and a callback `void`s
 * its effects (the reply comment, the verdict, the operator react, a delivery
 * reconcile that runs git). A test that returns first has its cleanup close
 * the database under that chain: "database is not open", then the
 * effects-lost note failing on the same closed handle.
 *
 * So a fake run's exit, and every completion callback, runs in this context,
 * and `unsettled` holds each promise created in it until that promise settles.
 * `drainRunCompletions` waits for it to empty.
 */
const completionWork = new AsyncLocalStorage<true>();
const unsettled = new Set<number>();
const promiseTracker = createHook({
  init(asyncId, type) {
    if (type === "PROMISE" && completionWork.getStore()) unsettled.add(asyncId);
  },
  promiseResolve(asyncId) {
    if (unsettled.delete(asyncId) && unsettled.size === 0) queueMicrotask(stopWhenIdle);
  },
});

/** The hook costs every promise in the process a call, so it runs only while
 *  there is work to watch. The check waits a microtask, so the rest of the
 *  synchronous stretch that emptied the set is still watched. */
function stopWhenIdle(): void {
  if (unsettled.size === 0) promiseTracker.disable();
}

function asCompletionWork(work: () => void): void {
  promiseTracker.enable();
  completionWork.run(true, work);
}

/** `configureRunServiceForTests` keeps the run service's state on
 *  `globalThis` under this key (`SERVICE_KEY` in run-service.server.ts). */
const RUN_SERVICE_KEY = Symbol.for("viberr.runService");

/** The run service's completion registry, running each callback set on it as
 *  completion work. */
class TrackedCompletions extends Map<string, RunCompletionCallback> {
  override set(runId: string, callback: RunCompletionCallback): this {
    return super.set(runId, (finished) => asCompletionWork(() => callback(finished)));
  }
}

/**
 * Install `adapters` in the run service the way `installFakeRuntime` installs
 * the fakes, so every completion callback runs as work `drainRunCompletions`
 * waits for. For a test that brings its own adapter.
 */
export function installRunAdapters(adapters: AdapterSet): void {
  configureRunServiceForTests(adapters);
  // Both firing paths read this registry: the settle after a run's exit, and
  // `registerRunCompletion` itself when the run has already settled, which is
  // every fake run (it exits a microtask after it starts, before its caller
  // registers). The registry is the one place a callback can be wrapped from
  // outside the run service.
  const slot: Record<symbol, { completions?: unknown } | undefined> = globalThis;
  const state = slot[RUN_SERVICE_KEY];
  if (!(state?.completions instanceof Map)) {
    throw new Error(
      "the run service's completion registry moved; update installRunAdapters in test-support/fake-runtime.ts",
    );
  }
  state.completions = new TrackedCompletions(state.completions);
}

/**
 * Wait for the completion work in flight to finish, so a test's cleanup never
 * closes the database under it. Call it in `afterEach`, before cleanup. Past
 * `timeoutMs` it stops waiting rather than fail the test: a chain that never
 * settles then logs against the closed database, as every chain did before.
 */
export async function drainRunCompletions(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (unsettled.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  unsettled.clear();
  promiseTracker.disable();
}

export function installFakeRuntime(): void {
  queued.claude.length = 0;
  queued.codex.length = 0;
  startedSpecs.length = 0;
  queuedCompactions.claude.length = 0;
  queuedCompactions.codex.length = 0;
  compactedSpecs.length = 0;
  installRunAdapters({
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

  const play = () => {
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
  };
  const gate = queuedRun?.gate;
  queueMicrotask(() => {
    if (gate) void gate.then(() => asCompletionWork(play));
    else asCompletionWork(play);
  });

  return {
    runId: spec.runId,
    interrupt() {
      if (stopped) return;
      stopped = true;
      asCompletionWork(() =>
        callbacks.onExit({
          outcome: "interrupted",
          effectiveBackend: spec.backend,
          sessionId,
        }),
      );
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
