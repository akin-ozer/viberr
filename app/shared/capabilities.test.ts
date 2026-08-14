import { describe, expect, it } from "vitest";
import {
  ALWAYS_HUMAN_CAPABILITY_IDS,
  CAP_CATALOG,
  CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS,
  ENFORCED_CAPABILITY_IDS,
  UNIFIED_CAP_CATALOG,
  applyVerdictOutcomeGate,
  capabilityByLabel,
  capabilityEnforcement,
  conservativeGrantsFor,
  normalizeDeliveryGrants,
  repairDeliveryGrants,
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

  it("classifies web egress as BOTH — the Codex webSearchMode channel enforces it (P14-RT-06)", () => {
    // It used to be labeled claude-only on the strength of a "prompt-level on
    // Codex" fallback that never existed in any prompt. Codex now disables web
    // search for a withheld grant, so both backends remove the built-in tool.
    expect(capabilityEnforcement("use-web-search-fetch")).toBe("both");
    expect(CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS.has("use-web-search-fetch")).toBe(
      false,
    );
  });

  it("classifies generic-agent collaboration gates by their real transport", () => {
    // verdict + ask-human gate server-side at completion → both backends;
    // the mid-run comment tool is Claude-only (Codex has no comment channel).
    expect(capabilityEnforcement("report-validation-verdict")).toBe("both");
    expect(capabilityEnforcement("ask-human")).toBe("both");
    expect(capabilityEnforcement("comment-on-task")).toBe("claude-only");
  });

  it("R19-19: classifies the browser as BOTH — withheld ⇒ the server is never mounted, either backend", () => {
    expect(capabilityEnforcement("use-browser")).toBe("both");
    // Default OFF: a casually created profile must not silently acquire a
    // driven browser (same rationale as report-validation-verdict).
    const entry = UNIFIED_CAP_CATALOG.find((c) => c.id === "use-browser")!;
    expect(entry.defaultMode).toBe("off");
    expect(entry.kinds).toEqual(["agent"]);
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

describe("delivery grants (F14 headline gate · B-AG1 no silent escalation)", () => {
  const mode = (capabilityId: string, m: string) => ({ capabilityId, mode: m });

  it("RESPECTS an explicit headline `off` and reports the contradiction instead of escalating", () => {
    const grants = [
      mode("execute-code-or-write-repo", "off"),
      mode("create-task-branch", "direct"),
      mode("commit-push-branch", "direct"),
      mode("open-review-pr", "direct"),
    ];
    const { grants: out, notice } = repairDeliveryGrants(grants);
    expect(out.find((g) => g.capabilityId === "execute-code-or-write-repo")?.mode).toBe("off");
    expect(notice?.kind).toBe("withheld");
    expect(notice?.message).toContain("cannot deliver");
    expect(notice?.scoped).toEqual([
      "create-task-branch",
      "commit-push-branch",
      "open-review-pr",
    ]);
    // Idempotent: a second save does not drift either.
    expect(normalizeDeliveryGrants(out)).toEqual(grants);
  });

  it("RESPECTS an explicit headline `human` (deliberate human gate)", () => {
    const grants = [
      mode("execute-code-or-write-repo", "human"),
      mode("commit-push-branch", "direct"),
    ];
    const { grants: out, notice } = repairDeliveryGrants(grants);
    expect(out.find((g) => g.capabilityId === "execute-code-or-write-repo")?.mode).toBe("human");
    expect(notice?.kind).toBe("withheld");
  });

  it("adds the headline grant when it is ABSENT but scoped delivery is actionable — and says so", () => {
    const grants = [mode("commit-push-branch", "direct")];
    const { grants: out, notice } = repairDeliveryGrants(grants);
    expect(out.some((g) => g.capabilityId === "execute-code-or-write-repo" && g.mode === "direct")).toBe(true);
    expect(notice?.kind).toBe("repaired");
    expect(notice?.message).toContain("Commit & push to the branch");
  });

  it("treats a specialist `recommend` scoped grant as actionable (absent headline repaired)", () => {
    const grants = [mode("open-review-pr", "recommend")];
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
    expect(repairDeliveryGrants(grants).notice).toBeNull();
  });
});

describe("applyVerdictOutcomeGate (F15-06 — verdict outcomes follow the verdict)", () => {
  const mode = (capabilityId: string, m: string) => ({ capabilityId, mode: m });

  it("withholds approve/request-changes/quality-flags when the verdict grant is off", () => {
    const out = applyVerdictOutcomeGate([
      mode("report-validation-verdict", "off"),
      mode("approve-review", "direct"),
      mode("request-changes", "direct"),
      mode("post-quality-flags", "direct"),
      mode("read-repo-diff", "direct"),
    ]);
    const modeOf = (id: string) => out.find((g) => g.capabilityId === id)?.mode;
    expect(modeOf("approve-review")).toBe("off");
    expect(modeOf("request-changes")).toBe("off");
    expect(modeOf("post-quality-flags")).toBe("off");
    // Unrelated advisory guidance is untouched.
    expect(modeOf("read-repo-diff")).toBe("direct");
  });

  it("withholds them when the verdict grant is ABSENT (catalog default is off)", () => {
    const out = applyVerdictOutcomeGate([mode("approve-review", "direct")]);
    expect(out[0]!.mode).toBe("off");
  });

  it("leaves them alone for a profile that explicitly holds the verdict", () => {
    const grants = [
      mode("report-validation-verdict", "direct"),
      mode("approve-review", "direct"),
      mode("request-changes", "recommend"),
    ];
    expect(applyVerdictOutcomeGate(grants)).toEqual(grants);
  });
});

describe("conservativeGrantsFor (surfaces with no capability UI)", () => {
  it("starts delivery AND the review-verdict outcomes withheld (F15-06)", () => {
    const byId = new Map(
      conservativeGrantsFor("agent").map((g) => [g.capabilityId, g.mode]),
    );
    for (const id of [
      "execute-code-or-write-repo",
      "create-task-branch",
      "commit-push-branch",
      "open-review-pr",
      "approve-review",
      "request-changes",
      "post-quality-flags",
    ]) {
      expect(byId.get(id), id).toBe("off");
    }
    expect(byId.get("report-validation-verdict")).toBe("off");
  });
});
