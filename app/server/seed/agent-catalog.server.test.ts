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
