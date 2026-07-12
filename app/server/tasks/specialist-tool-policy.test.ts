import { describe, expect, it } from "vitest";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
import {
  resolveDeliveryPermissions,
  resolveSpecialistDisallowedTools,
  specialistBackendCapabilitySupport,
} from "./specialist-tool-policy";

/**
 * The specialist capability → tool confinement mapping. These are the deny
 * rules a real Claude specialist run is bound by (they override
 * bypassPermissions), so this is the seam that makes specialist grants bite.
 */

const grant = (capabilityId: string, mode: CapabilityGrant["mode"]) =>
  ({ capabilityId, mode }) as CapabilityGrant;

describe("resolveSpecialistDisallowedTools", () => {
  it("fails closed when mapped capability grants are omitted", () => {
    expect(resolveSpecialistDisallowedTools([])).toEqual(
      expect.arrayContaining([
        "Bash(git push:*)",
        "Bash(gh pr create:*)",
        "Bash(gh pr merge:*)",
        "Bash(git checkout -b:*)",
        "Bash(git commit:*)",
        "Edit",
      ]),
    );
  });

  it("always denies model-side git push while commit permission remains capability-bound", () => {
    expect(
      resolveSpecialistDisallowedTools([grant("commit-push-branch", "human")]),
    ).toContain("Bash(git push:*)");
    expect(
      resolveSpecialistDisallowedTools([grant("commit-push-branch", "off")]),
    ).toContain("Bash(git push:*)");
    expect(
      resolveSpecialistDisallowedTools([
        grant("commit-push-branch", "direct"),
        grant("execute-code-or-write-repo", "direct"),
      ]),
    ).toContain("Bash(git push:*)");
    expect(
      resolveSpecialistDisallowedTools([
        grant("commit-push-branch", "direct"),
        grant("execute-code-or-write-repo", "direct"),
      ]),
    ).not.toContain("Bash(git commit:*)");
  });

  it("recommend grants its mapped action while other omissions stay withheld", () => {
    const denied = resolveSpecialistDisallowedTools([
      grant("commit-push-branch", "recommend"),
      grant("execute-code-or-write-repo", "direct"),
    ]);
    expect(denied).not.toContain("Bash(git commit:*)");
    expect(denied).toContain("Bash(git checkout -b:*)");
    expect(denied).not.toContain("Edit");
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
      grant("execute-code-or-write-repo", "direct"),
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

  it("always denies model-side PR creation; the capability gates Viberr's finalizer", () => {
    expect(
      resolveSpecialistDisallowedTools([grant("open-review-pr", "off")]),
    ).toContain("Bash(gh pr create:*)");
    expect(
      resolveSpecialistDisallowedTools([grant("open-review-pr", "direct")]),
    ).toContain("Bash(gh pr create:*)");
  });

  it("a fully-empowered developer can commit locally but remote delivery stays server-owned", () => {
    const grants = [
      grant("create-task-branch", "direct"),
      grant("commit-push-branch", "direct"),
      grant("open-review-pr", "direct"),
      grant("execute-code-or-write-repo", "direct"),
    ];
    expect(resolveSpecialistDisallowedTools(grants)).toEqual([
      "Bash(git push:*)",
      "Bash(gh pr create:*)",
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

describe("specialistBackendCapabilitySupport", () => {
  const fullyGranted = [
    grant("create-task-branch", "direct"),
    grant("commit-push-branch", "direct"),
    grant("execute-code-or-write-repo", "direct"),
  ];

  it("allows Claude to bind withheld local capabilities", () => {
    expect(specialistBackendCapabilitySupport([], "claude")).toEqual({
      supported: true,
      advisoryOnlyWithheld: [],
    });
  });

  it("hard-rejects Codex when a local enforced capability is missing or off", () => {
    expect(specialistBackendCapabilitySupport([], "codex")).toMatchObject({
      supported: false,
      advisoryOnlyWithheld: [
        "create-task-branch",
        "commit-push-branch",
        "execute-code-or-write-repo",
      ],
    });
    expect(
      specialistBackendCapabilitySupport(
        [...fullyGranted.slice(0, 2), grant("execute-code-or-write-repo", "off")],
        "codex",
      ),
    ).toMatchObject({
      supported: false,
      advisoryOnlyWithheld: ["execute-code-or-write-repo"],
    });
  });

  it("allows Codex only when every local capability is explicitly actionable", () => {
    expect(specialistBackendCapabilitySupport(fullyGranted, "codex")).toEqual({
      supported: true,
      advisoryOnlyWithheld: [],
    });
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
});
