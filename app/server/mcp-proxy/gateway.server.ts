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
  type CallToolResult,
  type JSONRPCMessage,
  type RequestMeta,
  type ServerCapabilities,
  type ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import { logger } from "~/server/logging/logger.server";
import { getMcpCredentialState, listMcpServers } from "~/server/org/resources.server";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { RunSpec } from "~/server/runtimes/adapter.server";
import { mcpWriteToolDenyReason } from "~/server/tasks/specialist-tool-policy";
import type { HttpMcpServerConfig } from "~/server/tasks/specialist-mcp.server";
import { errorMessage, toError } from "~/shared/errors";
import type { McpToolDenial } from "~/shared/mcp-tools";
import { connectStdioUpstream } from "./upstream-stdio.server";
import {
  connectHttpUpstream,
  UPSTREAM_CONNECT_TIMEOUT_MS,
  UpstreamConnectError,
  upstreamFailureReason,
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
 *    the server spawns with `MCP_CREDENTIAL`), one upstream per (run, server),
 *    closed at revoke. Withheld write tools are filtered from `tools/list` and
 *    refused on `tools/call`; every forwarded call is logged (never its
 *    arguments or result) and a call to a marked write tool is audited.
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
  listMs: number;
}

/** What a run's token opens. */
interface RunGrant {
  runId: string;
  /** The database the run was started against: the registry the upstream is
   *  read from and the audit table a write call lands in. */
  db: DatabaseSync;
  /** Server name → the tools this run withholds on it (ruling 176). */
  servers: Map<string, ReadonlySet<string>>;
  /** Who a write-tool call is audited as. */
  actor: AuditActor;
  projectSlug: string;
  taskKey: string;
  /** Whether the run's row still says it is live — the belt to the settle
   *  paths' braces: a token whose run has ended is refused even if a path
   *  forgot to revoke it. */
  isLive: () => boolean;
}

interface Upstream {
  key: string;
  runId: string;
  server: string;
  client: Client;
  transport: "streamable-http" | "sse" | "stdio";
  /** Ruling 176's marks as the registry held them at connect: the calls
   *  audited as write calls. */
  writeTools: ReadonlySet<string>;
  sessions: Set<Session>;
}

/** An upstream connecting (`ready` null) or connected. */
interface UpstreamEntry {
  pending: Promise<Upstream>;
  ready: Upstream | null;
}

interface Session {
  id: string | null;
  runId: string;
  server: string;
  mcp: Server;
  transport: StreamableHTTPServerTransport;
  upstream: Upstream;
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
   *  connected. `ready` is what lets a shutdown close a live upstream — and
   *  kill a spawned stdio process — synchronously, before the signal lands. */
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
        listMs: GATEWAY_LIST_TIMEOUT_MS,
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
  listTimeoutMs?: number;
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
    listMs: options.listTimeoutMs ?? GATEWAY_LIST_TIMEOUT_MS,
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
  for (const mount of mounts) {
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
    actor: input.actor,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    isLive: input.isLive,
  });
  state.byRun.set(input.runId, hash);
  logger.info("mcp gateway token minted", {
    runId: input.runId,
    mcps: [...servers.keys()],
  });
  return out;
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
  const close = (upstream: Upstream): Promise<void> => {
    for (const session of Array.from(upstream.sessions)) closeSession(session);
    // `Client.close` reaches the transport's close — the stdio process-group
    // kill — before its first await, so a connected upstream dies now.
    return upstream.client.close();
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
  session.upstream.sessions.delete(session);
  void session.mcp.close().catch(() => undefined);
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
  const entry: UpstreamEntry = {
    pending: connectUpstream(grant, server, key),
    ready: null,
  };
  state.upstreams.set(key, entry);
  entry.pending.then(
    (upstream) => {
      entry.ready = upstream;
    },
    () => {
      // A failed connect is not cached: the run's next initialize retries.
      if (state.upstreams.get(key) === entry) state.upstreams.delete(key);
    },
  );
  return entry.pending;
}

async function connectUpstream(grant: RunGrant, server: string, key: string): Promise<Upstream> {
  const state = getState();
  const row = listMcpServers(grant.db).find((entry) => entry.name === server);
  if (!row) throw new UpstreamConnectError("it is no longer in the org MCP registry");
  const credential = getMcpCredentialState(grant.db, server);
  if (credential.state === "unreadable") throw new UpstreamConnectError(credential.reason);
  const token = credential.state === "ok" ? credential.token : null;
  const connection =
    row.transport === "stdio"
      ? await connectStdioUpstream(row.target, { token, timeoutMs: state.timeouts.connectMs })
      : await connectHttpUpstream(row.target, { token, timeoutMs: state.timeouts.connectMs });
  const upstream: Upstream = {
    key,
    runId: grant.runId,
    server,
    client: connection.client,
    transport: connection.transport,
    writeTools: new Set(row.writeTools),
    sessions: new Set(),
  };
  // A revoke that landed while this connected finds nothing to close yet, so
  // the connection closes itself here.
  if (!state.byRun.has(grant.runId)) {
    await connection.client.close().catch(() => undefined);
    throw new UpstreamConnectError("the run has ended");
  }
  const client = connection.client;
  client.onclose = () => {
    const entry = state.upstreams.get(key);
    if (entry?.ready === upstream) state.upstreams.delete(key);
    // The run's sessions on a dead upstream are closed, so the CLI's next
    // request is a 404 and it re-initializes (a fresh upstream) as the
    // Streamable HTTP spec asks of a client.
    for (const session of Array.from(upstream.sessions)) closeSession(session);
  };
  const broadcast = (send: (session: Session) => Promise<void>) => {
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
  logger.info("mcp gateway connected upstream", {
    runId: grant.runId,
    mcp: server,
    transport: connection.transport,
  });
  return upstream;
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

/** An upstream error as the run reads it: the server named, the code kept. */
function namedError(server: string, cause: unknown): GatewayRpcError {
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
  return new GatewayRpcError(
    UPSTREAM_UNREACHABLE_CODE,
    `MCP server "${server}" failed through Viberr's gateway: ${errorMessage(cause)}`,
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
  const upstreamCaps = upstream.client.getServerCapabilities() ?? {};
  const capabilities: ServerCapabilities = {};
  if (upstreamCaps.tools) capabilities.tools = upstreamCaps.tools.listChanged ? { listChanged: true } : {};
  if (upstreamCaps.resources) {
    capabilities.resources = upstreamCaps.resources.listChanged ? { listChanged: true } : {};
  }
  if (upstreamCaps.prompts) {
    capabilities.prompts = upstreamCaps.prompts.listChanged ? { listChanged: true } : {};
  }
  const info = upstream.client.getServerVersion();
  const instructions = upstream.client.getInstructions();
  const mcp = new Server(
    { name: info?.name ?? server, version: info?.version ?? "0.0.0" },
    instructions ? { capabilities, instructions } : { capabilities },
  );
  const { listMs, callMs } = state.timeouts;
  const client = upstream.client;

  if (capabilities.tools) {
    mcp.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      try {
        const result = await client.request(
          { method: "tools/list", params: request.params },
          ListToolsResultSchema,
          { signal: extra.signal, timeout: listMs },
        );
        // Ruling 176: a withheld write tool is not offered at all.
        return { ...result, tools: result.tools.filter((tool) => !withheld.has(tool.name)) };
      } catch (error) {
        throw namedError(server, error);
      }
    });
    mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = request.params.name;
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
        const result = await client.request({ method: "tools/call", params }, CallToolResultSchema, options);
        outcome = result.isError ? "tool_error" : "ok";
        return result;
      } catch (error) {
        throw namedError(server, error);
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
    mcp.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
      try {
        return await client.request({ method: "resources/list", params: request.params }, ListResourcesResultSchema, {
          signal: extra.signal,
          timeout: listMs,
        });
      } catch (error) {
        throw namedError(server, error);
      }
    });
    mcp.setRequestHandler(ListResourceTemplatesRequestSchema, async (request, extra) => {
      try {
        return await client.request(
          { method: "resources/templates/list", params: request.params },
          ListResourceTemplatesResultSchema,
          { signal: extra.signal, timeout: listMs },
        );
      } catch (error) {
        throw namedError(server, error);
      }
    });
    mcp.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      try {
        return await client.request({ method: "resources/read", params: request.params }, ReadResourceResultSchema, {
          signal: extra.signal,
          timeout: callMs,
        });
      } catch (error) {
        throw namedError(server, error);
      }
    });
  }
  if (capabilities.prompts) {
    mcp.setRequestHandler(ListPromptsRequestSchema, async (request, extra) => {
      try {
        return await client.request({ method: "prompts/list", params: request.params }, ListPromptsResultSchema, {
          signal: extra.signal,
          timeout: listMs,
        });
      } catch (error) {
        throw namedError(server, error);
      }
    });
    mcp.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
      try {
        return await client.request({ method: "prompts/get", params: request.params }, GetPromptResultSchema, {
          signal: extra.signal,
          timeout: listMs,
        });
      } catch (error) {
        throw namedError(server, error);
      }
    });
  }

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
    upstream.sessions.delete(session);
  };
  await mcp.connect(session.transport);
  upstream.sessions.add(session);
  return session;
}
