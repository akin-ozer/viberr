import { describe, expect, it } from "vitest";
import {
  consoleCodeBlock,
  diffLineKind,
  fileChangeChips,
  fmtClock,
  fmtTok,
  groupThoughts,
  hoistRunInputs,
  roleShort,
  runInputRows,
  runLabel,
  runStatePill,
  RUN_STATE,
  thoughtLabel,
  toolChip,
} from "./runs-helpers";
import {
  runBoundaryLine,
  RUN_BOUNDARY_TAG,
  RUN_INPUTS_TAG,
  type LogLine,
  type RunInputs,
  type RunView,
} from "./runtime-types";

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

// ------------------------------------------------------------------- P19-G11

const emptyInputs: RunInputs = {
  cwd: "/data/projects/p/tasks/VIB-1/workspace/widgets",
  repo: "acme/widgets",
  cloned: true,
  delivers: true,
  personaChars: 0,
  promptChars: 4200,
  anchor: null,
  skills: { granted: [], native: [], injected: [] },
  knowledge: [],
  mcp: { mounted: [], unresolved: [], unhealthy: [] },
  unresolvedResources: [],
  tools: { denied: [], toolkit: [] },
  directive: null,
};

const inputsLine = (inputs: RunInputs): LogLine => ({
  t: "10:00:00",
  ev: "meta",
  tag: RUN_INPUTS_TAG,
  text: "Run inputs — …",
  inputs,
});

describe("hoistRunInputs (P19-G11)", () => {
  const row = (display: LogLine) => ({ display, raw: "{}" });
  const other = (tag: string): LogLine => ({ t: "10:00:01", ev: "text", tag, text: tag });

  it("moves the disclosure to the head of the block it is already in", () => {
    // It is written the instant startRun returns — chronologically first — but
    // by a different writer than the sink, so its seq is only first if the
    // provider has not emitted yet. The console's answer to "what was this run
    // given?" must not depend on that start-up race.
    // Canary: return `[...rows]` from hoistRunInputs and the order below flips.
    const out = hoistRunInputs([
      row(other("system·init")),
      row(inputsLine(emptyInputs)),
      row(other("agent_message")),
    ]);
    expect(out.map((r) => r.display.tag)).toEqual([
      RUN_INPUTS_TAG,
      "system·init",
      "agent_message",
    ]);
  });

  it("keeps each run's disclosure inside its OWN block across a resume boundary", () => {
    // UI-53 concatenates every run of one agent group into one console, so a
    // single hoist-to-the-top would attach run 2's inputs to run 1.
    const out = hoistRunInputs([
      row(other("run-1-line")),
      row(runBoundaryLine(2, 2)),
      row(other("run-2-line")),
      row(inputsLine(emptyInputs)),
    ]);
    expect(out.map((r) => r.display.tag)).toEqual([
      "run-1-line",
      RUN_BOUNDARY_TAG,
      RUN_INPUTS_TAG,
      "run-2-line",
    ]);
  });

  it("is a pass-through when no run carries a disclosure", () => {
    const rows = [row(other("a")), row(other("b"))];
    expect(hoistRunInputs(rows).map((r) => r.display.tag)).toEqual(["a", "b"]);
  });
});

describe("runInputRows (P19-G11)", () => {
  it("states an EMPTY grant explicitly rather than dropping the row", () => {
    // The whole point is to make an absence visible: a knowledge base that
    // reached no run is exactly what this surface exists to catch, and a row
    // that vanishes when it has nothing to say cannot report one.
    // Canary: skip the empty rows and the two assertions below fail.
    const rows = runInputRows(emptyInputs);
    const byTag = Object.fromEntries(rows.map((r) => [r.tag, r.text]));
    expect(byTag.knowledge).toBe("none granted");
    expect(byTag.skills).toBe("none granted");
    expect(byTag.anchor).toContain("No canonical task state was sent");
    expect(byTag.persona).toContain("no persona was sent");
  });

  it("carries the canonical anchor verbatim, with its line breaks intact", () => {
    const anchor = "## Canonical task state\n\n### Goal (canonical)\nShip the CURRENT goal.";
    const rows = runInputRows({ ...emptyInputs, anchor });
    const row = rows.find((r) => r.tag === "anchor")!;
    expect(row.text).toBe(anchor);
    expect(row.pre).toBe(true);
  });

  it("separates a skill that MOUNTED from one that rode the prompt", () => {
    const rows = runInputRows({
      ...emptyInputs,
      skills: {
        granted: ["commits", "review-craft"],
        native: ["commits"],
        injected: ["review-craft"],
      },
    });
    const text = rows.find((r) => r.tag === "skills")!.text;
    expect(text).toContain("mounted into the workspace: commits");
    expect(text).toContain("carried as prompt text instead: review-craft");
  });

  it("names an MCP grant that resolved to nothing and one whose probe failed", () => {
    const rows = runInputRows({
      ...emptyInputs,
      mcp: { mounted: ["github"], unresolved: ["vm-memory"], unhealthy: ["broken-mcp"] },
      unresolvedResources: [{ name: "house-style", reason: "no such knowledge base" }],
    });
    const byTag = Object.fromEntries(rows.map((r) => [r.tag, r.text]));
    expect(byTag.mcp).toContain("granted but NOT mounted (no such server): vm-memory");
    expect(byTag.mcp).toContain("last connection check failed: broken-mcp");
    expect(byTag.missing).toContain("house-style (no such knowledge base)");
  });
});


/* ------------------------------------------------------------------ P19-RC1
 *
 * The console projected `think` / `tool` / `out` / `diff` and painted them all
 * as the same flat row. These fold that structure back out — and every one of
 * them must be a NO-OP under `raw`, whose contract is "what the provider sent".
 */

const L = (over: Partial<LogLine> = {}): LogLine => ({
  t: "10:00:00",
  ev: "text",
  tag: "agent_message",
  text: "hello",
  ...over,
});
const R = (display: LogLine, raw = "{}") => ({ display, raw });
const line = <T,>(l: T) => ({ kind: "line" as const, line: l });

describe("groupThoughts (P19-RC1)", () => {
  it("folds a RUN of reasoning lines into one block", () => {
    const a = R(L({ ev: "think", text: "step one" }), "{a}");
    const b = R(L({ ev: "think", text: "step two" }), "{b}");
    const out = groupThoughts([line(a), line(b)], false);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("thought");
    if (out[0]!.kind === "thought") expect(out[0]!.lines).toEqual([a, b]);
  });

  it("does NOT fold across the work between two thoughts", () => {
    // Thought → acted → thought is the real shape of the turn. One merged
    // block would tell the reader the agent thought once.
    const out = groupThoughts(
      [
        line(R(L({ ev: "think", text: "before" }))),
        line(R(L({ ev: "tool", tag: "tool_use", name: "Bash", text: "npm test" }))),
        line(R(L({ ev: "think", text: "after" }))),
      ],
      false,
    );
    expect(out.map((b) => b.kind)).toEqual(["line", "line", "line"]);
  });

  it("leaves a LONE reasoning line as an ordinary row", () => {
    // A "1 step" disclosure would hide a line behind a click for nothing.
    const out = groupThoughts([line(R(L({ ev: "think" })))], false);
    expect(out.map((b) => b.kind)).toEqual(["line"]);
  });

  it("is a NO-OP under raw — the stored stream is never reshaped", () => {
    const entries = [
      line(R(L({ ev: "think", text: "one" }))),
      line(R(L({ ev: "think", text: "two" }))),
    ];
    expect(groupThoughts(entries, true)).toEqual(entries);
  });

  it("carries telemetry blocks through untouched", () => {
    const tele = { kind: "telemetry" as const, count: 3, tags: ["token_count"] };
    expect(groupThoughts([tele], false)).toEqual([tele]);
  });
});

describe("thoughtLabel (P19-RC1)", () => {
  it("MEASURES the span from the stored clocks", () => {
    expect(
      thoughtLabel([R(L({ t: "10:00:01" })), R(L({ t: "10:00:05" }))]),
    ).toBe("Thought for 4s · 2 steps");
  });

  it("omits a duration it cannot measure rather than inventing one", () => {
    // Same second, unreadable clock, or a midnight wrap: say the step count and
    // stop. A fabricated "4s" because it reads better is the exact
    // invented-signal failure this codebase keeps ruling out.
    expect(thoughtLabel([R(L({ t: "10:00:02" })), R(L({ t: "10:00:02" }))])).toBe(
      "Thought · 2 steps",
    );
    expect(thoughtLabel([R(L({ t: "nope" })), R(L({ t: "10:00:05" }))])).toBe(
      "Thought · 2 steps",
    );
    expect(thoughtLabel([R(L({ t: "23:59:59" })), R(L({ t: "00:00:03" }))])).toBe(
      "Thought · 2 steps",
    );
  });
});

describe("toolChip (P19-RC1)", () => {
  it("promotes the tool's own name and target", () => {
    expect(toolChip(L({ ev: "tool", name: "Bash", text: "npm run build" }))).toEqual({
      name: "Bash",
      detail: "npm run build",
    });
  });

  it("declines anything that is not a named tool call", () => {
    // No name = nothing the provider actually reported; a chip labelled with a
    // guess is worse than the plain row.
    expect(toolChip(L({ ev: "tool", text: "no name" }))).toBeNull();
    expect(toolChip(L({ ev: "text", name: "Bash" }))).toBeNull();
  });
});

describe("fileChangeChips (P19-RC1)", () => {
  it("reports the path and the KIND the envelope recorded", () => {
    const chips = fileChangeChips(
      L({
        ev: "diff",
        changes: [
          { path: "app/a.ts", kind: "add" },
          { path: "app/b.ts", kind: "delete" },
        ],
      }),
    );
    expect(chips).toEqual([
      { path: "app/a.ts", kind: "add" },
      { path: "app/b.ts", kind: "delete" },
    ]);
    // Deliberately no line counts: `changes` carries a path and a kind, so a
    // "+74 −41" beside it would be invented.
    expect(JSON.stringify(chips)).not.toMatch(/[+-]\d/);
  });

  it("is null when the line recorded no changes", () => {
    expect(fileChangeChips(L({ ev: "diff" }))).toBeNull();
    expect(fileChangeChips(L({ ev: "diff", changes: [] }))).toBeNull();
  });
});

describe("consoleCodeBlock (P19-RC1)", () => {
  it("lifts MULTI-line output and diffs out of the row", () => {
    expect(consoleCodeBlock(L({ ev: "out", text: "a\nb" }))).toEqual({
      code: "a\nb",
      diff: false,
    });
    expect(consoleCodeBlock(L({ ev: "diff", text: "+a\n-b" }))).toEqual({
      code: "+a\n-b",
      diff: true,
    });
  });

  it("leaves a single line inline, and other kinds alone", () => {
    expect(consoleCodeBlock(L({ ev: "out", text: "built in 1.2s" }))).toBeNull();
    expect(consoleCodeBlock(L({ ev: "text", text: "a\nb" }))).toBeNull();
  });

  it("never truncates — the whole output is the block's content", () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    expect(consoleCodeBlock(L({ ev: "out", text: long }))!.code).toBe(long);
  });
});

describe("diffLineKind (P19-RC1)", () => {
  it("marks adds and removals, and spares the file headers", () => {
    expect(diffLineKind("+ added")).toBe("add");
    expect(diffLineKind("- removed")).toBe("del");
    expect(diffLineKind(" context")).toBeNull();
    // `+++ b/file` / `--- a/file` are headers, not content.
    expect(diffLineKind("+++ b/app/a.ts")).toBeNull();
    expect(diffLineKind("--- a/app/a.ts")).toBeNull();
  });
});
