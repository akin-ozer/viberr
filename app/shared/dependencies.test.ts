import { describe, expect, it } from "vitest";
import {
  canonicalDependencyRef,
  formatDependencyRef,
  parseDependencyList,
  parseDependencyRef,
  splitDependencyText,
} from "./dependencies";

/**
 * Ruling 131 (pass 34): `blockedBy` has exactly TWO spellings. Everything the
 * writers refuse by name starts here, so the grammar is pinned tightly.
 *
 * Canary: widen `GOAL_LINK_RE` to `\s*link\s*` (or narrow its quantifier to
 * `\d`) and the "nothing else" / two-digit cases below fail.
 */
describe("dependency references — the two spellings and nothing else", () => {
  it("parses a task key, canonicalizing the prefix", () => {
    expect(parseDependencyRef("JC-6")).toEqual({ kind: "task", task: "JC-6" });
    expect(parseDependencyRef(" jc-6 ")).toEqual({ kind: "task", task: "JC-6" });
    expect(parseDependencyRef("JC-06")).toEqual({ kind: "task", task: "JC-6" });
  });

  it("parses a goal link, canonicalizing the goal id and the index", () => {
    expect(parseDependencyRef("goal-1 link 3")).toEqual({ kind: "goal", goal: "goal-1", link: 3 });
    expect(parseDependencyRef("Goal-1   Link 12")).toEqual({ kind: "goal", goal: "goal-1", link: 12 });
  });

  it("refuses everything else", () => {
    for (const bad of [
      "",
      "   ",
      "goal-1",
      "goal-1 link",
      "goal-1 link 0",
      "goal-1 link three",
      "goal-1 link 3 and JC-6",
      "link 3",
      "#6",
      "JC 6",
      "JC-",
      "https://github.com/x/y/pull/6",
    ]) {
      expect(parseDependencyRef(bad), bad).toBeNull();
    }
  });

  it("formats the canonical spelling and round-trips it", () => {
    for (const text of ["JC-6", "goal-1 link 3"]) {
      const ref = parseDependencyRef(text)!;
      expect(formatDependencyRef(ref)).toBe(text);
      expect(canonicalDependencyRef(text)).toBe(text);
    }
    expect(canonicalDependencyRef("jc-6")).toBe("JC-6");
    expect(canonicalDependencyRef("nope")).toBeNull();
  });

  it("parses a whole list: dedupes after canonicalizing and names the first bad entry", () => {
    expect(parseDependencyList(["jc-6", "JC-6", "goal-1 link 3"])).toEqual({
      refs: ["JC-6", "goal-1 link 3"],
      invalid: null,
    });
    expect(parseDependencyList(["JC-6", "goal-1 link", "JC-7"])).toEqual({
      refs: ["JC-6"],
      invalid: "goal-1 link",
    });
  });

  it("splits the editor's free text on newlines and commas", () => {
    expect(splitDependencyText("JC-6, goal-1 link 3\n\n JC-7 ,")).toEqual([
      "JC-6",
      "goal-1 link 3",
      "JC-7",
    ]);
  });
});
