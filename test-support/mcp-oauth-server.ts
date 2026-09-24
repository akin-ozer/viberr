import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  completeMcpOAuthSignIn,
  startMcpOAuthSignIn,
  type CompleteMcpOAuthResult,
} from "~/server/org/mcp-oauth.server";
import { fixtureServer, listen } from "./mcp-upstream";

/**
 * Ruling 469: an in-test MCP server that signs in with OAuth, the shape of the
 * Cloudflare API MCP server (`https://mcp.cloudflare.com/mcp`, measured
 * 2026-09-24): the MCP endpoint answers 401 with `WWW-Authenticate: Bearer
 * realm="OAuth", resource_metadata="…/.well-known/oauth-protected-resource/mcp"`,
 * the protected-resource metadata names the authorization server on the same
 * origin, and that server offers dynamic client registration (RFC 7591), the
 * authorization-code grant with PKCE S256 only, refresh tokens and revocation.
 *
 * Everything a test needs to break is a switch on `options`; everything it
 * needs to assert on is recorded, including every token it ever issued, so a
 * test can search logs, audit rows and views for them.
 */

export interface OAuthServerOptions {
  /** `expires_in` of the next access token issued. */
  accessTokenTtlSec: number;
  /** Whether the token endpoint issues refresh tokens. */
  issueRefreshToken: boolean;
  /** How the next refresh grant is answered. */
  refresh: "ok" | "invalid_grant" | "server_error";
  /** The consent screen's answer: approve, or the user said no. */
  consent: "approve" | "deny";
  /** Whether the metadata advertises a registration endpoint. */
  registration: boolean;
  /** Whether the metadata advertises PKCE S256. */
  pkce: boolean;
  /** RFC 7591 `client_secret_expires_at` on the next registration (seconds
   *  since the epoch); null leaves it out. Recorded, not enforced. */
  clientSecretExpiresAt: number | null;
}

export interface OAuthRegistration {
  clientId: string;
  clientSecret: string | null;
  redirectUris: string[];
  authMethod: string;
}

export interface OAuthMcpServerHandle {
  origin: string;
  /** The protected MCP endpoint, what an admin registers. */
  url: string;
  options: OAuthServerOptions;
  /** Tool names the MCP endpoint served. */
  calls: string[];
  /** Every Authorization header the MCP endpoint was sent, in order. */
  authorizations: (string | null)[];
  registrations: OAuthRegistration[];
  /** Every `/authorize` request's query, as the browser sent it. */
  authorizeRequests: URLSearchParams[];
  /** Every token-endpoint request: its grant and how it was answered. */
  tokenRequests: { grant: string; answered: string }[];
  /** Tokens the revocation endpoint was sent. */
  revoked: string[];
  /** Every secret this server ever issued: codes, access and refresh tokens,
   *  client secrets. A test serializes what Viberr stored or said and looks
   *  for each of these in it. */
  issuedSecrets(): string[];
  /** The live access tokens stop working (the next MCP call is a 401), the
   *  way a server-side revocation or a rotated signing key looks upstream. */
  invalidateAccessTokens(): void;
  /** The server forgets every client it registered (a store reset, a GC of
   *  dynamically registered clients): the token endpoint then answers
   *  `invalid_client` and the authorization endpoint refuses the id. */
  forgetClients(): void;
  /** Every registered client's secret changes, the way a lapsed secret
   *  looks: the client id still opens the consent screen, and the token
   *  endpoint answers the old secret `invalid_client`. */
  rotateClientSecrets(): void;
  close(): Promise<void>;
}

const DEFAULTS: OAuthServerOptions = {
  accessTokenTtlSec: 3600,
  issueRefreshToken: true,
  refresh: "ok",
  consent: "approve",
  registration: true,
  pkce: true,
  clientSecretExpiresAt: null,
};

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string | null;
}

const registrationBody = z.object({
  redirect_uris: z.array(z.string()),
  token_endpoint_auth_method: z.string().optional(),
  client_name: z.string().optional(),
});

/** A token endpoint's success reply (RFC 6749 §5.1). */
interface TokenReply {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
}

/** An OAuth error reply (RFC 6749 §5.2). */
interface ErrorReply {
  error: string;
  error_description?: string;
}

/** RFC 8414 metadata, as much of it as this server publishes. */
interface AuthorizationServerDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  registration_endpoint?: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported?: string[];
}

/** RFC 7591 registration reply. */
interface RegistrationReply {
  client_id: string;
  client_secret?: string;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
}

function token(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

/** Answer with an already serialized JSON document. */
function sendJson(res: ServerResponse, status: number, json: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

export async function startOAuthMcpServer(
  overrides: Partial<OAuthServerOptions> = {},
): Promise<OAuthMcpServerHandle> {
  const options: OAuthServerOptions = { ...DEFAULTS, ...overrides };
  const calls: string[] = [];
  const authorizations: (string | null)[] = [];
  const registrations: OAuthRegistration[] = [];
  const authorizeRequests: URLSearchParams[] = [];
  const tokenRequests: { grant: string; answered: string }[] = [];
  const revoked: string[] = [];
  const issued: string[] = [];
  const codes = new Map<string, PendingCode>();
  /** access token → the client it was issued to. */
  const accessTokens = new Map<string, string>();
  /** refresh token → the client it was issued to. */
  const refreshTokens = new Map<string, string>();
  let origin = "";

  const resourceUrl = () => `${origin}/mcp`;
  const metadataUrl = () => `${origin}/.well-known/oauth-protected-resource/mcp`;

  /** RFC 6749 §2.3.1: the client authenticates as it registered. */
  const authenticateClient = (req: IncomingMessage, form: URLSearchParams): OAuthRegistration | null => {
    const basic = /^Basic\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    let clientId = form.get("client_id");
    let secret = form.get("client_secret");
    if (basic?.[1]) {
      const [id, pass] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
      clientId = id ?? null;
      secret = pass ?? null;
    }
    const client = registrations.find((r) => r.clientId === clientId);
    if (!client) return null;
    if (client.clientSecret !== null && client.clientSecret !== secret) return null;
    return client;
  };

  const issueTokens = (clientId: string): TokenReply => {
    const access = token("at");
    accessTokens.set(access, clientId);
    issued.push(access);
    const body: TokenReply = {
      access_token: access,
      token_type: "Bearer",
      expires_in: options.accessTokenTtlSec,
    };
    if (options.issueRefreshToken) {
      const refresh = token("rt");
      refreshTokens.set(refresh, clientId);
      issued.push(refresh);
      body.refresh_token = refresh;
    }
    return body;
  };

  const server = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      sendJson(
        res,
        200,
        JSON.stringify({
          resource: resourceUrl(),
          authorization_servers: [origin],
          bearer_methods_supported: ["header"],
        }),
      );
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      const metadata: AuthorizationServerDocument = {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        revocation_endpoint: `${origin}/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      };
      if (options.registration) metadata.registration_endpoint = `${origin}/register`;
      if (options.pkce) metadata.code_challenge_methods_supported = ["S256"];
      sendJson(res, 200, JSON.stringify(metadata));
      return;
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const parsed = registrationBody.safeParse(JSON.parse(await readBody(req)));
      if (!parsed.success || parsed.data.redirect_uris.length === 0) {
        sendJson(res, 400, JSON.stringify({ error: "invalid_client_metadata" } satisfies ErrorReply));
        return;
      }
      const authMethod = parsed.data.token_endpoint_auth_method ?? "client_secret_basic";
      const client: OAuthRegistration = {
        clientId: token("client"),
        clientSecret: authMethod === "none" ? null : token("cs"),
        redirectUris: parsed.data.redirect_uris,
        authMethod,
      };
      if (client.clientSecret) issued.push(client.clientSecret);
      registrations.push(client);
      const reply: RegistrationReply = {
        client_id: client.clientId,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: authMethod,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
      if (client.clientSecret) reply.client_secret = client.clientSecret;
      if (options.clientSecretExpiresAt !== null) reply.client_secret_expires_at = options.clientSecretExpiresAt;
      sendJson(res, 201, JSON.stringify(reply));
      return;
    }
    if (url.pathname === "/authorize" && req.method === "GET") {
      const q = url.searchParams;
      authorizeRequests.push(q);
      const client = registrations.find((r) => r.clientId === q.get("client_id"));
      const redirectUri = q.get("redirect_uri") ?? "";
      if (!client || !client.redirectUris.includes(redirectUri)) {
        const refusal: ErrorReply = { error: "invalid_request", error_description: "unknown client or redirect_uri" };
        sendJson(res, 400, JSON.stringify(refusal));
        return;
      }
      const back = new URL(redirectUri);
      const state = q.get("state");
      if (state !== null) back.searchParams.set("state", state);
      if (options.consent === "deny") {
        back.searchParams.set("error", "access_denied");
        back.searchParams.set("error_description", "The user declined.");
      } else if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
        back.searchParams.set("error", "invalid_request");
      } else {
        const code = token("code");
        issued.push(code);
        codes.set(code, {
          clientId: client.clientId,
          redirectUri,
          challenge: q.get("code_challenge") ?? "",
          resource: q.get("resource"),
        });
        back.searchParams.set("code", code);
      }
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const grant = form.get("grant_type") ?? "";
      const answer = (status: number, body: TokenReply | ErrorReply) => {
        tokenRequests.push({ grant, answered: "error" in body ? body.error : "tokens" });
        sendJson(res, status, JSON.stringify(body));
      };
      const client = authenticateClient(req, form);
      if (!client) {
        answer(401, { error: "invalid_client" });
        return;
      }
      if (grant === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (
          !code ||
          code.clientId !== client.clientId ||
          code.redirectUri !== form.get("redirect_uri") ||
          code.challenge !== challenge ||
          code.resource !== form.get("resource")
        ) {
          answer(400, { error: "invalid_grant" });
          return;
        }
        answer(200, issueTokens(client.clientId));
        return;
      }
      if (grant === "refresh_token") {
        const presented = form.get("refresh_token") ?? "";
        if (options.refresh === "server_error") {
          answer(503, { error: "temporarily_unavailable" });
          return;
        }
        if (options.refresh === "invalid_grant" || refreshTokens.get(presented) !== client.clientId) {
          answer(400, { error: "invalid_grant", error_description: "The refresh token is no longer valid." });
          return;
        }
        // Rotation: the presented refresh token is spent.
        refreshTokens.delete(presented);
        answer(200, issueTokens(client.clientId));
        return;
      }
      answer(400, { error: "unsupported_grant_type" });
      return;
    }
    if (url.pathname === "/revoke" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const presented = form.get("token") ?? "";
      revoked.push(presented);
      accessTokens.delete(presented);
      refreshTokens.delete(presented);
      res.writeHead(200);
      res.end();
      return;
    }
    if (url.pathname === "/mcp") {
      const header = req.headers.authorization ?? null;
      authorizations.push(header);
      const bearer = /^Bearer\s+(\S+)$/.exec(header ?? "")?.[1];
      if (!bearer || !accessTokens.has(bearer)) {
        const error = bearer ? ', error="invalid_token"' : "";
        sendJson(
          res,
          401,
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }),
          { "www-authenticate": `Bearer realm="OAuth", resource_metadata="${metadataUrl()}"${error}` },
        );
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
      return;
    }
    res.writeHead(404);
    res.end();
  });
  origin = `http://127.0.0.1:${server.port}`;

  return {
    origin,
    url: resourceUrl(),
    options,
    calls,
    authorizations,
    registrations,
    authorizeRequests,
    tokenRequests,
    revoked,
    issuedSecrets: () => [...issued],
    invalidateAccessTokens: () => accessTokens.clear(),
    forgetClients: () => {
      registrations.length = 0;
    },
    rotateClientSecrets: () => {
      for (const client of registrations) {
        if (client.clientSecret === null) continue;
        client.clientSecret = token("cs");
        issued.push(client.clientSecret);
      }
    },
    close: server.close,
  };
}

/** The admin session the server-level sign-in helpers act as. */
export const TEST_OAUTH_ADMIN = {
  userId: "usr_arda",
  sessionId: "ses_arda",
  actor: { userId: "usr_arda", label: "arda@viberr.dev" },
};

/**
 * A whole sign-in at the registry level: start it, consent at the in-test
 * authorization server, and hand the callback's query to the completion.
 */
export async function signInWithOAuth(
  db: DatabaseSync,
  mcpId: string,
  redirectUri = "http://localhost:5173/resources/mcp-oauth/callback",
): Promise<CompleteMcpOAuthResult> {
  const started = await startMcpOAuthSignIn(db, {
    mcpId,
    redirectUri,
    userId: TEST_OAUTH_ADMIN.userId,
    sessionId: TEST_OAUTH_ADMIN.sessionId,
    actor: TEST_OAUTH_ADMIN.actor,
  });
  const back = await consentAt(started.authorizationUrl);
  return completeMcpOAuthSignIn(db, {
    state: back.searchParams.get("state"),
    code: back.searchParams.get("code"),
    error: back.searchParams.get("error"),
    errorDescription: back.searchParams.get("error_description"),
    userId: TEST_OAUTH_ADMIN.userId,
    sessionId: TEST_OAUTH_ADMIN.sessionId,
    actor: TEST_OAUTH_ADMIN.actor,
  });
}

/**
 * The browser's half of a sign-in: open the authorization URL, let the
 * in-test consent screen answer, and hand back where it redirects (the
 * instance's callback with `code` and `state`).
 */
export async function consentAt(authorizationUrl: string): Promise<URL> {
  const res = await fetch(authorizationUrl, { redirect: "manual" });
  const location = res.headers.get("location");
  if (res.status !== 302 || !location) {
    throw new Error(`the authorization endpoint answered ${res.status}: ${await res.text()}`);
  }
  return new URL(location);
}
