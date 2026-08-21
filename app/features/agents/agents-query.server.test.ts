import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { seedDefaultAgentAssets } from "~/server/seed/default-assets.server";
import {
  capabilitiesToActionLabels,
  effectiveProfileView,
} from "./agents-query.server";
import type {
  AgentDeployment,
  AgentDeploymentDefinition,
  CapabilityGrant,
  CapabilityMode,
} from "~/schemas/project-file.schema";
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
 * F20-9 / R20-7 (D1): the display buckets must mirror the runtime acceptance
 * gate (`operator-actions.server.ts:2580`,
 * `authority.autonomy !== "full" || gate(...) !== "direct"`). A supervised
 * operator holding `completion-for-acceptance: direct` renders it under ACTS
 * DIRECTLY — authority the server refuses — unless the autonomy ceiling is
 * applied, the exact F15-06 class one axis over.
 */
describe("capabilitiesToActionLabels — autonomy ceiling on accept-completion (F20-9/R20-7)", () => {
  it("a SUPERVISED operator's direct accept-completion renders RECOMMENDS ONLY, not ACTS DIRECTLY", () => {
    const out = capabilitiesToActionLabels(
      [
        cap("completion-for-acceptance", "direct"),
        cap("assign-primary-specialist", "direct"),
      ],
      [],
      "supervised",
    );
    // Canary: drop the `autonomy` arg / the ceiling and this flips back to `direct`.
    expect(out.direct).not.toContain("Accept completion into Done");
    expect(out.recommend).toContain("Accept completion into Done");
    // The ceiling touches ONLY accept-completion — other grants are unaffected.
    expect(out.direct).toContain("Assign the delivering agent");
  });

  it("a FULL-autonomy operator keeps it under ACTS DIRECTLY (the exception is live)", () => {
    const out = capabilitiesToActionLabels(
      [cap("completion-for-acceptance", "direct")],
      [],
      "full",
    );
    expect(out.direct).toContain("Accept completion into Done");
    expect(out.recommend).not.toContain("Accept completion into Done");
  });

  it("effectiveProfileView threads the operator's own autonomy into the ceiling", () => {
    const opDeployment = (
      autonomy: "supervised" | "full" | undefined,
      mode: CapabilityMode,
    ): AgentDeployment => {
      // The third case below is a deployment that never PERSISTED an autonomy —
      // an absent key, not a null one — so the key is set only when given.
      const definition: AgentDeploymentDefinition = {
        kind: "operator",
        name: "Operator",
      };
      if (autonomy) definition.autonomy = autonomy;
      return {
        profileId: "operator",
        capabilities: [cap("completion-for-acceptance", mode)],
        extras: [],
        definition,
      };
    };

    const supervised = effectiveProfileView(
      opDeployment("supervised", "direct"),
      undefined,
      absentDeliverReviewPrMode(false),
    );
    expect(supervised.autonomy).toBe("supervised");
    expect(supervised.actions.recommend).toContain("Accept completion into Done");
    expect(supervised.actions.direct).not.toContain("Accept completion into Done");

    const full = effectiveProfileView(
      opDeployment("full", "direct"),
      undefined,
      absentDeliverReviewPrMode(false),
    );
    expect(full.autonomy).toBe("full");
    expect(full.actions.direct).toContain("Accept completion into Done");

    // No autonomy on the deployment resolves to supervised, so the ceiling holds.
    const defaulted = effectiveProfileView(
      opDeployment(undefined, "direct"),
      undefined,
      absentDeliverReviewPrMode(false),
    );
    expect(defaulted.actions.recommend).toContain("Accept completion into Done");
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
    capabilities: CapabilityGrant[],
  ): AgentDeployment => ({
    profileId: "operator",
    capabilities,
    extras: [],
    definition: { kind: "operator", name: "Operator", role: "Task coordinator" },
  });

  const noGrant = [
    cap("assign-primary-specialist", "direct"),
    cap("stage-transitions", "recommend"),
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

/**
 * OBS-7 (live) — Developer is deployed from the global base, an admin edits it
 * in the project (the fork the edit modal warns about: "keeps its own copy and
 * stops tracking the global"), and the detail header goes on reading
 * "Global base" — the one line a reader consults to decide whether editing the
 * ORG profile would reach this project. Web Verifier, created in-project, reads
 * "Created in viberr" and is not affected, which is what made the flat label
 * look authoritative.
 *
 * The signal is the deployment's own `definition` snapshot: the seeded roster
 * carries none (agent-catalog.server.ts deploys `profileId` + capabilities), so
 * a snapshot exists only because this project wrote one. The scope-sentence test
 * keeps the paths that already name themselves — create ("Created in …") and the
 * library deploy ("Added from the global library to …") — out of it.
 *
 * OBS-7 residual (this pass): the snapshot's EXISTENCE was the whole rule, and
 * two writers produce one without touching identity — project creation's `auto`
 * preset (`{ autonomy: "full" }` alone) and the org resource-rename rewriter
 * (`definition.resources` alone). Both left the card asserting a divergence
 * that had not happened. The rule is now "at least one non-autonomy,
 * non-resources field, present AND different from the template", which the last
 * three cases pin from both sides.
 */
describe("OBS-7: a project-forked global profile is labeled as customized", () => {
  const ctx = createTestDbContext();
  afterEach(ctx.cleanup);

  const developer = (
    definition?: AgentDeploymentDefinition,
  ): AgentDeployment => {
    // An untouched deployment carries NO `definition` key at all — that absence
    // is the signal under test, so it must be a real absence.
    const deployment: AgentDeployment = {
      profileId: "developer",
      capabilities: [cap("commit-push-branch", "direct")],
      extras: [],
    };
    if (definition) deployment.definition = definition;
    return deployment;
  };

  const view = (deployment: AgentDeployment, dataRoot: string) =>
    effectiveProfileView(deployment, dataRoot, absentDeliverReviewPrMode(false));

  it("an untouched deployment tracks the global base and is NOT customized", () => {
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const untouched = view(developer(), dataRoot);
    // Non-vacuity: the template really was read (this is the template's scope).
    expect(untouched.scope).toBe("Global base");
    expect(untouched.customized).toBe(false);
  });

  it("a definition snapshot wearing the template's own scope IS customized", () => {
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    // Exactly what the edit writer persists: a full snapshot, with
    // `scope: current.scope` — the global base's sentence, carried forward.
    // The customization here is a Codex fork (the template now defaults to
    // Claude/sonnet), so backend+model differ while the scope sentence matches.
    const forked = view(
      developer({
        kind: "specialist",
        name: "Developer",
        role: "Implementation",
        scope: "Global base",
        backends: ["codex", "claude"],
        model: "gpt-5.6-terra",
      }),
      dataRoot,
    );
    expect(forked.scope).toBe("Global base");
    expect(forked.customized).toBe(true);
  });

  it("a profile that already names its project is not double-labeled", () => {
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    for (const scope of [
      "Created in Viberr Core",
      "Added from the global library to Viberr Core",
    ]) {
      const named = view(
        // `model` really does differ from the template's (`gpt-5.6-terra`), so
        // the identity rule below says CUSTOMIZED here and the scope sentence
        // is the only thing that can turn it off — otherwise this case would
        // pass for the wrong reason.
        developer({ kind: "specialist", name: "Developer", scope, model: "sonnet" }),
        dataRoot,
      );
      expect({ scope, customized: named.customized }).toEqual({
        scope,
        customized: false,
      });
    }
  });

  /**
   * OBS-7 residual: "a snapshot exists" is not "the copy diverged".
   *
   * `createProject` writes `definition: { ...a.definition, autonomy: "full" }`
   * onto the operator for the `auto` governance preset — on a base deployment
   * that spreads `undefined`, so the stored snapshot is `{ autonomy: "full" }`
   * and nothing else. Every auto-preset project therefore opened with its
   * operator card reading "Global base · customized for <project>" before
   * anyone had edited a thing. The org resource-rename rewriter
   * (resource-references.server.ts) is the same shape one field over.
   */
  it("a snapshot carrying ONLY autonomy is not an identity customization", () => {
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const autonomyOnly = view(developer({ autonomy: "full" }), dataRoot);
    expect(autonomyOnly.customized).toBe(false);
    // Non-vacuity: the snapshot IS there and IS read — the same deployment with
    // one real identity field flips, so this is the rule and not a dropped read.
    expect(
      view(developer({ autonomy: "full", role: "Delivery" }), dataRoot).customized,
    ).toBe(true);
  });

  it("a snapshot carrying ONLY resource grants is not an identity customization", () => {
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const resourcesOnly = view(
      developer({ resources: { skills: ["developer-expertise"], mcps: [], kb: [] } }),
      dataRoot,
    );
    expect(resourcesOnly.customized).toBe(false);
    // Non-vacuity: the grants really did reach the view.
    expect(resourcesOnly.resources.skills).toEqual(["developer-expertise"]);
  });

  it("a snapshot that only echoes the template's own identity is not customized", () => {
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    // Every field present, every value the template's — a fork that changed
    // nothing has nothing to disclose.
    const echo = view(
      developer({
        kind: "specialist",
        name: "Developer",
        role: "Implementation",
        icon: "branch",
        backends: ["claude", "codex"],
        model: "sonnet",
        scope: "Global base",
        stages: ["ready", "impl"],
      }),
      dataRoot,
    );
    // Non-vacuity: these really are the template's values (a drifted seed would
    // make the echo an override and this case meaningless).
    expect({ name: echo.name, role: echo.role, model: echo.model }).toEqual({
      name: "Developer",
      role: "Implementation",
      model: "sonnet",
    });
    expect(echo.customized).toBe(false);
    // One field off the template is the whole difference.
    expect(
      view(
        developer({ name: "Developer", role: "Implementation", icon: "bolt" }),
        dataRoot,
      ).customized,
    ).toBe(true);
  });
});
