import { describe, expect, it } from "vitest";
import { diffRows, noteLine, noteRange } from "./diff-rows";

/**
 * Ruling 484: the Changes panel quotes a note's `file:line`, so each drawn row
 * must carry the number the line has in the file it belongs to: the new file
 * for an added or context line, the old one for a removed line.
 */
describe("ruling 484: diffRows numbers every line the way a note quotes it", () => {
  it("counts both sides from each hunk header", () => {
    const rows = diffRows(
      [
        "@@ -10,4 +10,5 @@ export function x() {",
        " keep",
        "-gone",
        "+new one",
        "+new two",
        " tail",
        "@@ -40,2 +41,2 @@",
        "-old",
        "+fresh",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    expect(rows).toEqual([
      { kind: "hunk", text: "@@ -10,4 +10,5 @@ export function x() {" },
      { kind: "ctx", oldLine: 10, newLine: 10, text: "keep" },
      { kind: "del", oldLine: 11, newLine: null, text: "gone" },
      { kind: "add", oldLine: null, newLine: 11, text: "new one" },
      { kind: "add", oldLine: null, newLine: 12, text: "new two" },
      { kind: "ctx", oldLine: 12, newLine: 13, text: "tail" },
      { kind: "hunk", text: "@@ -40,2 +41,2 @@" },
      { kind: "del", oldLine: 40, newLine: null, text: "old" },
      { kind: "add", oldLine: null, newLine: 41, text: "fresh" },
      { kind: "meta", text: "No newline at end of file" },
    ]);
  });

  it("reads a one-line hunk header (no counts) and a blank context line", () => {
    expect(diffRows("@@ -3 +3 @@\n\n+x")).toEqual([
      { kind: "hunk", text: "@@ -3 +3 @@" },
      { kind: "ctx", oldLine: 3, newLine: 3, text: "" },
      { kind: "add", oldLine: null, newLine: 4, text: "x" },
    ]);
  });

  it("invents no numbers under a header it cannot read", () => {
    expect(diffRows("@@ garbage @@\n+x")).toEqual([
      { kind: "hunk", text: "@@ garbage @@" },
      { kind: "add", oldLine: null, newLine: null, text: "x" },
    ]);
  });
});

/**
 * Ruling 509: a note may cover several lines. The panel asks `noteRange` which
 * rows a drag or a shift-click from one line towards another covers, so the
 * range never leaves its hunk and never shares a line with another note.
 */
describe("ruling 509: noteRange keeps a note's lines inside one hunk and off other notes", () => {
  const rows = diffRows(
    [
      "@@ -10,4 +10,5 @@",
      " keep", // 1: new 10
      "-gone", // 2: old 11
      "+new one", // 3: new 11
      "+new two", // 4: new 12
      " tail", // 5: new 13
      "@@ -40,2 +41,2 @@", // 6
      "-old", // 7: old 40
      "+fresh", // 8: new 41
      "\\ No newline at end of file", // 9
      "",
    ].join("\n"),
  );
  const free = () => false;
  /** The first and last row of a range, or null. */
  const span = (range: ReturnType<typeof noteRange>) => range && [range.start.row, range.end.row];

  it("quotes a removed line in the old file and every other line in the new one", () => {
    expect(rows.map(noteLine)).toEqual([
      null,
      { side: "new", line: 10 },
      { side: "old", line: 11 },
      { side: "new", line: 11 },
      { side: "new", line: 12 },
      { side: "new", line: 13 },
      null,
      { side: "old", line: 40 },
      { side: "new", line: 41 },
      null,
    ]);
  });

  it("runs from the first row to the second, whichever way the pointer went, and names both ends' lines", () => {
    expect(noteRange(rows, 2, 4, free)).toEqual({
      start: { row: 2, side: "old", line: 11 },
      end: { row: 4, side: "new", line: 12 },
    });
    expect(span(noteRange(rows, 4, 1, free))).toEqual([1, 4]);
    expect(span(noteRange(rows, 3, 3, free))).toEqual([3, 3]);
  });

  it("stops at the hunk's edge in either direction", () => {
    expect(span(noteRange(rows, 2, 8, free))).toEqual([2, 5]);
    expect(span(noteRange(rows, 8, 0, free))).toEqual([7, 8]);
  });

  it("passes over the no-newline marker but never ends on it", () => {
    expect(span(noteRange(rows, 7, 9, free))).toEqual([7, 8]);
  });

  it("stops before a line another note covers, and starts nowhere a note already is", () => {
    const taken = (row: number) => row === 4;
    expect(span(noteRange(rows, 1, 5, taken))).toEqual([1, 3]);
    expect(span(noteRange(rows, 5, 1, taken))).toEqual([5, 5]);
    expect(noteRange(rows, 4, 1, taken)).toBeNull();
  });

  it("starts nowhere a note cannot sit", () => {
    expect(noteRange(rows, 0, 3, free)).toBeNull();
    expect(noteRange(rows, 9, 7, free)).toBeNull();
    expect(noteRange(diffRows("@@ garbage @@\n+x\n+y"), 1, 2, free)).toBeNull();
  });
});
