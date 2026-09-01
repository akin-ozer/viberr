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

  it("effort is a known key and round-trips as a string", () => {
    const { parsed, diagnostics } = parseAgentProfileContent(
      base + "effort: max\n---\nA developer.",
    );
    expect(parsed?.frontmatter.effort).toBe("max");
    expect(
      diagnostics.some((d) => d.code === "agent_profile.unknown_field"),
    ).toBe(false);
  });

  it("a junk effort value degrades to absent, never failing the whole profile", () => {
    // Ruling 106 review D2: the pre-schema decoder read "absent or non-string
    // as ''". A strict schema field turned `effort:` (YAML null) or
    // `effort: 3` into parsed:null — the controller config then reported
    // "profile missing from the store" over one hand-edited line, and
    // saveControllerConfig refused to repair it. The field is tolerant.
    for (const junk of ["effort:\n", "effort: 3\n", "effort: [a, b]\n"]) {
      const { parsed } = parseAgentProfileContent(
        base + junk + "---\nA developer.",
      );
      expect(parsed).not.toBeNull();
      expect(parsed?.frontmatter.effort).toBeUndefined();
    }
  });
});
