import { describe, expect, it } from "vitest";
import { BRANCH_CLEANUP_GUARDRAIL_ID } from "~/server/github/branch-cleanup.server";
import {
  DEFAULT_GUARDRAIL_IDS,
  GITHUB_MANAGED_GUARDRAIL_ID,
  guardrailKind,
  guardrailLabel,
} from "./guardrail-labels";
import { DEFAULT_GUARDRAILS } from "./templates";

/**
 * Review F11 (pass 32): the branch-cleanup guardrail id is owned by
 * `branch-cleanup.server.ts`; the client-safe label module cannot import a
 * server module, so it re-declares the string — this pins the two together.
 */
describe("guardrail labels", () => {
  it("the GitHub-managed id is the branch-cleanup id, verbatim", () => {
    expect(GITHUB_MANAGED_GUARDRAIL_ID).toBe(BRANCH_CLEANUP_GUARDRAIL_ID);
    expect(guardrailKind(BRANCH_CLEANUP_GUARDRAIL_ID)).toBe("github");
  });

  it("every enforced default has a short label and reads as `default`", () => {
    expect(DEFAULT_GUARDRAIL_IDS).toEqual(DEFAULT_GUARDRAILS.map((g) => g.id));
    for (const id of DEFAULT_GUARDRAIL_IDS) {
      expect(guardrailLabel(id)).not.toBe(id);
      expect(guardrailKind(id)).toBe("default");
    }
    expect(guardrailKind("operator-brevity")).toBe("unknown");
    expect(guardrailLabel("operator-brevity")).toBe("operator-brevity");
  });
});
