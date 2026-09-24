import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  consentAt,
  startOAuthMcpServer,
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
import { resolveSpecialistMcpServersDetailed } from "~/server/tasks/specialist-mcp.server";
import { startMcpGateway, stopMcpGateway } from "~/server/mcp-proxy/gateway.server";
import {
  completeMcpOAuthSignIn,
  mcpOAuthTokenSource,
  resetMcpOAuthForTests,
  signOutMcpOAuth,
  startMcpOAuthSignIn,
} from "./mcp-oauth.server";
import { getMcpServer, listMcpServers, saveMcpServer, testMcpServer } from "./resources.server";

/**
 * Ruling 469: an HTTP MCP connection signs in with OAuth, end to end against
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
const ADMIN = {
  userId: "usr_arda",
  sessionId: "ses_arda",
  actor: { userId: "usr_arda", label: "arda@viberr.dev" },
};

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
  resetMcpOAuthForTests();
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
async function signIn() {
  const started = await startMcpOAuthSignIn(db, {
    mcpId: MCP_ID,
    redirectUri: REDIRECT,
    userId: ADMIN.userId,
    sessionId: ADMIN.sessionId,
    actor: ADMIN.actor,
  });
  const back = await consentAt(started.authorizationUrl);
  const result = await completeMcpOAuthSignIn(db, callbackInput(back));
  return { started, back, result };
}

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

describe("sign-in: discovery, registration and the authorization request (ruling 469)", () => {
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

describe("the callback: exchange and seal (ruling 469)", () => {
  it("exchanges the code with the verifier, seals the tokens and drops a pasted credential", async () => {
    await startServer();
    db.prepare(`UPDATE org_mcp_servers SET cred_ref = ? WHERE id = ?`).run(sealSecret("pasted-static-token"), MCP_ID);
    const { result } = await signIn();
    expect(result).toEqual({ ok: true, mcpId: MCP_ID, name: "cloudflare-api", replacedStaticCredential: true });
    expect(server.tokenRequests).toEqual([{ grant: "authorization_code", answered: "tokens" }]);
    const row = rawRow();
    expect(row.cred_ref).toBeNull();
    expect(row.oauth_ref !== null && isSecretBox(row.oauth_ref)).toBe(true);
    for (const secret of server.issuedSecrets()) {
      expect(row.oauth_ref).not.toContain(secret);
      expect(row.oauth_json).not.toContain(secret);
    }
    const view = getMcpServer(db, MCP_ID)?.oauth;
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
    const { result } = await signIn();
    expect(result.ok === false && result.message).toMatch(/access_denied: The user declined/);
    expect(listAuditEvents(db, { action: "org.mcp.oauth_failed" })[0]?.details).toMatchObject({
      name: "cloudflare-api",
      stage: "authorization",
    });
  });
});

describe("the token upstream: use, renew, expire (ruling 469)", () => {
  it("sends the sealed access token upstream", async () => {
    await startServer();
    await signIn();
    expect(await callWhoami()).toBe("whoami,delete_zone,slow,fail");
    const bearer = server.authorizations.at(-1);
    expect(bearer).toMatch(/^Bearer at_/);
    expect(server.issuedSecrets()).toContain(bearer?.slice("Bearer ".length));
  });

  it("renews an access token that has run out before sending it, and re-seals the new pair", async () => {
    await startServer({ accessTokenTtlSec: 5 });
    await signIn();
    server.options.accessTokenTtlSec = 3600;
    expect(await callWhoami()).toContain("whoami");
    expect(server.tokenRequests.map((request) => request.grant)).toEqual(["authorization_code", "refresh_token"]);
    // Every MCP request carried the renewed token, none the one that ran out.
    const [, renewedAccess] = server.issuedSecrets().filter((secret) => secret.startsWith("at_"));
    expect(new Set(server.authorizations)).toEqual(new Set([`Bearer ${renewedAccess}`]));
    expect(getMcpServer(db, MCP_ID)?.oauth?.status).toBe("signed_in");
    expect(Date.parse(getMcpServer(db, MCP_ID)?.oauth?.expiresAt ?? "") - Date.now()).toBeGreaterThan(3_500_000);
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
    const view = getMcpServer(db, MCP_ID)?.oauth;
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
    expect(getMcpServer(db, MCP_ID)?.oauth?.status).toBe("signed_in");
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

describe("health, runs and sign-out (ruling 469)", () => {
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
    expect(getMcpServer(db, MCP_ID)?.oauth?.status).toBe("needs_sign_in");
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
    await expect(saveMcpServer(db, { ...base, cred: "a-pasted-token-123" }, ADMIN.actor)).rejects.toThrow(
      "cloudflare-api is signed in with OAuth. Sign it out first to use a pasted credential instead.",
    );
    // A plain re-save keeps it, probed with the sign-in.
    const kept = await saveMcpServer(db, { ...base, cred: "" }, ADMIN.actor);
    expect(kept.toast).toBe("cloudflare-api saved: 4 tools discovered · signed in with OAuth");
    const repointed = await saveMcpServer(db, { ...base, target: `${server.origin}/other`, cred: "" }, ADMIN.actor);
    expect(repointed.mcp.oauth).toBeNull();
    expect(rawRow().oauth_ref).toBeNull();
    expect(listAuditEvents(db, { action: "org.mcp.updated" })[0]?.details).toMatchObject({ oauthDropped: true });
  });
});

describe("no token material leaves the server (ruling 469)", () => {
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
