/**
 * Pass-9 use-case regression suite.
 *
 * A DEDICATED, runnable encoding of the logic-testable slice of the Phase-2
 * test cases documented in `docs/pass9-test-cases.md` (TC-01 … TC-26). The
 * end-to-end cases (operator selection, delivery, PR merge/reject, RBAC UI,
 * @mention resume) were validated live against akin-ozer/viberr with real
 * agents; the pure-logic invariants behind them are pinned here so they can't
 * silently regress. Each `it` names the TC id it covers.
 */
import { describe, expect, it } from "vitest";
import {
  capabilityEnforcement,
  normalizeDeliveryGrants,
} from "~/shared/capabilities";
import { resolveDeliveryPermissions } from "~/server/tasks/specialist-tool-policy";
import { resolveAgentCollab } from "~/server/tasks/agent-outcome.server";
import { classifyReviewerVerdict } from "~/server/tasks/task-actions.server";

const g = (capabilityId: string, mode: string) => ({ capabilityId, mode }) as {
  capabilityId: string;
  mode: "direct" | "recommend" | "human" | "off";
};

/** The seed developer's delivery grant shape (headline direct + scoped direct). */
const DEVELOPER_DELIVERY = [
  g("execute-code-or-write-repo", "direct"),
  g("create-task-branch", "direct"),
  g("commit-push-branch", "direct"),
  g("open-review-pr", "direct"),
  g("comment-on-task", "direct"),
  g("ask-human", "direct"),
  g("report-validation-verdict", "off"),
];

/** The seed reviewer's grant shape (verdict on, delivery withheld). */
const REVIEWER_GRANTS = [
  g("execute-code-or-write-repo", "off"),
  g("create-task-branch", "off"),
  g("commit-push-branch", "human"),
  g("open-review-pr", "off"),
  g("comment-on-task", "direct"),
  g("ask-human", "direct"),
  g("report-validation-verdict", "direct"),
];

describe("Pass-9 use cases — delivery capability model (TC-05, TC-20, TC-21)", () => {
  it("TC-21: a deliverer with scoped grants but the headline OFF is repaired to deliver", () => {
    const contradictory = [
      g("execute-code-or-write-repo", "off"),
      g("create-task-branch", "direct"),
      g("commit-push-branch", "direct"),
      g("open-review-pr", "direct"),
    ];
    const repaired = normalizeDeliveryGrants(contradictory);
    expect(
      repaired.find((c) => c.capabilityId === "execute-code-or-write-repo")?.mode,
    ).toBe("direct");
    // …and the repaired deliverer can actually deliver.
    const perms = resolveDeliveryPermissions(repaired);
    expect(perms).toEqual({ canBranch: true, canCommitPush: true, canOpenPr: true });
  });

  it("TC-21: the headline OFF is the master gate — it vetoes ALL scoped delivery", () => {
    // The failure the seed developer hit live (VIB-1): scoped grants direct but
    // the headline withheld ⇒ no delivery at all.
    const perms = resolveDeliveryPermissions([
      g("execute-code-or-write-repo", "off"),
      g("create-task-branch", "direct"),
      g("commit-push-branch", "direct"),
      g("open-review-pr", "direct"),
    ]);
    expect(perms).toEqual({ canBranch: false, canCommitPush: false, canOpenPr: false });
  });

  it("TC-21: a granted developer delivers; a reviewer never delivers", () => {
    expect(resolveDeliveryPermissions(DEVELOPER_DELIVERY)).toEqual({
      canBranch: true,
      canCommitPush: true,
      canOpenPr: true,
    });
    expect(resolveDeliveryPermissions(REVIEWER_GRANTS)).toEqual({
      canBranch: false,
      canCommitPush: false,
      canOpenPr: false,
    });
  });

  it("TC-21: normalize leaves a reviewer (no actionable scoped delivery) untouched", () => {
    expect(normalizeDeliveryGrants(REVIEWER_GRANTS)).toEqual(REVIEWER_GRANTS);
  });

  it("TC-20: repo-write caps are enforced on Claude only (honest Codex-advisory label)", () => {
    for (const id of [
      "execute-code-or-write-repo",
      "create-task-branch",
      "commit-push-branch",
      "open-review-pr",
    ]) {
      expect(capabilityEnforcement(id)).toBe("claude-only");
    }
    // Always-human structural locks bind on BOTH backends.
    expect(capabilityEnforcement("merge-pull-request")).toBe("both");
  });
});

describe("Pass-9 use cases — reviewer verdict gating (TC-08, TC-09)", () => {
  it("TC-08: a reviewer's report-validation-verdict grant resolves verdict-capable", () => {
    const collab = resolveAgentCollab(REVIEWER_GRANTS, /* delivers */ false);
    expect(collab.verdict).toBe(true);
    expect(collab.comment).toBe(true);
    expect(collab.ask).toBe(true);
  });

  it("TC-08: a DELIVERING developer without the verdict grant can NOT flip validation (R1/R2)", () => {
    const collab = resolveAgentCollab(DEVELOPER_DELIVERY, /* delivers */ true);
    expect(collab.verdict).toBe(false);
  });

  it("TC-09: prose verdict classifier — reject / approve / ambiguous(null, fail-safe)", () => {
    expect(classifyReviewerVerdict("Verdict: request_changes — the parser drops errors.")).toBe(
      "request_changes",
    );
    expect(classifyReviewerVerdict("# Verdict: approve\nLGTM, no blockers.")).toBe("approve");
    // A thorough approval that merely MENTIONS failure words is not a rejection.
    expect(classifyReviewerVerdict("Approved — none of the tests fail and there are no blockers.")).toBe(
      "approve",
    );
    // Genuinely ambiguous prose ⇒ null ⇒ validation LEFT UNCHANGED (never silently healthy).
    expect(classifyReviewerVerdict("I looked at the change and have some thoughts.")).toBeNull();
    expect(classifyReviewerVerdict(null)).toBeNull();
  });
});
