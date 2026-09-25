import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  InvalidClientError,
  OAuthError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError,
  UnauthorizedClientError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { errorMessage } from "~/shared/errors";
import type { McpFetch } from "./upstream.server";

/**
 * Ruling 469: the MCP authorization flow, as a client (the protocol half; the
 * registry half, which seals what this returns, is `org/mcp-oauth.server.ts`).
 *
 * An HTTP MCP server that answers 401 with `WWW-Authenticate: Bearer …
 * resource_metadata="…"` publishes RFC 9728 protected-resource metadata naming
 * its authorization server, whose RFC 8414 metadata names the endpoints. This
 * module discovers both, registers Viberr as a client (RFC 7591), builds the
 * authorization-code request with PKCE (S256), exchanges the code, refreshes
 * and revokes. The SDK's own client helpers do the wire work (they are what
 * its transports run); what is Viberr's is the refusals, each a sentence an
 * admin can act on, and the rule that nothing here logs or keeps a token.
 *
 * A leaf like `upstream.server.ts`: no database, no registry.
 */

/** How long one request to an authorization server may take. */
export const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

/** What Viberr keeps of an authorization server's metadata: the endpoints it
 *  calls and the capabilities it checked. */
export const oauthEndpointsSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  revocation_endpoint: z.string().optional(),
  response_types_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});
export type McpOAuthEndpoints = z.infer<typeof oauthEndpointsSchema>;

/** The client Viberr registered as, as the authorization server issued it. */
export const oauthClientSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
  /** RFC 7591: when the secret stops working, in seconds since the epoch; 0
   *  (or absent) is never. A lapsed one is registered again (R-oauth-4). */
  client_secret_expires_at: z.number().optional(),
  token_endpoint_auth_method: z.string().optional(),
  /** The redirect URI it was registered with: a different instance origin
   *  registers again rather than being refused at the consent screen. */
  redirect_uri: z.string(),
});
export type McpOAuthClient = z.infer<typeof oauthClientSchema>;

/** A client secret this close to its expiry is treated as lapsed. */
const CLIENT_SECRET_SKEW_MS = 60_000;

/** Whether a registered client's secret has lapsed (RFC 7591's
 *  `client_secret_expires_at`), so it must not be reused. */
export function clientSecretLapsed(client: McpOAuthClient, now: number = Date.now()): boolean {
  const at = client.client_secret_expires_at;
  return at !== undefined && at > 0 && at * 1000 - CLIENT_SECRET_SKEW_MS <= now;
}

/** Where a server's sign-in happens and what it asks for. */
export interface McpOAuthDiscovery {
  /** The authorization server's URL, as the protected-resource metadata names it. */
  authorizationServer: string;
  /** The RFC 8707 resource indicator, from the protected-resource metadata. */
  resource: string | null;
  /** The scopes the resource advertises, space-joined; null when it names none. */
  scope: string | null;
  endpoints: McpOAuthEndpoints;
}

/** A sign-in refused or failed, with the reason in words an admin can act on. */
export class McpOAuthError extends Error {
  readonly reason: string;
  /** False for a failure worth retrying as is: the authorization server was
   *  unreachable, slow or answered 5xx, so a refresh token may still be good. */
  readonly definitive: boolean;
  /** The authorization server refused the CLIENT Viberr registered as
   *  (`invalid_client`, `unauthorized_client`): the registration is dead. */
  readonly clientRejected: boolean;
  constructor(
    reason: string,
    options: { definitive?: boolean; clientRejected?: boolean; cause?: unknown } = {},
  ) {
    super(reason, { cause: options.cause });
    this.name = "McpOAuthError";
    this.reason = reason;
    this.definitive = options.definitive ?? true;
    this.clientRejected = options.clientRejected ?? false;
  }
}

/**
 * R-oauth-4 (2026-09-25): whether a failure says the registered client itself
 * is dead — the server forgot a dynamically registered client, or its secret
 * lapsed — so it must not be reused for the next sign-in. The SDK's own
 * `auth()` drops client credentials on exactly these two errors.
 */
export function isClientRefusal(cause: unknown): boolean {
  if (cause instanceof McpOAuthError) return cause.clientRejected;
  return cause instanceof InvalidClientError || cause instanceof UnauthorizedClientError;
}

/** `fetch` with a deadline, since the SDK's OAuth helpers set none. */
function timed(fetchImpl: McpFetch | undefined): McpFetch {
  const base = fetchImpl ?? fetch;
  return (url, init) =>
    base(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS) });
}

/**
 * OAuth 2.1 §1.5: every authorization-server endpoint is HTTPS. A loopback
 * `http:` URL is allowed, the way RFC 8252 allows it for redirect URIs, so a
 * server on the same host (and the in-test one) can sign in.
 */
export function isSecureOAuthUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

/** A failure as the words the audit row, the row and the callback page use. */
export function oauthFailureReason(cause: unknown): string {
  if (cause instanceof McpOAuthError) return cause.reason;
  if (cause instanceof OAuthError) {
    const detail = cause.message.trim();
    const words = detail ? `${cause.errorCode}: ${detail}` : cause.errorCode;
    return `the authorization server answered ${clip(words)}`;
  }
  if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
    return "the authorization server did not answer in time";
  }
  // `fetch` rejects with a TypeError for a refused, reset or unresolvable
  // connection; the SDK passes it through.
  if (cause instanceof TypeError) return "the authorization server could not be reached";
  if (cause instanceof z.ZodError) return "the authorization server answered in a shape Viberr does not read";
  return clip(errorMessage(cause));
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

/**
 * Whether a failure means the credential itself is dead (the sign-in has to be
 * done again) rather than that the authorization server could not answer now.
 * An OAuth error response is definitive (`invalid_grant`, `invalid_client`…)
 * except the three that say "later": `server_error`, `temporarily_unavailable`
 * and `too_many_requests`. A network failure or a timeout is not.
 */
export function isDefinitiveRefusal(cause: unknown): boolean {
  if (cause instanceof McpOAuthError) return cause.definitive;
  return (
    cause instanceof OAuthError &&
    !(cause instanceof ServerError) &&
    !(cause instanceof TemporarilyUnavailableError) &&
    !(cause instanceof TooManyRequestsError)
  );
}

/** Replace every secret value in `text` (defence in depth: a reason quoted
 *  from an authorization server is stored, so it must never carry a token). */
export function scrubSecrets(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/**
 * Find where `target` signs in. `resourceMetadataUrl` is the URL the server's
 * own 401 challenge named, when a probe saw one; without it the well-known
 * locations are tried (path-aware first, then the root, as the SDK does).
 */
export async function discoverMcpOAuth(
  target: string,
  options: { resourceMetadataUrl?: string | null; fetchImpl?: McpFetch } = {},
): Promise<McpOAuthDiscovery> {
  const fetchFn = timed(options.fetchImpl);
  let resourceMetadata: Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>> | null = null;
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      target,
      options.resourceMetadataUrl ? { resourceMetadataUrl: options.resourceMetadataUrl } : undefined,
      fetchFn,
    );
  } catch {
    // No RFC 9728 document: the 2025-03-26 MCP spec's fallback, where the
    // server's own origin is its authorization server.
    resourceMetadata = null;
  }
  const authorizationServer =
    resourceMetadata?.authorization_servers?.[0] ?? new URL("/", target).toString();
  let published: Awaited<ReturnType<typeof discoverAuthorizationServerMetadata>>;
  try {
    published = await discoverAuthorizationServerMetadata(authorizationServer, { fetchFn });
  } catch (error) {
    throw new McpOAuthError(
      `its authorization server's metadata could not be read (${oauthFailureReason(error)})`,
      { cause: error },
    );
  }
  if (!published) {
    throw new McpOAuthError(
      "it publishes no OAuth authorization-server metadata, so it cannot be signed in here. Paste a static token instead",
    );
  }
  const endpoints = oauthEndpointsSchema.parse(published);
  if (!endpoints.response_types_supported.includes("code")) {
    throw new McpOAuthError("its authorization server does not offer the authorization-code flow");
  }
  // MCP authorization spec: a client MUST use PKCE and MUST refuse to proceed
  // when the server does not advertise S256.
  if (!endpoints.code_challenge_methods_supported?.includes("S256")) {
    throw new McpOAuthError("its authorization server does not advertise PKCE (S256), which the MCP spec requires");
  }
  for (const [what, url] of [
    ["authorization endpoint", endpoints.authorization_endpoint],
    ["token endpoint", endpoints.token_endpoint],
    ["registration endpoint", endpoints.registration_endpoint],
    ["revocation endpoint", endpoints.revocation_endpoint],
  ] as const) {
    if (url !== undefined && !isSecureOAuthUrl(url)) {
      throw new McpOAuthError(`its ${what} is not an https:// URL (${clip(url)})`);
    }
  }
  let resource: string | null = null;
  if (resourceMetadata) {
    const allowed = checkResourceAllowed({
      requestedResource: resourceUrlFromServerUrl(target),
      configuredResource: resourceMetadata.resource,
    });
    if (!allowed) {
      throw new McpOAuthError(
        `its protected-resource metadata names ${clip(resourceMetadata.resource)}, which is not this endpoint`,
      );
    }
    resource = resourceMetadata.resource;
  }
  const scopes = resourceMetadata?.scopes_supported ?? [];
  return {
    authorizationServer,
    resource,
    scope: scopes.length > 0 ? scopes.join(" ") : null,
    endpoints,
  };
}

/** RFC 7591: register Viberr as a client of the server's authorization server. */
export async function registerMcpOAuthClient(
  discovery: McpOAuthDiscovery,
  redirectUri: string,
  fetchImpl?: McpFetch,
): Promise<McpOAuthClient> {
  if (!discovery.endpoints.registration_endpoint) {
    throw new McpOAuthError(
      "its authorization server offers no dynamic client registration, so Viberr cannot register itself. Paste a static token instead",
    );
  }
  try {
    const full = await registerClient(discovery.authorizationServer, {
      metadata: discovery.endpoints,
      clientMetadata: {
        client_name: "Viberr",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      scope: discovery.scope ?? undefined,
      fetchFn: timed(fetchImpl),
    });
    const client: McpOAuthClient = { client_id: full.client_id, redirect_uri: redirectUri };
    if (full.client_secret) client.client_secret = full.client_secret;
    if (full.client_secret_expires_at !== undefined) client.client_secret_expires_at = full.client_secret_expires_at;
    if (full.token_endpoint_auth_method) client.token_endpoint_auth_method = full.token_endpoint_auth_method;
    return client;
  } catch (error) {
    throw new McpOAuthError(`client registration failed: ${oauthFailureReason(error)}`, { cause: error });
  }
}

/** The authorization-code request with a fresh PKCE pair (S256). */
export async function authorizationRequest(
  discovery: McpOAuthDiscovery,
  client: McpOAuthClient,
  state: string,
): Promise<{ authorizationUrl: string; codeVerifier: string }> {
  const { authorizationUrl, codeVerifier } = await startAuthorization(discovery.authorizationServer, {
    metadata: discovery.endpoints,
    clientInformation: client,
    redirectUrl: client.redirect_uri,
    scope: discovery.scope ?? undefined,
    state,
    resource: discovery.resource ? new URL(discovery.resource) : undefined,
  });
  return { authorizationUrl: authorizationUrl.toString(), codeVerifier };
}

/** Exchange the code the callback carried for tokens. */
export async function exchangeMcpOAuthCode(
  discovery: McpOAuthDiscovery,
  client: McpOAuthClient,
  code: string,
  codeVerifier: string,
  fetchImpl?: McpFetch,
): Promise<OAuthTokens> {
  try {
    return await exchangeAuthorization(discovery.authorizationServer, {
      metadata: discovery.endpoints,
      clientInformation: client,
      authorizationCode: code,
      codeVerifier,
      redirectUri: client.redirect_uri,
      resource: discovery.resource ? new URL(discovery.resource) : undefined,
      fetchFn: timed(fetchImpl),
    });
  } catch (error) {
    throw new McpOAuthError(`the code exchange failed: ${oauthFailureReason(error)}`, {
      definitive: isDefinitiveRefusal(error),
      clientRejected: isClientRefusal(error),
      cause: error,
    });
  }
}

/** A refresh grant; the SDK keeps the old refresh token when none is re-issued. */
export async function refreshMcpOAuthTokens(
  discovery: McpOAuthDiscovery,
  client: McpOAuthClient,
  refreshToken: string,
  fetchImpl?: McpFetch,
): Promise<OAuthTokens> {
  try {
    return await refreshAuthorization(discovery.authorizationServer, {
      metadata: discovery.endpoints,
      clientInformation: client,
      refreshToken,
      resource: discovery.resource ? new URL(discovery.resource) : undefined,
      fetchFn: timed(fetchImpl),
    });
  } catch (error) {
    throw new McpOAuthError(oauthFailureReason(error), {
      definitive: isDefinitiveRefusal(error),
      clientRejected: isClientRefusal(error),
      cause: error,
    });
  }
}

/**
 * RFC 7009 revocation, when the server offers it. True when the server
 * accepted it; false when it offers no endpoint. A failure throws.
 */
export async function revokeMcpOAuthToken(
  discovery: McpOAuthDiscovery,
  client: McpOAuthClient,
  token: string,
  hint: "refresh_token" | "access_token",
  fetchImpl?: McpFetch,
): Promise<boolean> {
  const endpoint = discovery.endpoints.revocation_endpoint;
  if (!endpoint) return false;
  const body = new URLSearchParams({ token, token_type_hint: hint });
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  // The client authenticates as it registered: HTTP Basic for a secret
  // unless it registered for the body, the id alone for a public client.
  if (client.client_secret && client.token_endpoint_auth_method !== "client_secret_post") {
    headers.set("Authorization", `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}`);
  } else {
    body.set("client_id", client.client_id);
    if (client.client_secret) body.set("client_secret", client.client_secret);
  }
  let res: Response;
  try {
    res = await timed(fetchImpl)(endpoint, { method: "POST", headers, body });
  } catch (error) {
    throw new McpOAuthError(`revocation failed: ${oauthFailureReason(error)}`, { cause: error });
  }
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) throw new McpOAuthError(`revocation failed: the server answered ${res.status}`);
  return true;
}
