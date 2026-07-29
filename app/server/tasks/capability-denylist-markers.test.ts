import { describe, expect, it } from "vitest";
import {
  repoWriteWithheldFromDenylist,
  webSearchWithheldFromDenylist,
} from "~/server/runtimes/run-service.server";
import { resolveSpecialistDisallowedTools } from "./specialist-tool-policy";

/**
 * B-AG6 — the cross-file coupling nothing tied together.
 *
 * Codex has no denylist channel, so its two REAL enforcement levers (the
 * read-only sandbox, `webSearchMode: "disabled"`) are derived in
 * run-service.server by matching EXACT marker strings against the denylist
 * `specialist-tool-policy` emits. The two constants live in different files with
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
    // still edit files, so the Codex read-only sandbox must NOT engage.
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
