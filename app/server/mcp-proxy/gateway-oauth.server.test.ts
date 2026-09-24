import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  signInWithOAuth,
  startOAuthMcpServer,
  TEST_OAUTH_ADMIN,
  type OAuthMcpServerHandle,
} from "../../../test-support/mcp-oauth-server";
import { resetMcpOAuthForTests, signOutMcpOAuth } from "~/server/org/mcp-oauth.server";
import { getMcpServer, saveMcpServer } from "~/server/org/resources.server";
import { resolveSpecialistMcpServersDetailed } from "~/server/tasks/specialist-mcp.server";
import { bindRunToMcpGateway, startMcpGateway, stopMcpGateway } from "./gateway.server";
import { OAUTH_NEEDS_SIGN_IN, OAUTH_SIGN_IN_EXPIRED } from "./upstream.server";

/**
 * Ruling 469: the ruling-461 gateway carries an OAuth sign-in's access token
 * upstream exactly as it carries a pasted credential — in the server process,
 * never in the run's config — and renews it when the server answers 401,
 * mid-run, without the run noticing. A renewal the server refuses reaches the
 * run as "sign-in expired: an admin must sign in again", and a sign-out takes
 * effect on the run's next call.
 */

const ctx = createTestDbContext();
let db: DatabaseSync;
let server: OAuthMcpServerHandle;
const clients: Client[] = [];

const gatewayConfig = z.strictObject({
  type: z.literal("http"),
  url: z.string(),
  headers: z.strictObject({ Authorization: z.string() }),
});

const textResult = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
});

beforeEach(async () => {
  db = ctx.makeDb();
  await startMcpGateway({ port: 0, connectTimeoutMs: 3_000 });
  server = await startOAuthMcpServer();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO org_mcp_servers (id, name, transport, target, created_at, updated_at)
     VALUES ('mcp_cf', 'cloudflare-api', 'HTTP', ?, ?, ?)`,
  ).run(server.url, now, now);
  const signedIn = await signInWithOAuth(db, "mcp_cf");
  expect(signedIn.ok).toBe(true);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await stopMcpGateway();
  resetMcpOAuthForTests();
  await server.close();
  ctx.cleanup();
});

/** Mount the server as a run would and connect the run's own client. */
async function runClient(): Promise<{ client: Client; config: string }> {
  const resolution = resolveSpecialistMcpServersDetailed(db, ["cloudflare-api"]);
  const servers = bindRunToMcpGateway({
    db,
    runId: "run_oauth_1",
    servers: resolution.servers,
    toolDenials: resolution.toolDenials,
    actor: { userId: null, label: "agent:claude/developer (Developer)" },
    projectSlug: "acme",
    taskKey: "VIB-1",
    isLive: () => true,
  });
  const mount = gatewayConfig.parse(servers["cloudflare-api"]);
  const client = new Client({ name: "agent-cli", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mount.url), { requestInit: { headers: mount.headers } }),
  );
  clients.push(client);
  return { client, config: JSON.stringify(servers) };
}

describe("the gateway and an OAuth sign-in (ruling 469)", () => {
  it("sends the access token upstream and never puts a token in the run's config", async () => {
    const { client, config } = await runClient();
    const called = textResult.parse(await client.callTool({ name: "whoami", arguments: {} }));
    expect(called.content[0]?.text).toBe("whoami: ok");
    const [access] = server.issuedSecrets().filter((secret) => secret.startsWith("at_"));
    expect(server.authorizations.every((header) => header === `Bearer ${access}`)).toBe(true);
    for (const secret of server.issuedSecrets()) expect(config).not.toContain(secret);
  });

  it("renews on a 401 in the middle of a run and the call goes through", async () => {
    const { client } = await runClient();
    await client.callTool({ name: "whoami", arguments: {} });
    server.invalidateAccessTokens();
    const called = textResult.parse(await client.callTool({ name: "whoami", arguments: {} }));
    expect(called.content[0]?.text).toBe("whoami: ok");
    const accessTokens = server.issuedSecrets().filter((secret) => secret.startsWith("at_"));
    expect(accessTokens).toHaveLength(2);
    expect(server.authorizations.at(-1)).toBe(`Bearer ${accessTokens[1]}`);
    expect(server.calls).toEqual(["whoami", "whoami"]);
  });

  it("a renewal the server refuses reaches the run as 'sign-in expired'", async () => {
    const { client } = await runClient();
    server.options.refresh = "invalid_grant";
    server.invalidateAccessTokens();
    await expect(client.callTool({ name: "whoami", arguments: {} })).rejects.toThrow(OAUTH_SIGN_IN_EXPIRED);
    expect(getMcpServer(db, "mcp_cf")?.oauth?.status).toBe("expired");
    expect(server.calls).toEqual([]);
  });

  it("R-oauth-1: a re-point and a new sign-in never send the new tokens to the endpoint the run's connection was opened on", async () => {
    // CANARY: bind the token source to the row id alone and the run's held
    // connection sends the new sign-in's token to the OLD server, whose 401
    // then spends the new refresh token and ends the new sign-in.
    const { client } = await runClient();
    await client.callTool({ name: "whoami", arguments: {} });
    const moved = await startOAuthMcpServer();
    try {
      await saveMcpServer(
        db,
        { id: "mcp_cf", name: "cloudflare-api", transport: "HTTP", target: moved.url, cred: "" },
        TEST_OAUTH_ADMIN.actor,
      );
      const before = server.authorizations.length;
      // Re-pointed and not signed in yet: the run's next call reconnects to
      // the new endpoint, which needs a sign-in, and says so.
      await expect(client.callTool({ name: "whoami", arguments: {} })).rejects.toThrow(OAUTH_NEEDS_SIGN_IN);
      expect((await signInWithOAuth(db, "mcp_cf")).ok).toBe(true);

      const called = textResult.parse(await client.callTool({ name: "whoami", arguments: {} }));
      expect(called.content[0]?.text).toBe("whoami: ok");
      expect(moved.calls).toEqual(["whoami"]);
      // The old endpoint heard nothing more, and none of the new tokens.
      expect(server.authorizations.length).toBe(before);
      const oldHeard = JSON.stringify(server.authorizations);
      for (const secret of moved.issuedSecrets()) expect(oldHeard).not.toContain(secret);
      expect(getMcpServer(db, "mcp_cf")?.oauth?.status).toBe("signed_in");
    } finally {
      await moved.close();
    }
  });

  it("a sign-out takes effect on the run's next call", async () => {
    const { client } = await runClient();
    await client.callTool({ name: "whoami", arguments: {} });
    await signOutMcpOAuth(db, "mcp_cf", TEST_OAUTH_ADMIN.actor);
    await expect(client.callTool({ name: "whoami", arguments: {} })).rejects.toThrow(OAUTH_NEEDS_SIGN_IN);
    expect(server.calls).toEqual(["whoami"]);
  });
});
