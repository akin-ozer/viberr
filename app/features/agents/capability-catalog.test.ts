import { describe, expect, it } from "vitest";
import {
  ALWAYS_HUMAN_CAPABILITY_IDS,
  UNIFIED_CAP_CATALOG,
  capabilityEnforcement,
} from "~/shared/capabilities";
import {
  CAP_MODAL_CATALOG,
  CAP_MODAL_DEFAULTS,
  MODAL_CAP_IDS,
  OPERATOR_CAP_IDS,
  capabilityPatchRefusal,
} from "./capability-catalog";

describe("CAP_MODAL_CATALOG (ruling 62(b) — id-based against the shared catalog)", () => {
  it("carries only runtime-consulted agent toggles (ruling 62(b) prune + generic-agents Collaboration)", () => {
    // The toggleable catalog holds ONLY ids whose mode is consulted at runtime:
    // the repo-enforced delivery family, the Collaboration gates the
    // generic-agents plan (D10) and P13-D-26 promoted to real agent-toolkit
    // gates, web egress (P13-LV-18), the browser mount (R19-19), the GitHub-read
    // mount (F4) and the always-human ids. The advisory ids (read-task-repo,
    // run-validation-suites, approve-review, request-changes, …) still have no
    // runtime effect and stay matrix-only. "Consulted at runtime" is what
    // `capabilityEnforcement` classifies, so an agent id gets a toggle exactly
    // when it is not advisory.
    for (const entry of UNIFIED_CAP_CATALOG.filter((c) => c.kinds.includes("agent"))) {
      expect(MODAL_CAP_IDS.has(entry.id), entry.id).toBe(
        capabilityEnforcement(entry.id) !== "advisory",
      );
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

  it("the always-human invariant ids are all in the modal catalog, defaulted human", () => {
    for (const id of ALWAYS_HUMAN_CAPABILITY_IDS) {
      expect(MODAL_CAP_IDS.has(id)).toBe(true);
      expect(CAP_MODAL_DEFAULTS[id]).toBe("human");
    }
  });
});

/**
 * Ruling 261 (pass 34, F34-2): `capabilityPatchRefusal` refuses by name,
 * from the catalogue sets alone. Every governed id at a legal mode returns
 * null; everything else is named with the valid ids.
 *
 * Canary: validate against the UNION of both kinds' governed ids and the
 * "operator id on a specialist" case answers null.
 */
describe("capabilityPatchRefusal (ruling 261)", () => {
  it("every governed id at a legal mode returns null, for both kinds", () => {
    for (const id of MODAL_CAP_IDS) {
      const legal = id === "report-validation-verdict"
        ? (["direct", "off"] as const)
        : ALWAYS_HUMAN_CAPABILITY_IDS.includes(id)
          ? (["human"] as const)
          : (["direct", "human", "off"] as const);
      for (const mode of legal) {
        expect(capabilityPatchRefusal("agent", [{ capabilityId: id, mode }]), `${id} ${mode}`).toBeNull();
      }
    }
    for (const id of OPERATOR_CAP_IDS) {
      for (const mode of ["direct", "recommend", "human", "off"] as const) {
        expect(capabilityPatchRefusal("operator", [{ capabilityId: id, mode }]), `${id} ${mode}`).toBeNull();
      }
    }
    expect(capabilityPatchRefusal("agent", [])).toBeNull();
  });

  it("names an unknown id, lists the valid ones and points at list_capabilities; nothing else in the batch is judged first", () => {
    const refusal = capabilityPatchRefusal("agent", [
      { capabilityId: "commit-push-branch", mode: "direct" },
      { capabilityId: "push", mode: "direct" },
    ])!;
    expect(refusal).toContain('No capability answers to "push"');
    expect(refusal).toContain("commit-push-branch");
    expect(refusal).toContain("list_capabilities");
    expect(refusal).toContain("Nothing was written");
  });

  it("an operator id on a specialist (and the reverse) is refused as belonging to the other kind", () => {
    expect(capabilityPatchRefusal("agent", [{ capabilityId: "dispatch-agents", mode: "direct" }])).toContain(
      '"dispatch-agents" is an operator capability and cannot be set on a specialist',
    );
    expect(capabilityPatchRefusal("operator", [{ capabilityId: "use-browser", mode: "direct" }])).toContain(
      '"use-browser" is a specialist capability and cannot be set on the operator',
    );
  });

  it("a specialist `recommend`, a non-human mode on an always-human id, and a verdict grant at `human` are refused", () => {
    // Canary (verdict): delete branch (e) and the `human` verdict case answers null.
    expect(capabilityPatchRefusal("agent", [{ capabilityId: "use-browser", mode: "recommend" }])).toContain(
      "recommend is an operator-only mode",
    );
    expect(capabilityPatchRefusal("agent", [{ capabilityId: "merge-pull-request", mode: "direct" }])).toContain(
      "reserved for humans",
    );
    expect(capabilityPatchRefusal("agent", [{ capabilityId: "report-validation-verdict", mode: "human" }])).toContain(
      "takes only direct or off",
    );
  });

  it("an advisory (matrix-only) id is refused AS matrix-only, never as 'no such id'", () => {
    // Canary: fold the advisory branch into (a) and the wording assertion fails.
    const refusal = capabilityPatchRefusal("agent", [{ capabilityId: "approve-review", mode: "direct" }])!;
    expect(refusal).toContain("matrix-only capability with no toggle");
    expect(refusal).not.toContain("No capability answers to");
  });

  it("carries no em or en dash (client-safe copy)", () => {
    for (const patches of [
      [{ capabilityId: "push", mode: "direct" as const }],
      [{ capabilityId: "dispatch-agents", mode: "direct" as const }],
      [{ capabilityId: "use-browser", mode: "recommend" as const }],
      [{ capabilityId: "merge-pull-request", mode: "off" as const }],
      [{ capabilityId: "report-validation-verdict", mode: "human" as const }],
      [{ capabilityId: "approve-review", mode: "direct" as const }],
    ]) {
      expect(capabilityPatchRefusal("agent", patches)).not.toMatch(/[–—]/);
    }
  });
});
