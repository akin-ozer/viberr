import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveRunLogStore, type ConsoleThreadInput } from "./run-log-store";
import {
  NO_RUN_CACHE,
  type LogLine,
  type RunLiveFacts,
  type RunLogWindow,
} from "./runtime-types";

/**
 * The run-log store on its own (ruling 454): what it asks `/resources/run-log`
 * for and what it holds afterwards, for the paths a page drives without a
 * console on screen (a strip's run, a revalidation, a resume, the raw toggle).
 * The console-level behaviour is in `use-run-log-stream.test.tsx` and
 * `runs-panels.test.tsx`.
 */

const TASK = { kind: "task", projectSlug: "p", taskKey: "K-1" } as const;
/** `since` past every line: the store's facts-only read. */
const FACTS_ONLY = `since=${Number.MAX_SAFE_INTEGER}`;

const line = (text: string): LogLine => ({ t: "09:41:00", ev: "text", tag: "assistant", text });

const FACTS: RunLiveFacts = {
  phase: "Working",
  step: null,
  turns: 1,
  tokens: 100,
  tokensEstimated: true,
  cache: NO_RUN_CACHE,
};

const win = (patch: Partial<RunLogWindow> = {}): RunLogWindow => ({
  totalLines: 0,
  hasMore: false,
  runIds: ["run_1"],
  oldest: null,
  headSeq: -1,
  ...patch,
});

function thread(patch: Partial<ConsoleThreadInput> = {}): ConsoleThreadInput {
  return { id: "primary", serverRunId: "run_1", lines: [], raw: [], logWindow: win(), ...FACTS, ...patch };
}

/** A thread whose window the page carried: `n` lines of run_1, seq 0…n-1. */
function loaded(n: number, patch: Partial<ConsoleThreadInput> = {}): ConsoleThreadInput {
  const seqs = Array.from({ length: n }, (_, i) => i);
  return thread({
    lines: seqs.map((s) => line(`l${s}`)),
    lineKeys: seqs.map((s) => `0:${s}`),
    logWindow: win({ headSeq: n - 1, totalLines: n }),
    ...patch,
  });
}

/** One `/resources/run-log` answer, as much of a `Response` as the store reads. */
interface Answer {
  ok: boolean;
  status: number;
  json: () => Promise<{ data: object }>;
}
const ok = (data: object): Answer => ({ ok: true, status: 200, json: async () => ({ data }) });

const tailPage = (
  runId: string,
  seqs: number[],
  extra: { facts?: RunLiveFacts; raw?: boolean } = {},
): Answer =>
  ok({
    runId,
    state: "running",
    lines: seqs.map((seq) => ({ seq, display: line(`${runId}:${seq}`), ...(extra.raw ? { raw: `{"n":${seq}}` } : {}) })),
    headSeq: seqs.at(-1) ?? -1,
    oldestSeq: seqs[0] ?? -1,
    hasMore: false,
    ...(extra.facts ? { facts: extra.facts } : {}),
  });

/**
 * `fetch`, answered by the first route whose pattern the URL contains; a
 * route answering a function is called per request, so a test can hold one in
 * flight. Every URL asked is recorded.
 */
let asked: string[] = [];
let routes: [string, Answer | (() => Promise<Answer>)][] = [];
function route(pattern: string, answer: Answer | (() => Promise<Answer>)) {
  routes = [[pattern, answer], ...routes.filter(([p]) => p !== pattern)];
}
/** A route's next answer, held until the test releases it. */
function held(pattern: string): (answer: Answer) => void {
  let release: (answer: Answer) => void = () => {};
  route(pattern, () => new Promise<Answer>((resolve) => (release = resolve)));
  return (answer) => release(answer);
}

beforeEach(() => {
  asked = [];
  routes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      const hit = routes.find(([pattern]) => url.includes(pattern));
      if (!hit) return { ok: false, status: 599, json: async () => ({}) };
      const answer = hit[1];
      return typeof answer === "function" ? answer() : answer;
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function flush(times = 12) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("CON-1: every running group's strip moves, shown or not (ruling 454, LIVE-1)", () => {
  it("a frame for a thread the console never showed reads that run's facts", async () => {
    const store = createLiveRunLogStore(TASK, [
      loaded(2, { id: "op", serverRunId: "run_op" }),
      thread({ id: "spec", serverRunId: "run_spec", logWindow: win({ runIds: ["run_spec"], headSeq: 2, totalLines: 3, loaded: false }) }),
    ]);
    store.show("op");
    route("runId=run_spec&" + FACTS_ONLY, tailPage("run_spec", [], { facts: { ...FACTS, step: "Bash · npm test", turns: 5 } }));
    // CANARY: let `onFrame` only raise `announced` on a thread that is not
    // `ready` and the strip keeps the loader's turns (1) for the whole run.
    store.onFrame("run_spec", 3);
    await flush();
    expect(store.facts("run_spec")).toMatchObject({ step: "Bash · npm test", turns: 5 });
    // A facts read brings no lines, and loads no window nobody opened.
    expect(asked).toEqual([`/resources/run-log?runId=run_spec&${FACTS_ONLY}&raw=0`]);
    expect(store.thread("spec")?.status).toBe("unloaded");
  });

  it("one facts read in flight per thread, and one more for the frames it missed", async () => {
    const store = createLiveRunLogStore(TASK, [
      thread({ id: "spec", serverRunId: "run_spec", logWindow: win({ runIds: ["run_spec"], headSeq: 2, loaded: false }) }),
    ]);
    const release = held(FACTS_ONLY);
    for (const seq of [3, 4, 5, 6]) store.onFrame("run_spec", seq);
    await flush();
    expect(asked).toHaveLength(1);
    route(FACTS_ONLY, tailPage("run_spec", [], { facts: { ...FACTS, turns: 3 } }));
    release(tailPage("run_spec", [], { facts: { ...FACTS, turns: 2 } }));
    await flush();
    expect(asked).toHaveLength(2);
    expect(store.facts("run_spec")?.turns).toBe(3);
  });
});
