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

import { deadDependencyLabels, holdRefusal } from "./dependencies";

/**
 * Ruling 355 (pass 38, F38-9): the hold sentence promises a release only when
 * one can come. The release engine writes "can never complete … edit what it
 * waits on" for a failed, missing or cancelled entry, and this sentence stood
 * beside it on the same task promising "Viberr releases it when every entry
 * is done" — structurally unreachable for such an entry.
 */
describe("ruling 355: holdRefusal names an entry that can never complete", () => {
  it("keeps the release promise while every entry can still complete", () => {
    expect(holdRefusal("JC-9", ["JC-3"], "running an agent on it")).toContain(
      "Viberr releases it when every entry is done",
    );
  });

  it("replaces the promise with the edit the person has to make when an entry is dead", () => {
    // CANARY: ignore `dead`.
    const s = holdRefusal("JC-9", ["JC-3", "goal-1 link 2"], "running an agent on it", ["JC-3"]);
    expect(s).toContain("running an agent on it is refused");
    expect(s).toContain("JC-3 can never complete, so Viberr will not release it on its own");
    expect(s).toContain("edit what it waits on");
    expect(s).not.toContain("releases it when every entry is done");
  });

  it("deadDependencyLabels reads the entries' states", () => {
    const entries = [
      { ref: "JC-3", label: "JC-3", state: "cancelled" as const, taskKey: "JC-3", goalId: null },
      { ref: "JC-4", label: "JC-4", state: "open" as const, taskKey: "JC-4", goalId: null },
      { ref: "goal-1 link 2", label: "goal-1 link 2", state: "missing" as const, taskKey: null, goalId: "goal-1" },
    ];
    expect(deadDependencyLabels(entries)).toEqual(["JC-3", "goal-1 link 2"]);
  });
});
