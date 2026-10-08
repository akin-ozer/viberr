import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDbContext } from "../../test-support/test-db";
import { createAuth } from "./auth.server";

/**
 * F28-A1: the account-linking policy, read off the options the app's Better
 * Auth instance is built with — a config-only regression guard, no request
 * needed.
 */
describe("createAuth account linking (F28-A1)", () => {
  const ctx = createTestDbContext();
  afterEach(ctx.cleanup);
  let db: DatabaseSync;
  beforeEach(() => {
    db = ctx.makeDb();
  });

  async function opts() {
    const auth = createAuth({
      db,
      secret: "test-secret-at-least-32-characters-long-000",
      baseURL: "http://localhost:5173",
      trustedOrigins: ["http://localhost:5173"],
      github: { clientId: "gh-id", clientSecret: "gh-secret" },
      google: { clientId: "go-id", clientSecret: "go-secret" },
    });
    // Start-up checks the db's schema without waiting for the verdict; join
    // that shared check so it finishes before the db closes.
    await (await auth.$context).checkSchema?.();
    return auth.options;
  }

  it("does NOT trust github/google for implicit account linking", async () => {
    const linking = (await opts()).account?.accountLinking;
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
