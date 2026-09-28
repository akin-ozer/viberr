import { describe, expect, it } from "vitest";

import { closureRefusal, taskClosure } from "./task-closure.server";

const STAGES = [
  { id: "triage", name: "Triage" },
  { id: "impl", name: "Building" },
  { id: "review", name: "Review" },
  { id: "done", name: "Shipped" },
];

/**
 * Ruling 177 (pass 36): ONE predicate for "this task is closed", read by every
 * coordination door. Canary for each case: flip the matching branch in
 * `taskClosure`.
 */
describe("ruling 177: taskClosure is the one spelling of a closed task", () => {
  it("an open task at a working stage is not closed", () => {
    expect(taskClosure({ stage: "impl", archived: false }, STAGES)).toEqual({ closed: false });
    expect(taskClosure({ stage: "review" }, STAGES)).toEqual({ closed: false });
  });

  it("the terminal stage closes a task even when it is not archived", () => {
    expect(taskClosure({ stage: "done", archived: false }, STAGES)).toEqual({
      closed: true,
      why: "terminal",
      stageId: "done",
    });
  });

  it("archived closes a task at any stage, and wins over terminal in the reason", () => {
    expect(taskClosure({ stage: "impl", archived: true }, STAGES)).toEqual({
      closed: true,
      why: "archived",
      stageId: "impl",
    });
    expect(taskClosure({ stage: "done", archived: true }, STAGES)).toMatchObject({
      why: "archived",
    });
  });

  it("the terminal stage is the board's LAST stage, whatever it is named", () => {
    const renamed = [{ id: "a" }, { id: "b" }, { id: "shipped" }];
    expect(taskClosure({ stage: "shipped" }, renamed)).toMatchObject({ closed: true, why: "terminal" });
    expect(taskClosure({ stage: "done" }, renamed)).toEqual({ closed: false });
  });

  it("the refusal names the task, the reason and the verb, with the stage's display name", () => {
    expect(
      closureRefusal("VIB-9", { closed: true, why: "terminal", stageId: "done" }, STAGES, "running the operator on it"),
    ).toBe("VIB-9 is closed (Shipped is the terminal stage). Move it back to an open stage before running the operator on it.");
    expect(
      closureRefusal("VIB-9", { closed: true, why: "archived", stageId: "impl" }, STAGES, "running an agent on it"),
    ).toBe("VIB-9 is archived. Restore it before running an agent on it.");
  });
});
