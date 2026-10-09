import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ErrorCode,
  ListRootsRequestSchema,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { errorMessage } from "~/shared/errors";

/**
 * Ruling 191: the ONE MCP client Viberr speaks to an org server with.
 *
 * Two callers use it and must not disagree about what "up" means: the gateway
 * (`gateway.server.ts`), which holds a run's connection to a credentialed
 * server with the credential attached here, in the server process, and the
 * health probe (`discoverHttpMcpTools`, `resources.server.ts`), so a green dot
 * on a credentialed HTTP server is earned by the same handshake, the same
 * header and the same transport fallback a run's calls then travel through.
 *
 * A leaf on purpose: `resources.server.ts` imports it for the probe, so it may
 * import nothing of the registry's.
 */

/** What Viberr calls itself in an MCP handshake. */
export const MCP_CLIENT_INFO = { name: "viberr", version: "1.0.0" };

/**
 * The MCP client capabilities every handshake declares (P13-LV-19).
 *
 * The old handshake advertised `capabilities: {}`, and a server that gates
 * tools on client capabilities then hid them: Viberr's Settings row said
 * "13 tools discovered" for the Everything server while both live runs
 * enumerated **15** from the same command. The number shown has to be the
 * number a run gets, so the probe declares the same capability set the SDK
 * clients do — and the gateway's upstream client (ruling 191) IS that
 * client, answering each capability honestly (no roots, elicitation declined,
 * sampling refused with a sentence).
 */
export const MCP_CLIENT_CAPABILITIES = {
  roots: { listChanged: true },
  sampling: {},
  elicitation: {},
};

/** How long a handshake (transport start + `initialize`) may take. */
export const UPSTREAM_CONNECT_TIMEOUT_MS = 30_000;

/** The subset of `fetch` the SDK transports call, so a test can inject one. */
export type McpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface UpstreamHttpOptions {
  /** The decrypted org credential, sent as `Authorization: Bearer <token>`. */
  token?: string | null;
  /** Ruling 192: an OAuth sign-in's access token, asked for on every request
   *  (so a sign-out or a refresh elsewhere takes effect on the next one) and
   *  renewed once on a 401. Takes the place of `token`. */
  auth?: UpstreamTokenSource;
  fetchImpl?: McpFetch;
  timeoutMs?: number;
  /** Aborts the connect while it is in flight (`connectWithin`). */
  signal?: AbortSignal;
}

/**
 * Ruling 192: where an OAuth-signed-in connection's access token comes from.
 * The registry implements it (`org/mcp-oauth.server.ts`); this module only
 * attaches what it hands over, in the server process, like a static
 * credential. Each method throws an `UpstreamConnectError` whose reason is the
 * sentence the run, the probe and the Settings row then read.
 */
export interface UpstreamTokenSource {
  /** The access token to send now, refreshed first when it has run out. */
  accessToken(): Promise<string>;
  /** The server answered `rejected` with a 401: the token to retry with, once. */
  renewAfterRefusal(rejected: string): Promise<string>;
  /** The renewed token `rejected` was refused as well: record it (only while
   *  it is still the stored one), and return the error the request fails with. */
  refusedAfterRenewal(rejected: string): Promise<UpstreamConnectError>;
}

/** Ruling 192: what a server with no credential says when it asks for an
 *  OAuth sign-in (the MCP authorization spec's 401 challenge). */
export const OAUTH_NEEDS_SIGN_IN =
  "needs sign-in: this server asks for an OAuth sign-in, which an org admin does from its editor in Instance settings → Agent resources";

/** Ruling 192: what a sign-in that can no longer be renewed says. */
export const OAUTH_SIGN_IN_EXPIRED =
  "sign-in expired: an admin must sign in again (Instance settings → Agent resources)";

/** What both SDK HTTP client transports take from Viberr. */
interface HttpTransportOptions {
  requestInit?: RequestInit;
  fetch?: McpFetch;
}

/** A connected upstream: the client and which transport answered. */
export interface UpstreamConnection {
  client: Client;
  transport: "streamable-http" | "sse" | "stdio";
  /** Once the connection has closed, why, in the upstream's own words when it
   *  has any (a stdio process's exit and stderr); null while it is open. */
  closedReason?: () => string | null;
}

/** A connection that failed, with the reason in words a human can act on. */
export class UpstreamConnectError extends Error {
  readonly reason: string;
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = "UpstreamConnectError";
    this.reason = reason;
  }
}

/**
 * Ruling 192: a server with no credential answered the MCP authorization
 * challenge, a 401 carrying `resource_metadata`. The probe records it, so the
 * row reads "needs sign-in" and the sign-in knows where the metadata is.
 */
export class UpstreamSignInNeeded extends UpstreamConnectError {
  readonly resourceMetadataUrl: string;
  constructor(resourceMetadataUrl: string, options?: { cause?: unknown }) {
    super(OAUTH_NEEDS_SIGN_IN, options);
    this.name = "UpstreamSignInNeeded";
    this.resourceMetadataUrl = resourceMetadataUrl;
  }
}

/**
 * A request that was not processed because this connection is no longer the
 * right one: the gateway opens a new connection and sends it again, once.
 * Thrown from the transport's own `fetch`, so it reaches the caller as itself
 * rather than as an SDK error string.
 */
export class UpstreamReconnectNeeded extends UpstreamConnectError {
  constructor(reason: string) {
    super(reason);
    this.name = "UpstreamReconnectNeeded";
  }
}

/**
 * R-gateway-3 (2026-09-25): the server answered a request on a session it no
 * longer has (a restart, a redeploy, an idle expiry). The MCP spec's signal is
 * a 404 to a request carrying `Mcp-Session-Id`; servers built from the SDK's
 * examples answer 400, and a legacy SSE server refuses a POST to its forgotten
 * session URL the same way.
 */
class UpstreamSessionLost extends UpstreamReconnectNeeded {
  constructor(status: number) {
    super(`the server ended its MCP session (HTTP ${status})`);
    this.name = "UpstreamSessionLost";
  }
}

/**
 * R-oauth-1 (2026-09-25): the registry row no longer points where this
 * connection was opened. An OAuth sign-in's token is for the endpoint it was
 * issued to and a connection's endpoint is fixed, so nothing more goes out on
 * this one: its token source throws this before a request is sent.
 */
export class UpstreamEndpointChanged extends UpstreamReconnectNeeded {
  constructor() {
    super("its endpoint changed in the org MCP registry after this connection opened");
    this.name = "UpstreamEndpointChanged";
  }
}

class UpstreamTimeoutError extends Error {
  constructor(ms: number) {
    super(`no answer in ${Math.round(ms / 1000)}s`);
    this.name = "UpstreamTimeoutError";
  }
}

/**
 * A client that answers what it declared. The capabilities above exist so a
 * server shows a run every tool; the requests they license come back to the
 * server process, which has no roots to offer, no person to ask and no model
 * to lend — so each gets its honest answer instead of hanging.
 */
export function newUpstreamClient(): Client {
  const client = new Client(MCP_CLIENT_INFO, { capabilities: MCP_CLIENT_CAPABILITIES });
  client.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [] }));
  client.setRequestHandler(ElicitRequestSchema, () => ({ action: "decline" as const }));
  client.setRequestHandler(CreateMessageRequestSchema, () => {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Sampling is not available through Viberr's MCP gateway.",
    );
  });
  return client;
}

/** What an aborted connect rejects with. */
const CLOSED_BEFORE_OPEN = "the connection was closed before it opened";

/**
 * Connect `client` over `transport` inside `timeoutMs`, or close it and throw.
 * The SDK's own request timeout covers `initialize` but not the transport's
 * start, and a legacy SSE server that never sends its `endpoint` event would
 * otherwise hold the connect open for ever.
 *
 * `signal` aborts a connect in flight. The client is closed from the abort
 * listener itself, which reaches the transport's close before its first await,
 * so a stdio process still in its handshake is killed before `abort()` returns
 * — what a shutdown needs, since it re-raises the signal right after
 * (R-gateway-5, 2026-09-25).
 */
export async function connectWithin(
  client: Client,
  transport: Transport,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new UpstreamConnectError(CLOSED_BEFORE_OPEN);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UpstreamTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
    onAbort = () => {
      void client.close().catch(() => undefined);
      reject(new UpstreamConnectError(CLOSED_BEFORE_OPEN));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([client.connect(transport, { timeout: timeoutMs }), stopped]);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** The HTTP status an SDK transport error carries, when it carries one. */
function httpStatusOf(cause: unknown): number | null {
  if (cause instanceof StreamableHTTPError || cause instanceof SseError) {
    return cause.code !== undefined && cause.code > 0 ? cause.code : null;
  }
  return null;
}

/**
 * Why a connection failed, in the words the Settings row and the gateway's
 * refusal both use. Kept to the vocabulary the probe has always spoken, so a
 * row's `last_error` means the same thing it did before the probe moved here.
 */
export function upstreamFailureReason(cause: unknown): string {
  if (cause instanceof UpstreamConnectError) return cause.reason;
  if (
    cause instanceof UpstreamTimeoutError ||
    (cause instanceof McpError && cause.code === ErrorCode.RequestTimeout) ||
    (cause instanceof Error && cause.name === "TimeoutError")
  ) {
    return "connection timed out";
  }
  const status = httpStatusOf(cause);
  if (status === 401 || status === 403) return "authentication rejected";
  if (status !== null) return `endpoint answered ${status} (not an MCP endpoint?)`;
  // `fetch` rejects with a TypeError for a refused, reset or unresolvable
  // connection; the SDK passes it through untouched.
  if (cause instanceof TypeError) return "connection refused";
  if (cause instanceof McpError) return `the server refused the handshake: ${cause.message}`;
  return `responded, but not as an MCP server (${errorMessage(cause)})`;
}

/**
 * The MCP spec's backwards-compatibility rule: a client that POSTs an
 * `initialize` and gets a 4xx back tries the legacy HTTP+SSE transport. An
 * authentication refusal is not a transport mismatch, so it is reported as
 * itself instead of being retried as something else.
 */
function fallsBackToSse(cause: unknown): boolean {
  const status = cause instanceof StreamableHTTPError ? httpStatusOf(cause) : null;
  return status !== null && status >= 400 && status < 500 && status !== 401 && status !== 403;
}

/**
 * Ruling 192: every request carries the sign-in's current access token; a 401
 * renews it and retries once (a request body is a string, so it replays), and
 * a second 401 ends the sign-in rather than looping.
 */
function bearerFetch(source: UpstreamTokenSource, base: McpFetch): McpFetch {
  return async (url, init) => {
    const send = (token: string) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return base(url, { ...init, headers });
    };
    const first = await source.accessToken();
    const answer = await send(first);
    if (answer.status !== 401) return answer;
    await answer.body?.cancel().catch(() => undefined);
    const renewed = await source.renewAfterRefusal(first);
    const retry = await send(renewed);
    if (retry.status !== 401) return retry;
    await retry.body?.cancel().catch(() => undefined);
    throw await source.refusedAfterRenewal(renewed);
  };
}

/**
 * R-gateway-3: a POST the server refuses because the session it rode on is
 * gone throws `UpstreamSessionLost`, instead of handing the SDK a response it
 * only turns into "Error POSTing to endpoint". `onSession` says whether a POST
 * rode on a session: one carrying `Mcp-Session-Id` on Streamable HTTP (a 4xx
 * to the session-less `initialize` is the SSE fallback's cue, not a lost
 * session), every POST on the legacy transport (its message URL IS the
 * session).
 */
function watchSession(base: McpFetch, onSession: (init: RequestInit | undefined) => boolean): McpFetch {
  return async (url, init) => {
    const res = await base(url, init);
    if ((res.status === 404 || res.status === 400) && init?.method === "POST" && onSession(init)) {
      await res.body?.cancel().catch(() => undefined);
      throw new UpstreamSessionLost(res.status);
    }
    return res;
  };
}

/**
 * Connect to a remote MCP server: Streamable HTTP first, the legacy SSE
 * transport when the server answers the way an SSE-only server does. The
 * credential rides both as `Authorization: Bearer <token>` — attached here,
 * in the server process, and nowhere else (ruling 191). An OAuth sign-in's
 * token rides the same way, through `auth` (ruling 192).
 */
export async function connectHttpUpstream(
  target: string,
  options: UpstreamHttpOptions = {},
): Promise<UpstreamConnection> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new UpstreamConnectError("endpoint is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UpstreamConnectError("endpoint is not an http(s) URL");
  }
  const timeoutMs = options.timeoutMs ?? UPSTREAM_CONNECT_TIMEOUT_MS;
  // Ruling 192: with no credential at all, a 401 may be the MCP authorization
  // challenge; its `resource_metadata` is kept to report "needs sign-in". A
  // static credential's 401 stays "authentication rejected", as before.
  let challenge: string | null = null;
  const transportOptions = (onSession: (init: RequestInit | undefined) => boolean): HttpTransportOptions => {
    const base = watchSession(options.fetchImpl ?? fetch, onSession);
    if (options.auth) return { fetch: bearerFetch(options.auth, base) };
    if (options.token) {
      return { requestInit: { headers: { Authorization: `Bearer ${options.token}` } }, fetch: base };
    }
    return {
      fetch: async (input, init) => {
        const res = await base(input, init);
        if (res.status === 401) {
          challenge = extractWWWAuthenticateParams(res).resourceMetadataUrl?.toString() ?? challenge;
        }
        return res;
      },
    };
  };
  const failure = (cause: unknown): UpstreamConnectError =>
    challenge !== null && httpStatusOf(cause) === 401
      ? new UpstreamSignInNeeded(challenge, { cause })
      : new UpstreamConnectError(upstreamFailureReason(cause), { cause });

  const streamable = newUpstreamClient();
  try {
    await connectWithin(
      streamable,
      new StreamableHTTPClientTransport(
        url,
        transportOptions((init) => new Headers(init?.headers).has("mcp-session-id")),
      ),
      timeoutMs,
      options.signal,
    );
    return { client: streamable, transport: "streamable-http" };
  } catch (primary) {
    if (!fallsBackToSse(primary) || options.signal?.aborted) throw failure(primary);
    const sse = newUpstreamClient();
    try {
      await connectWithin(
        sse,
        new SSEClientTransport(url, transportOptions(() => true)),
        timeoutMs,
        options.signal,
      );
      return { client: sse, transport: "sse" };
    } catch {
      // The Streamable HTTP answer is the one worth reporting: the SSE attempt
      // is the compatibility retry, and its failure says only that the server
      // is not a legacy one either.
      throw failure(primary);
    }
  }
}

/** Page through `tools/list` (at most 50 pages). */
export async function listAllTools(
  client: Client,
  options: { timeoutMs?: number } = {},
): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await client.listTools(
      cursor ? { cursor } : undefined,
      options.timeoutMs ? { timeout: options.timeoutMs } : undefined,
    );
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools;
}
