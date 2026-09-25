import { describe, expect, it } from "vitest";
import { diffRows } from "./diff-rows";

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
