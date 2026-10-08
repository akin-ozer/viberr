import { describe, expect, it } from "vitest";
import {
  grantScopeToast,
  reconcileToast,
  RECONCILE_START_TOAST,
} from "./github-copy";

// The inputs no action test reaches. Every string a real reconcile or re-check
// produces is asserted through `runReconcile` / `runGrantScope` in
// github-route.server.test.ts.

describe("reconcile toast matrix", () => {
  it("keeps the start string verbatim (P11-14: 'Update status' wording)", () => {
    expect(RECONCILE_START_TOAST).toBe(
      "Updating branch and PR status from GitHub…",
    );
  });

  it("no repo → honest configuration copy", () => {
    expect(
      reconcileToast({
        status: "no_repo_configured",
        reconciled: 0,
        failed: 0,
        allFailuresOffline: false,
      }),
    ).toBe("No repository configured for this project.");
  });

  it("partial failure → counted honest copy", () => {
    expect(
      reconcileToast({
        status: "ok",
        reconciled: 5,
        failed: 2,
        allFailuresOffline: false,
      }),
    ).toBe(
      "Reconciled 5 of 7 branches. 2 couldn't sync; last-known state kept.",
    );
  });
});

describe("grant-scope toast matrix", () => {
  it("revoked / expired / repo_not_found / org approval → honest failures", () => {
    const base = { status: "revalidated", resolvedCount: 0 } as const;
    expect(grantScopeToast({ ...base, validationStatus: "revoked" })).toBe(
      "Re-check failed: the credential was revoked on GitHub.",
    );
    expect(grantScopeToast({ ...base, validationStatus: "expired" })).toBe(
      "Re-check failed: the credential has expired.",
    );
    expect(
      grantScopeToast({ ...base, validationStatus: "repo_not_found" }),
    ).toBe(
      "Re-check couldn't see the repository. The credential may lack repo access.",
    );
    expect(
      grantScopeToast({ ...base, validationStatus: "org_approval_missing" }),
    ).toBe("Re-check blocked: the token is pending organization approval.");
  });

  it("still-missing scope after a clean re-check → named in the copy", () => {
    expect(
      grantScopeToast({
        status: "revalidated",
        validationStatus: "insufficient_scope",
        resolvedCount: 0,
        stillMissingScope: "pull_request:write",
      }),
    ).toBe(
      "Re-checked. pull_request:write is still missing on the project credential.",
    );
  });
});
