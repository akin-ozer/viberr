import { describe, expect, it } from "vitest";
import type { Engagement } from "~/schemas/task-file.schema";
import {
  deliveringEngagement,
  deriveValidation,
  requiredReviewers,
  supportingEngagements,
  TIMELINE_EVENT_TYPES,
} from "~/schemas/task-file.schema";
import {
  ALWAYS_HUMAN_CAPABILITY_IDS,
  applyGrantCouplings,
  BROWSER_CAP_ID,
  capabilityEnforcement,
  coerceSpecialistCapabilityMode,
  WEB_EGRESS_CAP_ID,
} from "~/shared/capabilities";
import { roleCan, rolesForAction, ROLE_RANK } from "~/shared/rbac";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import { gate, type OperatorAuthority } from "./operator-actions.server";

/**
 * Pass-29 governance scenarios — the cross-cutting contracts the 2026-08-27
 * full-product pass exercised LIVE on a real instance (project VQP against
 * akin-ozer/viberr; see planning/discovery-2026-08-27-pass29/EXTENDED-COVERAGE.md),
 * codified here so the observed behavior is pinned, not folklore. Each block
 * names the live scenario it encodes. Everything here is a PURE contract —
 * no store, no network — so the suite stays fast and the assertions stay
 * exactly the rules the live pass verified.
 */

// --------------------------------------------------- RBAC triggering (UC6)

describe("RBAC triggering — the live viewer demo, as a contract", () => {
  it("a viewer can comment but not create tasks, run agents, or accept (the live 403-vs-200 pair)", () => {
    // Live: as qa-viewer on VQP-2, `comment` → 200 (landed on the timeline),
    // `owner-take` → 403 — same session, same valid CSRF.
    expect(roleCan("viewer", "comment")).toBe(true);
    expect(roleCan("viewer", "own-task")).toBe(false);
    expect(roleCan("viewer", "create-task")).toBe(false);
    expect(roleCan("viewer", "run-agents")).toBe(false);
    expect(roleCan("viewer", "accept-completion")).toBe(false);
  });

  it("every action's allowed roles are upward-closed by rank — no action a maintainer may take is denied an admin", () => {
    // The tier invariant the whole Policy grid renders: viewer ⊂ contributor ⊂
    // maintainer ⊂ admin. A grant list that skipped a HIGHER tier would make
    // the matrix lie.
    // SAFETY: `Object.keys` of the const ROLE_RANK record yields exactly its
    // literal keys — the four project roles — so the assertion narrows to the
    // key union the record itself declares.
    const roles = Object.keys(ROLE_RANK) as (keyof typeof ROLE_RANK)[];
    for (const action of [
      "view",
      "comment",
      "create-task",
      "own-task",
      "run-agents",
      "accept-completion",
      "force-accept-completion",
      "edit-policy",
    ] as const) {
      const allowed = rolesForAction(action);
      for (const role of roles) {
        if (!allowed.includes(role)) continue;
        for (const higher of roles) {
          if (ROLE_RANK[higher] > ROLE_RANK[role]) {
            expect(
              allowed.includes(higher),
              `${action}: ${role} allowed but ${higher} denied`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("user assignments: ownership is contributor+, releasing ANYONE's seat is admin-only", () => {
    // Live: Arda (admin) ran take → assign-to-contributor → release-anyone;
    // the Permissions panel told the viewer "View only (contributor+ to own)".
    expect(rolesForAction("own-task")).toContain("contributor");
    expect(rolesForAction("own-task")).not.toContain("viewer");
    expect(rolesForAction("release-any-ownership")).toEqual(["admin"]);
  });
});

// ------------------------------------------- stage transitions (UC3)

describe("stage transitions — role resolution on the standard 5-stage workflow", () => {
  const stages = [
    { id: "triage" },
    { id: "ready" },
    { id: "impl" },
    { id: "review" },
    { id: "done" },
  ];
  const workflow = [
    { from: "triage", to: "ready" },
    { from: "ready", to: "impl" },
    { from: "impl", to: "review" },
    { from: "review", to: "done" },
  ];

  it("review is the stage with the governed edge into terminal; work precedes it", () => {
    // Live: VQP tasks moved triage→ready (auto) → impl (auto) → review
    // (approval, human-applied recommendation) → done (human acceptance).
    const roles = resolveStageRoles(stages, workflow);
    expect(roles).toEqual({
      entryId: "triage",
      terminalId: "done",
      reviewId: "review",
      workId: "impl",
    });
  });

  it("a workflow-less board still resolves review/terminal positionally — governance never dangles", () => {
    const roles = resolveStageRoles(stages, []);
    expect(roles.terminalId).toBe("done");
    expect(roles.reviewId).toBe("review");
  });
});

// ------------------------- reviewers, verdicts, secondary assignments

describe("reviewers & secondary engagements — the VQP-2 shape, as a contract", () => {
  const eng = (over: Partial<Engagement>): Engagement => ({
    profileId: "developer",
    backend: "claude",
    role: "Implementation",
    delivers: false,
    verdictCapable: false,
    ...over,
  });
  // Live VQP-2: developer delivers; reviewer supports with a verdict; the
  // web-qa evidence-gatherer supports WITHOUT one (its approval gates nothing).
  const developer = eng({ delivers: true });
  const reviewer = eng({
    profileId: "reviewer",
    role: "Review & validation",
    verdictCapable: true,
  });
  const webQa = eng({ profileId: "web-qa", role: "Web QA" });
  const fm = { engagements: [developer, reviewer, webQa] };

  it("one deliverer, everyone else supports; only the verdict-capable supporter is a REQUIRED reviewer", () => {
    expect(deliveringEngagement(fm)?.profileId).toBe("developer");
    expect(supportingEngagements(fm).map((e) => e.profileId)).toEqual([
      "reviewer",
      "web-qa",
    ]);
    expect(requiredReviewers(fm).map((e) => e.profileId)).toEqual(["reviewer"]);
  });

  it("verdicts are revision-bound: an approval of a STALE revision does not turn the current one healthy", () => {
    // Live: the reviewer's verdict named the revision id + head sha it judged;
    // a new delivery staleness-expires every prior verdict (F10-32).
    const revision = {
      id: "rev_current",
      headSha: "a".repeat(40),
      treeSha: null,
      branch: "vqp-2",
      createdAt: "2026-08-27T09:49:54.865Z",
      sourceProfileId: "developer",
    };
    const verdict = (revisionId: string) => ({
      profileId: "reviewer",
      revisionId,
      headSha: "a".repeat(40),
      result: "approve" as const,
      reason: "clean",
      at: "2026-08-27T09:50:00.000Z",
    });
    const base = { engagements: fm.engagements, workRevision: revision };
    expect(deriveValidation({ ...base, verdicts: [] })).toBe("changed");
    expect(deriveValidation({ ...base, verdicts: [verdict("rev_stale")] })).toBe(
      "changed",
    );
    expect(
      deriveValidation({ ...base, verdicts: [verdict("rev_current")] }),
    ).toBe("healthy");
  });

  it("no revision delivered yet → validation none; nothing owes a verdict before delivery", () => {
    expect(
      deriveValidation({
        engagements: fm.engagements,
        workRevision: null,
        verdicts: [],
      }),
    ).toBe("none");
  });
});

// -------------------------------------------------- comment usage (UC5)

describe("comment usage — the timeline's typed-event contract", () => {
  it("comment is a first-class timeline event type, alongside exactly the other governed kinds", () => {
    // Live: the viewer's comment landed as `comment · user:… (QA Viewer)`;
    // agent replies and operator packets each arrived under their own type.
    expect(TIMELINE_EVENT_TYPES).toContain("comment");
    for (const t of ["transition", "github", "quality", "blocked", "completion"]) {
      expect(TIMELINE_EVENT_TYPES).toContain(t);
    }
  });
});

// ---------------------------------------- operator behavior (UC7 / F3)

describe("operator gating — proactive but ceilinged (the live cascade, as a contract)", () => {
  const authority = (
    modes: Record<string, "direct" | "recommend" | "human" | "off">,
    autonomy: "supervised" | "full",
    deployed = true,
  ): OperatorAuthority => ({
    policy: new Map(Object.entries(modes)),
    autonomy,
    backend: "claude",
    model: "sonnet",
    effort: "",
    name: "Operator",
    skills: [],
    kb: [],
    mcps: [],
    persona: null,
    deployed,
    humanGatedBeforeWork: false,
  });

  it("supervised keeps recommend as recommend; full autonomy promotes it to direct", () => {
    // Live (Balanced = supervised): every stage move surfaced as an
    // Apply/Dismiss card, never a silent transition.
    expect(gate(authority({ "stage-transitions": "recommend" }, "supervised"), "stage-transitions")).toBe("recommend");
    expect(gate(authority({ "stage-transitions": "recommend" }, "full"), "stage-transitions")).toBe("direct");
  });

  it("acceptance-to-Done never rides the autonomy promotion — recommend stays recommend even at full", () => {
    // The one capability where full autonomy must NOT widen a recommend: an
    // admin who configured a human gate on Done keeps it (owner ruling Q1).
    expect(
      gate(authority({ "completion-for-acceptance": "recommend" }, "full"), "completion-for-acceptance"),
    ).toBe("recommend");
    expect(
      gate(authority({ "completion-for-acceptance": "direct" }, "full"), "completion-for-acceptance"),
    ).toBe("direct");
  });

  it("human-mode and withheld grants both deny; an undeployed operator denies EVERYTHING", () => {
    // Live: the operator told Arda it could not create profiles/KBs — its
    // execute-code grant is mode human, and the gate reads that as deny.
    expect(gate(authority({ "execute-code-or-write-repo": "human" }, "full"), "execute-code-or-write-repo")).toBe("deny");
    expect(gate(authority({}, "full"), "stage-transitions")).toBe("deny");
    expect(gate(authority({ "stage-transitions": "direct" }, "full", false), "stage-transitions")).toBe("deny");
  });
});

// ------------------------- capabilities: browser focus + Claude/Codex parity

describe("capability catalog — browser coupling and the enforcement honesty the matrix renders", () => {
  it("the always-human trio is exactly merge / transition-to-done / change-policy", () => {
    expect([...ALWAYS_HUMAN_CAPABILITY_IDS].sort()).toEqual([
      "change-project-policy",
      "merge-pull-request",
      "transition-to-done",
    ]);
  });

  it("specialists act directly or are withheld — a stored `recommend` coerces away (R20-6)", () => {
    expect(coerceSpecialistCapabilityMode("recommend")).not.toBe("recommend");
    expect(coerceSpecialistCapabilityMode("direct")).toBe("direct");
  });

  it("granting the browser force-couples web egress at save time (the browser IS egress)", () => {
    // Live: ticking "Drive a live web browser" on the Web QA profile showed
    // egress as "Required by …" and saved the coherent pair.
    const coupled = applyGrantCouplings([
      { capabilityId: BROWSER_CAP_ID, mode: "direct" },
      { capabilityId: WEB_EGRESS_CAP_ID, mode: "off" },
    ]);
    expect(
      coupled.grants.find((g) => g.capabilityId === WEB_EGRESS_CAP_ID)?.mode,
    ).toBe("direct");
    // The repair is DISCLOSED to the admin, never silent.
    expect(coupled.notices.some((n) => n.rule === "browser-egress")).toBe(true);
  });

  it("Claude/Codex parity: the browser binds on BOTH backends; the repo-write family is claude-only again", () => {
    // History in one line: R22 made the headline claude-only, ruling 101
    // (2026-08-31) bound it on Codex through the read-only sandbox, and ruling
    // 185 (2026-09-12) removed the sandbox — so it is claude-only once more,
    // rendered "advisory on Codex" wherever the enforcement is shown. A
    // withheld browser still never MOUNTS on either backend, which is the
    // strongest shape the runtime has and needs no sandbox.
    expect(capabilityEnforcement("execute-code-or-write-repo")).toBe("claude-only");
    expect(capabilityEnforcement("commit-push-branch")).toBe("claude-only");
    expect(capabilityEnforcement(BROWSER_CAP_ID)).toBe("both");
  });
});
