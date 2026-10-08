import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ErrorCode,
  GetPromptRequestSchema,
  GetPromptResultSchema,
  isInitializeRequest,
  isJSONRPCRequest,
  JSONRPCMessageSchema,
  ListPromptsRequestSchema,
  ListPromptsResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
  PromptListChangedNotificationSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type CallToolRequest,
  type CallToolResult,
  type JSONRPCMessage,
  type ListToolsResult,
  type RequestMeta,
  type ServerCapabilities,
  type ServerNotification,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import { logger } from "~/server/logging/logger.server";
import { mcpOAuthTokenSource } from "~/server/org/mcp-oauth.server";
import { getMcpCredentialState, listMcpServers } from "~/server/org/resources.server";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { RunSpec } from "~/server/runtimes/adapter.server";
import { mcpWriteToolDenyReason } from "~/server/tasks/specialist-tool-policy";
import type { HttpMcpServerConfig } from "~/server/tasks/specialist-mcp.server";
import { errorMessage, toError } from "~/shared/errors";
import { mcpReadOnlyRefusal, type McpOAuthView } from "~/shared/mcp-oauth";
import type { McpToolDenial } from "~/shared/mcp-tools";
import { MCP_GRANT_TOOL, MCP_GRANT_TOOL_NAME, mcpGrantToolResult } from "./grant-tool.server";
import {
  KNOWLEDGE_CORRECT_TOOL,
  KNOWLEDGE_READ_TOOL,
  KNOWLEDGE_TOOLS,
  knowledgeArgsRefusal,
  knowledgeCorrectArgsSchema,
  knowledgeCorrectResult,
  knowledgeMountSchema,
  knowledgeReadArgsSchema,
  knowledgeReadResult,
  type KnowledgeMount,
} from "./knowledge-tool.server";
import {
  BOARD_READ_TOOL,
  BOARD_TOOLS,
  KEEP_SOURCE_NAME,
  PAGE_CAPTURE_TOOL,
  TASK_ATTACHMENT_TOOL,
  TASK_SOURCE_TOOL,
  TIMELINE_ENTRY_TOOL,
  boardArgsRefusal,
  boardMountSchema,
  boardReadArgsSchema,
  boardReadResult,
  keepSourceArgsRefusal,
  keepSourceArgsSchema,
  keepSourceResult,
  keepSourceTool,
  pageCaptureArgsRefusal,
  pageCaptureArgsSchema,
  pageCaptureResult,
  taskAttachmentArgsSchema,
  taskAttachmentResult,
  taskSourceArgsSchema,
  taskSourceResult,
  timelineEntryArgsSchema,
  timelineEntryResult,
  type BoardMount,
} from "./board-tool.server";
import { connectStdioUpstream } from "./upstream-stdio.server";
import {
  connectHttpUpstream,
  UPSTREAM_CONNECT_TIMEOUT_MS,
  UpstreamConnectError,
  upstreamFailureReason,
  UpstreamReconnectNeeded,
  type UpstreamConnection,
} from "./upstream.server";

/**
 * Ruling 461: Viberr's loopback MCP gateway. A credentialed org MCP server is
 * never handed to an agent process.
 *
 * Before this, `resolveSpecialistMcpServersDetailed` decrypted a server's
 * credential into the run's config — `Authorization: Bearer <credential>` on an
 * HTTP server, `MCP_CREDENTIAL` in a stdio server's env — and the Claude SDK
 * serializes `mcpServers` onto the CLI's argv, so the agent's own shell could
 * read the credential with `ps` (F40-2). Codex dropped it for that reason and
 * connected anonymously (F40-3). Now:
 *
 *  - This module holds an HTTP listener on `127.0.0.1` only, started at boot
 *    (`VIBERR_MCP_PROXY_PORT`, default an ephemeral port read back). It is not a
 *    React Router route and nothing outside the host reaches it.
 *  - A run that mounts credentialed servers gets ONE random 256-bit token,
 *    bound to its run id, the exact server names it mounts and the write tools
 *    it withholds on each (ruling 176). The token dies when the run settles
 *    (`revokeRunMcpGateway`, called from every settle path) and with the
 *    process. An unknown, revoked or wrong-server token is answered 401 with a
 *    JSON-RPC error and nothing is forwarded.
 *  - The run's config for such a server is `{ type: "http", url:
 *    "http://127.0.0.1:<port>/mcp/<name>", headers: { Authorization: "Bearer
 *    <run token>" } }` on BOTH backends. The run token is nobody's secret: it
 *    works only here, only for that run's grants and only while the run lives.
 *  - The gateway speaks MCP to the run (Streamable HTTP) and MCP to the real
 *    server with the credential attached in THIS process (`upstream.server.ts`
 *    for HTTP with its SSE fallback, `upstream-stdio.server.ts` for a command
 *    the server spawns with `MCP_CREDENTIAL`; for an OAuth-signed-in server
 *    the access token, renewed as it runs out, ruling 469), one upstream per (run, server),
 *    closed at revoke. Withheld write tools are filtered from `tools/list` and
 *    refused on `tools/call`; every forwarded call is logged (never its
 *    arguments or result) and a call to a marked write tool is audited. An
 *    upstream authorization refusal on an OAuth connection whose grant holds
 *    no write gains one sentence naming the grant and the remedy (ruling 486).
 *  - On an OAuth-signed-in connection the gateway adds one tool of its own,
 *    `viberr_connection_grant`, and answers it itself: the granted scopes,
 *    writes and reads listed apart, and the sign-in's expiry (ruling 486,
 *    F40-66, `grant-tool.server.ts`).
 *
 * State lives on `globalThis`, like the run service's, so a dev-server module
 * reload keeps the listener and the live tokens instead of opening a second port.
 */

/** A request slower than this is answered with a timeout error naming the
 *  server, never a hang. Progress notifications reset the clock. */
export const GATEWAY_CALL_TIMEOUT_MS = 5 * 60_000;
/** `tools/list`, `resources/*`, `prompts/*`: listings, not work. */
export const GATEWAY_LIST_TIMEOUT_MS = 60_000;
/** The largest JSON-RPC body the gateway reads from a run. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** JSON-RPC error code for a refused token (the implementation-defined range). */
const UNAUTHORIZED_CODE = -32001;
/** JSON-RPC error code for an upstream that could not be reached. */
const UPSTREAM_UNREACHABLE_CODE = -32002;

const SEP = "\u0000";

interface GatewayTimeouts {
  connectMs: number;
  callMs: number;
}

/** What a run's token opens. */
interface RunGrant {
  runId: string;
  /** The database the run was started against: the registry the upstream is
   *  read from and the audit table a write call lands in. */
  db: DatabaseSync;
  /** Server name → the tools this run withholds on it (ruling 176). */
  servers: Map<string, ReadonlySet<string>>;
  /** Ruling 585: the servers this gateway answers itself (the knowledge
   *  server), with the knowledge bases the run was given. Never upstreams. */
  knowledge: Map<string, KnowledgeMount>;
  /** Ruling 589: the board server, answered here too, with the store the
   *  run's task files are in. */
  board: Map<string, BoardMount>;
  /** Who a write-tool call is audited as. */
  actor: AuditActor;
  projectSlug: string;
  taskKey: string;
  /** Whether the run's row still says it is live — the belt to the settle
   *  paths' braces: a token whose run has ended is refused even if a path
   *  forgot to revoke it. */
  isLive: () => boolean;
  /** The run's process has exited (`closeRunMcpGatewayCalls`): the token
   *  still opens `initialize` and the listings for its completion compaction,
   *  and refuses every call. */
  callsClosed: boolean;
  /** Ruling 598: when each call came back with each answer, by a hash of
   *  both, inside the last window. */
  repeats: Map<string, number[]>;
  /** Ruling 598: the run was asked to stop for repeating one call. */
  loopStopped: boolean;
}

interface Upstream {
  key: string;
  runId: string;
  server: string;
  /** The connection requests go out on now: replaced when the server lost
   *  its session and the gateway opened a new one (R-gateway-3). */
  connection: UpstreamConnection;
  /** The entry's abort: a close stops a reconnect in flight as well. */
  signal: AbortSignal;
  /** A reconnect in flight, so the calls that met one lost session wait for
   *  one new connection. */
  reconnecting: Promise<UpstreamConnection> | null;
  /** Ruling 176's marks as the registry held them at the last connect: the
   *  calls audited as write calls. */
  writeTools: ReadonlySet<string>;
  sessions: Set<Session>;
}

/** An upstream connecting (`ready` null) or connected. */
interface UpstreamEntry {
  pending: Promise<Upstream>;
  /** Set the moment the connect has an upstream, in the same synchronous
   *  stretch, so no close ever finds a live connection it cannot reach. */
  ready: Upstream | null;
  /** Aborted by a close that finds the upstream still connecting: its
   *  transport closes at once — a stdio process still in its handshake is
   *  killed before the close returns — instead of after the handshake,
   *  which a shutdown never waits for (R-gateway-5). */
  abort: AbortController;
}

interface Session {
  id: string | null;
  runId: string;
  server: string;
  mcp: Server;
  transport: StreamableHTTPServerTransport;
  /** Null on a server the gateway answers itself (ruling 585). */
  upstream: Upstream | null;
}

interface GatewayState {
  http: HttpServer | null;
  port: number | null;
  timeouts: GatewayTimeouts;
  /** sha256(token) → grant. The plaintext token is never kept. */
  grants: Map<string, RunGrant>;
  /** runId → sha256(token). */
  byRun: Map<string, string>;
  /** `${runId}\0${server}` → the upstream, connecting (`ready` null) or
   *  connected. `ready` and `abort` are what let a shutdown close an upstream
   *  — and kill a spawned stdio process, connected or still in its handshake —
   *  synchronously, before the signal lands. */
  upstreams: Map<string, UpstreamEntry>;
  /** MCP session id → session. */
  sessions: Map<string, Session>;
}

const GATEWAY_KEY = Symbol.for("viberr.mcpGateway");

function getState(): GatewayState {
  const cache: Record<symbol, GatewayState | undefined> = globalThis;
  let state = cache[GATEWAY_KEY];
  if (!state) {
    state = {
      http: null,
      port: null,
      timeouts: {
        connectMs: UPSTREAM_CONNECT_TIMEOUT_MS,
        callMs: GATEWAY_CALL_TIMEOUT_MS,
      },
      grants: new Map(),
      byRun: new Map(),
      upstreams: new Map(),
      sessions: new Map(),
    };
    cache[GATEWAY_KEY] = state;
  }
  return state;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ------------------------------------------------------------- lifecycle

export interface StartMcpGatewayOptions {
  /** 0 (the default) picks an ephemeral port, read back after listen. */
  port?: number;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

/**
 * Start the listener on 127.0.0.1. Idempotent: a second call while listening
 * returns the port already bound (a dev reload re-runs boot).
 */
export async function startMcpGateway(options: StartMcpGatewayOptions = {}): Promise<{ port: number }> {
  const state = getState();
  state.timeouts = {
    connectMs: options.connectTimeoutMs ?? UPSTREAM_CONNECT_TIMEOUT_MS,
    callMs: options.callTimeoutMs ?? GATEWAY_CALL_TIMEOUT_MS,
  };
  if (state.http && state.port !== null) return { port: state.port };
  const http = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    http.once("error", onError);
    http.listen(options.port ?? 0, "127.0.0.1", () => {
      http.off("error", onError);
      resolve();
    });
  });
  http.on("error", (error) => {
    logger.error("mcp gateway listener error", { err: toError(error) });
  });
  // SAFETY: a server listening on a TCP host/port reports an AddressInfo (a
  // string address only exists for a pipe or unix socket, which this is not).
  const address = http.address() as AddressInfo;
  state.http = http;
  state.port = address.port;
  logger.info("mcp gateway listening", { host: "127.0.0.1", port: address.port });
  return { port: address.port };
}

/**
 * Close every session, upstream and token, then the listener. Everything but
 * the listener's final close happens synchronously, so the process-shutdown
 * hook (`runProcessShutdown`, which re-raises the signal right after) still
 * kills every stdio process the gateway spawned.
 */
export async function stopMcpGateway(): Promise<void> {
  const state = getState();
  for (const runId of Array.from(state.byRun.keys())) revokeRunMcpGateway(runId);
  for (const key of Array.from(state.upstreams.keys())) closeUpstreamByKey(key);
  const http = state.http;
  state.http = null;
  state.port = null;
  if (!http) return;
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
}

/** What `/resources/health` and `instance_health` report (append-only). */
export interface McpGatewayStatus {
  listening: boolean;
  port: number | null;
  liveTokens: number;
}

export function mcpGatewayStatus(): McpGatewayStatus {
  const state = getState();
  return {
    listening: state.http !== null && state.port !== null,
    port: state.port,
    liveTokens: state.grants.size,
  };
}

/**
 * The URL a run mounts `server` at, or null when the gateway is not listening
 * (a credentialed server then cannot be mounted at all — the resolver says so).
 */
export function mcpGatewayMountUrl(server: string): string | null {
  const state = getState();
  if (!state.http || state.port === null) return null;
  return `http://127.0.0.1:${state.port}/mcp/${encodeURIComponent(server)}`;
}

// ------------------------------------------------------------- run tokens

/** A gateway mount as the resolver writes it, read back tolerantly: the value
 *  arrives as an opaque `RunMcpServerDeclaration`. */
const gatewayMountSchema = z.object({
  type: z.literal("http"),
  url: z.string(),
  tools: z
    .array(z.object({ name: z.string(), permission_policy: z.literal("always_deny") }))
    .optional(),
  /** Ruling 585: set only on the knowledge mount, which the gateway answers
   *  itself. It stays here, and the run is handed the mount without it. */
  knowledge: knowledgeMountSchema.optional(),
  /** Ruling 589: set only on the board mount, kept here the same way. */
  board: boardMountSchema.optional(),
});

/** A run's MCP server map, as `RunSpec` carries it. */
export type RunServerMap = NonNullable<RunSpec["mcpServers"]>;

export interface GatewayRunBinding {
  db: DatabaseSync;
  runId: string;
  servers: RunServerMap;
  toolDenials: readonly McpToolDenial[];
  actor: AuditActor;
  projectSlug: string;
  taskKey: string;
  isLive: () => boolean;
}

/**
 * Mint the run's token and hand back its server map with the token on every
 * gateway mount. Called once, by `startRun`, the funnel every run goes through
 * (specialist, operator, controller, resume); a run with no gateway mount gets
 * the map back untouched and no token.
 *
 * A gateway mount is a server whose config is the resolver's
 * `{ type: "http", url: mcpGatewayMountUrl(name) }` — that exact URL, this
 * gateway's own port included, is the marker, so no second channel carries
 * "this one is proxied" past the callers in between, and an org server that
 * merely lives on the loopback at a `/mcp/<name>` path is left alone. A
 * gateway that is not listening marks nothing (the resolver mounts no
 * credentialed server then, and says why).
 */
export function bindRunToMcpGateway(input: GatewayRunBinding): RunServerMap {
  const mounts: { name: string; config: z.infer<typeof gatewayMountSchema> }[] = [];
  for (const [name, value] of Object.entries(input.servers)) {
    const parsed = gatewayMountSchema.safeParse(value);
    if (!parsed.success) continue;
    const own = mcpGatewayMountUrl(name);
    if (own === null || parsed.data.url !== own) continue;
    mounts.push({ name, config: parsed.data });
  }
  if (mounts.length === 0) return input.servers;
  const out: RunServerMap = { ...input.servers };
  revokeRunMcpGateway(input.runId);
  const token = randomBytes(32).toString("base64url");
  const servers = new Map<string, ReadonlySet<string>>();
  const knowledge = new Map<string, KnowledgeMount>();
  const board = new Map<string, BoardMount>();
  for (const mount of mounts) {
    if (mount.config.knowledge) knowledge.set(mount.name, mount.config.knowledge);
    if (mount.config.board) board.set(mount.name, mount.config.board);
    const withheld = input.toolDenials
      .filter((denial) => denial.server === mount.name)
      .flatMap((denial) => denial.tools);
    servers.set(mount.name, new Set(withheld));
    // Rebuilt from the parsed mount, so nothing but the URL, the run's token
    // and ruling 176's per-tool denies reaches the run.
    const config: HttpMcpServerConfig = {
      type: "http",
      url: mount.config.url,
      headers: { Authorization: `Bearer ${token}` },
    };
    if (mount.config.tools?.length) config.tools = mount.config.tools;
    out[mount.name] = config;
  }
  const hash = hashToken(token);
  const state = getState();
  state.grants.set(hash, {
    runId: input.runId,
    db: input.db,
    servers,
    knowledge,
    board,
    actor: input.actor,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    isLive: input.isLive,
    callsClosed: false,
    repeats: new Map(),
    loopStopped: false,
  });
  state.byRun.set(input.runId, hash);
  logger.info("mcp gateway token minted", {
    runId: input.runId,
    mcps: [...servers.keys()],
  });
  return out;
}

/**
 * The run's process has exited, and its completion compaction may be about to
 * replay the session (ruling 376). That request must carry the run's MCP
 * servers with the same tools, or it is a different prefix and misses the
 * cache it exists to read — so the token keeps opening `initialize` and the
 * listings (on the upstreams the run already holds), and from now on refuses
 * every call, resource read and prompt: nothing acts for a run that is over.
 * `revokeRunMcpGateway` ends it once the compaction is done (R-gateway-4,
 * 2026-09-25). A no-op for a run that holds no token.
 */
export function closeRunMcpGatewayCalls(runId: string): void {
  const state = getState();
  const grant = state.grants.get(state.byRun.get(runId) ?? "");
  if (grant) grant.callsClosed = true;
}

/**
 * The run has settled (or never will start): its token stops working, its
 * sessions close and its upstreams — a spawned stdio process included — are
 * torn down. Idempotent, and a no-op for a run that never held a token.
 */
export function revokeRunMcpGateway(runId: string): void {
  const state = getState();
  const hash = state.byRun.get(runId);
  if (hash) {
    state.byRun.delete(runId);
    state.grants.delete(hash);
    logger.info("mcp gateway token revoked", { runId });
  }
  for (const session of Array.from(state.sessions.values())) {
    if (session.runId === runId) closeSession(session);
  }
  for (const key of Array.from(state.upstreams.keys())) {
    if (key.startsWith(`${runId}${SEP}`)) closeUpstreamByKey(key);
  }
}

function closeUpstreamByKey(key: string): void {
  const state = getState();
  const entry = state.upstreams.get(key);
  if (!entry) return;
  state.upstreams.delete(key);
  entry.abort.abort();
  const close = (upstream: Upstream): Promise<void> => {
    for (const session of Array.from(upstream.sessions)) closeSession(session);
    // `Client.close` reaches the transport's close — the stdio process-group
    // kill — before its first await, so a connected upstream dies now.
    return upstream.connection.client.close();
  };
  const closing = entry.ready ? close(entry.ready) : entry.pending.then(close, () => undefined);
  closing.catch((error) => {
    logger.warn("mcp gateway upstream close failed", {
      key: key.replace(SEP, "/"),
      err: toError(error),
    });
  });
}

function closeSession(session: Session): void {
  const state = getState();
  if (session.id) state.sessions.delete(session.id);
  session.upstream?.sessions.delete(session);
  void session.mcp.close().catch(() => undefined);
}

/**
 * A session whose upstream closed under it. It stops routing now, so the
 * run's next request is a 404 and it re-initializes (a fresh upstream), as the
 * Streamable HTTP spec asks of a client. It CLOSES only once the calls in
 * flight have answered: the SDK runs an upstream's `onclose` before it rejects
 * the requests still waiting on it, and closing the session there aborted
 * their handlers, so a call on a stdio server that died mid-call was never
 * answered at all (R-gateway-2, 2026-09-25). Those rejections and the error
 * answers they turn into are microtasks, so the close waits one macrotask.
 */
function retireSession(session: Session): void {
  const state = getState();
  if (session.id) state.sessions.delete(session.id);
  session.upstream?.sessions.delete(session);
  setImmediate(() => {
    void session.mcp.close().catch(() => undefined);
  });
}

// ------------------------------------------------------------- HTTP

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  id: string | number | null,
  code: number,
  message: string,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }));
}

function refusalSentence(server: string): string {
  return (
    `Viberr's MCP gateway refused this request: the run token is unknown, revoked, or not ` +
    `granted "${server}". A run's token works only while that run is live, so a 401 here ` +
    "means the run has ended."
  );
}

/** The grant a request's bearer opens for `server`, or null. */
function grantFor(req: IncomingMessage, server: string): RunGrant | null {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match?.[1]) return null;
  const grant = getState().grants.get(hashToken(match[1]));
  if (!grant || !grant.servers.has(server)) return null;
  let live = false;
  try {
    live = grant.isLive();
  } catch {
    live = false;
  }
  if (!live) {
    revokeRunMcpGateway(grant.runId);
    return null;
  }
  return grant;
}

/** A POST body as the Streamable HTTP transport accepts it. */
type JsonRpcBody = JSONRPCMessage | JSONRPCMessage[];

/**
 * Read a POST body and decode it as JSON-RPC at this boundary, the same parse
 * the SDK transport applies to it next. Null when the body was refused — the
 * request has then been answered already.
 */
async function readJsonRpcBody(req: IncomingMessage, res: ServerResponse): Promise<JsonRpcBody | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      sendJsonRpcError(res, 413, null, ErrorCode.InvalidRequest, "Request body too large.");
      return null;
    }
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendJsonRpcError(res, 400, null, ErrorCode.ParseError, "Parse error: the body is not JSON.");
    return null;
  }
  const single = JSONRPCMessageSchema.safeParse(parsed);
  if (single.success) return single.data;
  if (Array.isArray(parsed)) {
    const batch: JSONRPCMessage[] = [];
    for (const item of parsed) {
      const message = JSONRPCMessageSchema.safeParse(item);
      if (!message.success) break;
      batch.push(message.data);
    }
    if (batch.length === parsed.length) return batch;
  }
  sendJsonRpcError(res, 400, null, ErrorCode.InvalidRequest, "Invalid Request: not a JSON-RPC message.");
  return null;
}

/** The `initialize` request in a body (or batch), with its id. */
function initializeIn(body: JsonRpcBody): { id: string | number } | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (isJSONRPCRequest(message) && isInitializeRequest(message)) return { id: message.id };
  }
  return null;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await route(req, res);
  } catch (error) {
    logger.error("mcp gateway request failed", { err: toError(error) });
    sendJsonRpcError(res, 500, null, ErrorCode.InternalError, "Viberr's MCP gateway failed this request.");
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const state = getState();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const match = /^\/mcp\/([^/]+)$/.exec(url.pathname);
  let server: string | null = null;
  try {
    server = match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    server = null;
  }
  if (!server) {
    sendJsonRpcError(res, 404, null, ErrorCode.InvalidRequest, "Not an MCP gateway path.");
    return;
  }
  const grant = grantFor(req, server);
  if (!grant) {
    logger.info("mcp gateway refused a request", { server, method: req.method });
    sendJsonRpcError(res, 401, null, UNAUTHORIZED_CODE, refusalSentence(server));
    return;
  }

  const sessionHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
  if (sessionId) {
    const session = state.sessions.get(sessionId);
    if (!session || session.runId !== grant.runId || session.server !== server) {
      sendJsonRpcError(res, 404, null, ErrorCode.InvalidRequest, "Session not found. Start a new MCP session.");
      return;
    }
    if (req.method !== "POST") {
      await session.transport.handleRequest(req, res);
      return;
    }
    const body = await readJsonRpcBody(req, res);
    if (body === null) return;
    await session.transport.handleRequest(req, res, body);
    return;
  }

  if (req.method !== "POST") {
    sendJsonRpcError(res, 400, null, ErrorCode.InvalidRequest, "Bad Request: No valid session ID provided");
    return;
  }
  const body = await readJsonRpcBody(req, res);
  if (body === null) return;
  const init = initializeIn(body);
  if (!init) {
    sendJsonRpcError(res, 400, null, ErrorCode.InvalidRequest, "Bad Request: No valid session ID provided");
    return;
  }
  // Rulings 585 and 589: the knowledge and board servers have no upstream;
  // this process answers them.
  const knowledge = grant.knowledge.get(server);
  const board = grant.board.get(server);
  if (knowledge || board) {
    const session = knowledge
      ? await openKnowledgeSession(grant, server, knowledge)
      : await openBoardSession(grant, server, board!);
    await session.transport.handleRequest(req, res, body);
    return;
  }
  let upstream: Upstream;
  try {
    upstream = await upstreamFor(grant, server);
  } catch (error) {
    const reason = upstreamFailureReason(error);
    logger.warn("mcp gateway could not reach an upstream", { runId: grant.runId, server, reason });
    sendJsonRpcError(
      res,
      502,
      init.id,
      UPSTREAM_UNREACHABLE_CODE,
      `MCP server "${server}" could not be reached through Viberr's gateway: ${reason}`,
    );
    return;
  }
  // The run may have settled while the upstream connected.
  if (!state.grants.has(state.byRun.get(grant.runId) ?? "")) {
    sendJsonRpcError(res, 401, init.id, UNAUTHORIZED_CODE, refusalSentence(server));
    return;
  }
  const session = await openSession(grant, server, upstream);
  await session.transport.handleRequest(req, res, body);
}

// ------------------------------------------------------------- upstreams

function upstreamFor(grant: RunGrant, server: string): Promise<Upstream> {
  const state = getState();
  const key = `${grant.runId}${SEP}${server}`;
  const existing = state.upstreams.get(key);
  if (existing) return existing.pending;
  const abort = new AbortController();
  const entry: UpstreamEntry = {
    pending: connectUpstream(grant, server, key, abort.signal, (upstream) => {
      entry.ready = upstream;
    }),
    ready: null,
    abort,
  };
  state.upstreams.set(key, entry);
  entry.pending.catch(() => {
    // A failed connect is not cached: the run's next initialize retries.
    if (state.upstreams.get(key) === entry) state.upstreams.delete(key);
  });
  return entry.pending;
}

/** A connection opened for `server` as its registry row reads now. */
async function openConnection(
  grant: RunGrant,
  server: string,
  signal: AbortSignal,
): Promise<{ connection: UpstreamConnection; writeTools: string[] }> {
  const state = getState();
  const row = listMcpServers(grant.db).find((entry) => entry.name === server);
  if (!row) throw new UpstreamConnectError("it is no longer in the org MCP registry");
  const credential = getMcpCredentialState(grant.db, server);
  if (credential.state === "unreadable" || credential.state === "signed_out") {
    throw new UpstreamConnectError(credential.reason);
  }
  const token = credential.state === "ok" ? credential.token : null;
  // Ruling 469: an OAuth sign-in's access token is asked for on every request
  // (renewed when it has run out, and once after a 401), never handed over.
  const auth =
    credential.state === "oauth" ? mcpOAuthTokenSource(grant.db, row.id, row.target) : undefined;
  const timeoutMs = state.timeouts.connectMs;
  const connection =
    row.transport === "stdio"
      ? await connectStdioUpstream(row.target, { token, timeoutMs, signal })
      : await connectHttpUpstream(row.target, { token, auth, timeoutMs, signal });
  // A revoke or a stop that landed while this connected finds nothing to
  // close yet, so the connection closes itself here.
  if (!state.byRun.has(grant.runId) || signal.aborted) {
    await connection.client.close().catch(() => undefined);
    throw new UpstreamConnectError("the run has ended");
  }
  return { connection, writeTools: row.writeTools };
}

async function connectUpstream(
  grant: RunGrant,
  server: string,
  key: string,
  signal: AbortSignal,
  onReady: (upstream: Upstream) => void,
): Promise<Upstream> {
  const { connection, writeTools } = await openConnection(grant, server, signal);
  const upstream: Upstream = {
    key,
    runId: grant.runId,
    server,
    connection,
    signal,
    reconnecting: null,
    writeTools: new Set(writeTools),
    sessions: new Set(),
  };
  onReady(upstream);
  wireConnection(upstream, connection);
  logger.info("mcp gateway connected upstream", {
    runId: grant.runId,
    mcp: server,
    transport: connection.transport,
  });
  return upstream;
}

/** The upstream's handlers on one of its connections. A connection the
 *  upstream has since replaced (a reconnect) closes quietly. */
function wireConnection(upstream: Upstream, connection: UpstreamConnection): void {
  const state = getState();
  const client = connection.client;
  client.onclose = () => {
    if (upstream.connection !== connection) return;
    const entry = state.upstreams.get(upstream.key);
    if (entry?.ready === upstream) state.upstreams.delete(upstream.key);
    for (const session of Array.from(upstream.sessions)) retireSession(session);
  };
  const broadcast = (send: (session: Session) => Promise<void>) => {
    if (upstream.connection !== connection) return;
    for (const session of upstream.sessions) {
      void send(session).catch(() => undefined);
    }
  };
  client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
    broadcast((session) => session.mcp.sendToolListChanged()),
  );
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () =>
    broadcast((session) => session.mcp.sendResourceListChanged()),
  );
  client.setNotificationHandler(PromptListChangedNotificationSchema, () =>
    broadcast((session) => session.mcp.sendPromptListChanged()),
  );
}

/**
 * Replace `failed` with a new connection to the server as its row reads now.
 * Single-flight per upstream: every call that met the same lost session waits
 * for one reconnect. The run's sessions stay as they are — nothing the run
 * holds points at the upstream's session.
 */
function reconnectUpstream(
  grant: RunGrant,
  upstream: Upstream,
  failed: UpstreamConnection,
  why: string,
): Promise<UpstreamConnection> {
  if (upstream.connection !== failed) return Promise.resolve(upstream.connection);
  if (upstream.reconnecting) return upstream.reconnecting;
  const attempt = (async () => {
    const { connection, writeTools } = await openConnection(grant, upstream.server, upstream.signal);
    upstream.connection = connection;
    upstream.writeTools = new Set(writeTools);
    wireConnection(upstream, connection);
    void failed.client.close().catch(() => undefined);
    logger.info("mcp gateway reconnected upstream", {
      runId: grant.runId,
      mcp: upstream.server,
      transport: connection.transport,
      why,
    });
    return connection;
  })();
  upstream.reconnecting = attempt;
  const done = () => {
    if (upstream.reconnecting === attempt) upstream.reconnecting = null;
  };
  void attempt.then(done, done);
  return attempt;
}

/**
 * Send one request upstream, answering a failure as a named error. When the
 * connection is no longer the right one, nothing was processed and the gateway
 * reconnects (once, however many calls met it) and sends the request again:
 *
 *  - the server says it no longer has the session the request rode on — a
 *    restart, a redeploy, an idle expiry — and the MCP spec asks the client to
 *    start a new one. Before, the upstream kept its dead session for the rest
 *    of the run, and a run that re-initialized was handed the same one
 *    (R-gateway-3, 2026-09-25);
 *  - the registry row was re-pointed since the connection opened. Before, an
 *    OAuth connection's token source followed the row, so a later sign-in's
 *    token went to the old endpoint (R-oauth-1, 2026-09-25); now the new
 *    connection goes where the row points, with its own sign-in.
 */
async function forward<T>(
  grant: RunGrant,
  upstream: Upstream,
  send: (client: Client) => Promise<T>,
): Promise<T> {
  const connection = upstream.connection;
  try {
    return await send(connection.client);
  } catch (error) {
    if (!(error instanceof UpstreamReconnectNeeded)) {
      throw withGrantNote(grant, upstream.server, error, namedError(upstream.server, error, connection));
    }
    let fresh: UpstreamConnection;
    try {
      fresh = await reconnectUpstream(grant, upstream, connection, error.reason);
    } catch (reconnect) {
      throw new GatewayRpcError(
        UPSTREAM_UNREACHABLE_CODE,
        `MCP server "${upstream.server}" failed through Viberr's gateway: ${error.reason}, and a new connection could not be opened: ${upstreamFailureReason(reconnect)}`,
      );
    }
    try {
      return await send(fresh.client);
    } catch (retry) {
      throw withGrantNote(grant, upstream.server, retry, namedError(upstream.server, retry, fresh));
    }
  }
}

// ------------------------------------------------------------- sessions

/**
 * A JSON-RPC error the gateway answers with. Not an `McpError`: that class
 * prefixes its message with "MCP error <code>: ", which the SDK server then
 * sends as the wire message, so the run would read the prefix twice (its own
 * client adds one) and the upstream's once more.
 */
class GatewayRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "GatewayRpcError";
    this.code = code;
  }
}

/**
 * An upstream error as the run reads it: the server named, the code kept. A
 * connection that closed under the call says why when it can — a stdio
 * process's exit and its stderr beat the SDK's "Connection closed".
 */
function namedError(server: string, cause: unknown, connection: UpstreamConnection): GatewayRpcError {
  if (cause instanceof McpError && cause.code !== ErrorCode.ConnectionClosed) {
    const message = cause.message.replace(/^(?:MCP error -?\d+: )+/, "");
    const timedOut = cause.code === ErrorCode.RequestTimeout;
    return new GatewayRpcError(
      cause.code,
      timedOut
        ? `MCP server "${server}" did not answer in time through Viberr's gateway (${message})`
        : `MCP server "${server}": ${message}`,
    );
  }
  const closed = cause instanceof McpError ? (connection.closedReason?.() ?? null) : null;
  return new GatewayRpcError(
    UPSTREAM_UNREACHABLE_CODE,
    `MCP server "${server}" failed through Viberr's gateway: ${closed ?? errorMessage(cause)}`,
  );
}

/**
 * Ruling 486(d): the words an upstream uses when it refuses the caller's
 * authority rather than the request — Cloudflare's API answers a write on a
 * read-only grant with "10000: Authentication error", inside a tool result.
 */
const AUTHORITY_REFUSAL = /authenticat|authori[sz]|forbidden|insufficient[_ ]scope|permission denied/i;

/** Whether an upstream failure is an authorization refusal: an HTTP 401 or
 *  403, or a JSON-RPC error that says so. */
function refusedAuthority(cause: unknown): boolean {
  if (cause instanceof StreamableHTTPError || cause instanceof SseError) {
    return cause.code === 401 || cause.code === 403;
  }
  return cause instanceof McpError && AUTHORITY_REFUSAL.test(cause.message);
}

/** Whether a tool result is an error whose text is an authorization refusal. */
function toolRefusedAuthority(result: CallToolResult): boolean {
  return (
    result.isError === true &&
    result.content.some((block) => block.type === "text" && AUTHORITY_REFUSAL.test(block.text))
  );
}

/**
 * `server`'s OAuth sign-in as its registry row reads now (ruling 469's public
 * half, which holds no token), or null when it is not an OAuth connection. A
 * registry that cannot be read is logged and reads as null.
 */
function oauthViewOf(grant: RunGrant, server: string): McpOAuthView | null {
  try {
    return listMcpServers(grant.db).find((entry) => entry.name === server)?.oauth ?? null;
  } catch (error) {
    logger.warn("mcp gateway could not read a server's grant", { mcp: server, err: toError(error) });
    return null;
  }
}

/**
 * Ruling 486(d): the sentence an authorization refusal gains when `server` is
 * signed in with OAuth and its grant holds no write — read from the row now,
 * so a sign-in again with write scopes stops it at once. Before, the run read
 * only the upstream's words ("Authentication error") beside a connection
 * every surface called "signed in", and the owner was asked to choose a
 * remedy without seeing why (F40-63).
 */
function readOnlyGrantNote(grant: RunGrant, server: string): string | null {
  return mcpReadOnlyRefusal(oauthViewOf(grant, server));
}

/** A named upstream error, with ruling 486's sentence after the upstream's
 *  own words when it is an authorization refusal on a read-only grant. */
function withGrantNote(grant: RunGrant, server: string, cause: unknown, named: GatewayRpcError): GatewayRpcError {
  if (!refusedAuthority(cause)) return named;
  const note = readOnlyGrantNote(grant, server);
  return note ? new GatewayRpcError(named.code, `${named.message} ${note}`) : named;
}

/** R-gateway-4: a run whose process has exited lists, and calls nothing. */
function assertCallsOpen(grant: RunGrant, server: string, method: string): void {
  if (!grant.callsClosed) return;
  logger.info("mcp gateway refused a call from a run that has ended", {
    runId: grant.runId,
    mcp: server,
    method,
  });
  throw new GatewayRpcError(
    UNAUTHORIZED_CODE,
    `Viberr's MCP gateway refused this ${method}: the run has ended. Its completion compaction may list what "${server}" offers, but nothing is called for a run that is over.`,
  );
}

/** The run's `_meta` without its progress token: the upstream client mints
 *  its own and relays progress back under the run's. */
function upstreamMeta(meta: RequestMeta | undefined): RequestMeta | undefined {
  if (!meta) return undefined;
  const { progressToken: _dropped, ...rest } = meta;
  return Object.keys(rest).length ? rest : undefined;
}

async function openSession(grant: RunGrant, server: string, upstream: Upstream): Promise<Session> {
  const state = getState();
  const withheld = grant.servers.get(server) ?? new Set<string>();
  const { client: opened } = upstream.connection;
  const upstreamCaps = opened.getServerCapabilities() ?? {};
  const capabilities: ServerCapabilities = {};
  if (upstreamCaps.tools) capabilities.tools = upstreamCaps.tools.listChanged ? { listChanged: true } : {};
  // Ruling 486 (F40-66): an OAuth-signed-in connection offers the gateway's
  // grant tool, so it has tools even when its server offers none.
  if (!capabilities.tools && oauthViewOf(grant, server)?.status === "signed_in") capabilities.tools = {};
  if (upstreamCaps.resources) {
    capabilities.resources = upstreamCaps.resources.listChanged ? { listChanged: true } : {};
  }
  if (upstreamCaps.prompts) {
    capabilities.prompts = upstreamCaps.prompts.listChanged ? { listChanged: true } : {};
  }
  const info = opened.getServerVersion();
  const instructions = opened.getInstructions();
  const mcp = new Server(
    { name: info?.name ?? server, version: info?.version ?? "0.0.0" },
    instructions ? { capabilities, instructions } : { capabilities },
  );
  const { callMs } = state.timeouts;

  if (capabilities.tools) {
    mcp.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const result: ListToolsResult = upstreamCaps.tools
        ? await forward(grant, upstream, (client) =>
            client.request({ method: "tools/list", params: request.params }, ListToolsResultSchema, {
              signal: extra.signal,
              timeout: GATEWAY_LIST_TIMEOUT_MS,
            }),
          )
        : { tools: [] };
      // Ruling 486 (F40-66): a connection signed in with OAuth now offers the
      // gateway's grant tool, once (on the first page), in place of any
      // upstream tool of that name.
      const grantTool = oauthViewOf(grant, server)?.status === "signed_in";
      // Ruling 176: a withheld write tool is not offered at all.
      const tools = result.tools.filter(
        (tool) => !withheld.has(tool.name) && !(grantTool && tool.name === MCP_GRANT_TOOL_NAME),
      );
      if (grantTool && request.params?.cursor === undefined) tools.push(MCP_GRANT_TOOL);
      return { ...result, tools };
    });
    mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      assertCallsOpen(grant, server, "tools/call");
      const tool = request.params.name;
      // Ruling 486 (F40-66): on an OAuth connection the grant tool is answered
      // here, from the row's public half: never forwarded, never withheld,
      // never audited as a write.
      const signIn = tool === MCP_GRANT_TOOL_NAME ? oauthViewOf(grant, server) : null;
      if (signIn) {
        logger.info("mcp gateway answered its grant tool", {
          runId: grant.runId,
          mcp: server,
          status: signIn.status,
        });
        return mcpGrantToolResult(server, signIn);
      }
      const started = Date.now();
      const marked = upstream.writeTools.has(tool);
      let outcome: "ok" | "tool_error" | "withheld" | "error" = "error";
      try {
        if (withheld.has(tool)) {
          outcome = "withheld";
          const refused: CallToolResult = {
            content: [{ type: "text", text: mcpWriteToolDenyReason(server, tool) }],
            isError: true,
          };
          return refused;
        }
        const progressToken = request.params._meta?.progressToken;
        const params = { ...request.params, _meta: upstreamMeta(request.params._meta) };
        if (!params._meta) delete params._meta;
        const options: RequestOptions = {
          signal: extra.signal,
          timeout: callMs,
          resetTimeoutOnProgress: true,
        };
        // The run asked for progress, so the upstream's is relayed back under
        // the run's own token.
        if (progressToken !== undefined) {
          options.onprogress = (progress) => {
            const notification: ServerNotification = {
              method: "notifications/progress",
              params: { ...progress, progressToken },
            };
            void extra.sendNotification(notification).catch(() => undefined);
          };
        }
        const result = await forward(grant, upstream, (client) =>
          client.request({ method: "tools/call", params }, CallToolResultSchema, options),
        );
        const stop = repeatedCallStop(grant, server, tool, request.params.arguments, result);
        if (stop) {
          outcome = "tool_error";
          return stop;
        }
        outcome = result.isError ? "tool_error" : "ok";
        // Ruling 486(d): the upstream's words stay as they are; the note
        // follows them as one more text block.
        const note = toolRefusedAuthority(result) ? readOnlyGrantNote(grant, server) : null;
        return note ? { ...result, content: [...result.content, { type: "text", text: note }] } : result;
      } catch (error) {
        // Ruling 598: an upstream that answers with an error answers too; a
        // script that catches it and sends the call again is the same loop.
        const failed: CallToolResult = { content: [{ type: "text", text: errorMessage(error) }], isError: true };
        const stop = repeatedCallStop(grant, server, tool, request.params.arguments, failed);
        if (stop) {
          outcome = "tool_error";
          return stop;
        }
        throw error;
      } finally {
        const durationMs = Date.now() - started;
        // Ruling 461(5): every forwarded call, never its arguments or result.
        logger.info("mcp gateway call", { runId: grant.runId, mcp: server, tool, durationMs, outcome });
        // A call to a tool the admin marked as a write tool is the outward-
        // facing kind, so it is audited — a refused one too.
        if (marked) {
          recordAudit(grant.db, {
            action: "task.agent.mcp_write_call",
            actor: grant.actor,
            subjectKind: "run",
            subjectId: grant.runId,
            projectSlug: grant.projectSlug,
            taskKey: grant.taskKey,
            details: { runId: grant.runId, server, tool, outcome, durationMs },
          });
        }
      }
    });
  }
  if (capabilities.resources) {
    mcp.setRequestHandler(ListResourcesRequestSchema, (request, extra) =>
      forward(grant, upstream, (client) =>
        client.request({ method: "resources/list", params: request.params }, ListResourcesResultSchema, {
          signal: extra.signal,
          timeout: GATEWAY_LIST_TIMEOUT_MS,
        }),
      ),
    );
    mcp.setRequestHandler(ListResourceTemplatesRequestSchema, (request, extra) =>
      forward(grant, upstream, (client) =>
        client.request(
          { method: "resources/templates/list", params: request.params },
          ListResourceTemplatesResultSchema,
          { signal: extra.signal, timeout: GATEWAY_LIST_TIMEOUT_MS },
        ),
      ),
    );
    mcp.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      assertCallsOpen(grant, server, "resources/read");
      return forward(grant, upstream, (client) =>
        client.request({ method: "resources/read", params: request.params }, ReadResourceResultSchema, {
          signal: extra.signal,
          timeout: callMs,
        }),
      );
    });
  }
  if (capabilities.prompts) {
    mcp.setRequestHandler(ListPromptsRequestSchema, (request, extra) =>
      forward(grant, upstream, (client) =>
        client.request({ method: "prompts/list", params: request.params }, ListPromptsResultSchema, {
          signal: extra.signal,
          timeout: GATEWAY_LIST_TIMEOUT_MS,
        }),
      ),
    );
    mcp.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
      assertCallsOpen(grant, server, "prompts/get");
      return forward(grant, upstream, (client) =>
        client.request({ method: "prompts/get", params: request.params }, GetPromptResultSchema, {
          signal: extra.signal,
          timeout: GATEWAY_LIST_TIMEOUT_MS,
        }),
      );
    });
  }

  return connectSession(grant, server, mcp, upstream);
}

/** A session on `mcp`, routed by the id its transport mints. */
async function connectSession(
  grant: RunGrant,
  server: string,
  mcp: Server,
  upstream: Upstream | null,
): Promise<Session> {
  const state = getState();
  const port = state.port ?? 0;
  const session: Session = {
    id: null,
    runId: grant.runId,
    server,
    mcp,
    // Assigned below; the transport's callbacks close over the session.
    transport: new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.id = id;
        state.sessions.set(id, session);
      },
      onsessionclosed: () => closeSession(session),
      // Loopback only; the Host check is the SDK's DNS-rebinding guard.
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    }),
    upstream,
  };
  session.transport.onclose = () => {
    if (session.id) state.sessions.delete(session.id);
    upstream?.sessions.delete(session);
  };
  await mcp.connect(session.transport);
  upstream?.sessions.add(session);
  return session;
}

/**
 * Ruling 598: how often one call may come back with one answer inside
 * `LOOP_WINDOW_MS` before the run is stopped. A poll once a second never
 * reaches it; a script that retries without reading the answer reaches it in
 * about two seconds.
 */
export const LOOP_REPEATS = 100;
export const LOOP_WINDOW_MS = 60_000;
/** Past this many remembered calls, the ones outside the window are dropped. */
const LOOP_KEYS_PRUNE_AT = 2_000;

/**
 * Ruling 598: a run that keeps sending one call and getting one answer is
 * stopped. Live on AWSC-49 (2026-09-30) the Estimate Judge ran a script in
 * Codex's code mode that corrected a golden entry in an unbounded loop, and
 * the correction was refused every time ("The passage you sent as `replaces`
 * stands 3 times … Nothing was written."). The script never read the answer:
 * 44,725 corrections and as many reads in twenty minutes, until a person
 * stopped the run. Nothing else bounds a script, which calls at machine speed
 * between two model turns. Returns the answer to send instead once the run
 * repeats past the bound; the run service ends it failed, with the call and
 * the answer as its cause.
 */
function repeatedCallStop(
  grant: RunGrant,
  server: string,
  tool: string,
  args: ToolCallArguments | undefined,
  result: CallToolResult,
): CallToolResult | null {
  const now = Date.now();
  const key = createHash("sha256")
    .update(JSON.stringify([server, tool, args ?? null, result.content, result.isError === true]))
    .digest("hex");
  const recent = (grant.repeats.get(key) ?? []).filter((at) => now - at < LOOP_WINDOW_MS);
  recent.push(now);
  grant.repeats.set(key, recent);
  if (grant.repeats.size > LOOP_KEYS_PRUNE_AT) {
    for (const [k, times] of grant.repeats) {
      if (now - times[times.length - 1]! >= LOOP_WINDOW_MS) grant.repeats.delete(k);
    }
  }
  if (recent.length < LOOP_REPEATS) return null;
  const answer = result.content
    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const seconds = Math.max(1, Math.round((now - recent[0]!) / 1000));
  const sentence =
    `Viberr stopped the run: it sent \`${tool}\` (${server}) with the same arguments ${recent.length} times in ` +
    `${seconds} s and got the same answer each time: "${answer.length > 400 ? `${answer.slice(0, 399)}…` : answer}". ` +
    "Sending it again cannot change the answer; the call has to change.";
  if (!grant.loopStopped) {
    grant.loopStopped = true;
    logger.warn("mcp gateway stopped a run repeating one call", { runId: grant.runId, mcp: server, tool, repeats: recent.length });
    void import("~/server/runtimes/run-service.server")
      .then(({ stopRunForToolLoop }) => stopRunForToolLoop(grant.runId, sentence))
      .catch((error) => logger.error("mcp gateway could not stop a looping run", { runId: grant.runId, err: toError(error) }));
  }
  return { content: [{ type: "text", text: `[stopped] ${sentence}` }], isError: true };
}

/** A tool call's arguments as the MCP request carries them. */
type ToolCallArguments = NonNullable<CallToolRequest["params"]["arguments"]>;

/**
 * Rulings 585 and 589: a session on a server this process answers itself. It
 * lists `tools`, and `call` answers a call to one of them. Like every gateway
 * call it is logged without its arguments or its result, and a run that has
 * ended calls nothing.
 */
async function openOwnSession(
  grant: RunGrant,
  server: string,
  tools: Tool[],
  call: (tool: string, raw: ToolCallArguments) => Promise<CallToolResult | null>,
): Promise<Session> {
  const mcp = new Server({ name: server, version: "1.0.0" }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    assertCallsOpen(grant, server, "tools/call");
    const tool = request.params.name;
    const started = Date.now();
    const answered = (await call(tool, request.params.arguments ?? {})) ?? {
      content: [{ type: "text", text: `"${server}" has no tool "${tool}"; it offers ${tools.map((t) => t.name).join(" and ")}.` }],
      isError: true,
    };
    const result = repeatedCallStop(grant, server, tool, request.params.arguments, answered) ?? answered;
    logger.info("mcp gateway call", {
      runId: grant.runId,
      mcp: server,
      tool,
      durationMs: Date.now() - started,
      outcome: result.isError ? "tool_error" : "ok",
    });
    return result;
  });
  return connectSession(grant, server, mcp, null);
}

/**
 * Ruling 585: the knowledge server. It reaches only the knowledge bases the
 * run's mount named: `read_knowledge_doc` reads, and `correct_knowledge_doc`
 * writes a correction as the run's agent on the run's task.
 */
function openKnowledgeSession(grant: RunGrant, server: string, mount: KnowledgeMount): Promise<Session> {
  return openOwnSession(grant, server, KNOWLEDGE_TOOLS, async (tool, raw) => {
    if (tool === KNOWLEDGE_READ_TOOL.name) {
      const args = knowledgeReadArgsSchema.safeParse(raw);
      return args.success ? knowledgeReadResult(mount, args.data) : knowledgeArgsRefusal(KNOWLEDGE_READ_TOOL);
    }
    if (tool === KNOWLEDGE_CORRECT_TOOL.name) {
      const args = knowledgeCorrectArgsSchema.safeParse(raw);
      return args.success
        ? await knowledgeCorrectResult({
            db: grant.db,
            projectSlug: grant.projectSlug,
            taskKey: grant.taskKey,
            mount,
            args: args.data,
          })
        : knowledgeArgsRefusal(KNOWLEDGE_CORRECT_TOOL);
    }
    return null;
  });
}

/**
 * Ruling 589: the board server. `read_board` reads the run's project, and
 * `read_timeline_entry` one entry of the run's own task, with the readers a
 * Claude run's toolkit calls; ruling 594 adds `read_task_attachment`, one
 * file of any task in the project. Ruling 690 adds `read_task_source`, and
 * `keep_source` for a run whose mount says it may keep one.
 */
async function openBoardSession(grant: RunGrant, server: string, mount: BoardMount): Promise<Session> {
  // Ruling 691: `capture_page` is listed only while this server can render a
  // page. Loaded here, not at the top: the capture reaches the task layer,
  // which reaches the run service that binds this gateway.
  const { pageCaptureStatus } = await import("~/server/tasks/page-capture.server");
  // Ruling 690: a run that may save files on its task keeps sources here,
  // told how for what its web grant lets it reach.
  const tools = [
    ...BOARD_TOOLS,
    ...(pageCaptureStatus().available ? [PAGE_CAPTURE_TOOL] : []),
    ...(mount.sources ? [keepSourceTool(mount.sources.web)] : []),
  ];
  const context = {
    db: grant.db,
    runId: grant.runId,
    projectSlug: grant.projectSlug,
    taskKey: grant.taskKey,
    mount,
    // Ruling 648: what the run's knowledge server lets it read.
    readerKbs: [...grant.knowledge.values()].flatMap((knowledge) => knowledge.kb),
  };
  return openOwnSession(grant, server, tools, async (tool, raw) => {
    if (tool === BOARD_READ_TOOL.name) {
      const args = boardReadArgsSchema.safeParse(raw);
      return args.success ? await boardReadResult(context, args.data) : boardArgsRefusal(BOARD_READ_TOOL);
    }
    if (tool === TIMELINE_ENTRY_TOOL.name) {
      const args = timelineEntryArgsSchema.safeParse(raw);
      return args.success ? await timelineEntryResult(context, args.data) : boardArgsRefusal(TIMELINE_ENTRY_TOOL);
    }
    // Ruling 594: one attachment of a task in the run's project.
    if (tool === TASK_ATTACHMENT_TOOL.name) {
      const args = taskAttachmentArgsSchema.safeParse(raw);
      return args.success ? await taskAttachmentResult(context, args.data) : boardArgsRefusal(TASK_ATTACHMENT_TOOL);
    }
    // Ruling 690: the sources a task of the run's project keeps.
    if (tool === TASK_SOURCE_TOOL.name) {
      const args = taskSourceArgsSchema.safeParse(raw);
      return args.success ? await taskSourceResult(context, args.data) : boardArgsRefusal(TASK_SOURCE_TOOL);
    }
    // And the keep, on the run's own task, as the run's agent and run. A run
    // whose mount carries no `sources` is answered that the server has no
    // such tool.
    if (tool === KEEP_SOURCE_NAME && mount.sources) {
      const args = keepSourceArgsSchema.safeParse(raw);
      return args.success
        ? await keepSourceResult({ ...context, runId: grant.runId }, args.data)
        : keepSourceArgsRefusal();
    }
    // Ruling 691: one page of the run's own task, as a reader sees it.
    if (tool === PAGE_CAPTURE_TOOL.name && tools.includes(PAGE_CAPTURE_TOOL)) {
      const args = pageCaptureArgsSchema.safeParse(raw);
      return args.success ? await pageCaptureResult(context, args.data) : pageCaptureArgsRefusal();
    }
    return null;
  });
}
