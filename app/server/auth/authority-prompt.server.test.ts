import { describe, expect, it } from "vitest";
import { RBAC_DEFINITIONS, ROLE_RANK, roleCan, type ProjectRole } from "~/shared/rbac";
import {
  askerAuthorityLine,
  authorityTiers,
  projectAuthorityPrompt,
  tiersFrom,
} from "./authority-prompt.server";

/**
 * Ruling 309. These tests exist because the block they cover is a SECOND
 * description of the authorization the server enforces, and a second
 * description is worth having only while it is provably the same description.
 */

describe("authorityTiers", () => {
  it("places every action under exactly one tier, and under its lowest holder", () => {
    const tiers = authorityTiers();
    const placed = tiers.flatMap((t) => t.gains);
    expect(placed).toHaveLength(RBAC_DEFINITIONS.length);
    expect(new Set(placed).size).toBe(RBAC_DEFINITIONS.length);

    // Not "some tier has it" — THE tier, and the right one: the lowest role
    // that holds it per the enforcement map itself.
    for (const { id, label, roles } of RBAC_DEFINITIONS) {
      const tier = tiers.find((t) => t.gains.includes(label));
      expect(tier, `"${label}" is under no tier`).toBeDefined();
      const floor = tier!.role;
      expect(roleCan(floor, id), `${floor} should hold "${id}"`).toBe(true);
      for (const role of roles) {
        expect(
          ROLE_RANK[role] >= ROLE_RANK[floor],
          `"${id}" is filed under ${floor} but ${role} holds it too`,
        ).toBe(true);
      }
    }
  });

  it("refuses to group a table that is not monotonic over the tier", () => {
    // The one thing the grouping ASSUMES. A gap in the middle of the tier —
    // held by viewer and maintainer but not contributor — cannot be described
    // by a floor, and the generated list would silently claim contributors have
    // it. `rbac.ts` states the invariant; this proves the generator checks it
    // rather than trusting the prose.
    const holey: readonly { id: string; label: string; roles: readonly ProjectRole[] }[] = [
      { id: "holey", label: "Holey action", roles: ["viewer", "maintainer", "admin"] },
    ];
    expect(() => tiersFrom(holey)).toThrow(/not monotonic/);
  });

  it("refuses a table with an action no role holds", () => {
    expect(() => tiersFrom([{ id: "orphan", label: "Orphan", roles: [] }])).toThrow(
      /held by no role/,
    );
  });
});

describe("projectAuthorityPrompt", () => {
  const text = projectAuthorityPrompt();

  it("names every action the server gates, in the product's own words", () => {
    // The labels are the Policy page's; a transformation that made them read
    // better in a list (lower-casing) corrupted the two carrying proper nouns.
    for (const { label } of RBAC_DEFINITIONS) {
      expect(text, `"${label}" is missing from the prompt`).toContain(label);
    }
    expect(text).toContain("Accept completion → Done");
    expect(text).toContain("Reconcile GitHub state");
  });

  it("says the list may never be used to refuse the person", () => {
    // The hazard the controller named when this was put to it: "a table in my
    // prompt creates a second authorization evaluator that can disagree with
    // the first... if I start pre-refusing on that basis, I convert a server
    // [denied] — authoritative, audited, correct at the instant of the write —
    // into a controller refusal that is none of those three."
    expect(text).toContain("never grounds for refusing");
    expect(text).toMatch(/MAKE THE CALL ANYWAY/);
  });

  it("forbids explaining a non-role refusal in role terms", () => {
    // The hazard the fix itself creates, which the controller named on the turn
    // after it shipped: "your exception list tells me what the unexplainable
    // refusals will be... for those, 'you need maintainer, ask a project admin'
    // isn't an incomplete explanation — it's a false one, and the table will
    // actively tempt me toward it, because tier is the vocabulary it hands me."
    // A person sent to fix the wrong gate is worse off than one told nothing.
    expect(text).toContain("it was not a role that stopped it");
    expect(text).toContain("do not supply one from here");
  });

  it("marks the hand-maintained half as hand-maintained", () => {
    // The tiers are generated and cannot drift. The exceptions are prose, and
    // prose next to a generated table inherits its credibility without earning
    // it, which is the failure this whole ruling is about.
    const generatedAt = text.indexOf("generated from the server's authorization map");
    const disclaimerAt = text.indexOf("maintained by hand");
    expect(generatedAt).toBeGreaterThan(-1);
    expect(disclaimerAt).toBeGreaterThan(generatedAt);
    // Each exception must sit AFTER the disclaimer, or it reads as generated.
    for (const exception of ["ORG admin", "DISABLED account", "ARCHIVED project"]) {
      expect(text.indexOf(exception)).toBeGreaterThan(disclaimerAt);
    }
  });
});

describe("askerAuthorityLine", () => {
  it("names the role and does not do the multiplication for the model", () => {
    const line = askerAuthorityLine("contributor", false);
    expect(line).toContain("project role contributor");
    // Deliberately NOT a held/not-held set: the two factors stay separate so a
    // denial can be explained ("which tier is missing") rather than only
    // reported. A regression to computing the set server-side shows up as the
    // action labels appearing here.
    for (const { label } of RBAC_DEFINITIONS) {
      expect(line, `the context line should not enumerate "${label}"`).not.toContain(label);
    }
    expect(line.length).toBeLessThan(260);
  });

  it("says where the roles it does NOT carry can be read", () => {
    // Tools default to the bound project but accept another, so this line is
    // silent about exactly the case a task-anchored conversation drifts into.
    expect(askerAuthorityLine("maintainer", false)).toContain("whoami");
  });

  it("distinguishes a role from an override, and reports both when both apply", () => {
    expect(askerAuthorityLine(null, true)).toContain("org-admin override");
    expect(askerAuthorityLine(null, false)).toBe(
      "your authority: not a member of this project · your role on any OTHER project is not in this read — whoami has it, and the tier list in your instructions says what a role holds",
    );

    // An org admin who is ALSO a plain member: the role is real and the
    // override is what actually carries them, and a line naming only one of
    // the two misdescribes what happens on a call.
    const both = askerAuthorityLine("contributor", true);
    expect(both).toContain("project role contributor");
    expect(both).toContain("org admin");
    expect(both).not.toBe(askerAuthorityLine("contributor", false));
  });
});
