import { describe, expect, it } from "vitest";
import {
  ALWAYS_HUMAN_CAPABILITY_IDS,
  capabilityById,
} from "~/shared/capabilities";
import {
  CAP_MODAL_CATALOG,
  CAP_MODAL_DEFAULTS,
  MODAL_CAP_IDS,
  OPERATOR_CAP_MODES,
  SPECIALIST_CAP_MODES,
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

  it("carries only runtime-consulted agent toggles (ruling 7 prune + generic-agents Collaboration)", () => {
    // The toggleable catalog holds ONLY ids whose mode is consulted at runtime:
    // 4 repo-enforced (create-task-branch, commit-push-branch,
    // execute-code-or-write-repo, open-review-pr) + 4 Collaboration gates
    // (comment-on-task, ask-human, report-validation-verdict — promoted from
    // decorative to real agent-toolkit gates by the generic-agents plan, D10 —
    // and attach-evidence-references, promoted the same way by P13-D-26 when
    // the `evidence:` block was wired) + 1 web-egress gate
    // (use-web-search-fetch, P13-LV-18) + 1 browser gate (use-browser, R19-19
    // — the mode decides whether the browser MCP server mounts at all) + 1
    // GitHub-read gate (read-github-api, F4 — the mode decides whether the
    // in-process github_read tool mounts) + 3 always-human.
    // The remaining advisory ids (read-task-repo, run-validation-suites,
    // approve-review, request-changes, …) still have no runtime effect and stay
    // matrix-only.
    expect(MODAL_CAP_IDS.size).toBe(14);
    expect([...MODAL_CAP_IDS].sort()).toEqual(
      [
        "ask-human",
        "attach-evidence-references",
        "change-project-policy",
        "comment-on-task",
        "commit-push-branch",
        "create-task-branch",
        "execute-code-or-write-repo",
        "merge-pull-request",
        "open-review-pr",
        "read-github-api",
        "use-browser",
        "use-web-search-fetch",
        "report-validation-verdict",
        "transition-to-done",
      ].sort(),
    );
    // The pruned fake toggles are still gone.
    for (const gone of [
      "read-task-repo",
      "approve-review",
      "request-changes",
      "move-task-to-review",
    ]) {
      expect(MODAL_CAP_IDS.has(gone)).toBe(false);
    }
    expect(CAP_MODAL_CATALOG.map((g) => g.group)).toEqual([
      "Repository & execution",
      "Collaboration",
      "Reserved for humans",
    ]);
    // G2/R2: verdict power is never seeded onto a casually-created profile —
    // the grant defaults OFF (the seed grants it to the reviewer explicitly).
    expect(CAP_MODAL_DEFAULTS["report-validation-verdict"]).toBe("off");
    // F4: authenticated GitHub reads are OFF by default — a casually created
    // profile must not silently acquire authenticated reach to a private repo.
    expect(CAP_MODAL_DEFAULTS["read-github-api"]).toBe("off");
    expect(CAP_MODAL_DEFAULTS["comment-on-task"]).toBe("direct");
    expect(CAP_MODAL_DEFAULTS["ask-human"]).toBe("direct");
    // XS-8: the enforced "write to the repo" capability is now expressible.
    expect(CAP_MODAL_DEFAULTS["execute-code-or-write-repo"]).toBe("direct");
    // R7-5: `open-review-pr` now defaults to `direct` ("Allowed") — the
    // specialist picker no longer offers `recommend`.
    expect(CAP_MODAL_DEFAULTS["open-review-pr"]).toBe("direct");
    expect(CAP_MODAL_DEFAULTS["merge-pull-request"]).toBe("human");
    // No specialist modal default may be `recommend` (an operator-only mode).
    expect(Object.values(CAP_MODAL_DEFAULTS)).not.toContain("recommend");
  });

  it("R7-5 — the specialist picker offers 3 honest modes, the operator keeps 4", () => {
    // The specialist collapses to Allowed/Human-only/Off — `recommend` is
    // operator-only (runtime-identical to `direct` for a specialist; F7-CAP1).
    expect(SPECIALIST_CAP_MODES.map((m) => m.id)).toEqual([
      "direct",
      "human",
      "off",
    ]);
    expect(SPECIALIST_CAP_MODES.map((m) => m.label)).toEqual([
      "Allowed",
      "Human-only",
      "Off",
    ]);
    expect(SPECIALIST_CAP_MODES.map((m) => m.id)).not.toContain("recommend");
    // The operator keeps all 4, where `recommend` has real propose-a-card
    // semantics.
    expect(OPERATOR_CAP_MODES.map((m) => m.id)).toEqual([
      "direct",
      "recommend",
      "human",
      "off",
    ]);
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
