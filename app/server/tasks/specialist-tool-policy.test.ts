import { describe, expect, it } from "vitest";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
import { resolveSpecialistDisallowedTools } from "./specialist-tool-policy";

/**
 * The specialist capability → tool confinement mapping. These are the deny
 * rules a real Claude specialist run is bound by (they override
 * bypassPermissions), so this is the seam that makes specialist grants bite.
 */

const grant = (capabilityId: string, mode: CapabilityGrant["mode"]) =>
  ({ capabilityId, mode }) as CapabilityGrant;

describe("resolveSpecialistDisallowedTools", () => {
  it("always denies PR merge (an always-human capability), even with no grants", () => {
    expect(resolveSpecialistDisallowedTools([])).toEqual(["Bash(gh pr merge:*)"]);
  });

  it("denies git push when commit-push is withheld (human or off), not when direct", () => {
    expect(
      resolveSpecialistDisallowedTools([grant("commit-push-branch", "human")]),
    ).toContain("Bash(git push:*)");
    expect(
      resolveSpecialistDisallowedTools([grant("commit-push-branch", "off")]),
    ).toContain("Bash(git push:*)");
    expect(
      resolveSpecialistDisallowedTools([grant("commit-push-branch", "direct")]),
    ).not.toContain("Bash(git push:*)");
  });

  it("keeps default tool access for unspecified / recommend capabilities", () => {
    // Only the always-human merge deny is present; push/PR/branch stay allowed.
    expect(
      resolveSpecialistDisallowedTools([grant("commit-push-branch", "recommend")]),
    ).toEqual(["Bash(gh pr merge:*)"]);
  });

  it("denies opening a PR only when open-review-pr is withheld", () => {
    expect(
      resolveSpecialistDisallowedTools([grant("open-review-pr", "off")]),
    ).toContain("Bash(gh pr create:*)");
    expect(
      resolveSpecialistDisallowedTools([grant("open-review-pr", "direct")]),
    ).not.toContain("Bash(gh pr create:*)");
  });

  it("a fully-empowered developer is confined only by the always-human merge rule", () => {
    const grants = [
      grant("create-task-branch", "direct"),
      grant("commit-push-branch", "direct"),
      grant("open-review-pr", "direct"),
    ];
    expect(resolveSpecialistDisallowedTools(grants)).toEqual([
      "Bash(gh pr merge:*)",
    ]);
  });

  it("a withheld-everything specialist is denied branch, push, and PR commands", () => {
    const grants = [
      grant("create-task-branch", "human"),
      grant("commit-push-branch", "human"),
      grant("open-review-pr", "human"),
    ];
    const denied = resolveSpecialistDisallowedTools(grants);
    expect(denied).toEqual(
      expect.arrayContaining([
        "Bash(git checkout -b:*)",
        "Bash(git switch -c:*)",
        "Bash(git push:*)",
        "Bash(gh pr create:*)",
        "Bash(gh pr merge:*)",
      ]),
    );
  });
});
