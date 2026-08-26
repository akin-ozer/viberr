import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildAuthOptions } from "./auth.server";

/**
 * F28-A1: buildAuthOptions is the one place the exact Better Auth options are
 * assembled, so the account-linking policy is pinned here — a config-only
 * regression guard, no live handler needed.
 */
describe("buildAuthOptions account linking (F28-A1)", () => {
  const opts = () =>
    buildAuthOptions({
      // buildAuthOptions only ASSIGNS the db (the hooks are closures, not called
      // during construction), so a stub is enough for this config assertion.
      db: {} as unknown as DatabaseSync,
      secret: "test-secret-at-least-32-characters-long-000",
      trustedOrigins: ["http://localhost:5173"],
      github: { clientId: "gh-id", clientSecret: "gh-secret" },
      google: { clientId: "go-id", clientSecret: "go-secret" },
    });

  it("does NOT trust github/google for implicit account linking", () => {
    const linking = opts().account?.accountLinking;
    const trusted = linking?.trustedProviders ?? [];
    // Trusting a provider links a social sign-in to an existing account by email
    // WITHOUT the provider's emailVerified check. Combined with every viberr
    // account being provisioned emailVerified:1, that would leave NO gate — an
    // account-takeover hole once an admin enables OAuth. Only provider-VERIFIED
    // emails may auto-link, which is the untrusted-provider behavior.
    expect(trusted).not.toContain("github");
    expect(trusted).not.toContain("google");
    // Implicit linking stays ON so a whitelisted user's OAuth login still
    // auto-links to their admin-created row (by a VERIFIED email now).
    expect(linking?.enabled).toBe(true);
    expect(linking?.disableImplicitLinking).not.toBe(true);
  });
});
