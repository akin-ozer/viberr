import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  CLOUDFLARE_AUTH_ERROR_TEXT,
  signInWithOAuth,
  startOAuthMcpServer,
  TEST_OAUTH_ADMIN,
  type OAuthMcpServerHandle,
} from "../../../test-support/mcp-oauth-server";
import { CLOUDFLARE_READ_ONLY_GRANT } from "../../../test-support/cloudflare-read-only-grant";
import { signOutMcpOAuth } from "~/server/org/mcp-oauth.server";
import { listMcpServers, saveMcpServer } from "~/server/org/resources.server";
import { resolveSpecialistMcpServersDetailed } from "~/server/tasks/specialist-mcp.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import { bindRunToMcpGateway, closeRunMcpGatewayCalls, startMcpGateway, stopMcpGateway } from "./gateway.server";
import { MCP_GRANT_TOOL_NAME } from "./grant-tool.server";
import { errorMessage } from "~/shared/errors";
import { OAUTH_NEEDS_SIGN_IN, OAUTH_SIGN_IN_EXPIRED } from "./upstream.server";

/**
 * Ruling 192: the ruling-191 gateway carries an OAuth sign-in's access token
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

const toolResult = textResult.extend({ isError: z.boolean().optional() });

/** The connection as the Agent resources list reads it. */
const mcpRow = () => listMcpServers(db).find((mcp) => mcp.id === "mcp_cf");

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
  await server.close();
  ctx.cleanup();
});

/** Mount the server as a run would and connect the run's own client. */
async function runClient(): Promise<{ client: Client; config: string; runToken: string }> {
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
  return {
    client,
    config: JSON.stringify(servers),
    runToken: mount.headers.Authorization.replace(/^Bearer /, ""),
  };
}

describe("the gateway and an OAuth sign-in (ruling 192)", () => {
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
    expect(mcpRow()?.oauth?.status).toBe("expired");
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
      expect(mcpRow()?.oauth?.status).toBe("signed_in");
    } finally {
      await moved.close();
    }
  });

  describe("an upstream authorization refusal names a read-only grant (ruling 192)", () => {
    const SENTENCE =
      "This connection's sign-in granted read-only scopes (194); an admin must sign it in again with write scopes in Instance settings → Agent resources.";

    /** Sign in again, the server granting `scope` this time. */
    async function grantedAgain(scope: string): Promise<void> {
      server.options.grantedScope = scope;
      expect((await signInWithOAuth(db, "mcp_cf")).ok).toBe(true);
    }

    /** What the run's own client reads when a call fails. */
    async function refusalOf(call: ReturnType<Client["callTool"]>): Promise<string> {
      try {
        await call;
      } catch (cause) {
        return errorMessage(cause);
      }
      return "answered";
    }

    it("an upstream 403 on a read-only grant gains the sentence; on a grant that writes it does not", async () => {
      // CANARY: relay the refusal as it came, and the run reads only
      // "insufficient_scope" beside a connection every surface calls signed in.
      await grantedAgain(CLOUDFLARE_READ_ONLY_GRANT);
      server.options.refuseWrites = "http-403";
      const { client } = await runClient();
      const readOnly = await refusalOf(client.callTool({ name: "delete_zone", arguments: {} }));
      expect(readOnly).toContain('MCP server "cloudflare-api" failed through Viberr\'s gateway');
      // The upstream's own words stay as they were, the sentence after them.
      expect(readOnly).toContain('{"error":"insufficient_scope"}');
      expect(readOnly.endsWith(SENTENCE)).toBe(true);
      expect(server.calls).toEqual(["refused:delete_zone"]);
      // The sign-in stands: a refusal of authority is not an expired token.
      expect(mcpRow()?.oauth?.status).toBe("signed_in");

      await grantedAgain(`${CLOUDFLARE_READ_ONLY_GRANT} workers-scripts.write`);
      const writes = await refusalOf(client.callTool({ name: "delete_zone", arguments: {} }));
      expect(writes).toContain('{"error":"insufficient_scope"}');
      expect(writes).not.toContain("read-only scopes");
    });

    it("a tool result that says 'Authentication error' on a read-only grant gains the sentence after the upstream's text", async () => {
      // CANARY: look only at thrown errors, and Cloudflare's "10000:
      // Authentication error" (a tool result) reaches the run bare.
      await grantedAgain(CLOUDFLARE_READ_ONLY_GRANT);
      server.options.refuseWrites = "tool-error";
      const { client } = await runClient();
      const refused = toolResult.parse(await client.callTool({ name: "delete_zone", arguments: {} }));
      expect(refused.isError).toBe(true);
      expect(refused.content.map((block) => block.text)).toEqual([CLOUDFLARE_AUTH_ERROR_TEXT, SENTENCE]);
      // A result that is not a refusal is left alone.
      const fine = toolResult.parse(await client.callTool({ name: "whoami", arguments: {} }));
      expect(fine.content.map((block) => block.text)).toEqual(["whoami: ok"]);

      await grantedAgain(`${CLOUDFLARE_READ_ONLY_GRANT} workers-scripts.write`);
      const writes = toolResult.parse(await client.callTool({ name: "delete_zone", arguments: {} }));
      expect(writes.content.map((block) => block.text)).toEqual([CLOUDFLARE_AUTH_ERROR_TEXT]);
    });
  });

  it("a sign-out takes effect on the run's next call", async () => {
    const { client } = await runClient();
    await client.callTool({ name: "whoami", arguments: {} });
    await signOutMcpOAuth(db, "mcp_cf", TEST_OAUTH_ADMIN.actor);
    await expect(client.callTool({ name: "whoami", arguments: {} })).rejects.toThrow(OAUTH_NEEDS_SIGN_IN);
    expect(server.calls).toEqual(["whoami"]);
  });

  describe("the connection's grant tool (ruling 192, F40-66)", () => {
    const WRITES = ["workers-kv-storage.write", "workers-scripts.write"];

    /** The grant tool's answer as the run's client reads it, and as it came. */
    async function grantAnswer(client: Client): Promise<{ text: string; raw: string }> {
      const answered = await client.callTool({ name: MCP_GRANT_TOOL_NAME, arguments: {} });
      const parsed = toolResult.parse(answered);
      expect(parsed.isError).not.toBe(true);
      return { text: parsed.content.map((block) => block.text).join("\n"), raw: JSON.stringify(answered) };
    }

    it("is listed on an OAuth-signed-in connection and answers the grant's writes, reads and expiry without reaching the server", async () => {
      // CANARIES: offer no grant tool (the listing ends at "fail"); forward
      // the call upstream (the server hears it and answers "…: ok"); count
      // every scope as a write (the writes list holds the reads); put the
      // run's bearer in the answer (the token search finds it).
      server.options.grantedScope = `${CLOUDFLARE_READ_ONLY_GRANT} ${WRITES.join(" ")}`;
      expect((await signInWithOAuth(db, "mcp_cf")).ok).toBe(true);
      // Marked as a write tool by hand, it still never counts as a write call.
      db.prepare(`UPDATE org_mcp_servers SET tool_policy_json = ? WHERE id = 'mcp_cf'`).run(
        JSON.stringify([MCP_GRANT_TOOL_NAME, "delete_zone"].map((name) => ({ name, gate: "repo-write" }))),
      );
      const { client, runToken } = await runClient();

      const listed = (await client.listTools()).tools;
      expect(listed.map((tool) => tool.name)).toEqual(["whoami", "delete_zone", "slow", "fail", MCP_GRANT_TOOL_NAME]);
      expect(listed.at(-1)?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

      const heard = server.authorizations.length;
      const { text, raw } = await grantAnswer(client);
      // Answered by the gateway: the server heard nothing at all.
      expect(server.authorizations).toHaveLength(heard);
      expect(server.calls).toEqual([]);

      const [head, writes, reads] = text.split("\n\n");
      const expiresAt = mcpRow()?.oauth?.expiresAt;
      expect(expiresAt).toEqual(expect.any(String));
      expect(head).toContain("cloudflare-api: signed in (expires in 60 minutes, renews itself) with OAuth");
      expect(head).toContain(`the access token expires at ${expiresAt}.`);
      expect(head).toContain("Granted 196 scopes: 2 writes and 194 reads.");
      expect(writes?.split("\n")).toEqual(["Writes (2):", ...WRITES]);
      const readLines = reads?.split("\n") ?? [];
      expect(readLines[0]).toBe("Reads (194):");
      expect(readLines).toHaveLength(195);
      expect(readLines).toContain("workers-kv-storage.read");
      expect(readLines).not.toContain("workers-kv-storage.write");

      // No token material: none the server issued, and not the run's own.
      for (const secret of [...server.issuedSecrets(), runToken]) expect(raw).not.toContain(secret);

      // Not audited as a write call though its name is marked; the marked
      // upstream tool still is.
      expect(listAuditEvents(db, { action: "task.agent.mcp_write_call" })).toEqual([]);
      await client.callTool({ name: "delete_zone", arguments: {} });
      expect(listAuditEvents(db, { action: "task.agent.mcp_write_call" }).map((row) => row.details)).toEqual([
        expect.objectContaining({ tool: "delete_zone" }),
      ]);
    });

    it("says the server did not name the grant when its sign-in named no scope", async () => {
      expect(mcpRow()?.oauth?.scope).toBeNull();
      const { client } = await runClient();
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(MCP_GRANT_TOOL_NAME);
      const { text } = await grantAnswer(client);
      expect(text).toContain("The server did not say which scopes it granted");
      expect(text).not.toContain("Writes");
      expect(server.calls).toEqual([]);
    });

    it("after a sign-out it says nothing is granted, and once the run's calls close it is refused like any call", async () => {
      // CANARY: answer it before the calls-closed check, and the ended run
      // still reads its grant.
      const { client } = await runClient();
      await client.listTools();
      await signOutMcpOAuth(db, "mcp_cf", TEST_OAUTH_ADMIN.actor);
      const heard = server.authorizations.length;
      const { text } = await grantAnswer(client);
      expect(text).toBe(
        "cloudflare-api is not signed in with OAuth now (it needs a sign-in), so its connection grants nothing until an org admin signs it in again in Instance settings → Agent resources.",
      );
      expect(server.authorizations).toHaveLength(heard);

      closeRunMcpGatewayCalls("run_oauth_1");
      await expect(client.callTool({ name: MCP_GRANT_TOOL_NAME, arguments: {} })).rejects.toThrow(
        "the run has ended",
      );
    });
  });
});
