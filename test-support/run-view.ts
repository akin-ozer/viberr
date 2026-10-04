import type { RunCacheView, RunView } from "~/features/runtime/runtime-types";

/** Ruling 369: the cache record of a run that has reported nothing yet. */
export const NO_RUN_CACHE: RunCacheView = {
  writeTokens: 0,
  readTokens: 0,
  firstCall: null,
  ttlBucket: null,
  peakPromptTokens: 0,
  lastPromptTokens: 0,
  compactions: 0,
};

/** A controller turn in flight, as the controller page's projection carries it:
 *  three turns in, one line in its console. */
export function controllerRun(patch: Partial<RunView> = {}): RunView {
  return {
    id: "controller",
    serverRunId: "run_ctl",
    role: "Controller",
    kind: "controller",
    profileId: "controller",
    who: { kind: "agent", backend: "claude", name: "Controller", role: "Controller" },
    backend: "claude",
    sdk: "Claude Agent SDK",
    model: "claude-opus-4-8",
    sid: "sess-ctl",
    exportable: false,
    state: "running",
    lifecycle: "running",
    interruptedBy: null,
    phase: "Working",
    step: "viberr_controller · list_tasks",
    startedAt: "2026-09-24T09:59:00.000Z",
    finished: null,
    turns: 3,
    tokens: 1200,
    tokensEstimated: false,
    cache: NO_RUN_CACHE,
    lines: [{ t: "10:00:01", ev: "text", tag: "assistant", text: "Reading the board." }],
    raw: ['{"type":"assistant"}'],
    lineCount: 1,
    logWindow: { totalLines: 1, hasMore: false, runIds: ["run_ctl"], oldest: null, headSeq: 0 },
    ...patch,
  };
}
