import { describe, expect, it } from "vitest";
import { fmtClock, fmtTok, roleShort, runLabel, runStatePill, RUN_STATE } from "./runs-helpers";
import type { RunView } from "./runtime-types";

const base: RunView = {
  id: "primary", serverRunId: "run_1", role: "Primary specialist", kind: "primary",
  profileId: "developer",
  who: { kind: "agent", backend: "codex", name: "Codex", role: "Developer" },
  backend: "codex", sdk: "Codex SDK", model: "gpt-5.4-codex", sid: "0199", exportable: false,
  state: "running", lifecycle: "running", interruptedBy: null, phase: null, step: null,
  startedAt: null, finished: null, turns: 0, tokens: 0, lines: [], raw: [], lineCount: 0,
  logWindow: { totalLines: 0, hasMore: false, runIds: ["run_1"], oldest: null, headSeq: -1 },
};

describe("fmtClock boundaries (runs.md §7)", () => {
  it("402 → 06:42, 5462 → 1:31:02 (hours unpadded)", () => {
    expect(fmtClock(402)).toBe("06:42");
    expect(fmtClock(5462)).toBe("1:31:02");
    expect(fmtClock(0)).toBe("00:00");
  });
});

describe("fmtTok boundaries (runs.md §7)", () => {
  it("999→999, 1000→1.0k, 99999→100.0k, 100000→100k, 128442→128k", () => {
    expect(fmtTok(999)).toBe("999");
    expect(fmtTok(1000)).toBe("1.0k");
    expect(fmtTok(38400)).toBe("38.4k");
    expect(fmtTok(99999)).toBe("100.0k");
    expect(fmtTok(100000)).toBe("100k");
    expect(fmtTok(128442)).toBe("128k");
  });
});

describe("runLabel / roleShort", () => {
  it("runLabel = who.name (+ role)", () => {
    expect(runLabel(base)).toBe("Codex · Developer");
    expect(runLabel({ ...base, op: true, who: { kind: "agent", name: "Operator" } })).toBe("Operator");
  });
  it("roleShort speaks engagement vocabulary: operator / delivering / supporting", () => {
    // UXV19-3: the run picker printed the internal RunKind literal "primary"
    // for the delivering run — a third name for the agent the Execution
    // profile on the SAME page calls "Delivering agent" and the Agents roster
    // calls "delivering" (F10-20's mapping). The kind literals stay on the row.
    // Canary: restore `kind === "primary" ? "primary" : "reviewer"` and both
    // halves below fail.
    expect(roleShort({ ...base, op: true })).toBe("operator");
    expect(roleShort(base)).toBe("delivering");
    // `kind: "reviewer"` is what EVERY non-delivering run is written with
    // (specialist-run.server.ts), so the label is the honest superset.
    expect(roleShort({ ...base, kind: "reviewer" })).toBe("supporting");
    // Kind is data on the run row — the role label is free-form (live
    // engagement role), so roleShort keys on kind, never the label.
    expect(roleShort({ ...base, kind: "reviewer", role: "Anything" })).toBe("supporting");
  });
});

describe("runStatePill (ruling 11 lifecycle mapping)", () => {
  it("running/idle/done/error use RUN_STATE", () => {
    expect(runStatePill({ ...base, state: "done", lifecycle: "finished" }).label).toBe(RUN_STATE.done.label);
    expect(runStatePill({ ...base, state: "error", lifecycle: "error" }).label).toBe("continuity error");
  });
  it("queued → neutral 'queued'", () => {
    expect(runStatePill({ ...base, state: "idle", lifecycle: "queued" })).toEqual({ kind: "neutral", label: "queued" });
  });
  it("interrupted → neutral 'interrupted · by <actor>'", () => {
    const p = runStatePill({ ...base, state: "idle", lifecycle: "interrupted", interruptedBy: { userId: "u1", label: "Arda Kaya" } });
    expect(p.kind).toBe("neutral");
    expect(p.label).toBe("interrupted · by Arda");
  });
});
