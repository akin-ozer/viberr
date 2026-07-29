import { describe, expect, it } from "vitest";
import {
  capabilitiesToActionLabels,
  effectiveProfileView,
} from "./agents-query.server";
import type { CapabilityMode } from "~/schemas/project-file.schema";
import { absentDeliverReviewPrMode } from "~/shared/capabilities";

const cap = (capabilityId: string, mode: CapabilityMode) => ({ capabilityId, mode });

/**
 * NEW-3: `human` (a structural always-human lock) and `off` (withheld from this
 * agent) are SEPARATE buckets. Conflating them made an explicitly withheld
 * capability render as "Reserved for humans" in the matrix / profile detail /
 * policy "N human" count, when it is simply not granted.
 */
describe("capabilitiesToActionLabels — off vs human separation (NEW-3)", () => {
  it("routes mode 'off' to the `off` bucket and mode 'human' to `forbidden`", () => {
    const out = capabilitiesToActionLabels(
      [
        cap("commit-push-branch", "direct"),
        cap("report-validation-verdict", "off"), // withheld → off, NOT reserved
        cap("merge-pull-request", "human"), // structural always-human → forbidden
      ],
      [],
    );
    expect(out.direct).toContain("Commit & push to the branch");
    // The withheld verdict is "not granted", NOT "reserved for humans".
    expect(out.off).toContain("Report a validation verdict");
    expect(out.forbidden).not.toContain("Report a validation verdict");
    // The genuine always-human lock stays in `forbidden` (renders "Reserved for humans").
    expect(out.forbidden).toContain("Merge a pull request");
    expect(out.off).not.toContain("Merge a pull request");
  });

  it("recommend stays its own bucket", () => {
    const out = capabilitiesToActionLabels([cap("stage-transitions", "recommend")], []);
    expect(out.recommend).toContain("Stage transitions");
    expect(out.off).toEqual([]);
  });
});

/**
 * F15-06 (live): a profile created where no capability UI exists is seeded from
 * the catalog defaults, which grant the advisory review OUTCOMES `direct` while
 * `report-validation-verdict` defaults to `off`. The agents page then showed a
 * brand-new docs writer holding "Approve the review" and "Request changes"
 * under ACTS DIRECTLY — authority the completion pipeline refuses it.
 */
describe("capabilitiesToActionLabels — verdict outcomes follow the verdict (F15-06)", () => {
  it("never lists approve/request-changes as granted without verdict authority", () => {
    const out = capabilitiesToActionLabels(
      [
        cap("report-validation-verdict", "off"),
        cap("approve-review", "direct"),
        cap("request-changes", "direct"),
        cap("post-quality-flags", "direct"),
        cap("read-repo-diff", "direct"),
      ],
      [],
    );
    expect(out.direct).not.toContain("Approve the review");
    expect(out.direct).not.toContain("Request changes");
    expect(out.direct).not.toContain("Post quality-flag events");
    expect(out.off).toContain("Approve the review");
    // Guidance unrelated to the verdict is untouched.
    expect(out.direct).toContain("Read the repository & diff");
  });

  it("keeps them for a profile that explicitly holds the verdict (the reviewer)", () => {
    const out = capabilitiesToActionLabels(
      [
        cap("report-validation-verdict", "direct"),
        cap("approve-review", "direct"),
        cap("request-changes", "direct"),
      ],
      [],
    );
    expect(out.direct).toContain("Approve the review");
    expect(out.direct).toContain("Request changes");
  });
});

/**
 * Live find (pass 15): `deliver-review-pr` postdates every operator deployment
 * created before R15-2. Its runtime gate reads an ABSENT grant as `direct`
 * (deliverGate), so those operators kept delivering — while this view, which
 * renders only the grants a deployment PERSISTED, showed no row for it at all.
 * A capability that governs real behavior must not be invisible in the surface
 * that claims to list the policy, and it must be editable there.
 */
describe("R15-2: a pre-R15-2 operator deployment still shows its delivery grant", () => {
  const operatorDeployment = (
    capabilities: { capabilityId: string; mode: CapabilityMode }[],
  ) =>
    ({
      profileId: "operator",
      capabilities,
      extras: [],
      definition: { kind: "operator", name: "Operator", role: "Task coordinator" },
    }) as never;

  const noGrant = [
    { capabilityId: "assign-primary-specialist", mode: "direct" as CapabilityMode },
    { capabilityId: "stage-transitions", mode: "recommend" as CapabilityMode },
  ];

  it("materializes the grant at the mode the runtime applies when it is absent", () => {
    const view = effectiveProfileView(
      operatorDeployment(noGrant),
      undefined,
      absentDeliverReviewPrMode(false),
    );
    expect(
      view.actions.direct,
      "the panel must name the delivery grant the operator actually runs under",
    ).toContain("Deliver the branch & open the review PR");
  });

  it("R15-9: on a human-gated project the SAME absent grant materializes as recommend", () => {
    // The whole point of R15-9: two projects with no stored grant must not
    // differ by creation date. A project whose pre-work advances are human-gated
    // resolves the absent grant to `recommend`, and the panel says so — if this
    // view kept a hardcoded `direct` it would assert a mode `deliverGate` does
    // not apply, which is F15-20 all over again.
    // Canary: return "direct" unconditionally from absentDeliverReviewPrMode.
    const view = effectiveProfileView(
      operatorDeployment(noGrant),
      undefined,
      absentDeliverReviewPrMode(true),
    );
    expect(view.actions.recommend).toContain(
      "Deliver the branch & open the review PR",
    );
    expect(view.actions.direct).not.toContain(
      "Deliver the branch & open the review PR",
    );
  });

  it("never overrides an EXPLICIT mode — a strict project's recommend stays recommend", () => {
    const view = effectiveProfileView(
      operatorDeployment([
        { capabilityId: "assign-primary-specialist", mode: "direct" },
        { capabilityId: "deliver-review-pr", mode: "recommend" },
      ]),
      undefined,
      // Explicit grant must win even when the derived default disagrees.
      absentDeliverReviewPrMode(false),
    );
    expect(view.actions.recommend).toContain(
      "Deliver the branch & open the review PR",
    );
    expect(view.actions.direct).not.toContain(
      "Deliver the branch & open the review PR",
    );
  });
});
