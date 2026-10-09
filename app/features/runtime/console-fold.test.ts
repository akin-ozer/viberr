import { describe, expect, it } from "vitest";
import { createConsoleFolder, type ConsoleRow, type FoldLine } from "./console-fold";
import { isTelemetryLine } from "./log-noise";
import { isThoughtLine } from "./runs-helpers";
import {
  isRunBoundary,
  isRunInputsLine,
  isWaitLine,
  runBoundaryLine,
  RUN_INPUTS_TAG,
  TOOL_PROGRESS_TAG,
  type LogLine,
} from "./runtime-types";

/**
 * Ruling 11 (LIVE-4): the incremental fold draws exactly what the batch chain
 * the console used to run on every render draws, however the lines arrive. The
 * chain lives on below as the oracle; the console itself only ever runs the
 * incremental fold.
 */

const INPUTS: NonNullable<LogLine["inputs"]> = {
  cwd: null,
  repo: null,
  cloned: false,
  delivers: true,
  personaChars: 0,
  promptChars: 0,
  anchor: null,
  skills: { granted: [], native: [], injected: [] },
  knowledge: [],
  mcp: { mounted: [], unresolved: [], unhealthy: [] },
  unresolvedResources: [],
  tools: { denied: [], toolkit: [] },
  directive: null,
};

/** A small deterministic generator, so a failure names its seed. */
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function line(kind: number, i: number): FoldLine {
  const key = `k${i}`;
  switch (kind) {
    case 0:
      return { key, display: { t: "1", ev: "meta", tag: "system·thinking_tokens", text: "{}" } };
    case 1:
      return { key, display: { t: "1", ev: "meta", tag: "rate_limit_event", text: "{}" } };
    case 2:
      return { key, display: { t: "1", ev: "think", tag: "thinking", text: `t${i}` } };
    case 3:
      return {
        key,
        display: {
          t: "1",
          ev: "meta",
          tag: TOOL_PROGRESS_TAG,
          text: "",
          name: "Bash",
          progress: { call: i % 2 ? "a" : "b", elapsed: 30, heartbeat: true, at: null },
        },
      };
    case 4:
      return { key, display: { t: "1", ev: "meta", tag: RUN_INPUTS_TAG, text: "given", inputs: INPUTS } };
    case 5:
      return { key, display: runBoundaryLine(2, 3) };
    default:
      return { key, display: { t: "1", ev: "text", tag: "assistant", text: `x${i}` } };
  }
}

/** What a row draws, in the terms both folds share: its kind and the line
 *  objects it holds (the incremental fold adds a key the batch chain lacks). */
type DrawnRow =
  | { kind: "line"; line: FoldLine }
  | { kind: "telemetry"; count: number; tags: string[] }
  | { kind: "thought" | "wait"; lines: FoldLine[] };

function drawn(row: ConsoleRow<FoldLine>): DrawnRow {
  switch (row.kind) {
    case "line":
      return { kind: "line", line: row.line };
    case "telemetry":
      return { kind: "telemetry", count: row.count, tags: row.tags };
    default:
      return { kind: row.kind, lines: row.lines };
  }
}

/* The oracle: the batch chain, each fold over the whole console. Every fold
   but the hoist is a no-op under `raw`. */

/** P19-G11: each run's `run·inputs` line to the head of its own block. */
function hoistRunInputs(lines: readonly FoldLine[]): FoldLine[] {
  const out: FoldLine[] = [];
  let blockStart = 0;
  for (const line of lines) {
    if (isRunBoundary(line.display)) {
      out.push(line);
      blockStart = out.length;
      continue;
    }
    if (isRunInputsLine(line.display)) {
      out.splice(blockStart, 0, line);
      continue;
    }
    out.push(line);
  }
  return out;
}

/** P14-WL-02: a run of telemetry lines into one row that counts them. */
function collapseTelemetry(lines: readonly FoldLine[], raw: boolean): DrawnRow[] {
  if (raw) return lines.map((line) => ({ kind: "line", line }));
  const out: DrawnRow[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (!isTelemetryLine(line.display)) {
      out.push({ kind: "line", line });
    } else if (last?.kind === "telemetry") {
      last.count += 1;
      if (!last.tags.includes(line.display.tag)) last.tags.push(line.display.tag);
    } else {
      out.push({ kind: "telemetry", count: 1, tags: [line.display.tag] });
    }
  }
  return out;
}

/** P19-RC1: a run of thoughts into one block; a lone thought stays a line. */
function groupThoughts(rows: readonly DrawnRow[], raw: boolean): DrawnRow[] {
  if (raw) return [...rows];
  const out: DrawnRow[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (row.kind !== "line" || !isThoughtLine(row.line.display)) {
      out.push(row);
    } else if (last?.kind === "thought") {
      last.lines.push(row.line);
    } else {
      out.push({ kind: "thought", lines: [row.line] });
    }
  }
  return out.map((row): DrawnRow =>
    row.kind === "thought" && row.lines.length === 1 ? { kind: "line", line: row.lines[0]! } : row,
  );
}

/** Ruling 168: one call's consecutive heartbeats into one wait row. */
function foldWaits(rows: readonly DrawnRow[], raw: boolean): DrawnRow[] {
  if (raw) return [...rows];
  const out: DrawnRow[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (row.kind !== "line" || !isWaitLine(row.line.display)) {
      out.push(row);
    } else if (
      last?.kind === "wait" &&
      last.lines[0]!.display.progress?.call === row.line.display.progress?.call
    ) {
      last.lines.push(row.line);
    } else {
      out.push({ kind: "wait", lines: [row.line] });
    }
  }
  return out;
}

function batch(lines: readonly FoldLine[], raw: boolean): DrawnRow[] {
  return foldWaits(groupThoughts(collapseTelemetry(hoistRunInputs(lines), raw), raw), raw);
}

describe("createConsoleFolder (ruling 11, LIVE-4)", () => {
  it("draws what the batch chain draws, line by line and in bursts, on 300 random consoles", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = random(seed);
      const lines = Array.from({ length: 60 }, (_, i) => line(Math.floor(next() * 9), i));
      for (const raw of [false, true]) {
        const folder = createConsoleFolder<FoldLine>();
        let at = 0;
        while (at < lines.length) {
          at = Math.min(lines.length, at + 1 + Math.floor(next() * 4));
          const shown = lines.slice(0, at);
          const rows = folder.fold(shown, raw, 1);
          expect(rows.map(drawn), `seed ${seed}, raw ${raw}, ${at} lines`).toEqual(
            batch(shown, raw),
          );
        }
      }
    }
  });

  it("keys every row by its first line, and keeps a drawn row's object when a line is appended", () => {
    const folder = createConsoleFolder<FoldLine>();
    const lines = [line(9, 0), line(2, 1), line(2, 2), line(9, 3)];
    const first = folder.fold(lines, false, 1);
    expect(first.map((r) => r.key)).toEqual(["k0", "k1", "k3"]);
    const second = folder.fold([...lines, line(9, 4)], false, 1);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
    expect(second.map((r) => r.key)).toEqual(["k0", "k1", "k3", "k4"]);
  });

  it("folds everything again when the buffer's epoch moves (a backward page, envelopes filled in)", () => {
    const folder = createConsoleFolder<FoldLine>();
    const a = [line(9, 0), line(9, 1)];
    folder.fold(a, false, 1);
    // The same last line object, but the buffer changed under it.
    const b = [line(2, 5), line(2, 6), a[1]!];
    expect(folder.fold(b, false, 2).map(drawn)).toEqual(batch(b, false));
  });
});

/** A named line: its key is its name, so a drawn row reads by the names. */
const named = (key: string, display: LogLine): FoldLine => ({ key, display });
const said = (key: string) => named(key, { t: "1", ev: "text", tag: "assistant", text: key });
const thought = (key: string) => named(key, { t: "1", ev: "think", tag: "thinking", text: key });
const toolCall = (key: string) =>
  named(key, { t: "1", ev: "tool", tag: "tool_use", name: "Bash", text: "npm test" });
const beat = (key: string, call: string) =>
  named(key, {
    t: "1",
    ev: "meta",
    tag: TOOL_PROGRESS_TAG,
    text: "",
    name: "Bash",
    progress: { call, elapsed: 30, heartbeat: true, at: null },
  });
const telemetry = (key: string, tag = "rate_limit_event") =>
  named(key, { t: "1", ev: "meta", tag, text: "{}" });

/** Each row in one word: a line's key, a fold's kind and what it holds. */
function labels(rows: readonly ConsoleRow<FoldLine>[]): string[] {
  return rows.map((row) => {
    switch (row.kind) {
      case "line":
        return row.line.key;
      case "telemetry":
        return `telemetry ${row.count} (${row.tags.join(", ")})`;
      default:
        return `${row.kind} ${row.lines.map((l) => l.key).join(" ")}`;
    }
  });
}

/**
 * What each fold draws, pinned on the folder the console runs rather than
 * only through the oracle above.
 */
describe("the console's four folds, as the folder draws them", () => {
  const CASES: [name: string, lines: FoldLine[], raw: boolean, rows: string[]][] = [
    // P19-G11: into its OWN block — UI-53 draws every run of a group in one
    // console, so a hoist to the top would give run 2's inputs to run 1.
    [
      "a run's inputs lead their own block, across a resume boundary",
      [
        said("run-1"),
        named("resumed", runBoundaryLine(2, 2)),
        said("run-2"),
        named("inputs", { t: "1", ev: "meta", tag: RUN_INPUTS_TAG, text: "given", inputs: INPUTS }),
      ],
      false,
      ["run-1", "resumed", "inputs", "run-2"],
    ],
    // P19-RC1: thought → acted → thought is the turn's real shape, and a
    // "1 step" disclosure would hide a line behind a click for nothing.
    ["a run of thoughts folds into one block", [thought("t1"), thought("t2")], false, ["thought t1 t2"]],
    ["a lone thought stays a line", [thought("t1")], false, ["t1"]],
    [
      "the work between two thoughts splits them",
      [thought("t1"), toolCall("npm"), thought("t2")],
      false,
      ["t1", "npm", "t2"],
    ],
    // Ruling 168: keyed on the call, not on adjacency; a single heartbeat still
    // folds, and one that never got its structured field is the meta line it is.
    [
      "one call's heartbeats fold into one wait row",
      [toolCall("call"), beat("h1", "a"), beat("h2", "a"), said("done"), beat("h3", "b")],
      false,
      ["call", "wait h1 h2", "done", "wait h3"],
    ],
    ["two calls back to back stay two waits", [beat("h1", "a"), beat("h2", "b")], false, ["wait h1", "wait h2"]],
    [
      "a heartbeat without its figure stays a line",
      [named("bare", { t: "1", ev: "meta", tag: TOOL_PROGRESS_TAG, text: "{…}" })],
      false,
      ["bare"],
    ],
    // P14-WL-02: a telemetry run is one row that counts it; nothing is reordered.
    [
      "a run of telemetry folds into one row with its count and tags",
      [
        said("a"),
        telemetry("m1", "system·thinking_tokens"),
        telemetry("m2", "system·thinking_tokens"),
        telemetry("m3"),
        toolCall("npm"),
      ],
      false,
      ["a", "telemetry 3 (system·thinking_tokens, rate_limit_event)", "npm"],
    ],
    [
      "separate telemetry runs fold separately",
      [telemetry("m1"), said("a"), telemetry("m2")],
      false,
      ["telemetry 1 (rate_limit_event)", "a", "telemetry 1 (rate_limit_event)"],
    ],
    // `{ } raw` is what the provider sent: no fold reshapes it.
    [
      "raw folds nothing",
      [thought("t1"), thought("t2"), beat("h1", "a"), beat("h2", "a"), telemetry("m1"), telemetry("m2")],
      true,
      ["t1", "t2", "h1", "h2", "m1", "m2"],
    ],
  ];

  it.each(CASES)("%s", (_name, lines, raw, rows) => {
    expect(labels(createConsoleFolder<FoldLine>().fold(lines, raw, 1))).toEqual(rows);
  });
});
