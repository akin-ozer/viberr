import { describe, expect, it } from "vitest";
import {
  canonicalDependencyRef,
  formatDependencyRef,
  parseDependencyRef,
  splitDependencyText,
} from "./dependencies";

/**
 * Ruling 131 (pass 34): `blockedBy` has one spelling, a task key. Everything
 * the writers refuse by name starts here, so the grammar is pinned tightly.
 * Ruling 503 retired the second spelling, `goal-1 link 3`, with the chains.
 *
 * Canary: loosen `TASK_REF_RE` (drop its anchors, or narrow `\d+` to `\d`)
 * and the "nothing else" / two-digit cases below fail.
 */
describe("dependency references — the task key and nothing else", () => {
  it("parses a task key, canonicalizing the prefix", () => {
    expect(parseDependencyRef("JC-6")).toEqual({ kind: "task", task: "JC-6" });
    expect(parseDependencyRef(" jc-6 ")).toEqual({ kind: "task", task: "JC-6" });
    expect(parseDependencyRef("JC-06")).toEqual({ kind: "task", task: "JC-6" });
  });

  it("ruling 503: a goal link is no longer a spelling", () => {
    // CANARY: bring `GOAL_LINK_RE` back into `parseDependencyRef`.
    expect(parseDependencyRef("goal-1 link 3")).toBeNull();
    expect(parseDependencyRef("Goal-1   Link 12")).toBeNull();
    // A two-digit key parses whole.
    expect(parseDependencyRef("JC-12")).toEqual({ kind: "task", task: "JC-12" });
  });

  it("refuses everything else", () => {
    for (const bad of [
      "",
      "   ",
      "goal-1 link",
      "goal-1 link three",
      "JC-6 and JC-7",
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
    for (const text of ["JC-6", "AX-120"]) {
      const ref = parseDependencyRef(text)!;
      expect(formatDependencyRef(ref)).toBe(text);
      expect(canonicalDependencyRef(text)).toBe(text);
    }
    expect(canonicalDependencyRef("jc-6")).toBe("JC-6");
    expect(canonicalDependencyRef("nope")).toBeNull();
  });

  it("splits the editor's free text on newlines and commas", () => {
    expect(splitDependencyText("JC-6, AX-12\n\n JC-7 ,")).toEqual([
      "JC-6",
      "AX-12",
      "JC-7",
    ]);
  });
});

import { holdEntriesSentence, holdRefusal, type DependencyRender } from "./dependencies";

const entry = (label: string, state: DependencyRender["state"]): DependencyRender => ({
  ref: label,
  label,
  state,
  // The resolver's shape: a task ref is its own key, and a missing one has none.
  taskKey: state === "missing" ? null : label,
});

/**
 * Ruling 355 (pass 38, F38-9): the hold sentence promises a release only when
 * one can come. The release engine writes "can never complete … edit what it
 * waits on" for a failed or missing entry, and this sentence stood
 * beside it on the same task promising "Viberr releases it when every entry
 * is done" — structurally unreachable for such an entry.
 */
describe("ruling 355: holdRefusal names an entry that can never complete", () => {
  it("keeps the release promise while every entry can still complete", () => {
    expect(holdRefusal("JC-9", [entry("JC-3", "open")], "running an agent on it")).toContain(
      "Viberr releases it when every entry is done",
    );
  });

  it("replaces the promise with the edit the person has to make when an entry is dead", () => {
    // CANARY: ignore the entries' states.
    const s = holdRefusal(
      "JC-9",
      [entry("JC-3", "failed"), entry("JC-8", "open")],
      "running an agent on it",
    );
    expect(s).toContain("running an agent on it is refused");
    expect(s).toContain("JC-3 can never complete, so Viberr will not release it on its own");
    expect(s).toContain("edit what it waits on");
    expect(s).not.toContain("releases it when every entry is done");
  });

  it("a missing entry can never complete either", () => {
    expect(holdRefusal("JC-9", [entry("JC-40", "missing")], "running an agent on it")).toContain(
      "JC-40 can never complete",
    );
  });
});

/**
 * Ruling 356 (pass 38, F38-10): a hold releases as a whole, so the stored list
 * keeps an entry after the task it names is done — and every sentence built
 * from the bare labels named it as still waited on, beside a rail marking it
 * done. The states are on the entries; the sentence reads them.
 */
describe("ruling 356: the hold sentence names a done entry as done, not as waited on", () => {
  it("lists an all-open hold as before", () => {
    expect(holdEntriesSentence([entry("JC-2", "open"), entry("JC-3", "open")])).toBe("JC-2 and JC-3");
    expect(holdEntriesSentence([entry("JC-3", "open")])).toBe("JC-3");
  });

  it("names what still holds the task, then the finished entries as finished", () => {
    // CANARY: drop the `state === "done"` split.
    expect(
      holdEntriesSentence([
        entry("BNB-2", "done"),
        entry("BNB-4", "open"),
        entry("BNB-11", "done"),
      ]),
    ).toBe("BNB-4, BNB-2 (done) and BNB-11 (done)");
    expect(holdEntriesSentence([entry("JC-2", "open"), entry("JC-3", "done")])).toBe("JC-2 and JC-3 (done)");
  });

  it("F39-44: a done entry's tag never reads as the pending entry before it", () => {
    // Live on ax-clone's Goals rail: the trailing `(… is done)` group read as
    // the LAST pending entry's own parenthesis, so "goal-1 link 2 (JC-3 is
    // done)" said the PENDING entry was done. The chains are gone (ruling 503);
    // the rule stands for task keys.
    // CANARY: restore the trailing group, `${pending} (${done} are done)`.
    const s = holdEntriesSentence([
      entry("AX-7", "open"),
      entry("AX-4", "done"),
      entry("AX-16", "done"),
    ]);
    expect(s).toBe("AX-7, AX-4 (done) and AX-16 (done)");
    // No parenthesis opens straight after the pending entry.
    expect(s).not.toMatch(/AX-7 \(/);
    // Every entry that is done says so inside its own parenthesis.
    for (const label of ["AX-4", "AX-16"]) {
      expect(s).toMatch(new RegExp(`${label} \\([^)]*done\\)`));
    }
  });

  it("lists an all-done hold plainly: the release sweep is on its way", () => {
    expect(holdEntriesSentence([entry("JC-3", "done"), entry("JC-4", "done")])).toBe("JC-3 and JC-4");
  });

  it("the refusal reads the same split and keeps its release promise", () => {
    const s = holdRefusal("BNB-3", [entry("BNB-4", "open"), entry("BNB-11", "done")], "running an agent on it");
    expect(s).toContain(
      "BNB-3 waits on BNB-4 and BNB-11 (done) and Viberr is holding it, so running an agent on it is refused.",
    );
    // The done entry is never listed as something still waited on.
    expect(s).not.toMatch(/BNB-11(?! \(done\))/);
    expect(s).toContain("Viberr releases it when every entry is done");
  });

  it("a dead entry still decides the tail", () => {
    const s = holdRefusal("BNB-3", [entry("BNB-4", "failed"), entry("BNB-11", "done")], "running an agent on it");
    expect(s).toContain("waits on BNB-4 and BNB-11 (done)");
    expect(s).toContain("BNB-4 can never complete");
  });
});
