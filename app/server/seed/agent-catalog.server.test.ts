import { describe, expect, it } from "vitest";
import { SEED_AGENT_PROFILES } from "./agent-catalog.server";

/**
 * F17 / H15: the seeded specialist profiles shipped
 * `Global base · customized for Viberr Core` — a workspace that exists nowhere
 * in the product. It is a literal lifted from the design mock
 * (design/html-app/app/data.js), where "Viberr Core" is the prototype's one
 * fake project; the app's OWN profile writer (`gagents.server.ts`) has always
 * written the honest `Global base`. So a clean-sheet instance's Agents page
 * described every preinstalled profile as customized for a project the user
 * had not created and could not find.
 *
 * The scope line is display copy with no parser behind it, which is exactly why
 * nothing caught the drift. These assertions are the guard: seeded copy names
 * only things the product actually has.
 */

const SCOPE_OF = (id: string) =>
  SEED_AGENT_PROFILES.find((p) => p.frontmatter.id === id)?.frontmatter.scope;

describe("seeded agent catalog copy", () => {
  it("preinstalled specialists claim the same scope the app writes for a new profile", () => {
    // `createGlobalAgentTemplate` (org/gagents.server.ts) writes exactly this
    // for every profile a user creates — seeded and user-made profiles must be
    // describable in the same words, or the roster reads as two products.
    expect(SCOPE_OF("developer")).toBe("Global base");
    expect(SCOPE_OF("reviewer")).toBe("Global base");
  });

  it("the operator states its real scope (one instance per active task)", () => {
    expect(SCOPE_OF("operator")).toBe("System role · one per active task");
  });

  it("no seeded copy names a workspace the product does not have", () => {
    // "Viberr Core" is the design mock's fake project. A REAL project is named
    // by its own project.md; nothing shipped in the seed may assert one.
    const copy = SEED_AGENT_PROFILES.flatMap((p) => [
      p.frontmatter.scope,
      p.frontmatter.desc,
      p.frontmatter.name,
      p.frontmatter.role,
      p.description,
    ]);
    for (const line of copy) {
      expect(line).not.toMatch(/Viberr Core/i);
      // The mock's phrasing more generally: a global template cannot be
      // "customized for" any particular project — that is what a project
      // deployment is for.
      expect(line).not.toMatch(/customized for/i);
    }
  });

  it("every seeded profile carries a non-empty scope line", () => {
    for (const p of SEED_AGENT_PROFILES) {
      expect(p.frontmatter.scope.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("seeded specialist capability modes (F20-21 / R20-6 — direct or withheld)", () => {
  const grantsOf = (id: string) =>
    SEED_AGENT_PROFILES.find((p) => p.frontmatter.id === id)!.frontmatter
      .capabilities;
  const modeOf = (id: string, capId: string) =>
    grantsOf(id).find((c) => c.capabilityId === capId)?.mode;

  it("no seeded SPECIALIST grant is `recommend` — the file matches the matrix", () => {
    // The seed used to ship `move-task-to-review: recommend` (Developer) and
    // `approve-review`/`request-changes: recommend` (Reviewer) while the runtime
    // widened them to `direct`, so the canonical project.md disagreed with every
    // rendered surface. Specialists act directly or are withheld — never propose.
    for (const p of SEED_AGENT_PROFILES) {
      if (p.frontmatter.kind !== "specialist") continue;
      const recommend = p.frontmatter.capabilities.filter(
        (c) => c.mode === "recommend",
      );
      expect(
        recommend,
        `${p.frontmatter.id} must ship no recommend grants`,
      ).toEqual([]);
    }
  });

  it("the Developer's former `recommend` (move-task-to-review) now ships `direct`", () => {
    expect(modeOf("developer", "move-task-to-review")).toBe("direct");
  });

  it("the Reviewer's former `recommend` verdict outcomes now ship `direct`", () => {
    expect(modeOf("reviewer", "approve-review")).toBe("direct");
    expect(modeOf("reviewer", "request-changes")).toBe("direct");
  });

  it("the OPERATOR keeps its real `recommend` grants (only specialists were coerced)", () => {
    expect(modeOf("operator", "stage-transitions")).toBe("recommend");
    expect(modeOf("operator", "completion-for-acceptance")).toBe("recommend");
  });
});

describe("seeded Frontend/Design specialist (repo-grounded UI craft profile)", () => {
  const frontendDesign = SEED_AGENT_PROFILES.find(
    (p) => p.frontmatter.id === "frontend-design",
  );

  it("ships as a specialist profile carrying its own skill", () => {
    expect(frontendDesign).toBeDefined();
    expect(frontendDesign!.frontmatter.kind).toBe("specialist");
    expect(frontendDesign!.frontmatter.resources.skills).toEqual([
      "frontend-design-expertise",
    ]);
  });

  it("does not hold the review-verdict outcomes — the Reviewer stays the required gate", () => {
    const modeOf = (capId: string) =>
      frontendDesign!.frontmatter.capabilities.find((c) => c.capabilityId === capId)?.mode;
    expect(modeOf("report-validation-verdict")).toBeUndefined();
    expect(modeOf("approve-review")).toBeUndefined();
    expect(modeOf("request-changes")).toBeUndefined();
  });
});

describe("repo-grounded KB granted to Developer + Reviewer", () => {
  it("both carry the repo-conventions KB (not a fabricated demo ADR)", () => {
    const dev = SEED_AGENT_PROFILES.find((p) => p.frontmatter.id === "developer")!;
    const reviewer = SEED_AGENT_PROFILES.find((p) => p.frontmatter.id === "reviewer")!;
    expect(dev.frontmatter.resources.kb).toContain("repo-conventions");
    expect(reviewer.frontmatter.resources.kb).toContain("repo-conventions");
  });
});

describe("seeded Developer backend (owner ruling 2026-08-21)", () => {
  it("defaults to CLAUDE so a fresh install runs without a Codex quota; Codex stays available", () => {
    const dev = SEED_AGENT_PROFILES.find((p) => p.frontmatter.id === "developer")!;
    // Claude is the PRIMARY (first) backend, so a run/display resolves Claude…
    expect(dev.frontmatter.backends[0]).toBe("claude");
    expect(dev.frontmatter.model).toBe("sonnet");
    // …and Codex is still OFFERED, so an admin can flip the profile to it.
    expect(dev.frontmatter.backends).toContain("codex");
  });
});
