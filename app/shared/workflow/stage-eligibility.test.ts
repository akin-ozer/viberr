import { describe, expect, it } from "vitest";
import {
  boardStageRoles,
  declaredStageRole,
  resolveDeclaredStages,
  stageEligible,
} from "./stage-eligibility";

/**
 * R14-1 — a profile's declared stage ids must land on ANY board.
 *
 * The live failure this replaces: `Lightweight Lab` (ids `todo/doing/done`, from
 * the 3-stage preset deleted in pass 13) had a blocked task no agent could be
 * engaged on, because every deployed profile declares `ready`/`impl`/`review`
 * and none of those ids exist there. The operator could only report the dead
 * end — "No agent profile is eligible for this stage" — forever.
 */

const STANDARD = {
  stages: [
    { id: "triage" },
    { id: "ready" },
    { id: "impl" },
    { id: "review" },
    { id: "done" },
  ],
  workflow: [
    { from: "triage", to: "ready" },
    { from: "ready", to: "impl" },
    { from: "impl", to: "review" },
    { from: "review", to: "done" },
  ],
};

/** The dropped 3-stage preset, still live in projects created before pass 13. */
const LEGACY_THREE = {
  stages: [{ id: "todo" }, { id: "doing" }, { id: "done" }],
  workflow: [
    { from: "todo", to: "doing" },
    { from: "doing", to: "done" },
  ],
};

/** An admin renamed every stage — ids are arbitrary, the graph is the same. */
const RENAMED = {
  stages: [
    { id: "inbox" },
    { id: "planned" },
    { id: "build" },
    { id: "qa" },
    { id: "shipped" },
  ],
  workflow: [
    { from: "inbox", to: "planned" },
    { from: "planned", to: "build" },
    { from: "build", to: "qa" },
    { from: "qa", to: "shipped" },
  ],
};

describe("declaredStageRole", () => {
  it("maps the known vocabulary and nothing else", () => {
    expect(declaredStageRole("impl")).toBe("work");
    expect(declaredStageRole("doing")).toBe("work");
    expect(declaredStageRole("Review")).toBe("review"); // case-insensitive
    expect(declaredStageRole("done")).toBe("terminal");
    expect(declaredStageRole("triage")).toBe("entry");
    expect(declaredStageRole("bikeshedding")).toBeNull();
  });
});

describe("boardStageRoles", () => {
  it("reads the standard 5-stage board", () => {
    const roles = boardStageRoles(STANDARD.stages, STANDARD.workflow);
    expect([...(roles.get("triage") ?? [])]).toContain("entry");
    expect([...(roles.get("ready") ?? [])]).toContain("ready");
    expect([...(roles.get("impl") ?? [])]).toContain("work");
    expect([...(roles.get("review") ?? [])]).toContain("review");
    expect([...(roles.get("done") ?? [])]).toContain("terminal");
  });

  it("collapses work onto the review stage when the board is too short to separate them", () => {
    // `todo → doing → done`: the graph makes `todo` both entry and work, which
    // would leave an implementation agent eligible only for the inbox. `doing`
    // is where work happens on such a board, so it holds both roles.
    const roles = boardStageRoles(LEGACY_THREE.stages, LEGACY_THREE.workflow);
    expect([...(roles.get("doing") ?? [])]).toEqual(
      expect.arrayContaining(["review", "work"]),
    );
    expect([...(roles.get("done") ?? [])]).toContain("terminal");
    // No stage sits between entry and work, so nothing fills the `ready` role.
    for (const set of roles.values()) expect(set.has("ready")).toBe(false);
  });
});

describe("resolveDeclaredStages", () => {
  it("prefers a literal id match", () => {
    expect(resolveDeclaredStages(["ready", "impl"], STANDARD.stages, STANDARD.workflow)).toEqual([
      "ready",
      "impl",
    ]);
  });

  it("maps a standard-template profile onto a renamed board", () => {
    expect(resolveDeclaredStages(["impl", "review"], RENAMED.stages, RENAMED.workflow)).toEqual([
      "build",
      "qa",
    ]);
  });

  it("maps a standard-template profile onto the legacy 3-stage board", () => {
    // The LL-1 case. `impl` is the work role, which a 3-stage board spreads
    // across both non-terminal stages (`todo` by the graph, `doing` by the
    // collapse rule) — the same span a Developer holds on the standard board,
    // where it is eligible at Ready AND In Progress. What matters is that
    // `doing`, where the blocked task actually sits, is now reachable.
    expect(resolveDeclaredStages(["ready", "impl"], LEGACY_THREE.stages, LEGACY_THREE.workflow)).toEqual(
      ["todo", "doing"],
    );
    expect(resolveDeclaredStages(["ready", "impl"], LEGACY_THREE.stages, LEGACY_THREE.workflow)).not.toContain(
      "done",
    );
  });

  it("returns nothing when the declaration means nothing here", () => {
    expect(
      resolveDeclaredStages(["bikeshedding"], STANDARD.stages, STANDARD.workflow),
    ).toEqual([]);
  });

  it("returns board order, deduplicated", () => {
    expect(
      resolveDeclaredStages(["review", "impl", "impl"], STANDARD.stages, STANDARD.workflow),
    ).toEqual(["impl", "review"]);
  });
});

describe("stageEligible", () => {
  const dev = { stages: ["ready", "impl"], spanAll: false };

  it("holds the declared scope on its own board", () => {
    expect(stageEligible(dev, "impl", STANDARD.stages, STANDARD.workflow)).toBe(true);
    expect(stageEligible(dev, "review", STANDARD.stages, STANDARD.workflow)).toBe(false);
    expect(stageEligible(dev, "done", STANDARD.stages, STANDARD.workflow)).toBe(false);
  });

  it("makes the stranded legacy board workable again (the LL-1 regression)", () => {
    // Before R14-1 this was false for EVERY stage, so no agent could be engaged
    // and the task sat blocked with the operator reporting a dead end.
    expect(stageEligible(dev, "doing", LEGACY_THREE.stages, LEGACY_THREE.workflow)).toBe(true);
    expect(stageEligible(dev, "done", LEGACY_THREE.stages, LEGACY_THREE.workflow)).toBe(false);
  });

  it("follows a renamed board", () => {
    expect(stageEligible(dev, "build", RENAMED.stages, RENAMED.workflow)).toBe(true);
    expect(stageEligible(dev, "shipped", RENAMED.stages, RENAMED.workflow)).toBe(false);
  });

  it("treats spanAll and an empty declaration as unrestricted", () => {
    const anywhere = { stages: [], spanAll: false };
    expect(stageEligible(anywhere, "done", STANDARD.stages, STANDARD.workflow)).toBe(true);
    expect(
      stageEligible({ stages: ["impl"], spanAll: true }, "done", STANDARD.stages, STANDARD.workflow),
    ).toBe(true);
  });

  it("falls back to unrestricted when the declaration resolves to nothing (rule 3)", () => {
    // A profile scoped entirely to ids this board has never heard of says
    // nothing about this workflow. Silently disabling it everywhere is the
    // worse failure — and the one we actually shipped.
    const alien = { stages: ["bikeshedding", "yak-shaving"], spanAll: false };
    expect(stageEligible(alien, "impl", STANDARD.stages, STANDARD.workflow)).toBe(true);
    expect(stageEligible(alien, "done", STANDARD.stages, STANDARD.workflow)).toBe(true);
  });
});
