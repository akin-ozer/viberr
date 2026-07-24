import { describe, expect, it } from "vitest";
import { parseAgentProfileContent } from "./agent-profile-file.server";

/**
 * Agent-profile files are `.loose()`, so unknown frontmatter is preserved but
 * otherwise silent. parseAgentProfileContent surfaces it as a drift warning
 * (seed #3) — the same class of guard the task/project files already have.
 */
describe("parseAgentProfileContent — schema drift detection", () => {
  const base =
    "---\nid: dev\nkind: specialist\nname: Developer\nrole: Implementation\n";

  it("warns on an unrecognized top-level frontmatter field", () => {
    const { parsed, diagnostics } = parseAgentProfileContent(
      base + "renamedField: oops\n---\nA developer.",
    );
    // Still parses (loose preserves the value) — but the drift is flagged.
    expect(parsed).not.toBeNull();
    const drift = diagnostics.find((d) => d.code === "agent_profile.unknown_field");
    expect(drift).toBeTruthy();
    expect(drift!.message).toContain("renamedField");
  });

  it("does not warn on a clean, in-schema profile", () => {
    const { parsed, diagnostics } = parseAgentProfileContent(
      base + "backends:\n  - claude\nstages:\n  - impl\n---\nA developer.",
    );
    expect(parsed).not.toBeNull();
    expect(
      diagnostics.some((d) => d.code === "agent_profile.unknown_field"),
    ).toBe(false);
  });
});
