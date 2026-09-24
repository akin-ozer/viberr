import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Real MCP servers for the gateway's tests (ruling 461): the in-test stand-ins
 * for a remote org server that REQUIRES its bearer — the shape of the
 * Cloudflare API MCP server the gateway exists for — over Streamable HTTP and
 * over the legacy SSE transport, and a stdio command that reports the
 * `MCP_CREDENTIAL` it was started with.
 */

export interface UpstreamHandle {
  url: string;
  /** Tool names called on the upstream, in order: what actually arrived. */
  calls: string[];
  /** Every Authorization header the upstream was sent, in order. */
  authorizations: (string | null)[];
  close(): Promise<void>;
}

/** The tools every fixture server offers. `slow` answers after 1.5 s, `fail`
 *  answers with a JSON-RPC error. */
const TOOLS = [
  { name: "whoami", description: "Who the upstream thinks called", inputSchema: { type: "object" as const } },
  { name: "delete_zone", description: "A write tool an admin marks", inputSchema: { type: "object" as const } },
  { name: "slow", description: "Answers late", inputSchema: { type: "object" as const } },
  { name: "fail", description: "Answers with an error", inputSchema: { type: "object" as const } },
];

/** The fixture MCP server every stand-in serves (ruling 469's OAuth server too). */
export function fixtureServer(calls: string[]): Server {
  const server = new Server(
    { name: "fixture-upstream", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: "fixture instructions" },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls.push(request.params.name);
    if (request.params.name === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return { content: [{ type: "text" as const, text: "late" }] };
    }
    if (request.params.name === "fail") {
      throw new McpError(ErrorCode.InvalidParams, "no such zone");
    }
    return { content: [{ type: "text" as const, text: `${request.params.name}: ok` }] };
  });
  return server;
}

function refuse(res: ServerResponse): void {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }));
}

/** An HTTP listener on 127.0.0.1 with a free port, closed with every socket. */
export async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<{ port: number; close(): Promise<void> }> {
  const http = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", () => resolve()));
  // SAFETY: a TCP listener's address() is an AddressInfo (a string is a pipe).
  const { port } = http.address() as AddressInfo;
  return {
    port,
    close: async () => {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** A Streamable HTTP MCP server (stateless) that answers only `Bearer <token>`. */
export async function startHttpUpstream(token: string): Promise<UpstreamHandle> {
  const calls: string[] = [];
  const authorizations: (string | null)[] = [];
  const server = await listen(async (req, res) => {
    authorizations.push(req.headers.authorization ?? null);
    if (req.headers.authorization !== `Bearer ${token}`) {
      refuse(res);
      return;
    }
    const mcp = fixtureServer(calls);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    calls,
    authorizations,
    close: server.close,
  };
}

/** A legacy HTTP+SSE MCP server: GET /sse streams, POST /messages sends, and a
 *  POST to /sse is refused the way an SSE-only server refuses it. */
export async function startSseUpstream(token: string): Promise<UpstreamHandle> {
  const calls: string[] = [];
  const authorizations: (string | null)[] = [];
  const sessions = new Map<string, SSEServerTransport>();
  const server = await listen(async (req, res) => {
    authorizations.push(req.headers.authorization ?? null);
    if (req.headers.authorization !== `Bearer ${token}`) {
      refuse(res);
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/sse" && req.method === "GET") {
      const transport = new SSEServerTransport("/messages", res);
      sessions.set(transport.sessionId, transport);
      res.on("close", () => sessions.delete(transport.sessionId));
      await fixtureServer(calls).connect(transport);
      return;
    }
    if (url.pathname === "/messages" && req.method === "POST") {
      const transport = sessions.get(url.searchParams.get("sessionId") ?? "");
      if (!transport) {
        res.writeHead(404);
        res.end();
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }
    res.writeHead(405);
    res.end();
  });
  return {
    url: `http://127.0.0.1:${server.port}/sse`,
    calls,
    authorizations,
    close: server.close,
  };
}

/** How far past the SDK's 10 MiB stdio line limit `huge` answers. */
const HUGE_ANSWER_BYTES = 11 * 1024 * 1024;

/**
 * A stdio MCP server as a plain Node script: `read_credential` answers with the
 * `MCP_CREDENTIAL` in its environment, `pid` with its process id, `huge` with
 * one JSON-RPC line of 11 MiB (past the SDK's 10 MiB stdio limit), and `exit`
 * never answers: it prints a sentence on stderr and exits 3 mid-call. Returns
 * the registry command line that starts it.
 */
export function writeStdioUpstream(dir: string): string {
  const script = path.join(dir, "stdio-upstream.cjs");
  writeFileSync(
    script,
    `let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "stdio-upstream", version: "1.0.0" },
      } });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [
        { name: "read_credential", inputSchema: { type: "object" } },
        { name: "pid", inputSchema: { type: "object" } },
        { name: "huge", inputSchema: { type: "object" } },
        { name: "exit", inputSchema: { type: "object" } },
      ] } });
    } else if (message.method === "tools/call" && message.params.name === "exit") {
      process.stderr.write("the database went away\\n", () => process.exit(3));
    } else if (message.method === "tools/call") {
      const text = message.params.name === "pid"
        ? String(process.pid)
        : message.params.name === "huge"
          ? "x".repeat(${HUGE_ANSWER_BYTES})
          : (process.env.MCP_CREDENTIAL ?? "<none>");
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } });
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } });
    }
  }
});
`,
  );
  return `"${process.execPath}" "${script}"`;
}

/** A stdio fixture's registry command line and where it writes its pid. */
export interface StdioFixture {
  command: string;
  pidFile: string;
}

/**
 * A stdio MCP server that never finishes its handshake: it writes its pid to
 * `pidFile` and reads stdin without ever answering, the way a cold `npx -y`
 * install holds `initialize` open. For a shutdown that lands mid-handshake.
 */
export function writeSilentStdioUpstream(dir: string): StdioFixture {
  const script = path.join(dir, "silent-upstream.cjs");
  const pidFile = path.join(dir, "silent-upstream.pid");
  writeFileSync(
    script,
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.on("data", () => {});
`,
  );
  return { command: `"${process.execPath}" "${script}"`, pidFile };
}
