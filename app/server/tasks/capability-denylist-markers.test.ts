import { describe, expect, it } from "vitest";
import {
  repoWriteWithheldFromDenylist,
  webSearchWithheldFromDenylist,
} from "~/server/runtimes/run-service.server";
import { resolveSpecialistDisallowedTools } from "./specialist-tool-policy";
// F21-3: imported from BOTH modules on purpose — the point of the pin below
// is that the two names resolve to one value.
import { OPERATOR_READ_ONLY_DENIED_TOOLS as operatorDeniedFromRuntime } from "~/server/runtimes/claude-runtime.server";
import { OPERATOR_READ_ONLY_DENIED_TOOLS as operatorDeniedFromRun } from "~/server/runtimes/operator-run.server";

/**
 * B-AG6 — the cross-file coupling nothing tied together.
 *
 * Codex has no denylist channel, so the two withheld detectors are derived in
 * run-service.server by matching EXACT marker strings against the denylist
 * `specialist-tool-policy` emits. The web one is a REAL Codex lever
 * (`webSearchMode: "disabled"`); the repo-write one no longer drives a
 * sandbox (ruling 185) but still decides which admin-marked MCP write tools a
 * run loses (ruling 176), on both backends. The two constants live in different files with
 * no compile-time link: rename or re-scope a `CAP_DENY_RULES` entry and the
 * marker sets silently stop matching — Codex enforcement quietly drops while
 * Claude keeps working, which is invisible in every test that asserts one side
 * alone.
 *
 * These assert the JOIN: what the policy emits for a withheld grant must be what
 * the detectors recognize, and a granted profile must trip neither.
 */
describe("capability denylist ↔ Codex withheld detectors (B-AG6)", () => {
  const grants = (modes: Record<string, "direct" | "off" | "human">) =>
    Object.entries(modes).map(([capabilityId, mode]) => ({ capabilityId, mode }));

  it("a withheld repo-write grant produces a denylist the repo-write detector recognizes", () => {
    const denied = resolveSpecialistDisallowedTools(
      grants({ "execute-code-or-write-repo": "off" }),
    );
    expect(repoWriteWithheldFromDenylist(denied)).toBe(true);
  });

  it("a withheld web-egress grant produces a denylist the web detector recognizes", () => {
    const denied = resolveSpecialistDisallowedTools(
      grants({ "use-web-search-fetch": "off" }),
    );
    expect(webSearchWithheldFromDenylist(denied)).toBe(true);
  });

  it("the fully-withheld posture trips BOTH detectors", () => {
    const denied = resolveSpecialistDisallowedTools(
      grants({
        "execute-code-or-write-repo": "off",
        "use-web-search-fetch": "off",
        "create-task-branch": "off",
        "commit-push-branch": "off",
        "open-review-pr": "off",
      }),
    );
    expect(repoWriteWithheldFromDenylist(denied)).toBe(true);
    expect(webSearchWithheldFromDenylist(denied)).toBe(true);
  });

  it("a GRANTED profile trips neither detector", () => {
    const denied = resolveSpecialistDisallowedTools(
      grants({
        "execute-code-or-write-repo": "direct",
        "use-web-search-fetch": "direct",
        "create-task-branch": "direct",
        "commit-push-branch": "direct",
        "open-review-pr": "direct",
      }),
    );
    expect(repoWriteWithheldFromDenylist(denied)).toBe(false);
    expect(webSearchWithheldFromDenylist(denied)).toBe(false);
  });

  it("withholding only the SCOPED delivery steps must not read as repo-write withheld", () => {
    // branch/push/PR withheld while the headline stays granted: the run may
    // still edit files, so the repo-write detector must NOT trip (it would
    // strip the run's MCP write tools, ruling 176).
    const denied = resolveSpecialistDisallowedTools(
      grants({
        "execute-code-or-write-repo": "direct",
        "create-task-branch": "off",
        "commit-push-branch": "off",
        "open-review-pr": "off",
      }),
    );
    expect(denied.length).toBeGreaterThan(0);
    expect(repoWriteWithheldFromDenylist(denied)).toBe(false);
  });
});

/**
 * F21-3 — the OPERATOR's confinement list existed TWICE.
 *
 * `claude-runtime.server` denied it per `kind: "operator"` run; `operator-run.
 * server` stated the same five tool names again as a second unguarded literal,
 * with nothing tying the two together and no test on either. Two copies of a
 * confinement list is one copy away from a run that believes it is read-only
 * and is not — and the F21-21 fix DEPENDS on `Bash` being on it (that is why
 * the anchored default-branch read had to be a tool rather than `git show`).
 *
 * There is one const now. These pin the join, the membership, and the shape of
 * the list a run actually carries.
 */
describe("operator read-only denylist is ONE list (F21-3)", () => {
  it("the runtime's list and the run-builder's export are the same value", () => {
    // Canary: re-introduce a second literal in operator-run.server and this
    // fails the moment the two differ by one entry.
    expect(operatorDeniedFromRun).toBe(operatorDeniedFromRuntime);
  });

  it("is COMPLETE — every write/shell built-in, and none of the read tools", () => {
    const denied = [...operatorDeniedFromRun];
    // Shell is on it: the operator cannot run git itself, which is why
    // `read_default_branch_file` exists (F21-21).
    for (const tool of ["Bash", "Edit", "MultiEdit", "Write", "NotebookEdit"]) {
      expect(denied).toContain(tool);
    }
    // Reading is the whole point of the operator's checkout (R19-1).
    for (const tool of ["Read", "Grep", "Glob"]) {
      expect(denied).not.toContain(tool);
    }
    // No stray entries: an addition here is a deliberate confinement change.
    expect(denied.length).toBe(5);
  });
});
