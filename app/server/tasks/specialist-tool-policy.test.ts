import { describe, expect, it } from "vitest";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
import {
  resolveDeliveryPermissions,
  resolveSpecialistDisallowedTools,
  resolveUndeployedDisallowedTools,
} from "./specialist-tool-policy";

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

  it("confines an UNDEPLOYED profile conservatively — denies ALL delivery, not just merge (AO-5 #5)", () => {
    const denied = resolveUndeployedDisallowedTools();
    // Every delivery tool is denied (branch create, commit, push, PR open, file writes),
    // NOT just the always-human merge — a resumed run of a vanished profile can't deliver.
    for (const t of [
      "Bash(git checkout -b:*)",
      "Bash(git push:*)",
      "Bash(git commit:*)",
      "Bash(gh pr create:*)",
      "Bash(gh pr merge:*)",
      "Edit",
      "Write",
    ]) {
      expect(denied).toContain(t);
    }
    // Strictly more restrictive than the empty-grants (deployed, unspecified) case.
    expect(denied.length).toBeGreaterThan(
      resolveSpecialistDisallowedTools([]).length,
    );
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

  it("withholding execute-code-or-write-repo denies Edit/MultiEdit/Write + git commit (D1, XS-13)", () => {
    const denied = resolveSpecialistDisallowedTools([
      grant("execute-code-or-write-repo", "human"),
    ]);
    expect(denied).toContain("Edit");
    expect(denied).toContain("MultiEdit"); // XS-13: was omitted vs the operator denylist
    expect(denied).toContain("Write");
    expect(denied).toContain("NotebookEdit");
    expect(denied).toContain("Bash(git commit:*)");
    // direct keeps write access.
    expect(
      resolveSpecialistDisallowedTools([grant("execute-code-or-write-repo", "direct")]),
    ).not.toContain("Edit");
  });

  it("does NOT blanket-deny git checkout/switch — a granted create-task-branch can create its own branch (F11)", () => {
    // The removed `edit-other-task-branch` rule denied `Bash(git checkout:*)`,
    // which (deny wins under bypassPermissions) also blocked the specialist's own
    // `git checkout -B <task-branch>` and defeated create-task-branch. With the
    // rule gone, a fully-granted developer has NO git-checkout/switch denies.
    const denied = resolveSpecialistDisallowedTools([
      grant("create-task-branch", "direct"),
      grant("commit-push-branch", "direct"),
      grant("open-review-pr", "direct"),
      grant("edit-other-task-branch", "off"), // orphan grant: ignored, no rule
    ]);
    expect(denied).not.toContain("Bash(git checkout:*)");
    expect(denied).not.toContain("Bash(git switch:*)");
    expect(denied).not.toContain("Bash(git checkout -b:*)");
  });

  it("commit-push withheld also denies git commit (a reviewer can't commit — D4)", () => {
    const denied = resolveSpecialistDisallowedTools([
      grant("commit-push-branch", "human"),
    ]);
    expect(denied).toContain("Bash(git push:*)");
    expect(denied).toContain("Bash(git commit:*)");
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

  it("withheld create-task-branch also denies the force-create variants (XS-4)", () => {
    // The delivery-contract prompt instructs `git checkout -B <branch>`; a
    // `-b`/`-c`-only denylist let a withheld specialist branch by following it.
    const denied = resolveSpecialistDisallowedTools([
      grant("create-task-branch", "human"),
    ]);
    expect(denied).toEqual(
      expect.arrayContaining([
        "Bash(git checkout -b:*)",
        "Bash(git checkout -B:*)",
        "Bash(git switch -c:*)",
        "Bash(git switch -C:*)",
      ]),
    );
  });
});

describe("resolveDeliveryPermissions", () => {
  it("reports all steps permitted for a fully-granted developer", () => {
    expect(
      resolveDeliveryPermissions([
        grant("create-task-branch", "direct"),
        grant("commit-push-branch", "direct"),
        grant("open-review-pr", "direct"),
      ]),
    ).toEqual({ canBranch: true, canCommitPush: true, canOpenPr: true });
  });

  it("reflects each withheld step so the prompt matches enforcement (XS-4)", () => {
    expect(
      resolveDeliveryPermissions([
        grant("create-task-branch", "human"),
        grant("commit-push-branch", "off"),
        grant("open-review-pr", "human"),
      ]),
    ).toEqual({ canBranch: false, canCommitPush: false, canOpenPr: false });
  });

  it("a withheld execute-code-or-write-repo gates ALL delivery — the prompt may not instruct a commit the tool layer denies (VIB-1 incident)", () => {
    expect(
      resolveDeliveryPermissions([
        grant("execute-code-or-write-repo", "human"),
        grant("create-task-branch", "direct"),
        grant("commit-push-branch", "direct"),
        grant("open-review-pr", "direct"),
      ]),
    ).toEqual({ canBranch: false, canCommitPush: false, canOpenPr: false });
  });
});
