import { describe, expect, it } from "vitest";
import {
  ALWAYS_HUMAN_CAPABILITY_IDS,
  capabilityById,
} from "~/shared/capabilities";
import {
  CAP_MODAL_CATALOG,
  CAP_MODAL_DEFAULTS,
  MODAL_CAP_IDS,
} from "./capability-catalog";
import { capabilitiesToActionLabels } from "./agents-query.server";

describe("CAP_MODAL_CATALOG (ruling 7 — id-based against the shared catalog)", () => {
  it("every modal capability id exists in CAP_CATALOG with the identical label", () => {
    for (const group of CAP_MODAL_CATALOG) {
      for (const cap of group.caps) {
        const shared = capabilityById(cap.id);
        expect(shared, `missing shared capability ${cap.id}`).not.toBeNull();
        expect(cap.label).toBe(shared!.label);
      }
    }
  });

  it("carries the curated specialist capability set with its default modes", () => {
    // 17 after the role-bindings prune removed `edit-other-task-branch` (F11:
    // moot + harmful under per-task workspace isolation).
    expect(MODAL_CAP_IDS.size).toBe(17);
    expect(MODAL_CAP_IDS.has("edit-other-task-branch")).toBe(false);
    expect(CAP_MODAL_CATALOG.map((g) => g.group)).toEqual([
      "Repository & execution",
      "Validation & review",
      "Workflow & approvals",
    ]);
    // Spot-check the mock's defaults (agents spec §3.6).
    expect(CAP_MODAL_DEFAULTS["read-task-repo"]).toBe("direct");
    expect(CAP_MODAL_DEFAULTS["open-review-pr"]).toBe("recommend");
    expect(CAP_MODAL_DEFAULTS["merge-pull-request"]).toBe("human");
  });

  it("the always-human invariant ids are all in the modal catalog, defaulted human", () => {
    for (const id of ALWAYS_HUMAN_CAPABILITY_IDS) {
      expect(MODAL_CAP_IDS.has(id)).toBe(true);
      expect(CAP_MODAL_DEFAULTS[id]).toBe("human");
    }
  });
});

describe("capabilitiesToActionLabels", () => {
  it("renders catalog labels from ids and appends extras per bucket", () => {
    const buckets = capabilitiesToActionLabels(
      [
        { capabilityId: "author-test-cases", mode: "direct" },
        { capabilityId: "attach-evidence-references", mode: "direct" },
        { capabilityId: "report-validation-verdict", mode: "recommend" },
        { capabilityId: "merge-pull-request", mode: "human" },
        { capabilityId: "transition-to-done", mode: "human" },
      ],
      [{ label: "Run the validation suite", mode: "direct" }],
    );
    expect(buckets.direct).toEqual([
      "Author test cases",
      "Attach evidence references",
      "Run the validation suite",
    ]);
    expect(buckets.recommend).toEqual(["Report a validation verdict"]);
    expect(buckets.forbidden).toEqual([
      "Merge a pull request",
      "Transition a task to Done",
    ]);
  });

  it("keeps unknown capability ids tolerantly (renders the id)", () => {
    const buckets = capabilitiesToActionLabels(
      [{ capabilityId: "not-a-real-cap", mode: "direct" }],
      [],
    );
    expect(buckets.direct).toEqual(["not-a-real-cap"]);
  });
});
