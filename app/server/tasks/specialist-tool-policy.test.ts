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
  it("denies EVERY delivery tool when no grant says otherwise (P14-LV-01)", () => {
    // The polarity that matters: an empty grant list is not "unspecified, so
    // allowed" — it is "nobody granted delivery, so none of it". Live, the old
    // polarity let a deployed org template described as "never touches app
    // code" branch, commit, push and open PRs.
    const denied = resolveSpecialistDisallowedTools([]);
    for (const t of [
      "Bash(git checkout -b:*)",
      "Bash(git checkout -B:*)",
      "Bash(git push:*)",
      "Bash(git commit:*)",
      "Bash(gh pr create:*)",
      "Bash(gh pr merge:*)",
      "Edit",
      "MultiEdit",
      "Write",
      "NotebookEdit",
    ]) {
      expect(denied).toContain(t);
    }
    // Non-delivery capabilities keep the permissive default — withholding web
    // egress is a policy choice, not something absence should decide.
    expect(denied).not.toContain("WebFetch");
    expect(denied).not.toContain("WebSearch");
  });

  it("confines an UNDEPLOYED profile even harder — web egress goes too (AO-5 #5)", () => {
    const denied = resolveUndeployedDisallowedTools();
    for (const t of [
      "Bash(git checkout -b:*)",
      "Bash(git push:*)",
      "Bash(git commit:*)",
      "Bash(gh pr create:*)",
      "Bash(gh pr merge:*)",
      "Edit",
      "Write",
      "WebFetch",
      "WebSearch",
    ]) {
      expect(denied).toContain(t);
    }
    // "We know nothing about this profile" is stricter than "this profile was
    // authored with no delivery grants": only the former also loses the web.
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

  it("a scoped delivery grant repairs the absent headline instead of crippling the run", () => {
    // `recommend` on a scoped delivery capability is actionable, so the write
    // paths' `normalizeDeliveryGrants` repair applies here too: the profile
    // clearly delivers, so an ABSENT `execute-code-or-write-repo` must not read
    // as withheld and strip Edit/Write from a working deliverer.
    const denied = resolveSpecialistDisallowedTools([
      grant("commit-push-branch", "recommend"),
    ]);
    expect(denied).not.toContain("Bash(git push:*)");
    expect(denied).not.toContain("Edit");
    expect(denied).not.toContain("Write");
    // Un-granted delivery steps are still denied, and merge is always human.
    expect(denied).toContain("Bash(git checkout -b:*)");
    expect(denied).toContain("Bash(gh pr create:*)");
    expect(denied).toContain("Bash(gh pr merge:*)");
  });

  it("an EXPLICIT off headline is never overturned by a scoped delivery grant", () => {
    // The mirror image of P14-LV-01: permission must not appear from anything
    // other than a grant. The read side repairs an ABSENT headline (below), but
    // an admin who set "Execute code or write to the repo: Off" while leaving
    // "Commit & push" on has withheld file writes, and a scoped grant must not
    // hand them back. (`normalizeDeliveryGrants` does rewrite this at SAVE time,
    // where the admin can see and re-edit the result — reusing it here silently
    // re-granted Edit/Write at the enforcement layer.)
    const denied = resolveSpecialistDisallowedTools([
      grant("execute-code-or-write-repo", "off"),
      grant("commit-push-branch", "direct"),
    ]);
    expect(denied).toContain("Edit");
    expect(denied).toContain("Write");
    expect(denied).toContain("MultiEdit");
    expect(denied).toContain("NotebookEdit");
    expect(denied).toContain("Bash(git commit:*)");
    // The explicitly granted scoped step is still permitted.
    expect(denied).not.toContain("Bash(git push:*)");
    expect(
      resolveDeliveryPermissions([
        grant("execute-code-or-write-repo", "off"),
        grant("commit-push-branch", "direct"),
      ]),
    ).toMatchObject({ canCommitPush: false });
  });

  it("an explicit HUMAN headline is likewise respected, not repaired", () => {
    const denied = resolveSpecialistDisallowedTools([
      grant("execute-code-or-write-repo", "human"),
      grant("commit-push-branch", "direct"),
    ]);
    expect(denied).toContain("Edit");
    expect(denied).toContain("Write");
  });

  it("a capability outside the grant-required set stays permissive when unspecified", () => {
    // Web egress is a policy nicety, not a delivery power: absence keeps it.
    expect(resolveSpecialistDisallowedTools([])).not.toContain("WebFetch");
    expect(
      resolveSpecialistDisallowedTools([grant("use-web-search-fetch", "off")]),
    ).toContain("WebFetch");
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

/* --------------------------------------------- web egress (P13-LV-18) */

describe("web egress capability", () => {
  it("an ABSENT grant keeps the web tools — nothing regresses for existing profiles", () => {
    expect(resolveSpecialistDisallowedTools([])).not.toContain("WebFetch");
    expect(resolveSpecialistDisallowedTools([])).not.toContain("WebSearch");
  });

  it("withholding use-web-search-fetch denies WebFetch + WebSearch", () => {
    const denied = resolveSpecialistDisallowedTools([
      grant("use-web-search-fetch", "off"),
    ]);
    expect(denied).toContain("WebFetch");
    expect(denied).toContain("WebSearch");
  });

  it("human-only mode withholds it from the agent too", () => {
    expect(
      resolveSpecialistDisallowedTools([grant("use-web-search-fetch", "human")]),
    ).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
  });
});

/* --------------------------------- MCP is outside the matrix (R16-5) */

describe("MCP tools are deliberately NOT capability-gated (R16-5)", () => {
  // Owner ruling, 2026-08-04: MCP grants stay outside the capability matrix.
  // Viberr cannot know what a third-party tool does, so it does not pretend to
  // bound one — granting a server IS the grant, and the only rule it can
  // enforce is the prompt-level one (an MCP tool may never merge, close a task
  // or change policy).
  //
  // Without this test the decision is invisible: the absence of an `mcp__*`
  // deny rule reads exactly like an oversight, and the obvious "fix" — denying
  // `mcp__*` alongside Edit/Write when execute-code-or-write-repo is withheld —
  // would silently revoke every read-only MCP server an operator granted on
  // purpose. This is the record that says the gap is a decision.

  it("withholding execute-code-or-write-repo does NOT deny the mcp__* channel", () => {
    const denied = resolveSpecialistDisallowedTools([
      grant("execute-code-or-write-repo", "off"),
    ]);
    // The file-write tools ARE removed — the capability has teeth where Viberr
    // can see the tool.
    expect(denied).toContain("Edit");
    expect(denied).toContain("Write");
    // …and stops exactly at the boundary of what it can see.
    expect(denied.some((tool) => tool.startsWith("mcp__"))).toBe(false);
  });

  it("no capability, at any mode, denies an mcp__* tool", () => {
    const modes: CapabilityGrant["mode"][] = ["off", "human", "direct"];
    for (const mode of modes) {
      for (const capabilityId of [
        "execute-code-or-write-repo",
        "use-web-search-fetch",
        "create-task-branch",
        "commit-push-branch",
        "open-review-pr",
        "merge-pull-request",
      ]) {
        const denied = resolveSpecialistDisallowedTools([grant(capabilityId, mode)]);
        expect(
          denied.filter((tool) => tool.startsWith("mcp__")),
          `${capabilityId} @ ${mode} must not touch the mcp__* channel`,
        ).toEqual([]);
      }
    }
  });

  it("an undeployed agent is confined by DEPLOYMENT, not by the matrix", () => {
    // The one place mcp__* could legitimately be cut is "this agent is not
    // deployed here at all" — a different question from "which capabilities did
    // you grant it". Pinned so the two stay distinguishable.
    const denied = resolveUndeployedDisallowedTools();
    expect(denied.length).toBeGreaterThan(0);
  });
});
