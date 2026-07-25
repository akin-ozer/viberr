import { describe, expect, it } from "vitest";
import {
  ALWAYS_HUMAN_CAPABILITY_IDS,
  CAP_CATALOG,
  CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS,
  ENFORCED_CAPABILITY_IDS,
  capabilityByLabel,
  capabilityEnforcement,
  normalizeDeliveryGrants,
} from "./capabilities";

describe("capability catalog", () => {
  it("has no duplicate ids and every enforced id exists in the catalog", () => {
    const ids = CAP_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const idSet = new Set(ids);
    for (const id of ENFORCED_CAPABILITY_IDS) {
      expect(idSet.has(id), `${id} in ENFORCED but missing from catalog`).toBe(true);
    }
    for (const id of ALWAYS_HUMAN_CAPABILITY_IDS) {
      expect(idSet.has(id), `${id} in ALWAYS_HUMAN but missing from catalog`).toBe(true);
    }
  });

  it("pruned ids (F11/R3) are gone from the catalog", () => {
    const ids = new Set(CAP_CATALOG.map((c) => c.id));
    for (const gone of ["edit-other-task-branch", "open-or-merge-pr", "compress-timelines", "owner-reassignment"]) {
      expect(ids.has(gone), `${gone} should have been pruned`).toBe(false);
    }
  });
});

describe("capabilityEnforcement (S3 backend-asymmetry labeling)", () => {
  it("classifies the FINE-GRAINED tool-denylist caps as claude-only", () => {
    for (const id of ["create-task-branch", "commit-push-branch", "open-review-pr"]) {
      expect(capabilityEnforcement(id), id).toBe("claude-only");
    }
  });

  it("classifies the headline repo-write cap as BOTH — the Codex sandbox enforces it (P14-RT-03)", () => {
    // Since P13-RT-02 a Codex run with repo-write withheld gets the read-only
    // sandbox, which is OS-level enforcement. Leaving it labeled claude-only
    // made the capability matrix understate the product's own guarantee.
    expect(capabilityEnforcement("execute-code-or-write-repo")).toBe("both");
    expect(
      CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS.has("execute-code-or-write-repo"),
    ).toBe(false);
  });

  it("classifies structural ALWAYS_HUMAN caps as BOTH — never advisory-on-Codex", () => {
    // Regression for the adversarial-review finding: merge-pull-request was
    // mislabeled "claude-only" (⇒ the matrix badged it 'advisory on Codex'),
    // understating the single most safety-critical row. Always-human caps hold
    // on both backends because an agent never gets them in an actionable mode.
    for (const id of ALWAYS_HUMAN_CAPABILITY_IDS) {
      expect(capabilityEnforcement(id), id).toBe("both");
    }
    expect(capabilityEnforcement("merge-pull-request")).toBe("both");
    expect(CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS.has("merge-pull-request")).toBe(false);
  });

  it("classifies operator-gate caps as both, and unknown/advisory caps as advisory", () => {
    for (const id of ["assign-primary-specialist", "summon-reviewers", "generate-packets", "append-typed-events", "stage-transitions"]) {
      expect(capabilityEnforcement(id), id).toBe("both");
    }
    expect(capabilityEnforcement("post-quality-flags")).toBe("advisory");
    expect(capabilityEnforcement("no-such-capability")).toBe("advisory");
  });

  it("classifies generic-agent collaboration gates by their real transport", () => {
    // verdict + ask-human gate server-side at completion → both backends;
    // the mid-run comment tool is Claude-only (Codex has no comment channel).
    expect(capabilityEnforcement("report-validation-verdict")).toBe("both");
    expect(capabilityEnforcement("ask-human")).toBe("both");
    expect(capabilityEnforcement("comment-on-task")).toBe("claude-only");
  });

  it("the matrix badge (capabilityByLabel → enforcement) is claude-only ONLY for the 3 fine-grained delivery rows", () => {
    // What the CapabilityMatrixModal actually does: label → id → enforcement.
    const claudeOnlyLabels = ["Create the task-key branch", "Commit & push to the branch", "Open the review pull request"];
    for (const label of claudeOnlyLabels) {
      const id = capabilityByLabel(label)?.id;
      expect(id, label).toBeTruthy();
      expect(capabilityEnforcement(id!), label).toBe("claude-only");
    }
    // Merge a pull request and the headline repo-write must NOT get the badge.
    expect(capabilityEnforcement(capabilityByLabel("Merge a pull request")!.id)).toBe("both");
    expect(
      capabilityEnforcement(capabilityByLabel("Execute code or write to the repo")!.id),
    ).toBe("both");
  });
});

describe("normalizeDeliveryGrants (F14 — headline is the master delivery gate)", () => {
  const mode = (capabilityId: string, m: string) => ({ capabilityId, mode: m });

  it("repairs a deliverer whose scoped delivery is granted but the headline is explicit off", () => {
    const grants = [
      mode("execute-code-or-write-repo", "off"),
      mode("create-task-branch", "direct"),
      mode("commit-push-branch", "direct"),
      mode("open-review-pr", "direct"),
    ];
    const out = normalizeDeliveryGrants(grants);
    expect(out.find((g) => g.capabilityId === "execute-code-or-write-repo")?.mode).toBe("direct");
    // Idempotent.
    expect(normalizeDeliveryGrants(out)).toEqual(out);
  });

  it("adds the headline grant when it is absent but scoped delivery is actionable", () => {
    const grants = [mode("commit-push-branch", "direct")];
    const out = normalizeDeliveryGrants(grants);
    expect(out.some((g) => g.capabilityId === "execute-code-or-write-repo" && g.mode === "direct")).toBe(true);
  });

  it("treats a specialist `recommend` scoped grant as actionable (repairs the headline)", () => {
    const grants = [
      mode("open-review-pr", "recommend"),
      mode("execute-code-or-write-repo", "off"),
    ];
    const out = normalizeDeliveryGrants(grants);
    expect(out.find((g) => g.capabilityId === "execute-code-or-write-repo")?.mode).toBe("direct");
  });

  it("leaves a non-deliverer (reviewer: scoped delivery off/human) untouched", () => {
    const grants = [
      mode("execute-code-or-write-repo", "off"),
      mode("create-task-branch", "off"),
      mode("commit-push-branch", "human"),
      mode("open-review-pr", "off"),
      mode("report-validation-verdict", "direct"),
    ];
    expect(normalizeDeliveryGrants(grants)).toEqual(grants);
  });

  it("leaves an already-correct deliverer (headline direct) untouched", () => {
    const grants = [
      mode("execute-code-or-write-repo", "direct"),
      mode("create-task-branch", "direct"),
    ];
    expect(normalizeDeliveryGrants(grants)).toEqual(grants);
  });
});
