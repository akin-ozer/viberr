import { isTelemetryLine } from "./log-noise";
import { isThoughtLine } from "./runs-helpers";
import { isRunBoundary, isRunInputsLine, isWaitLine, type LogLine } from "./runtime-types";

/**
 * Ruling 457 (LIVE-4): the console's four folds, applied incrementally.
 *
 * What the console draws: each run's `run·inputs` line moved to the head of
 * its block (P19-G11), then telemetry runs collapsed into one row (P14-WL-02),
 * reasoning runs into one disclosure (P19-RC1) and a call's heartbeats into one
 * wait row (ruling 366) — every fold but the move a no-op under `raw`. Run as a
 * batch chain from scratch on every appended line, that was work that grew
 * with the console's history. Every one of those folds merges a line only into
 * the row drawn LAST, so an appended line can be folded onto the rows already
 * drawn; only two changes start over: a `run·inputs` line arriving after its
 * block already has rows (it moves to the block's head, so the block is folded
 * again, once per run) and anything that is not an append (a backward page, a
 * new window, the raw toggle), which folds everything.
 *
 * The result is exactly the batch chain's (console-fold.test.ts keeps that
 * chain as its oracle and proves it on random consoles), with one addition:
 * every row carries a `key`, its first line's key, which is what the console
 * keys the row and its disclosure by.
 */

/** A console line as the fold reads it: its key and its display projection. */
export interface FoldLine {
  key: string;
  display: LogLine;
}

export type ConsoleRow<T extends FoldLine> =
  | { kind: "line"; key: string; line: T }
  | { kind: "telemetry"; key: string; count: number; tags: string[] }
  | { kind: "thought"; key: string; lines: T[] }
  | { kind: "wait"; key: string; lines: T[] };

export interface ConsoleFolder<T extends FoldLine> {
  /**
   * The rows `lines` draws, `raw` or not. Cheap to call again with the same
   * arguments; an append costs the appended lines. `epoch` names the buffer
   * the lines belong to: the caller changes it whenever the buffer changed in
   * any way other than lines appended at its end (a new window, a backward
   * page, envelopes filled in), and everything is folded again.
   */
  fold(lines: readonly T[], raw: boolean, epoch: number): readonly ConsoleRow<T>[];
}

export function createConsoleFolder<T extends FoldLine>(): ConsoleFolder<T> {
  let seen: readonly T[] = [];
  let seenRaw = false;
  let seenEpoch = Number.NaN;
  let rows: ConsoleRow<T>[] = [];
  let result: readonly ConsoleRow<T>[] = [];
  /** `rows.length` where the current run block's rows begin. */
  let blockStart = 0;
  /** The current block's lines in arrival order (its boundary excluded). */
  let block: T[] = [];
  /** How many of those are `run·inputs` lines (they sit at the block's head). */
  let blockInputs = 0;

  const push = (line: T, raw: boolean) => {
    const display = line.display;
    const last = rows[rows.length - 1];
    if (raw) {
      rows.push({ kind: "line", key: line.key, line });
      return;
    }
    if (isTelemetryLine(display)) {
      if (last?.kind === "telemetry") {
        rows[rows.length - 1] = {
          kind: "telemetry",
          key: last.key,
          count: last.count + 1,
          tags: last.tags.includes(display.tag) ? last.tags : [...last.tags, display.tag],
        };
      } else {
        rows.push({ kind: "telemetry", key: line.key, count: 1, tags: [display.tag] });
      }
      return;
    }
    if (isThoughtLine(display)) {
      // A lone thought draws as a plain line; the second one makes it a fold.
      if (last?.kind === "thought") {
        rows[rows.length - 1] = { kind: "thought", key: last.key, lines: [...last.lines, line] };
        return;
      }
      if (last?.kind === "line" && isThoughtLine(last.line.display)) {
        rows[rows.length - 1] = { kind: "thought", key: last.key, lines: [last.line, line] };
        return;
      }
      rows.push({ kind: "line", key: line.key, line });
      return;
    }
    if (isWaitLine(display)) {
      // Keyed on the call, not on adjacency: two calls back to back are two
      // waits. A single heartbeat still folds; it is a call still open.
      if (last?.kind === "wait" && last.lines[0]!.display.progress?.call === display.progress?.call) {
        rows[rows.length - 1] = { kind: "wait", key: last.key, lines: [...last.lines, line] };
      } else {
        rows.push({ kind: "wait", key: line.key, lines: [line] });
      }
      return;
    }
    rows.push({ kind: "line", key: line.key, line });
  };

  /** Folds the current block's lines onto `rows[0, blockStart)`, inputs first
   *  (each one moved to the head in turn, so the newest first). The inputs
   *  line is written by another writer than the provider's stream, so where it
   *  lands in the stored order is a start-up race; drawn at its block's head,
   *  "what was this run given?" reads the same every time (P19-G11). */
  const refoldBlock = (raw: boolean) => {
    rows.length = blockStart;
    const inputs = block.filter((l) => isRunInputsLine(l.display)).reverse();
    for (const line of inputs) push(line, raw);
    for (const line of block) if (!isRunInputsLine(line.display)) push(line, raw);
  };

  const append = (line: T, raw: boolean) => {
    if (isRunBoundary(line.display)) {
      push(line, raw);
      blockStart = rows.length;
      block = [];
      blockInputs = 0;
      return;
    }
    block.push(line);
    if (isRunInputsLine(line.display)) {
      blockInputs += 1;
      // Already at the head: nothing but inputs came before it in its block.
      if (block.length === blockInputs && blockInputs === 1) {
        push(line, raw);
        return;
      }
      refoldBlock(raw);
      return;
    }
    push(line, raw);
  };

  const reset = () => {
    rows = [];
    blockStart = 0;
    block = [];
    blockInputs = 0;
  };

  return {
    fold(lines, raw, epoch) {
      if (lines === seen && raw === seenRaw && epoch === seenEpoch) return result;
      const appended =
        raw === seenRaw &&
        epoch === seenEpoch &&
        lines.length >= seen.length &&
        (seen.length === 0 || lines[seen.length - 1] === seen[seen.length - 1]);
      if (!appended) reset();
      for (let i = appended ? seen.length : 0; i < lines.length; i++) append(lines[i]!, raw);
      seen = lines;
      seenRaw = raw;
      seenEpoch = epoch;
      result = rows.slice();
      return result;
    },
  };
}
