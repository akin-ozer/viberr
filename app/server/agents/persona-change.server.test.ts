import { describe, expect, it } from "vitest";
import { describePersonaChange } from "./persona-change.server";

/**
 * Ruling 467: the reply to a persona edit names the length before and after
 * and the first and last changed lines, and never shortens a line without
 * saying so.
 */
describe("describePersonaChange (ruling 467)", () => {
  it("says nothing for an unchanged persona", () => {
    expect(describePersonaChange("same", "same")).toBeNull();
  });

  it("names one changed range, however far it is from the ends", () => {
    const before = ["a", "b", "c", "d", "e"].join("\n");
    const after = ["a", "B", "c", "D", "e"].join("\n");
    // CANARY: compare lines from the front only and the unchanged `e` is
    // counted into the range.
    expect(describePersonaChange(before, after)).toBe(
      '9 → 9 characters; lines 2-4 of 5 changed: first "b" → "B"; last "d" → "D"',
    );
  });

  it("reads an insertion and a removal as what they are", () => {
    expect(describePersonaChange("a\nc", "a\nb\nc")).toBe(
      '3 → 5 characters; line 2 of 3 changed: first (none) → "b"',
    );
    expect(describePersonaChange("a\nb\nc", "a\nc")).toBe(
      '5 → 3 characters; 1 line removed after line 1: first "b" → (none)',
    );
  });

  it("says when it cut a quoted line", () => {
    const long = "x".repeat(200);
    const text = describePersonaChange("short", long)!;
    // CANARY: drop the note and a clipped quote reads as the whole line.
    expect(text).toContain(`"${"x".repeat(120)}…"`);
    expect(text).toContain("the whole persona was written");
    expect(describePersonaChange("short", "tall")).not.toContain("the whole persona was written");
  });
});
