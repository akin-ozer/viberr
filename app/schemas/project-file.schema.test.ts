import { describe, expect, it } from "vitest";
import { parseProjectFrontmatter } from "./project-file.schema";

describe("parseProjectFrontmatter — per-entry tolerance (F18)", () => {
  it("keeps valid members and drops only the malformed row (never wipes the ACL)", () => {
    const { frontmatter, diagnostics } = parseProjectFrontmatter(
      {
        slug: "proj",
        members: [
          { userId: "u_admin", role: "admin" },
          { role: "maintainer" }, // malformed: no userId
          { userId: "u_contrib", role: "contributor" },
        ],
      },
      { fallbackSlug: "proj" },
    );
    // Both valid members survive — one bad row no longer strips EVERY role.
    expect(frontmatter.members.map((m) => m.userId)).toEqual([
      "u_admin",
      "u_contrib",
    ]);
    // The bad row is reported at its index.
    expect(diagnostics.some((d) => d.path === "members[1]")).toBe(true);
  });

  it("keeps valid agent deployments and drops only the malformed one", () => {
    const { frontmatter, diagnostics } = parseProjectFrontmatter(
      {
        slug: "proj",
        agents: [
          { profileId: "operator", capabilities: [], extras: [] },
          { capabilities: "not-a-list" }, // malformed: no profileId, bad caps
        ],
      },
      { fallbackSlug: "proj" },
    );
    expect(frontmatter.agents.map((a) => a.profileId)).toEqual(["operator"]);
    expect(diagnostics.some((d) => d.path === "agents[1]")).toBe(true);
  });

  /**
   * `guardrails` was left on the whole-array path when F18 moved the other
   * four lists. An emptied list reads to every consumer as "nothing
   * configured": each anti-noise guardrail reads OFF, and a
   * `delete-branch-after-merge` an admin explicitly disabled flips back to its
   * ON default — after which the next project write persists the loss.
   */
  it("keeps valid guardrails and drops only the malformed row", () => {
    const { frontmatter, diagnostics } = parseProjectFrontmatter(
      {
        slug: "proj",
        guardrails: [
          { id: "evidence-separation", on: true },
          "run-cap", // malformed: a bare string, not an entry
          { id: "delete-branch-after-merge", on: false },
        ],
      },
      { fallbackSlug: "proj" },
    );
    expect(frontmatter.guardrails.map((g) => g.id)).toEqual([
      "evidence-separation",
      "delete-branch-after-merge",
    ]);
    // The disabled guardrail stays disabled rather than reverting to its
    // default by disappearing.
    expect(
      frontmatter.guardrails.find((g) => g.id === "delete-branch-after-merge")?.on,
    ).toBe(false);
    expect(diagnostics.some((d) => d.path === "guardrails[1]")).toBe(true);
  });

  it("a non-list value for a list field degrades to empty (never throws)", () => {
    const { frontmatter, diagnostics } = parseProjectFrontmatter(
      { slug: "proj", members: "not-a-list" },
      { fallbackSlug: "proj" },
    );
    expect(frontmatter.members).toEqual([]);
    expect(diagnostics.some((d) => d.path === "members")).toBe(true);
  });
});
