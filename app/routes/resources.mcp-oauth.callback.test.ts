import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";
import { listAuditEvents } from "../../test-support/audit-log";
import {
  consentAt,
  startOAuthMcpServer,
  type OAuthMcpServerHandle,
} from "../../test-support/mcp-oauth-server";

/**
 * Ruling 469, through the routes: an org admin's "Sign in" (`mcp-oauth-start`
 * on /org/settings) hands back the authorization URL with this instance's
 * callback as its redirect URI; the browser consents and lands on
 * GET /resources/mcp-oauth/callback, which seals the tokens, probes the
 * connection and answers a page that says it can be closed. A replayed
 * callback, one in another session and a member's are refused; "Sign out"
 * drops the tokens.
 */

let app: AppTestContext;
let ardaId: string;
let elifId: string;
let server: OAuthMcpServerHandle;
const MCP_ID = "mcp_cf";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda; // org admin
  elifId = userIds.elif; // org member
  server = await startOAuthMcpServer();
  const now = new Date().toISOString();
  app.db
    .prepare(
      `INSERT INTO org_mcp_servers (id, name, transport, target, created_at, updated_at)
       VALUES (?, 'cloudflare-api', 'HTTP', ?, ?, ?)`,
    )
    .run(MCP_ID, server.url, now, now);
});

afterAll(async () => {
  await server.close();
  app.cleanup();
});

const settingsReply = z.object({
  ok: z.boolean(),
  toast: z.string().optional(),
  error: z.string().optional(),
  authorizeUrl: z.string().optional(),
  issuer: z.string().optional(),
});

async function settingsAction(userId: string, fields: Record<string, string>) {
  const { action } = await import("~/routes/org.settings");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  fd.set("_csrf", await app.csrfFor(sessionId));
  const request = app.request("/org/settings", { method: "POST", body: fd, cookie });
  const result = await action({
    request,
    url: new URL(request.url),
    pattern: "/org/settings",
    params: {},
    context: new RouterContextProvider(),
  });
  return { cookie, body: settingsReply.parse("data" in result ? result.data : result) };
}

async function callback(back: URL, cookie: string): Promise<{ status: number; html: string; headers: Headers }> {
  const { loader } = await import("./resources.mcp-oauth.callback");
  const request = app.request(`/resources/mcp-oauth/callback${back.search}`, { cookie });
  try {
    const response = await loader({
      request,
      url: new URL(request.url),
      params: {},
      pattern: "/resources/mcp-oauth/callback",
      context: new RouterContextProvider(),
    });
    return { status: response.status, html: await response.text(), headers: response.headers };
  } catch (thrown) {
    // The admin guard throws a Response (403 for a member).
    if (thrown instanceof Response) return { status: thrown.status, html: await thrown.text(), headers: thrown.headers };
    throw thrown;
  }
}

describe("MCP OAuth sign-in through the routes (ruling 469)", () => {
  let back: URL;
  let adminCookie: string;

  it("Sign in hands back the authorization URL with this instance's callback as the redirect URI", async () => {
    const { cookie, body } = await settingsAction(ardaId, { intent: "mcp-oauth-start", mcpId: MCP_ID });
    adminCookie = cookie;
    expect(body.ok).toBe(true);
    expect(body.issuer).toBe(new URL(server.origin).host);
    const url = new URL(body.authorizeUrl ?? "");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:5173/resources/mcp-oauth/callback");
    back = await consentAt(url.toString());
    expect(`${back.origin}${back.pathname}`).toBe("http://localhost:5173/resources/mcp-oauth/callback");
  });

  it("a member's visit to the callback is refused and spends nothing", async () => {
    const { cookie } = await app.cookieFor(elifId);
    const { status } = await callback(back, cookie);
    expect(status).toBe(403);
    expect(server.tokenRequests).toHaveLength(0);
  });

  it("the admin's callback seals the tokens and answers a page that says it can be closed", async () => {
    const { status, html, headers } = await callback(back, adminCookie);
    expect(status).toBe(200);
    expect(headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("<h1>Signed in to cloudflare-api</h1>");
    expect(html).toMatch(/Connection check: cloudflare-api healthy: 4 tools · \d+ms · signed in \(expires in 60 minutes, renews itself\)\./);
    expect(html).toContain("You can close this tab.");
    for (const secret of server.issuedSecrets()) expect(html).not.toContain(secret);
    expect(html).not.toContain(back.searchParams.get("state") ?? "<none>");
    const { listMcpServers } = await import("~/server/org/resources.server");
    expect(listMcpServers(app.db).find((m) => m.id === MCP_ID)?.oauth?.status).toBe("signed_in");
    expect(listAuditEvents(app.db, { action: "org.mcp.oauth_connected" })[0]?.actorLabel).toBe("arda@viberr.dev");
  });

  it("the same callback again is refused: a state is spent once", async () => {
    const { status, html } = await callback(back, adminCookie);
    expect(status).toBe(400);
    expect(html).toContain("This sign-in link is unknown, has expired or was already used.");
    expect(server.tokenRequests).toHaveLength(1);
  });

  it("a callback that lands in another session of the same admin is refused", async () => {
    const { body } = await settingsAction(ardaId, { intent: "mcp-oauth-start", mcpId: MCP_ID });
    const next = await consentAt(body.authorizeUrl ?? "");
    const { cookie: otherSession } = await app.cookieFor(ardaId);
    const { status, html } = await callback(next, otherSession);
    expect(status).toBe(400);
    expect(html).toContain("This sign-in was started in another session.");
  });

  it("Sign out drops the tokens", async () => {
    const { body } = await settingsAction(ardaId, { intent: "mcp-oauth-sign-out", mcpId: MCP_ID });
    expect(body).toMatchObject({ ok: true, toast: expect.stringMatching(/^cloudflare-api signed out\./) });
    const { listMcpServers } = await import("~/server/org/resources.server");
    expect(listMcpServers(app.db).find((m) => m.id === MCP_ID)?.oauth?.status).toBe("needs_sign_in");
  });
});
