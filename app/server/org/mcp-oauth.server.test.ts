import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  consentAt,
  signInWithOAuth,
  startOAuthMcpServer,
  TEST_OAUTH_ADMIN as ADMIN,
  type OAuthMcpServerHandle,
  type OAuthServerOptions,
} from "../../../test-support/mcp-oauth-server";
import { isSecretBox, sealSecret } from "~/server/secrets/secret-box.server";
import {
  OAUTH_NEEDS_SIGN_IN,
  OAUTH_SIGN_IN_EXPIRED,
  connectHttpUpstream,
  listAllTools,
} from "~/server/mcp-proxy/upstream.server";
import { gatewayMcpSection, resolveSpecialistMcpServersDetailed } from "~/server/tasks/specialist-mcp.server";
import { CLOUDFLARE_READ_ONLY_GRANT } from "../../../test-support/cloudflare-read-only-grant";
import { startMcpGateway, stopMcpGateway } from "~/server/mcp-proxy/gateway.server";
import {
  backfillMcpGrantScopes,
  completeMcpOAuthSignIn,
  mcpOAuthTokenSource,
  signOutMcpOAuth,
  startMcpOAuthSignIn,
} from "./mcp-oauth.server";
import { listMcpServers, saveMcpServer, testMcpServer } from "./resources.server";

/**
 * Ruling 192: an HTTP MCP connection signs in with OAuth, end to end against
 * an in-test authorization server + protected resource (the shape of
 * `https://mcp.cloudflare.com/mcp`): discovery, dynamic registration, the
 * authorization-code request with PKCE, the callback exchange that seals the
 * tokens, the state checks, the token source the gateway and the probe use
 * (renewal on expiry and on a 401, a renewal that fails), sign-out, and the
 * rule that no token reaches an audit row, a log line or a view.
 */

const ctx = createTestDbContext();
let db: DatabaseSync;
let server: OAuthMcpServerHandle;
const MCP_ID = "mcp_cf";
const REDIRECT = "http://localhost:5173/resources/mcp-oauth/callback";

async function startServer(options: Partial<OAuthServerOptions> = {}): Promise<void> {
  server = await startOAuthMcpServer(options);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO org_mcp_servers (id, name, transport, target, created_at, updated_at)
     VALUES (?, 'cloudflare-api', 'HTTP', ?, ?, ?)`,
  ).run(MCP_ID, server.url, now, now);
}

beforeEach(() => {
  db = ctx.makeDb();
});

afterEach(async () => {
  await server?.close();
  ctx.cleanup();
});

function callbackInput(back: URL, session = ADMIN) {
  return {
    state: back.searchParams.get("state"),
    code: back.searchParams.get("code"),
    error: back.searchParams.get("error"),
    errorDescription: back.searchParams.get("error_description"),
    userId: session.userId,
    sessionId: session.sessionId,
    actor: session.actor,
  };
}

/** Start, consent at the in-test authorization server, complete. */
const signIn = () => signInWithOAuth(db, MCP_ID);

/** The connection as the Agent resources list reads it. */
const mcpRow = () => listMcpServers(db).find((mcp) => mcp.id === MCP_ID);

function rawRow(): { cred_ref: string | null; oauth_ref: string | null; oauth_json: string | null } {
  // SAFETY: three nullable TEXT columns of `org_mcp_servers` (0001_baseline.sql).
  return db
    .prepare(`SELECT cred_ref, oauth_ref, oauth_json FROM org_mcp_servers WHERE id = ?`)
    .get(MCP_ID) as { cred_ref: string | null; oauth_ref: string | null; oauth_json: string | null };
}

/** What a tool call through the token source's upstream sends and gets. */
async function callWhoami(): Promise<string> {
  const connection = await connectHttpUpstream(server.url, {
    auth: mcpOAuthTokenSource(db, MCP_ID, server.url),
    timeoutMs: 5_000,
  });
  try {
    const tools = await listAllTools(connection.client);
    return tools.map((tool) => tool.name).join(",");
  } finally {
    await connection.client.close();
  }
}

describe("sign-in: discovery, registration and the authorization request (ruling 192)", () => {
  it("registers Viberr with the redirect URI and builds an S256 PKCE request with a state and the resource", async () => {
    await startServer();
    const started = await startMcpOAuthSignIn(db, {
      mcpId: MCP_ID,
      redirectUri: REDIRECT,
      userId: ADMIN.userId,
      sessionId: ADMIN.sessionId,
      actor: ADMIN.actor,
    });
    expect(started.issuer).toBe(new URL(server.origin).host);
    expect(server.registrations).toHaveLength(1);
    expect(server.registrations[0]?.redirectUris).toEqual([REDIRECT]);
    const url = new URL(started.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${server.origin}/authorize`);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(server.registrations[0]?.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("resource")).toBe(server.url);
    // Starting writes nothing: an abandoned sign-in leaves the row as it was.
    expect(rawRow()).toEqual({ cred_ref: null, oauth_ref: null, oauth_json: null });
  });

  it("refuses a server without PKCE (S256), and one with no registration endpoint, each audited", async () => {
    await startServer({ pkce: false });
    const start = () =>
      startMcpOAuthSignIn(db, {
        mcpId: MCP_ID,
        redirectUri: REDIRECT,
        userId: ADMIN.userId,
        sessionId: ADMIN.sessionId,
        actor: ADMIN.actor,
      });
    await expect(start()).rejects.toThrow(/does not advertise PKCE \(S256\)/);
    server.options.pkce = true;
    server.options.registration = false;
    await expect(start()).rejects.toThrow(/offers no dynamic client registration/);
    const failures = listAuditEvents(db, { action: "org.mcp.oauth_failed" });
    expect(failures.map((row) => row.details?.stage)).toEqual(["registration", "discovery"]);
  });
});

describe("the callback: exchange and seal (ruling 192)", () => {
  it("exchanges the code with the verifier, seals the tokens and drops a pasted credential", async () => {
    await startServer();
    db.prepare(`UPDATE org_mcp_servers SET cred_ref = ? WHERE id = ?`).run(sealSecret("pasted-static-token"), MCP_ID);
    const result = await signIn();
    expect(result).toEqual({ ok: true, mcpId: MCP_ID, name: "cloudflare-api", replacedStaticCredential: true });
    expect(server.tokenRequests).toEqual([{ grant: "authorization_code", answered: "tokens" }]);
    const row = rawRow();
    expect(row.cred_ref).toBeNull();
    expect(row.oauth_ref !== null && isSecretBox(row.oauth_ref)).toBe(true);
    for (const secret of server.issuedSecrets()) {
      expect(row.oauth_ref).not.toContain(secret);
      expect(row.oauth_json).not.toContain(secret);
    }
    const view = mcpRow()?.oauth;
    expect(view).toMatchObject({ status: "signed_in", renews: true, issuer: new URL(server.origin).host, reason: null });
    expect(Date.parse(view?.expiresAt ?? "") - Date.now()).toBeGreaterThan(3_500_000);
    const [connected] = listAuditEvents(db, { action: "org.mcp.oauth_connected" });
    expect(connected?.actorLabel).toBe("arda@viberr.dev");
    expect(connected?.details).toMatchObject({
      name: "cloudflare-api",
      renews: true,
      replacedStaticCredential: true,
    });
  });

  it("refuses a wrong state and a replayed one, and seals nothing", async () => {
    await startServer();
    const started = await startMcpOAuthSignIn(db, {
      mcpId: MCP_ID,
      redirectUri: REDIRECT,
      userId: ADMIN.userId,
      sessionId: ADMIN.sessionId,
      actor: ADMIN.actor,
    });
    const back = await consentAt(started.authorizationUrl);
    const forged = new URL(back);
    forged.searchParams.set("state", "not-the-state-viberr-sent");
    const wrong = await completeMcpOAuthSignIn(db, callbackInput(forged));
    expect(wrong).toEqual({ ok: false, name: null, message: expect.stringMatching(/unknown, has expired or was already used/) });
    expect(rawRow().oauth_ref).toBeNull();

    const first = await completeMcpOAuthSignIn(db, callbackInput(back));
    expect(first.ok).toBe(true);
    const replay = await completeMcpOAuthSignIn(db, callbackInput(back));
    expect(replay.ok).toBe(false);
    // One exchange only: the replay never reached the token endpoint.
    expect(server.tokenRequests).toHaveLength(1);
  });

  it("refuses a callback that arrives in another session, spending its state, audited", async () => {
    await startServer();
    const started = await startMcpOAuthSignIn(db, {
      mcpId: MCP_ID,
      redirectUri: REDIRECT,
      userId: ADMIN.userId,
      sessionId: ADMIN.sessionId,
      actor: ADMIN.actor,
    });
    const back = await consentAt(started.authorizationUrl);
    const other = { ...ADMIN, sessionId: "ses_someone_else" };
    const refused = await completeMcpOAuthSignIn(db, callbackInput(back, other));
    expect(refused).toMatchObject({ ok: false, name: "cloudflare-api" });
    expect(refused.ok === false && refused.message).toMatch(/started in another session/);
    // The rightful session cannot use it afterwards either: a state is spent once.
    expect((await completeMcpOAuthSignIn(db, callbackInput(back))).ok).toBe(false);
    expect(server.tokenRequests).toHaveLength(0);
    expect(listAuditEvents(db, { action: "org.mcp.oauth_failed" })[0]?.details).toMatchObject({ stage: "state" });
  });

  it("records a consent the person declined", async () => {
    await startServer({ consent: "deny" });
    const result = await signIn();
    expect(result.ok === false && result.message).toMatch(/access_denied: The user declined/);
    expect(listAuditEvents(db, { action: "org.mcp.oauth_failed" })[0]?.details).toMatchObject({
      name: "cloudflare-api",
      stage: "authorization",
    });
  });
});

describe("the token upstream: use, renew, expire (ruling 192)", () => {
  it("renews an access token that has run out before sending it, and re-seals the new pair", async () => {
    await startServer({ accessTokenTtlSec: 5 });
    await signIn();
    server.options.accessTokenTtlSec = 3600;
    expect(await callWhoami()).toContain("whoami");
    expect(server.tokenRequests.map((request) => request.grant)).toEqual(["authorization_code", "refresh_token"]);
    // Every MCP request carried the renewed token, none the one that ran out.
    const [, renewedAccess] = server.issuedSecrets().filter((secret) => secret.startsWith("at_"));
    expect(new Set(server.authorizations)).toEqual(new Set([`Bearer ${renewedAccess}`]));
    expect(mcpRow()?.oauth?.status).toBe("signed_in");
    expect(Date.parse(mcpRow()?.oauth?.expiresAt ?? "") - Date.now()).toBeGreaterThan(3_500_000);
  });

  it("renews once on a 401 and retries with the new token", async () => {
    await startServer();
    await signIn();
    server.invalidateAccessTokens();
    expect(await callWhoami()).toContain("whoami");
    const accessTokens = server.issuedSecrets().filter((secret) => secret.startsWith("at_"));
    expect(accessTokens).toHaveLength(2);
    expect(server.authorizations.slice(0, 2)).toEqual([`Bearer ${accessTokens[0]}`, `Bearer ${accessTokens[1]}`]);
    expect(server.tokenRequests.at(-1)).toEqual({ grant: "refresh_token", answered: "tokens" });
  });

  it("a renewal the server refuses ends the sign-in: 'sign-in expired', audited, the tokens dropped", async () => {
    await startServer({ refresh: "invalid_grant" });
    await signIn();
    server.invalidateAccessTokens();
    await expect(callWhoami()).rejects.toThrow(OAUTH_SIGN_IN_EXPIRED);
    const view = mcpRow()?.oauth;
    expect(view).toMatchObject({ status: "expired", renews: false });
    expect(view?.reason).toMatch(/invalid_grant/);
    const [failed] = listAuditEvents(db, { action: "org.mcp.oauth_failed" });
    expect(failed?.details).toMatchObject({ name: "cloudflare-api", stage: "refresh" });
    expect(failed?.actorLabel).toBe("system");
    // The next request does not try again: the admin has to sign in.
    await expect(callWhoami()).rejects.toThrow(OAUTH_SIGN_IN_EXPIRED);
    expect(server.tokenRequests.filter((request) => request.grant === "refresh_token")).toHaveLength(1);
  });

  it("a renewal that fails for now (503) is reported and keeps the sign-in", async () => {
    await startServer({ refresh: "server_error" });
    await signIn();
    server.invalidateAccessTokens();
    await expect(callWhoami()).rejects.toThrow(/could not renew the OAuth sign-in: .*temporarily_unavailable/);
    expect(mcpRow()?.oauth?.status).toBe("signed_in");
    server.options.refresh = "ok";
    expect(await callWhoami()).toContain("whoami");
  });

  it("two requests that meet an expired token at once spend the refresh token once", async () => {
    await startServer({ accessTokenTtlSec: 5 });
    await signIn();
    server.options.accessTokenTtlSec = 3600;
    const source = mcpOAuthTokenSource(db, MCP_ID, server.url);
    const [a, b] = await Promise.all([source.accessToken(), source.accessToken()]);
    expect(a).toBe(b);
    expect(server.tokenRequests.filter((request) => request.grant === "refresh_token")).toHaveLength(1);
  });
});

describe("health, runs and sign-out (ruling 192)", () => {
  it("a probe with no credential reads 'needs sign-in', and a signed-in probe is up with its tools", async () => {
    await startServer();
    const saved = await saveMcpServer(
      db,
      { id: MCP_ID, name: "cloudflare-api", transport: "HTTP", target: server.url, cred: "" },
      ADMIN.actor,
    );
    expect(saved.toast).toBe(`cloudflare-api saved: ${OAUTH_NEEDS_SIGN_IN}`);
    expect(saved.mcp.oauth?.status).toBe("needs_sign_in");
    expect(saved.mcp.lastError).toBe(OAUTH_NEEDS_SIGN_IN);

    // A run is told why the server is missing instead of meeting 401s.
    const unsigned = resolveSpecialistMcpServersDetailed(db, ["cloudflare-api"]);
    expect(unsigned.servers).toEqual({});
    expect(unsigned.unresolved).toEqual([{ name: "cloudflare-api", reason: OAUTH_NEEDS_SIGN_IN }]);

    await signIn();
    const tested = await testMcpServer(db, MCP_ID);
    expect(tested.toast).toMatch(/^cloudflare-api healthy: 4 tools · \d+ms · signed in \(expires in 60 minutes, renews itself\)$/);
    expect(tested.mcp).toMatchObject({ up: true, tools: 4, lastError: null });

    await startMcpGateway({ port: 0 });
    try {
      const signed = resolveSpecialistMcpServersDetailed(db, ["cloudflare-api"]);
      expect(signed.proxied).toEqual(["cloudflare-api"]);
      for (const secret of server.issuedSecrets()) expect(JSON.stringify(signed)).not.toContain(secret);
    } finally {
      await stopMcpGateway();
    }
  });

  it("an expired sign-in probes as 'sign-in expired', and the run is told so", async () => {
    await startServer({ refresh: "invalid_grant" });
    await signIn();
    server.invalidateAccessTokens();
    await expect(callWhoami()).rejects.toThrow();
    const tested = await testMcpServer(db, MCP_ID);
    expect(tested.toast).toBe(`cloudflare-api: ${OAUTH_SIGN_IN_EXPIRED}`);
    expect(tested.mcp.oauth?.status).toBe("expired");
    expect(resolveSpecialistMcpServersDetailed(db, ["cloudflare-api"]).unresolved).toEqual([
      { name: "cloudflare-api", reason: OAUTH_SIGN_IN_EXPIRED },
    ]);
  });

  it("sign-out revokes both tokens at the server, drops them here and audits it", async () => {
    await startServer();
    await signIn();
    const [access, refresh] = server.issuedSecrets().filter((secret) => /^(at|rt)_/.test(secret));
    const { toast } = await signOutMcpOAuth(db, MCP_ID, ADMIN.actor);
    expect(toast).toBe("cloudflare-api signed out. Its tokens were revoked at the server and deleted here.");
    expect(new Set(server.revoked)).toEqual(new Set([access, refresh]));
    expect(rawRow().oauth_ref).toBeNull();
    expect(mcpRow()?.oauth?.status).toBe("needs_sign_in");
    expect(listAuditEvents(db, { action: "org.mcp.oauth_signed_out" })[0]?.details).toEqual({
      name: "cloudflare-api",
      revocation: "revoked",
      reason: null,
    });
    await expect(callWhoami()).rejects.toThrow(OAUTH_NEEDS_SIGN_IN);
    await expect(signOutMcpOAuth(db, MCP_ID, ADMIN.actor)).rejects.toThrow("cloudflare-api is not signed in.");
  });

  it("a pasted credential over a live sign-in is refused, and re-pointing the row drops the sign-in", async () => {
    await startServer();
    await signIn();
    const base = { id: MCP_ID, name: "cloudflare-api", transport: "HTTP", target: server.url };
    await expect(saveMcpServer(db, { ...base, cred: "a-pasted-token-123" }, ADMIN.actor)).rejects.toMatchObject({
      message: "cloudflare-api is signed in with OAuth. Sign it out first to use a pasted credential instead.",
      // Ruling 288: about the credential, so the editor says it at that field.
      // CANARY: refuse without naming it and the editor says it at its foot.
      field: "cred",
    });
    // A plain re-save keeps it, probed with the sign-in.
    const kept = await saveMcpServer(db, { ...base, cred: "" }, ADMIN.actor);
    expect(kept.toast).toBe("cloudflare-api saved: 4 tools discovered · signed in with OAuth");
    const repointed = await saveMcpServer(db, { ...base, target: `${server.origin}/other`, cred: "" }, ADMIN.actor);
    expect(repointed.mcp.oauth).toBeNull();
    expect(rawRow().oauth_ref).toBeNull();
    expect(listAuditEvents(db, { action: "org.mcp.updated" })[0]?.details).toMatchObject({ oauthDropped: true });
  });
});

describe("a sign-in ended or landed while a request was on the wire (R-oauth-3)", () => {
  it("a renewal refused after a new sign-in landed leaves the new sign-in alone", async () => {
    // CANARY: expire whatever was read before the refresh, and the admin's
    // fresh sign-in is wiped to "sign-in expired" with the old registration.
    await startServer({ refresh: "invalid_grant" });
    await signIn();
    const [firstAccess] = server.issuedSecrets().filter((secret) => secret.startsWith("at_"));
    const signInAgain = async () => {
      await signIn();
    };
    server.options.holdTokenAnswer = { grant: "refresh_token", until: signInAgain };
    const source = mcpOAuthTokenSource(db, MCP_ID, server.url);
    const token = await source.renewAfterRefusal(firstAccess ?? "");
    const [, secondAccess] = server.issuedSecrets().filter((secret) => secret.startsWith("at_"));
    expect(token).toBe(secondAccess);
    expect(mcpRow()?.oauth?.status).toBe("signed_in");
    expect(listAuditEvents(db, { action: "org.mcp.oauth_failed" })).toEqual([]);
  });

  it("a renewed token refused after the sign-in moved on ends nothing; the stored one refused does", async () => {
    // CANARY: expire whatever `current()` holds, whatever token was refused.
    await startServer();
    await signIn();
    const [stale] = server.issuedSecrets().filter((secret) => secret.startsWith("at_"));
    await signIn();
    const [, live] = server.issuedSecrets().filter((secret) => secret.startsWith("at_"));
    const source = mcpOAuthTokenSource(db, MCP_ID, server.url);
    await source.refusedAfterRenewal(stale ?? "");
    expect(mcpRow()?.oauth?.status).toBe("signed_in");
    const ended = await source.refusedAfterRenewal(live ?? "");
    expect(ended.reason).toBe(OAUTH_SIGN_IN_EXPIRED);
    expect(mcpRow()?.oauth?.status).toBe("expired");
  });

  it("a callback whose row was re-pointed during the code exchange writes nothing and keeps the credential that save pasted", async () => {
    // CANARY: write after the exchange without reading the row again, and a
    // sign-in for the old endpoint lands on the re-pointed row and erases
    // the credential its save just pasted.
    await startServer();
    const started = await startMcpOAuthSignIn(db, {
      mcpId: MCP_ID,
      redirectUri: REDIRECT,
      userId: ADMIN.userId,
      sessionId: ADMIN.sessionId,
      actor: ADMIN.actor,
    });
    const back = await consentAt(started.authorizationUrl);
    const repoint = async () => {
      await saveMcpServer(
        db,
        { id: MCP_ID, name: "cloudflare-api", transport: "HTTP", target: `${server.origin}/other`, cred: "a-pasted-token-123" },
        ADMIN.actor,
      );
    };
    server.options.holdTokenAnswer = { grant: "authorization_code", until: repoint };
    const result = await completeMcpOAuthSignIn(db, callbackInput(back));
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("endpoint changed") });
    expect(rawRow().cred_ref).not.toBeNull();
    expect(rawRow()).toMatchObject({ oauth_ref: null, oauth_json: null });
    expect(mcpRow()?.target).toBe(`${server.origin}/other`);
  });
});

describe("a registered client the authorization server no longer accepts (R-oauth-4)", () => {
  it("a renewal refused with invalid_client drops the client, so the next sign-in registers again", async () => {
    // CANARY: keep the client on a client refusal and the next sign-in
    // reuses the dead id; the consent screen refuses it (no redirect back).
    await startServer();
    await signIn();
    const [first] = server.registrations.map((client) => client.clientId);
    server.forgetClients();
    server.invalidateAccessTokens();
    await expect(callWhoami()).rejects.toThrow(OAUTH_SIGN_IN_EXPIRED);
    expect(rawRow().oauth_ref).toBeNull();
    expect(mcpRow()?.oauth).toMatchObject({ status: "expired", reason: expect.stringContaining("invalid_client") });

    const again = await signIn();
    expect(again.ok).toBe(true);
    expect(server.registrations.map((client) => client.clientId)).not.toContain(first);
    expect(server.registrations).toHaveLength(1);
    expect(await callWhoami()).toContain("whoami");
  });

  it("a code exchange refused with invalid_client drops the stored client it reused", async () => {
    // CANARY: leave the stored client alone after the refused exchange and
    // every later sign-in reuses it and fails the same way.
    await startServer();
    await signIn();
    server.rotateClientSecrets();
    const refused = await signIn();
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("invalid_client") });
    expect(rawRow().oauth_ref).toBeNull();
    expect(mcpRow()?.oauth?.status).toBe("expired");

    const again = await signIn();
    expect(again.ok).toBe(true);
    expect(server.registrations).toHaveLength(2);
    expect(await callWhoami()).toContain("whoami");
  });

  it("a client whose secret has lapsed (client_secret_expires_at) is registered again rather than reused", async () => {
    // CANARY: drop the lapse check from the reuse and the second sign-in
    // reuses the first registration.
    await startServer({ clientSecretExpiresAt: Math.floor(Date.now() / 1000) - 60 });
    await signIn();
    await signIn();
    expect(server.registrations).toHaveLength(2);
    // One that does not lapse is reused, as before.
    server.options.clientSecretExpiresAt = 0;
    await signIn();
    await signIn();
    expect(server.registrations).toHaveLength(3);
  });
});

describe("a pasted credential and what is left of a sign-in (R-oauth-2)", () => {
  const base = () => ({ id: MCP_ID, name: "cloudflare-api", transport: "HTTP", target: server.url });

  it("pasting over 'needs sign-in' or 'sign-in expired' clears the sign-in's leftovers, so no surface says the server is not mounted", async () => {
    // CANARY: keep `oauth_json` when a save holds a credential and the row
    // reads "needs sign-in" for good, beside the credential runs mount.
    await startServer();
    await saveMcpServer(db, { ...base(), cred: "" }, ADMIN.actor);
    expect(mcpRow()?.oauth?.status).toBe("needs_sign_in");
    await saveMcpServer(db, { ...base(), cred: "a-pasted-token-123" }, ADMIN.actor);
    expect(rawRow()).toMatchObject({ oauth_ref: null, oauth_json: null });
    expect(rawRow().cred_ref).not.toBeNull();
    expect(mcpRow()).toMatchObject({ hasCred: true, oauth: null });

    // An expired sign-in's sealed half (its registration) goes too: the
    // connection holds one credential, and it is the pasted one.
    await signIn();
    server.options.refresh = "invalid_grant";
    server.invalidateAccessTokens();
    await expect(callWhoami()).rejects.toThrow(OAUTH_SIGN_IN_EXPIRED);
    expect(mcpRow()?.oauth?.status).toBe("expired");
    await saveMcpServer(db, { ...base(), cred: "a-pasted-token-456" }, ADMIN.actor);
    expect(rawRow()).toMatchObject({ oauth_ref: null, oauth_json: null });
    expect(mcpRow()?.oauth).toBeNull();
    expect(listAuditEvents(db, { action: "org.mcp.updated" })[0]?.details).toMatchObject({ oauthDropped: true });
  });

  it("a row that holds a pasted credential reads no sign-in status, whatever its OAuth columns still say", async () => {
    // CANARY: map the public half regardless of `cred_ref`, and a row the
    // resolver mounts with its credential reads "needs sign-in".
    await startServer();
    db.prepare(`UPDATE org_mcp_servers SET cred_ref = ?, oauth_json = ? WHERE id = ?`).run(
      sealSecret("a-pasted-token-789"),
      JSON.stringify({ status: "needs_sign_in", expiresAt: null, renews: false, issuer: null, resourceMetadataUrl: null, reason: null }),
      MCP_ID,
    );
    expect(mcpRow()).toMatchObject({ hasCred: true, oauth: null });
  });
});

describe("what a sign-in was granted, and what it asks for (ruling 192)", () => {
  /** The stored public half, as far as these tests read it. `scope` may be
   *  missing, which is what a canary that drops it produces. */
  const publicHalf = z.object({ status: z.string(), scope: z.string().nullable().optional() });

  /** The public half as an older row holds it: every field but `scope` (zod
   *  drops the key it does not name). */
  const publicWithoutScope = z.object({
    status: z.string(),
    expiresAt: z.string().nullable(),
    renews: z.boolean(),
    issuer: z.string().nullable(),
    resourceMetadataUrl: z.string().nullable(),
    reason: z.string().nullable(),
  });

  function oauthJson(): z.infer<typeof publicHalf> {
    return publicHalf.parse(JSON.parse(rawRow().oauth_json ?? "null"));
  }

  it("keeps the granted scope in the public half on the callback, updates it on a refresh and clears it on sign-out", async () => {
    // CANARY: leave `scope` out of the public half the callback writes, and
    // no surface can say the live grant is read-only.
    await startServer({ grantedScope: CLOUDFLARE_READ_ONLY_GRANT });
    await signIn();
    expect(oauthJson().scope).toBe(CLOUDFLARE_READ_ONLY_GRANT);
    expect(mcpRow()?.oauth?.scope).toBe(CLOUDFLARE_READ_ONLY_GRANT);
    const [connected] = listAuditEvents(db, { action: "org.mcp.oauth_connected" });
    expect(connected?.details?.scope).toBe(CLOUDFLARE_READ_ONLY_GRANT);

    // CANARY: re-seal a renewal with the old public half's scope, and a
    // refresh that grants more is never seen.
    server.options.grantedScope = "user:read offline_access workers-scripts.write";
    server.invalidateAccessTokens();
    expect(await callWhoami()).toContain("whoami");
    expect(server.tokenRequests.at(-1)).toEqual({ grant: "refresh_token", answered: "tokens" });
    expect(mcpRow()?.oauth?.scope).toBe("user:read offline_access workers-scripts.write");

    // A refresh reply that names no scope keeps the grant the sign-in held.
    server.options.grantedScope = null;
    server.invalidateAccessTokens();
    expect(await callWhoami()).toContain("whoami");
    expect(mcpRow()?.oauth?.scope).toBe("user:read offline_access workers-scripts.write");

    // CANARY: keep `scope` through a sign-out, and a signed-out row still
    // claims a grant.
    await signOutMcpOAuth(db, MCP_ID, ADMIN.actor);
    expect(oauthJson()).toMatchObject({ status: "needs_sign_in", scope: null });
    expect(mcpRow()?.oauth?.scope).toBeNull();
  });

  it("a sign-in stored without a public scope learns its grant at boot from the sealed token scope, once", async () => {
    // Live 2026-09-25: the owner's cloudflare-api sign-in predates the public
    // scope, so every surface would name no grant until a refresh repeated it.
    await startServer({ grantedScope: CLOUDFLARE_READ_ONLY_GRANT });
    await signIn();
    const before486 = publicWithoutScope.parse(JSON.parse(rawRow().oauth_json ?? "null"));
    db.prepare(`UPDATE org_mcp_servers SET oauth_json = ? WHERE id = ?`).run(JSON.stringify(before486), MCP_ID);
    expect(mcpRow()?.oauth?.scope).toBeNull();
    // CANARY: skip the write, and the row keeps naming no grant.
    expect(backfillMcpGrantScopes(db)).toEqual(["cloudflare-api"]);
    expect(oauthJson()).toMatchObject({ status: "signed_in", scope: CLOUDFLARE_READ_ONLY_GRANT });
    // Idempotent: a row that names its grant is left alone.
    expect(backfillMcpGrantScopes(db)).toEqual([]);
  });

  it("the grant backfill leaves a signed-out row and a token reply that named no scope as they are", async () => {
    await startServer({ grantedScope: null });
    await signIn();
    const noScope = publicWithoutScope.parse(JSON.parse(rawRow().oauth_json ?? "null"));
    db.prepare(`UPDATE org_mcp_servers SET oauth_json = ? WHERE id = ?`).run(JSON.stringify(noScope), MCP_ID);
    // The sealed tokens name no scope, so there is nothing true to copy.
    expect(backfillMcpGrantScopes(db)).toEqual([]);
    await signOutMcpOAuth(db, MCP_ID, ADMIN.actor);
    expect(backfillMcpGrantScopes(db)).toEqual([]);
    expect(oauthJson()).toMatchObject({ status: "needs_sign_in", scope: null });
  });

  it("an expired sign-in holds no grant", async () => {
    await startServer({ grantedScope: CLOUDFLARE_READ_ONLY_GRANT, refresh: "invalid_grant" });
    await signIn();
    server.invalidateAccessTokens();
    await expect(callWhoami()).rejects.toThrow(OAUTH_SIGN_IN_EXPIRED);
    expect(oauthJson()).toMatchObject({ status: "expired", scope: null });
  });

  it("sends Requested scopes as the authorization request's scope, and the resource's scopes_supported when there are none", async () => {
    // CANARY: start the sign-in from the discovered scope alone, and the
    // admin's Requested scopes never reach the authorization server.
    await startServer({ scopesSupported: ["mcp.read", "mcp.write"] });
    const base = { id: MCP_ID, name: "cloudflare-api", transport: "HTTP", target: server.url, cred: "" };
    await expect(saveMcpServer(db, { ...base, requestedScopes: 'zone.read "x"' }, ADMIN.actor)).rejects.toThrow(
      'The requested scope "x" is not one OAuth allows',
    );
    // Empty: the resource's advertised scopes, the default.
    await signIn();
    expect(server.authorizeRequests.at(-1)?.get("scope")).toBe("mcp.read mcp.write");
    // A token reply that names no scope granted what was asked (RFC 6749 §5.1).
    expect(mcpRow()?.oauth?.scope).toBe("mcp.read mcp.write");

    const saved = await saveMcpServer(
      db,
      { ...base, requestedScopes: "workers-scripts.write, zone.read\nworkers-scripts.write" },
      ADMIN.actor,
    );
    expect(saved.mcp.requestedScope).toBe("workers-scripts.write zone.read");
    expect(listAuditEvents(db, { action: "org.mcp.updated" })[0]?.details).toMatchObject({
      requestedScope: "workers-scripts.write zone.read",
    });
    await signIn();
    expect(server.authorizeRequests.at(-1)?.get("scope")).toBe("workers-scripts.write zone.read");
    expect(mcpRow()?.oauth?.scope).toBe("workers-scripts.write zone.read");

    // Absent keeps it; blank clears it.
    await saveMcpServer(db, base, ADMIN.actor);
    expect(mcpRow()?.requestedScope).toBe("workers-scripts.write zone.read");
    await saveMcpServer(db, { ...base, requestedScopes: " " }, ADMIN.actor);
    expect(mcpRow()?.requestedScope).toBeNull();
  });

  it("tells a run what each OAuth sign-in was granted, and the save and test toasts say it too", async () => {
    // CANARY: resolve a signed-in server without its grant, and the run's
    // prompt says only that it is mounted through the gateway.
    await startServer({ grantedScope: CLOUDFLARE_READ_ONLY_GRANT });
    await signIn();
    const saved = await saveMcpServer(
      db,
      { id: MCP_ID, name: "cloudflare-api", transport: "HTTP", target: server.url, cred: "" },
      ADMIN.actor,
    );
    expect(saved.toast).toBe("cloudflare-api saved: 4 tools discovered · signed in with OAuth (read-only · 194 scopes)");
    const tested = await testMcpServer(db, MCP_ID);
    expect(tested.toast).toMatch(/ · signed in \(expires in 60 minutes, renews itself\) · read-only · 194 scopes$/);
    await startMcpGateway({ port: 0 });
    try {
      const resolved = resolveSpecialistMcpServersDetailed(db, ["cloudflare-api"]);
      expect(resolved.oauthGrants).toEqual([{ name: "cloudflare-api", scope: CLOUDFLARE_READ_ONLY_GRANT }]);
      const section = gatewayMcpSection(resolved.proxied, resolved.oauthGrants);
      expect(section).toContain(
        "- cloudflare-api: signed in with OAuth, granted read-only · 194 scopes. The server refuses any call that writes, so do not attempt one; if the task needs a write, report that an org admin must sign it in again with write scopes in Instance settings → Agent resources.",
      );
      expect(section).not.toContain("workers-ci.read");
    } finally {
      await stopMcpGateway();
    }
  });

  it("F40-66: a known grant's line sends the run to the gateway's grant tool instead of listing the scopes", () => {
    // CANARY: drop the sentence from the line, and the run is back to reading
    // only "195 scopes · 1 write".
    const writes = gatewayMcpSection(
      ["cloudflare-api"],
      [{ name: "cloudflare-api", scope: `${CLOUDFLARE_READ_ONLY_GRANT} workers-kv-storage.write` }],
    );
    expect(writes).toContain(
      "- cloudflare-api: signed in with OAuth, granted 195 scopes · 1 write. Call its `viberr_connection_grant` tool to see exactly which scopes are granted before you assume a write will be refused or accepted.",
    );
    expect(writes).not.toContain("workers-kv-storage.write");
    const readOnly = gatewayMcpSection(["cloudflare-api"], [{ name: "cloudflare-api", scope: CLOUDFLARE_READ_ONLY_GRANT }]);
    expect(readOnly).toContain(
      "Instance settings → Agent resources. Call its `viberr_connection_grant` tool to see exactly which scopes are granted before you assume a read will be refused or accepted.",
    );
    // A grant the server did not name has nothing to look up.
    const unknown = gatewayMcpSection(["cloudflare-api"], [{ name: "cloudflare-api", scope: null }]);
    expect(unknown).toContain("- cloudflare-api: signed in with OAuth; the server did not say which scopes it granted.");
    expect(unknown).not.toContain("viberr_connection_grant");
  });

  it("ruling 169: the grant lines read in the names' code-point order, like the names above them", () => {
    // The section is in the specialist's and the controller's cached prefix.
    // `localeCompare` put `Sentry` last under an English locale, after the
    // names line had put it first, and may order it differently elsewhere.
    const section = gatewayMcpSection(
      ["linear", "Sentry", "cloudflare-api"],
      [
        { name: "linear", scope: null },
        { name: "cloudflare-api", scope: null },
        { name: "Sentry", scope: null },
      ],
    );
    expect(section).toContain("Sentry, cloudflare-api, linear are mounted");
    const granted = section
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2, line.indexOf(":")));
    expect(granted).toEqual(["Sentry", "cloudflare-api", "linear"]);
  });
});

describe("no token material leaves the server (ruling 192)", () => {
  it("not in an audit row, a log line or a view, across sign-in, renewal, expiry and sign-out", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      await startServer({ accessTokenTtlSec: 5 });
      await signIn();
      server.options.accessTokenTtlSec = 3600;
      await callWhoami();
      server.invalidateAccessTokens();
      await callWhoami();
      await testMcpServer(db, MCP_ID);
      const views = JSON.stringify(listMcpServers(db));
      server.options.refresh = "invalid_grant";
      server.invalidateAccessTokens();
      await callWhoami().catch(() => undefined);
      await signIn();
      await signOutMcpOAuth(db, MCP_ID, ADMIN.actor);
      const audit = JSON.stringify(listAuditEvents(db));
      const logs = lines.join("");
      expect(logs).toContain("mcp oauth token renewed");
      expect(audit).toContain("org.mcp.oauth_connected");
      const secrets = server.issuedSecrets();
      expect(secrets.length).toBeGreaterThan(6);
      for (const secret of secrets) {
        expect(audit).not.toContain(secret);
        expect(logs).not.toContain(secret);
        expect(views).not.toContain(secret);
        expect(JSON.stringify(listMcpServers(db))).not.toContain(secret);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
