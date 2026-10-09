import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_READ_ONLY_GRANT,
  CLOUDFLARE_READ_ONLY_SCOPES,
} from "../../test-support/cloudflare-read-only-grant";
import {
  isWriteScope,
  mcpGrantPhrase,
  mcpReadOnlyRefusal,
  mcpSignInNote,
  parseRequestedScopes,
  summarizeMcpGrant,
  type McpOAuthView,
} from "./mcp-oauth";

/**
 * Ruling 192 (F40-63): the one classifier every surface reads a sign-in's
 * grant through — the Settings row and editor, the controller, the run's
 * prompt and the gateway's refusal sentence.
 */

const SIGNED_IN: McpOAuthView = {
  status: "signed_in",
  expiresAt: null,
  renews: true,
  issuer: "mcp.cloudflare.com",
  reason: null,
  scope: CLOUDFLARE_READ_ONLY_GRANT,
};

describe("the grant classifier (ruling 192)", () => {
  it("reads the 194 scopes of the live cloudflare-api grant as read-only", () => {
    // CANARY: drop `monitoring` or `report` from the read actions, or treat
    // `offline_access` / `user:read` as writes, and the live grant grows writes.
    expect(CLOUDFLARE_READ_ONLY_SCOPES).toHaveLength(194);
    expect(CLOUDFLARE_READ_ONLY_SCOPES.filter(isWriteScope)).toEqual([]);
    const grant = summarizeMcpGrant(CLOUDFLARE_READ_ONLY_GRANT);
    expect(grant?.scopes).toHaveLength(194);
    expect(grant?.writes).toEqual([]);
    expect(mcpGrantPhrase(CLOUDFLARE_READ_ONLY_GRANT)).toBe("read-only · 194 scopes");
    // The four shapes a read takes in it, and the refresh token's scope.
    for (const scope of [
      "workers-ci.read",
      "workers_ai.metadata_read",
      "teams-connector-cloudflared.monitoring",
      "teams.report",
      "user:read",
      "account:read",
      "offline_access",
    ]) {
      expect(CLOUDFLARE_READ_ONLY_SCOPES).toContain(scope);
      expect(isWriteScope(scope)).toBe(false);
    }
  });

  it("counts the writes in a mixed grant, each scope once", () => {
    // CANARY: call every scope a read and the writes vanish.
    const mixed =
      "user:read offline_access workers-scripts.write workers-ci.write zone.read dns.edit ai-search.run workers-ci.write";
    const grant = summarizeMcpGrant(mixed);
    expect(grant?.scopes).toHaveLength(7);
    expect(grant?.writes).toEqual(["workers-scripts.write", "workers-ci.write", "dns.edit", "ai-search.run"]);
    expect(mcpGrantPhrase(mixed)).toBe("7 scopes · 4 writes");
    expect(mcpGrantPhrase("workers-scripts.write")).toBe("1 scope · 1 write");
    // A scope with no action word is not known to be a read.
    expect(isWriteScope("repo")).toBe(true);
    // No grant is no phrase, never "read-only · 0 scopes".
    expect(summarizeMcpGrant(null)).toBeNull();
    expect(mcpGrantPhrase("  ")).toBeNull();
  });

  it("names the read-only grant in the refusal sentence, and says nothing for a write grant or an unknown one", () => {
    expect(mcpReadOnlyRefusal(SIGNED_IN)).toBe(
      "This connection's sign-in granted read-only scopes (194); an admin must sign it in again with write scopes in Instance settings → Agent resources.",
    );
    expect(mcpReadOnlyRefusal({ ...SIGNED_IN, scope: `${CLOUDFLARE_READ_ONLY_GRANT} workers-scripts.write` })).toBeNull();
    expect(mcpReadOnlyRefusal({ ...SIGNED_IN, scope: null })).toBeNull();
    expect(mcpReadOnlyRefusal({ ...SIGNED_IN, status: "expired" })).toBeNull();
    expect(mcpReadOnlyRefusal(null)).toBeNull();
  });

  it("tells the controller what the sign-in may do", () => {
    expect(mcpSignInNote(SIGNED_IN)).toContain(
      "Its grant is read-only (194 scopes): the server refuses any call that writes, until an org admin signs it in again with write scopes",
    );
    expect(mcpSignInNote({ ...SIGNED_IN, scope: "zone.read dns.edit" })).toContain(
      "Its grant: 2 scopes, 1 write among them.",
    );
    expect(mcpSignInNote({ ...SIGNED_IN, scope: null })).toContain("The server did not say which scopes it granted.");
  });

  it("reads Requested scopes separated by spaces, commas or lines, each once, and names a token OAuth does not allow", () => {
    expect(parseRequestedScopes(" workers-scripts.write,zone.read\nworkers-scripts.write  ")).toEqual({
      scope: "workers-scripts.write zone.read",
      invalid: [],
    });
    expect(parseRequestedScopes("   ")).toEqual({ scope: null, invalid: [] });
    expect(parseRequestedScopes('zone.read "quoted" back\\slash').invalid).toEqual(['"quoted"', "back\\slash"]);
  });
});
