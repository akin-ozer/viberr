import { describe, expect, it } from "vitest";
import { createConsoleFolder, type ConsoleRow, type FoldLine } from "./console-fold";
import { collapseTelemetry } from "./log-noise";
import { foldWaits, groupThoughts, hoistRunInputs, type ConsoleBlock } from "./runs-helpers";
import { runBoundaryLine, RUN_INPUTS_TAG, TOOL_PROGRESS_TAG, type LogLine } from "./runtime-types";

/**
 * Ruling 454 (LIVE-4): the incremental fold draws exactly what the batch chain
 * the console used to run on every render draws, however the lines arrive.
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

function drawn(row: ConsoleRow<FoldLine> | ConsoleBlock<FoldLine>): DrawnRow {
  switch (row.kind) {
    case "line":
      return { kind: "line", line: row.line };
    case "telemetry":
      return { kind: "telemetry", count: row.count, tags: row.tags };
    default:
      return { kind: row.kind, lines: row.lines };
  }
}

function batch(lines: FoldLine[], raw: boolean) {
  return foldWaits(groupThoughts(collapseTelemetry(hoistRunInputs(lines), raw), raw), raw);
}

describe("createConsoleFolder (ruling 454, LIVE-4)", () => {
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
            batch(shown, raw).map(drawn),
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
    expect(folder.fold(b, false, 2).map(drawn)).toEqual(batch(b, false).map(drawn));
  });
});
