import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import { gone } from "../../../test-support/process-liveness";
import { waitFor } from "../../../test-support/polling";
import {
  startHttpUpstream,
  startSessionfulHttpUpstream,
  startSseUpstream,
  writeSilentStdioUpstream,
  writeStdioUpstream,
  type UpstreamHandle,
} from "../../../test-support/mcp-upstream";
import { sealSecret } from "~/server/secrets/secret-box.server";
import {
  resolveSpecialistMcpServersDetailed,
  verifyStdioMcpMountsForRun,
} from "~/server/tasks/specialist-mcp.server";
import type { RunMcpServerDeclaration } from "~/server/runtimes/adapter.server";
import {
  bindRunToMcpGateway,
  mcpGatewayMountUrl,
  mcpGatewayStatus,
  revokeRunMcpGateway,
  startMcpGateway,
  stopMcpGateway,
} from "./gateway.server";

/**
 * Ruling 461: the loopback gateway, end to end against real MCP servers that
 * REQUIRE their bearer — the resolver's config, the run's token, the upstream
 * with the credential attached in the server process, the ruling-176 filter,
 * and the refusals.
 */

const SECRET = "cf-api-token-sentinel-461";
const ctx = createTestDbContext();
let db: DatabaseSync;
const upstreams: UpstreamHandle[] = [];
const clients: Client[] = [];

beforeEach(async () => {
  db = ctx.makeDb();
  await startMcpGateway({ port: 0, callTimeoutMs: 400, connectTimeoutMs: 3_000 });
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await stopMcpGateway();
  for (const upstream of upstreams.splice(0)) await upstream.close();
  ctx.cleanup();
});

function addMcp(name: string, transport: "HTTP" | "stdio", target: string, credential: string | null): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO org_mcp_servers (id, name, transport, target, cred_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`mcp_${name}`, name, transport, target, credential ? sealSecret(credential) : null, now, now);
}

function markWriteTools(name: string, tools: string[]): void {
  db.prepare(`UPDATE org_mcp_servers SET tool_policy_json = ? WHERE name = ?`).run(
    JSON.stringify(tools.map((tool) => ({ name: tool, gate: "repo-write" }))),
    name,
  );
}

/** The run config shape a gateway mount must have, read back strictly. */
const gatewayConfig = z.strictObject({
  type: z.literal("http"),
  url: z.string(),
  headers: z.strictObject({ Authorization: z.string() }),
  tools: z.array(z.object({ name: z.string(), permission_policy: z.string() })).optional(),
});

let runSeq = 0;
/** Resolve `names` as a run would and bind a fresh run id to the gateway. */
function mountRun(
  names: string[],
  options: { withholdWriteTools?: boolean; live?: () => boolean } = {},
) {
  runSeq += 1;
  const runId = `run_gw_${runSeq}`;
  const resolution = resolveSpecialistMcpServersDetailed(db, names, {
    withholdWriteTools: options.withholdWriteTools ?? false,
  });
  const servers = bindRunToMcpGateway({
    db,
    runId,
    servers: resolution.servers,
    toolDenials: resolution.toolDenials,
    actor: { userId: null, label: "agent:claude/developer (Developer)" },
    projectSlug: "acme",
    taskKey: "VIB-1",
    isLive: options.live ?? (() => true),
  });
  return { runId, servers };
}

async function connect(config: RunMcpServerDeclaration | undefined): Promise<Client> {
  const mount = gatewayConfig.parse(config);
  const client = new Client({ name: "agent-cli", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mount.url), {
      requestInit: { headers: mount.headers },
    }),
  );
  clients.push(client);
  return client;
}

/** A raw `initialize` POST, for the refusals a client library would hide. */
async function rawInitialize(url: string, authorization: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } },
    }),
  });
}

const jsonRpcError = z.object({
  jsonrpc: z.literal("2.0"),
  error: z.object({ code: z.number(), message: z.string() }),
});

const textResult = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  isError: z.boolean().optional(),
});

describe("the gateway against an HTTP upstream that requires its bearer", () => {
  it("lists and calls through, with the credential attached upstream and never in the run config", async () => {
    const upstream = await startHttpUpstream(SECRET);
    upstreams.push(upstream);
    addMcp("cloudflare", "HTTP", upstream.url, SECRET);

    const { servers } = mountRun(["cloudflare"]);
    // The run config names the gateway and the RUN's token — and nothing
    // anywhere in it is the credential.
    const mount = gatewayConfig.parse(servers.cloudflare);
    expect(mount.url).toBe(mcpGatewayMountUrl("cloudflare"));
    expect(mount.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/cloudflare$/);
    expect(mount.headers.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(servers)).not.toContain(SECRET);

    const client = await connect(servers.cloudflare);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["whoami", "delete_zone", "slow", "fail"]);
    const called = textResult.parse(await client.callTool({ name: "whoami", arguments: {} }));
    expect(called.content[0]?.text).toBe("whoami: ok");
    expect(upstream.calls).toEqual(["whoami"]);
    // Every request the upstream saw carried the credential, attached here.
    expect(new Set(upstream.authorizations)).toEqual(new Set([`Bearer ${SECRET}`]));
  });

  it("ruling 176: a withheld write tool is absent from the list and refused on call, and the call is audited", async () => {
    const upstream = await startHttpUpstream(SECRET);
    upstreams.push(upstream);
    addMcp("cloudflare", "HTTP", upstream.url, SECRET);
    markWriteTools("cloudflare", ["delete_zone"]);

    const { runId, servers } = mountRun(["cloudflare"], { withholdWriteTools: true });
    const client = await connect(servers.cloudflare);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("whoami");
    expect(names).not.toContain("delete_zone");

    const refused = textResult.parse(await client.callTool({ name: "delete_zone", arguments: {} }));
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("Withheld by capability policy");
    expect(refused.content[0]?.text).toContain("`delete_zone` on cloudflare");
    // Nothing was forwarded.
    expect(upstream.calls).toEqual([]);

    const audit = listAuditEvents(db, { action: "task.agent.mcp_write_call" });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorLabel: "agent:claude/developer (Developer)",
      subjectId: runId,
      projectSlug: "acme",
      taskKey: "VIB-1",
    });
    expect(audit[0]?.details).toMatchObject({ server: "cloudflare", tool: "delete_zone", outcome: "withheld" });
  });

  it("a run holding the write grant calls a marked tool through, and the call is audited as forwarded", async () => {
    const upstream = await startHttpUpstream(SECRET);
    upstreams.push(upstream);
    addMcp("cloudflare", "HTTP", upstream.url, SECRET);
    markWriteTools("cloudflare", ["delete_zone"]);

    const { servers } = mountRun(["cloudflare"]);
    const client = await connect(servers.cloudflare);
    textResult.parse(await client.callTool({ name: "delete_zone", arguments: {} }));
    expect(upstream.calls).toEqual(["delete_zone"]);
    // An unmarked tool is logged, not audited.
    textResult.parse(await client.callTool({ name: "whoami", arguments: {} }));
    const audit = listAuditEvents(db, { action: "task.agent.mcp_write_call" });
    expect(audit.map((row) => row.details)).toEqual([
      expect.objectContaining({ tool: "delete_zone", outcome: "ok" }),
    ]);
  });

  it("ruling 486 (F40-66): a connection not signed in with OAuth offers no grant tool, and a call by that name is the server's", async () => {
    // CANARY: offer the grant tool on every gateway connection, and both
    // listings carry it.
    const upstream = await startHttpUpstream(SECRET);
    upstreams.push(upstream);
    addMcp("cloudflare", "HTTP", upstream.url, SECRET);
    const open = await startHttpUpstream(null);
    upstreams.push(open);
    addMcp("docs", "HTTP", open.url, null);

    const { servers } = mountRun(["cloudflare", "docs"]);
    const pasted = await connect(servers.cloudflare);
    expect((await pasted.listTools()).tools.map((tool) => tool.name)).toEqual(["whoami", "delete_zone", "slow", "fail"]);
    const called = textResult.parse(await pasted.callTool({ name: "viberr_connection_grant", arguments: {} }));
    expect(called.content[0]?.text).toBe("viberr_connection_grant: ok");
    expect(upstream.calls).toEqual(["viberr_connection_grant"]);

    // An uncredentialed server mounts directly; reached through the gateway
    // anyway (a credential removed mid-run leaves the run's mount there), it
    // offers no grant tool either.
    expect(servers.docs).toEqual({ type: "http", url: open.url });
    const bare = bindRunToMcpGateway({
      db,
      runId: "run_gw_bare",
      servers: { docs: { type: "http", url: mcpGatewayMountUrl("docs") ?? "" } },
      toolDenials: [],
      actor: { userId: null, label: "agent:claude/developer (Developer)" },
      projectSlug: "acme",
      taskKey: "VIB-1",
      isLive: () => true,
    });
    const unsigned = await connect(bare.docs);
    expect((await unsigned.listTools()).tools.map((tool) => tool.name)).toEqual(["whoami", "delete_zone", "slow", "fail"]);
  });

  it("a wrong token, another server's name and a revoked token are all 401 with a JSON-RPC error", async () => {
    const upstream = await startHttpUpstream(SECRET);
    upstreams.push(upstream);
    addMcp("cloudflare", "HTTP", upstream.url, SECRET);
    addMcp("billing", "HTTP", upstream.url, SECRET);

    const { runId, servers } = mountRun(["cloudflare"]);
    const mount = gatewayConfig.parse(servers.cloudflare);

    const wrong = await rawInitialize(mount.url, "Bearer not-a-run-token");
    expect(wrong.status).toBe(401);
    expect(jsonRpcError.parse(await wrong.json()).error.message).toContain("a 401 here means the run has ended");

    // The token opens only the servers its run mounts.
    const otherServer = await rawInitialize(`${mount.url.replace(/cloudflare$/, "billing")}`, mount.headers.Authorization);
    expect(otherServer.status).toBe(401);

    const client = await connect(servers.cloudflare);
    await client.listTools();
    expect(mcpGatewayStatus().liveTokens).toBe(1);

    revokeRunMcpGateway(runId);
    expect(mcpGatewayStatus().liveTokens).toBe(0);
    const after = await rawInitialize(mount.url, mount.headers.Authorization);
    expect(after.status).toBe(401);
    jsonRpcError.parse(await after.json());
    // …and the live session died with it.
    await expect(client.listTools()).rejects.toThrow();
    // No tool call reached the upstream.
    expect(upstream.calls).toEqual([]);
  });

  it("a token whose run is no longer live is refused even before anything revokes it", async () => {
    const upstream = await startHttpUpstream(SECRET);
    upstreams.push(upstream);
    addMcp("cloudflare", "HTTP", upstream.url, SECRET);
    let live = true;
    const { servers } = mountRun(["cloudflare"], { live: () => live });
    const mount = gatewayConfig.parse(servers.cloudflare);
    live = false;
    const refused = await rawInitialize(mount.url, mount.headers.Authorization);
    expect(refused.status).toBe(401);
    expect(mcpGatewayStatus().liveTokens).toBe(0);
  });

  it("an upstream error and a timeout come back as JSON-RPC errors naming the server", async () => {
    const upstream = await startHttpUpstream(SECRET);
    upstreams.push(upstream);
    addMcp("cloudflare", "HTTP", upstream.url, SECRET);
    const { servers } = mountRun(["cloudflare"]);
    const client = await connect(servers.cloudflare);
    await expect(client.callTool({ name: "fail", arguments: {} })).rejects.toThrow(
      /MCP server "cloudflare": no such zone/,
    );
    // The gateway's call timeout is 400 ms here; `slow` answers at 1.5 s.
    await expect(client.callTool({ name: "slow", arguments: {} })).rejects.toThrow(
      /MCP server "cloudflare" did not answer in time/,
    );
  });

  it("an upstream the gateway cannot reach is a 502 JSON-RPC error naming the server, never a hang", async () => {
    addMcp("dead", "HTTP", "http://127.0.0.1:9/mcp", SECRET);
    const { servers } = mountRun(["dead"]);
    const mount = gatewayConfig.parse(servers.dead);
    const response = await rawInitialize(mount.url, mount.headers.Authorization);
    expect(response.status).toBe(502);
    expect(jsonRpcError.parse(await response.json()).error.message).toMatch(
      /^MCP server "dead" could not be reached through Viberr's gateway: connection refused/,
    );
  });

  it("an upstream that refuses the credential is reported as authentication rejected", async () => {
    const upstream = await startHttpUpstream(SECRET);
    upstreams.push(upstream);
    addMcp("cloudflare", "HTTP", upstream.url, "a-stale-token");
    const { servers } = mountRun(["cloudflare"]);
    const mount = gatewayConfig.parse(servers.cloudflare);
    const response = await rawInitialize(mount.url, mount.headers.Authorization);
    expect(response.status).toBe(502);
    expect(jsonRpcError.parse(await response.json()).error.message).toContain("authentication rejected");
  });

  for (const lostStatus of [404, 400] as const) {
    it(`R-gateway-3: an upstream that loses its session (${lostStatus}) gets a new one and the call goes through`, async () => {
      // CANARY: let the lost session's refusal reach the run as an error and
      // every later call fails for the rest of the run.
      const upstream = await startSessionfulHttpUpstream(SECRET, lostStatus);
      upstreams.push(upstream);
      addMcp("cloudflare", "HTTP", upstream.url, SECRET);
      const client = await connect(mountRun(["cloudflare"]).servers.cloudflare);
      textResult.parse(await client.callTool({ name: "whoami", arguments: {} }));
      expect(upstream.initializes()).toBe(1);

      upstream.forgetSessions();
      const called = textResult.parse(await client.callTool({ name: "whoami", arguments: {} }));
      expect(called.content[0]?.text).toBe("whoami: ok");
      expect(upstream.initializes()).toBe(2);
      // The refused request was never processed; the one sent again was.
      expect(upstream.calls).toEqual(["whoami", "whoami"]);

      // Two calls that meet the next loss at once open ONE new session.
      upstream.forgetSessions();
      const [a, b] = await Promise.all([client.listTools(), client.listTools()]);
      expect(a.tools.map((tool) => tool.name)).toEqual(b.tools.map((tool) => tool.name));
      expect(upstream.initializes()).toBe(3);
      expect(new Set(upstream.authorizations)).toEqual(new Set([`Bearer ${SECRET}`]));
    });
  }

  it("R-gateway-3: a legacy SSE upstream that forgot the session gets a new one too", async () => {
    const upstream = await startSseUpstream(SECRET);
    upstreams.push(upstream);
    addMcp("legacy", "HTTP", upstream.url, SECRET);
    const client = await connect(mountRun(["legacy"]).servers.legacy);
    textResult.parse(await client.callTool({ name: "whoami", arguments: {} }));
    upstream.forgetSessions();
    const called = textResult.parse(await client.callTool({ name: "whoami", arguments: {} }));
    expect(called.content[0]?.text).toBe("whoami: ok");
    expect(upstream.initializes()).toBe(2);
    expect(upstream.calls).toEqual(["whoami", "whoami"]);
    // Both sessions, the first one the SSE fallback opened included, carried
    // the stored credential and nothing else.
    expect(new Set(upstream.authorizations)).toEqual(new Set([`Bearer ${SECRET}`]));
  });
});

describe("the gateway against a stdio upstream the server spawns", () => {
  it("the command gets MCP_CREDENTIAL in its environment, the run config does not, and revoke kills it", async () => {
    const command = writeStdioUpstream(ctx.makeTempDir("viberr-gw-stdio-"));
    addMcp("pg", "stdio", command, SECRET);

    const resolution = await verifyStdioMcpMountsForRun(
      db,
      resolveSpecialistMcpServersDetailed(db, ["pg"]),
    );
    // The pre-flight ran WITH the credential and the server stays mounted —
    // as a gateway URL, not a command the CLI would spawn.
    expect(resolution.proxied).toEqual(["pg"]);
    const runId = "run_gw_stdio";
    const servers = bindRunToMcpGateway({
      db,
      runId,
      servers: resolution.servers,
      toolDenials: resolution.toolDenials,
      actor: { userId: null, label: "operator" },
      projectSlug: "acme",
      taskKey: "VIB-1",
      isLive: () => true,
    });
    const mount = gatewayConfig.parse(servers.pg);
    expect(JSON.stringify(servers)).not.toContain(SECRET);
    expect(JSON.stringify(servers)).not.toContain("MCP_CREDENTIAL");

    const client = await connect(mount);
    const credential = textResult.parse(await client.callTool({ name: "read_credential", arguments: {} }));
    expect(credential.content[0]?.text).toBe(SECRET);
    const pid = Number(textResult.parse(await client.callTool({ name: "pid", arguments: {} })).content[0]?.text);
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(process.pid);

    revokeRunMcpGateway(runId);
    expect(await gone(pid)).toBe(true);
  });

  function addStdioPg(): void {
    addMcp("pg", "stdio", writeStdioUpstream(ctx.makeTempDir("viberr-gw-stdio-")), SECRET);
  }

  /** The credentialed stdio server mounted on a fresh run, the run's client
   *  and the pid of the process the gateway spawned for it. */
  async function stdioRun(runId: string): Promise<{ client: Client; pid: number }> {
    const resolution = resolveSpecialistMcpServersDetailed(db, ["pg"]);
    const servers = bindRunToMcpGateway({
      db,
      runId,
      servers: resolution.servers,
      toolDenials: resolution.toolDenials,
      actor: { userId: null, label: "operator" },
      projectSlug: "acme",
      taskKey: "VIB-1",
      isLive: () => true,
    });
    const client = await connect(servers.pg);
    const pid = Number(textResult.parse(await client.callTool({ name: "pid", arguments: {} })).content[0]?.text);
    return { client, pid };
  }

  it("R-gateway-1: an answer over the 10 MiB stdio line limit fails that call by name, stops the process and leaves the server up", async () => {
    // Before the fix the SDK's ReadBuffer threw inside the stdout listener: an
    // uncaughtException that exits the whole Viberr process. CANARY: drop the
    // try/catch around the append and vitest reports the unhandled error while
    // this call only times out.
    // The upstream has to finish writing its 10 MiB line before the call's
    // clock runs out, and the file's 400 ms clock did not allow that under a
    // loaded full suite: the call timed out instead, in two runs on 2026-09-28.
    await stopMcpGateway();
    await startMcpGateway({ port: 0, callTimeoutMs: 8_000, connectTimeoutMs: 3_000 });
    addStdioPg();
    const { client, pid } = await stdioRun("run_gw_huge");
    await expect(client.callTool({ name: "huge", arguments: {} }, undefined, { timeout: 10_000 })).rejects.toThrow(
      /MCP server "pg" failed through Viberr's gateway: stopped: it sent one message over the 10 MiB stdio limit/,
    );
    expect(await gone(pid)).toBe(true);
    // The run's session went with the process; a new one gets a new process.
    const again = await stdioRun("run_gw_huge_2");
    expect(again.pid).not.toBe(pid);
  });

  it("R-gateway-2: a process that dies mid-call answers the call with its own exit, not a hang", async () => {
    // CANARY: close the sessions in the upstream's onclose (before the SDK
    // rejects the calls in flight) and the answer is never written: the
    // run's client hears nothing until its own timeout.
    addStdioPg();
    const { client, pid } = await stdioRun("run_gw_exit");
    await expect(client.callTool({ name: "exit", arguments: {} }, undefined, { timeout: 5_000 })).rejects.toThrow(
      /MCP server "pg" failed through Viberr's gateway: exited \(exit code 3\)/,
    );
    expect(await gone(pid)).toBe(true);
    // The session is gone with the upstream, so the run's next request is a
    // 404 and it re-initializes onto a fresh process.
    await expect(client.listTools()).rejects.toMatchObject({ code: 404 });
    const again = await stdioRun("run_gw_exit_2");
    expect(again.pid).not.toBe(pid);
  });

  it("R-gateway-5: a shutdown while a stdio upstream is still in its handshake kills that process at once", async () => {
    // A handshake clock far longer than the check below, so only the stop
    // itself can end the process in time. CANARY: leave a connecting
    // upstream to `pending.then(close)` and it outlives the shutdown until
    // this 20 s timeout fires.
    await stopMcpGateway();
    await startMcpGateway({ port: 0, connectTimeoutMs: 20_000 });
    const { command, pidFile } = writeSilentStdioUpstream(ctx.makeTempDir("viberr-gw-silent-"));
    addMcp("slow", "stdio", command, SECRET);
    const mount = gatewayConfig.parse(mountRun(["slow"]).servers.slow);
    const answered = rawInitialize(mount.url, mount.headers.Authorization).catch(() => null);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", "the stdio process to start");
    const pid = Number(readFileSync(pidFile, "utf8"));
    // What `runProcessShutdown` does right before it re-raises the signal.
    void stopMcpGateway();
    expect(await gone(pid, 1_000)).toBe(true);
    await answered;
  });
});

describe("what counts as a gateway mount", () => {
  it("an uncredentialed server that merely lives on the loopback at /mcp/<name> is left alone", () => {
    // Canary: recognize a mount by its `127.0.0.1…/mcp/<name>` shape instead
    // of the gateway's own URL, and this local server is rewritten and bound.
    const local = { type: "http", url: "http://127.0.0.1:9/mcp/local" };
    const servers = bindRunToMcpGateway({
      db,
      runId: "run_local",
      servers: { local },
      toolDenials: [],
      actor: { userId: null, label: "operator" },
      projectSlug: "acme",
      taskKey: "VIB-1",
      isLive: () => true,
    });
    expect(servers).toEqual({ local });
    expect(mcpGatewayStatus().liveTokens).toBe(0);
  });
});

describe("mounting when the gateway is down", () => {
  it("a credentialed server is not mounted and the run is told why; an uncredentialed one mounts directly", async () => {
    await stopMcpGateway();
    addMcp("cloudflare", "HTTP", "https://mcp.example.test/mcp", SECRET);
    addMcp("docs", "HTTP", "https://docs.example.test/mcp", null);
    const resolution = resolveSpecialistMcpServersDetailed(db, ["cloudflare", "docs"]);
    expect(resolution.servers).toEqual({ docs: { type: "http", url: "https://docs.example.test/mcp" } });
    expect(resolution.proxied).toEqual([]);
    expect(resolution.unresolved).toEqual([
      {
        name: "cloudflare",
        reason:
          "it has a stored credential and Viberr's MCP gateway, the only way a run reaches such a server, is not running",
      },
    ]);
    expect(mcpGatewayStatus()).toEqual({ listening: false, port: null, liveTokens: 0 });
  });
});
