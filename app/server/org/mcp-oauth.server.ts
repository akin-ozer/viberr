import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import {
  recordAudit,
  SYSTEM_ACTOR,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { appOrigin } from "~/server/config/env.server";
import { AppError } from "~/server/errors/app-error.server";
import { logger } from "~/server/logging/logger.server";
import {
  authorizationRequest,
  clientSecretLapsed,
  discoverMcpOAuth,
  exchangeMcpOAuthCode,
  isClientRefusal,
  isDefinitiveRefusal,
  isSecureOAuthUrl,
  oauthClientSchema,
  oauthEndpointsSchema,
  oauthFailureReason,
  refreshMcpOAuthTokens,
  registerMcpOAuthClient,
  revokeMcpOAuthToken,
  scrubSecrets,
  type McpOAuthClient,
  type McpOAuthDiscovery,
} from "~/server/mcp-proxy/oauth-client.server";
import {
  OAUTH_NEEDS_SIGN_IN,
  OAUTH_SIGN_IN_EXPIRED,
  UpstreamConnectError,
  UpstreamEndpointChanged,
  type McpFetch,
  type UpstreamTokenSource,
} from "~/server/mcp-proxy/upstream.server";
import {
  isSecretBox,
  openSecretRotating,
  sealSecret,
} from "~/server/secrets/secret-box.server";
import { MCP_OAUTH_STATUSES, type McpOAuthView } from "~/shared/mcp-oauth";
import { toError } from "~/shared/errors";
import { publishResourceUpdated } from "./resource-events.server";

/**
 * Ruling 469: an org admin signs an HTTP MCP connection in with OAuth, and the
 * tokens live only in this server.
 *
 * Two columns on `org_mcp_servers` carry it. `oauth_ref` is a secret-box
 * (the same AES-256-GCM box as `cred_ref`, rotated with it) around the sealed
 * half: the authorization server's endpoints, the client Viberr registered as
 * (its secret, when one was issued) and the tokens. `oauth_json` is the public
 * half every surface reads without opening a box: the status, when the access
 * token expires, whether it renews, the issuer's host, the challenge's
 * metadata URL, the scope the server granted (ruling 486: not a secret, and
 * the one thing that says whether a run may write through the connection)
 * and, once a sign-in expires, why. Nothing here logs, audits or
 * publishes a token, a code, a verifier or a client secret, and a reason quoted
 * from an authorization server is scrubbed of every one of them before it is
 * stored.
 *
 * The flow: `startMcpOAuthSignIn` discovers, registers (or reuses the client
 * already registered for this endpoint and redirect URI) and returns the
 * authorization URL, keeping the PKCE verifier in memory under the SHA-256 of
 * a random `state` bound to the admin's session; `completeMcpOAuthSignIn` is
 * the callback's half, which spends that state once, checks it belongs to the
 * same session, exchanges the code and seals the tokens (dropping a static
 * credential: a connection holds one). `mcpOAuthTokenSource` is what the
 * ruling-461 gateway and the health probe attach upstream: it renews the
 * access token when it has run out, and once after a 401, and re-seals what
 * comes back; a refusal it cannot renew ends the sign-in ("sign-in expired").
 * `signOutMcpOAuth` revokes upstream when the server offers it and drops the
 * sealed half.
 *
 * Imports nothing of `resources.server.ts`, which imports this.
 */

/** How long a started sign-in waits for its callback. */
export const MCP_OAUTH_PENDING_TTL_MS = 10 * 60_000;

/** Where the authorization server sends the browser back (`app/routes.ts`). */
export const MCP_OAUTH_CALLBACK_PATH = "/resources/mcp-oauth/callback";

/**
 * The redirect URI this instance registers and sends: its public origin as
 * better-auth derives its own OAuth callbacks — `BETTER_AUTH_URL` when set
 * (required behind a reverse proxy, where the request's own origin is the
 * proxy's upstream), else the origin the request arrived on, which is also
 * how the Sign-in & SSO card computes the callback it shows (R19-16).
 */
export function mcpOAuthRedirectUri(request: Request): string {
  return `${appOrigin() ?? new URL(request.url).origin}${MCP_OAUTH_CALLBACK_PATH}`;
}

/** A token this close to its expiry is renewed before it is sent. */
const EXPIRY_SKEW_MS = 60_000;

const storedTokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  token_type: z.string(),
  scope: z.string().optional(),
  /** ISO; null when the server gave no `expires_in`. */
  expires_at: z.string().nullable(),
});
type StoredTokens = z.infer<typeof storedTokensSchema>;

/** The sealed half. */
const sealedOAuthSchema = z.object({
  v: z.literal(1),
  /** The endpoint the sign-in is for: a token is sent to no other. */
  target: z.string(),
  authorizationServer: z.string(),
  resource: z.string().nullable(),
  scope: z.string().nullable(),
  endpoints: oauthEndpointsSchema,
  client: oauthClientSchema,
  tokens: storedTokensSchema.nullable(),
});
type SealedOAuth = z.infer<typeof sealedOAuthSchema>;

/** The public half, read tolerantly: a field that no longer parses reads as
 *  absent rather than failing every Settings render. */
const publicOAuthSchema = z.object({
  status: z.enum(MCP_OAUTH_STATUSES),
  expiresAt: z.string().nullable().catch(null),
  renews: z.boolean().catch(false),
  issuer: z.string().nullable().catch(null),
  resourceMetadataUrl: z.string().nullable().catch(null),
  reason: z.string().nullable().catch(null),
  /** Ruling 486: the granted scope; absent on a row written before it. */
  scope: z.string().nullable().catch(null),
});
type PublicOAuth = z.infer<typeof publicOAuthSchema>;

function readPublic(raw: string | null): PublicOAuth | null {
  if (raw === null) return null;
  try {
    const parsed = publicOAuthSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The view of a row's `oauth_json` (`McpView.oauth`); null for a connection
 *  that is not an OAuth one. */
export function mcpOAuthView(raw: string | null): McpOAuthView | null {
  const pub = readPublic(raw);
  if (!pub) return null;
  return {
    status: pub.status,
    expiresAt: pub.expiresAt,
    renews: pub.renews,
    issuer: pub.issuer,
    reason: pub.reason,
    scope: pub.scope,
  };
}

interface OAuthRow {
  id: string;
  name: string;
  transport: string;
  target: string;
  cred_ref: string | null;
  oauth_ref: string | null;
  oauth_json: string | null;
  /** Ruling 486(c): the scope the admin asked the next sign-in for. */
  oauth_requested_scope: string | null;
}

const ROW_SQL = `SELECT id, name, transport, target, cred_ref, oauth_ref, oauth_json, oauth_requested_scope FROM org_mcp_servers`;

function rowById(db: DatabaseSync, id: string): OAuthRow | null {
  // SAFETY: `ROW_SQL` selects exactly the eight `org_mcp_servers` columns
  // `OAuthRow` declares (0001_baseline.sql): id/name/transport/target NOT NULL
  // TEXT, the other four nullable TEXT.
  return (db.prepare(`${ROW_SQL} WHERE id = ?`).get(id) as OAuthRow | undefined) ?? null;
}

type OpenedOAuth =
  | { state: "none" }
  | { state: "ok"; sealed: SealedOAuth }
  | { state: "unreadable"; reason: string };

const UNREADABLE_REASON =
  "its stored OAuth sign-in cannot be decrypted (the secret-encryption key changed). Set VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS to the old key, or sign it in again in Instance settings → Agent resources";

/** Open a row's sealed half, re-sealing it under the current key when it
 *  opened under a retired one (the lazy rotation `cred_ref` gets). */
function openOAuth(db: DatabaseSync, row: OAuthRow): OpenedOAuth {
  if (!row.oauth_ref) return { state: "none" };
  if (!isSecretBox(row.oauth_ref)) return { state: "unreadable", reason: UNREADABLE_REASON };
  try {
    const opened = openSecretRotating(row.oauth_ref);
    const parsed = sealedOAuthSchema.safeParse(JSON.parse(opened.plaintext));
    if (!parsed.success) return { state: "unreadable", reason: UNREADABLE_REASON };
    if (opened.staleKey) {
      db.prepare(`UPDATE org_mcp_servers SET oauth_ref = ? WHERE id = ?`).run(
        sealSecret(opened.plaintext),
        row.id,
      );
      logger.info("re-sealed an MCP OAuth sign-in under the current encryption key", { mcp: row.name });
    }
    return { state: "ok", sealed: parsed.data };
  } catch (error) {
    logger.error("mcp oauth sign-in failed to decrypt under every configured key", {
      mcp: row.name,
      err: toError(error),
    });
    return { state: "unreadable", reason: UNREADABLE_REASON };
  }
}

function writeOAuth(db: DatabaseSync, id: string, sealed: SealedOAuth | null, pub: PublicOAuth | null): void {
  db.prepare(`UPDATE org_mcp_servers SET oauth_ref = ?, oauth_json = ?, updated_at = ? WHERE id = ?`).run(
    sealed ? sealSecret(JSON.stringify(sealed)) : null,
    pub ? JSON.stringify(pub) : null,
    new Date().toISOString(),
    id,
  );
}

function discoveryOf(sealed: SealedOAuth): McpOAuthDiscovery {
  return {
    authorizationServer: sealed.authorizationServer,
    resource: sealed.resource,
    scope: sealed.scope,
    endpoints: sealed.endpoints,
  };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function storedTokens(tokens: OAuthTokens, now: number = Date.now()): StoredTokens {
  const stored: StoredTokens = {
    access_token: tokens.access_token,
    token_type: tokens.token_type,
    expires_at:
      tokens.expires_in !== undefined && Number.isFinite(tokens.expires_in)
        ? new Date(now + tokens.expires_in * 1000).toISOString()
        : null,
  };
  if (tokens.refresh_token) stored.refresh_token = tokens.refresh_token;
  if (tokens.scope) stored.scope = tokens.scope;
  return stored;
}

/**
 * The public half of a sign-in that holds tokens. `scope` is what the token
 * reply granted (ruling 486); a reply that names none granted `granted`
 * (RFC 6749: the scope asked for on a code exchange, and the scope already
 * held on a refresh, §5.1 and §6).
 */
function signedInPublic(
  sealed: SealedOAuth,
  tokens: StoredTokens,
  previous: PublicOAuth | null,
  granted: string | null,
): PublicOAuth {
  return {
    status: "signed_in",
    expiresAt: tokens.expires_at,
    renews: Boolean(tokens.refresh_token),
    issuer: hostOf(sealed.authorizationServer),
    resourceMetadataUrl: previous?.resourceMetadataUrl ?? null,
    reason: null,
    scope: tokens.scope ?? granted,
  };
}

/** Every secret a sealed half holds, for `scrubSecrets`. */
function secretsOf(sealed: SealedOAuth | null, ...more: (string | null | undefined)[]): (string | undefined | null)[] {
  return [
    sealed?.tokens?.access_token,
    sealed?.tokens?.refresh_token,
    sealed?.client.client_secret,
    ...more,
  ];
}

function auditFailure(
  db: DatabaseSync,
  row: Pick<OAuthRow, "id" | "name">,
  actor: AuditActor,
  stage: "discovery" | "registration" | "authorization" | "state" | "token" | "refresh",
  reason: string,
): void {
  recordAudit(db, {
    action: "org.mcp.oauth_failed",
    actor,
    subjectKind: "org_mcp",
    subjectId: row.id,
    details: { name: row.name, stage, reason },
  });
}

// ------------------------------------------------------------ credential state

/** What a row's OAuth columns yield for a run, the gateway and a probe. */
export type McpOAuthCredential =
  /** Not an OAuth connection. */
  | { state: "none" }
  /** Signed in: the gateway attaches the token (`mcpOAuthTokenSource`). */
  | { state: "signed_in" }
  /** Asks for a sign-in it does not have, or its sign-in expired. */
  | { state: "signed_out"; reason: string }
  | { state: "unreadable"; reason: string };

export function mcpOAuthCredential(db: DatabaseSync, id: string): McpOAuthCredential {
  const row = rowById(db, id);
  if (!row) return { state: "none" };
  const opened = openOAuth(db, row);
  if (opened.state === "unreadable") return opened;
  if (opened.state === "ok" && opened.sealed.tokens && opened.sealed.target === row.target) {
    return { state: "signed_in" };
  }
  const pub = readPublic(row.oauth_json);
  if (pub?.status === "expired") return { state: "signed_out", reason: OAUTH_SIGN_IN_EXPIRED };
  if (pub) return { state: "signed_out", reason: OAUTH_NEEDS_SIGN_IN };
  return { state: "none" };
}

/**
 * A probe with no credential met the MCP authorization challenge: the row now
 * reads "needs sign-in" (an expired sign-in keeps saying so), and the sign-in
 * will start from the metadata URL the challenge named.
 */
export function recordMcpOAuthChallenge(db: DatabaseSync, id: string, resourceMetadataUrl: string): void {
  const row = rowById(db, id);
  if (!row) return;
  const pub = readPublic(row.oauth_json);
  if (pub?.status === "signed_in") return;
  const next: PublicOAuth = {
    status: pub?.status === "expired" ? "expired" : "needs_sign_in",
    expiresAt: null,
    renews: false,
    issuer: pub?.issuer ?? null,
    resourceMetadataUrl,
    reason: pub?.reason ?? null,
    scope: null,
  };
  if (JSON.stringify(next) === JSON.stringify(pub)) return;
  db.prepare(`UPDATE org_mcp_servers SET oauth_json = ? WHERE id = ?`).run(JSON.stringify(next), id);
}

/** A probe with no credential got in: the server asks for no sign-in (any
 *  more), so a "needs sign-in" left from an earlier probe is dropped. */
export function clearMcpOAuthChallenge(db: DatabaseSync, id: string): void {
  const row = rowById(db, id);
  const pub = row ? readPublic(row.oauth_json) : null;
  if (!row || !pub || pub.status === "signed_in") return;
  db.prepare(`UPDATE org_mcp_servers SET oauth_json = NULL WHERE id = ?`).run(id);
}

// ------------------------------------------------------------ sign-in

interface PendingSignIn {
  mcpId: string;
  name: string;
  target: string;
  userId: string;
  sessionId: string;
  codeVerifier: string;
  discovery: McpOAuthDiscovery;
  client: McpOAuthClient;
  expiresAt: number;
}

const PENDING_KEY = Symbol.for("viberr.mcpOAuthPending");

/** state hash → the sign-in it opens. On `globalThis`, like the gateway's
 *  state, so a dev reload does not strand a sign-in in flight. */
function pending(): Map<string, PendingSignIn> {
  const cache: Record<symbol, Map<string, PendingSignIn> | undefined> = globalThis;
  let map = cache[PENDING_KEY];
  if (!map) {
    map = new Map();
    cache[PENDING_KEY] = map;
  }
  return map;
}

function stateKey(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/** Test-only: forget every sign-in in flight. */
export function resetMcpOAuthForTests(): void {
  pending().clear();
}

export interface StartMcpOAuthInput {
  mcpId: string;
  /** `<the instance's own origin>/resources/mcp-oauth/callback`. */
  redirectUri: string;
  /** The admin's session: the callback must arrive in the same one. */
  userId: string;
  sessionId: string;
  actor: AuditActor;
  fetchImpl?: McpFetch;
}

/**
 * Discover, register (or reuse the client this endpoint and redirect URI
 * already registered) and return the authorization URL the admin's browser
 * opens. Writes nothing to the row: a sign-in that is abandoned leaves the
 * connection as it was, and a sign-in already held keeps working until the
 * new one lands.
 */
export async function startMcpOAuthSignIn(
  db: DatabaseSync,
  input: StartMcpOAuthInput,
): Promise<{ authorizationUrl: string; issuer: string | null }> {
  const row = rowById(db, input.mcpId);
  if (!row) throw AppError.notFound("No such MCP server.");
  if (row.transport !== "HTTP") {
    throw AppError.validation(`${row.name} is a stdio command. Only an HTTP server signs in with OAuth.`);
  }
  if (!isSecureOAuthUrl(row.target)) {
    throw AppError.validation(
      `${row.name} is not an https:// endpoint, so a token sent to it would travel in the clear. Only an https:// server (or one on this host) signs in with OAuth.`,
    );
  }
  const opened = openOAuth(db, row);
  const refuse = (stage: "discovery" | "registration" | "authorization", said: string): never => {
    const reason = scrubSecrets(said, secretsOf(opened.state === "ok" ? opened.sealed : null));
    auditFailure(db, row, input.actor, stage, reason);
    logger.warn("mcp oauth sign-in could not start", { mcp: row.name, stage, reason });
    throw AppError.validation(`${row.name} cannot be signed in: ${reason}.`);
  };
  let discovery: McpOAuthDiscovery;
  try {
    discovery = await discoverMcpOAuth(row.target, {
      resourceMetadataUrl: readPublic(row.oauth_json)?.resourceMetadataUrl ?? null,
      fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    return refuse("discovery", oauthFailureReason(error));
  }
  // Ruling 486(c): the scope the admin asked for, when there is one, is what
  // the authorization request (and a registration) sends; else the scopes
  // the resource advertises, as before. The server decides what it grants.
  if (row.oauth_requested_scope) discovery = { ...discovery, scope: row.oauth_requested_scope };
  // A client whose secret has lapsed is registered again, not reused
  // (R-oauth-4); one the server refused is no longer stored at all.
  const known =
    opened.state === "ok" &&
    opened.sealed.target === row.target &&
    opened.sealed.authorizationServer === discovery.authorizationServer &&
    opened.sealed.client.redirect_uri === input.redirectUri &&
    !clientSecretLapsed(opened.sealed.client)
      ? opened.sealed.client
      : null;
  let client: McpOAuthClient;
  try {
    client = known ?? (await registerMcpOAuthClient(discovery, input.redirectUri, input.fetchImpl));
  } catch (error) {
    return refuse("registration", oauthFailureReason(error));
  }
  const state = randomBytes(32).toString("base64url");
  let request: { authorizationUrl: string; codeVerifier: string };
  try {
    request = await authorizationRequest(discovery, client, state);
  } catch (error) {
    return refuse("authorization", oauthFailureReason(error));
  }
  const now = Date.now();
  const inFlight = pending();
  for (const [key, entry] of inFlight) if (entry.expiresAt <= now) inFlight.delete(key);
  inFlight.set(stateKey(state), {
    mcpId: row.id,
    name: row.name,
    target: row.target,
    userId: input.userId,
    sessionId: input.sessionId,
    codeVerifier: request.codeVerifier,
    discovery,
    client,
    expiresAt: now + MCP_OAUTH_PENDING_TTL_MS,
  });
  logger.info("mcp oauth sign-in started", { mcp: row.name, issuer: hostOf(discovery.authorizationServer) });
  return { authorizationUrl: request.authorizationUrl, issuer: hostOf(discovery.authorizationServer) };
}

/**
 * R-oauth-4 (2026-09-25): the authorization server refused the client a
 * row's sealed half holds (`invalid_client`, `unauthorized_client` — it forgot
 * a dynamically registered client, or the secret lapsed). Kept, every later
 * sign-in reused the dead id and failed the same way until someone happened
 * to sign out. The sealed half goes, so the next sign-in registers again, and
 * the row reads "sign-in expired" with the server's words: a sign-in riding
 * on that client is dead with it. Nothing happens when the row holds another
 * client by now.
 */
function forgetRefusedClient(db: DatabaseSync, id: string, clientId: string, reason: string): void {
  const row = rowById(db, id);
  const opened = row ? openOAuth(db, row) : null;
  if (!row || opened?.state !== "ok" || opened.sealed.client.client_id !== clientId) return;
  const scrubbed = scrubSecrets(reason, secretsOf(opened.sealed));
  writeOAuth(db, row.id, null, {
    status: "expired",
    expiresAt: null,
    renews: false,
    issuer: hostOf(opened.sealed.authorizationServer),
    resourceMetadataUrl: readPublic(row.oauth_json)?.resourceMetadataUrl ?? null,
    reason: scrubbed,
    scope: null,
  });
  logger.warn("mcp oauth client refused by its authorization server; the registration is dropped", {
    mcp: row.name,
    reason: scrubbed,
  });
  publishResourceUpdated("mcp", row.id);
}

export interface CompleteMcpOAuthInput {
  /** The callback's query, as the authorization server sent it. */
  state: string | null;
  code: string | null;
  error: string | null;
  errorDescription: string | null;
  /** The session the callback arrived in. */
  userId: string;
  sessionId: string;
  actor: AuditActor;
  fetchImpl?: McpFetch;
}

export type CompleteMcpOAuthResult =
  | { ok: true; mcpId: string; name: string; replacedStaticCredential: boolean }
  | { ok: false; name: string | null; message: string };

const UNKNOWN_STATE =
  "This sign-in link is unknown, has expired or was already used. Start the sign-in again from Instance settings → Agent resources.";

/**
 * The callback's half: spend the state (once, whatever happens next), check
 * the callback arrived in the session that started it, exchange the code with
 * the PKCE verifier, and seal the tokens as the connection's credential.
 */
export async function completeMcpOAuthSignIn(
  db: DatabaseSync,
  input: CompleteMcpOAuthInput,
): Promise<CompleteMcpOAuthResult> {
  const key = input.state ? stateKey(input.state) : null;
  const entry = key ? pending().get(key) : undefined;
  if (key) pending().delete(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    logger.warn("mcp oauth callback refused: its state is unknown, expired or spent");
    return { ok: false, name: null, message: UNKNOWN_STATE };
  }
  const subject = { id: entry.mcpId, name: entry.name };
  const scrub = (text: string) =>
    scrubSecrets(text, [input.code, entry.codeVerifier, entry.client.client_secret]);
  const failed = (
    stage: "authorization" | "state" | "token",
    reason: string,
    message: string,
  ): CompleteMcpOAuthResult => {
    auditFailure(db, subject, input.actor, stage, scrub(reason));
    logger.warn("mcp oauth sign-in failed", { mcp: entry.name, stage, reason: scrub(reason) });
    return { ok: false, name: entry.name, message: scrub(message) };
  };
  if (entry.userId !== input.userId || entry.sessionId !== input.sessionId) {
    return failed(
      "state",
      "the callback arrived in a different session from the one that started the sign-in",
      "This sign-in was started in another session. Start it again from Instance settings → Agent resources.",
    );
  }
  if (input.error) {
    const said = [input.error, input.errorDescription].filter(Boolean).join(": ").slice(0, 200);
    return failed(
      "authorization",
      `the authorization server answered ${said}`,
      `${entry.name} was not signed in: the authorization server answered ${said}.`,
    );
  }
  if (!input.code) {
    return failed("authorization", "the callback carried no code", `${entry.name} was not signed in: the callback carried no code.`);
  }
  const removed: CompleteMcpOAuthResult = {
    ok: false,
    name: entry.name,
    message: `${entry.name} was removed while you were signing in.`,
  };
  const moved = (): CompleteMcpOAuthResult =>
    failed(
      "state",
      "its endpoint changed during the sign-in",
      `${entry.name}'s endpoint changed while you were signing in. Sign in again.`,
    );
  const before = rowById(db, entry.mcpId);
  if (!before) return removed;
  if (before.target !== entry.target || before.transport !== "HTTP") return moved();
  let tokens: OAuthTokens;
  try {
    tokens = await exchangeMcpOAuthCode(entry.discovery, entry.client, input.code, entry.codeVerifier, input.fetchImpl);
  } catch (error) {
    const reason = oauthFailureReason(error);
    if (isClientRefusal(error)) forgetRefusedClient(db, entry.mcpId, entry.client.client_id, scrub(reason));
    return failed("token", reason, `${entry.name} was not signed in: ${reason}.`);
  }
  // Read again after the exchange, and written in the same synchronous
  // stretch: a save that re-pointed (or removed) the row while the code was
  // on the wire wins. Checking only before the await let a sign-in for the
  // old endpoint land on the re-pointed row and erase the credential that
  // save had just pasted (R-oauth-3, 2026-09-25). The tokens are dropped
  // unrevoked, as a re-point's are.
  const row = rowById(db, entry.mcpId);
  if (!row) return removed;
  if (row.target !== entry.target || row.transport !== "HTTP") return moved();
  const stored = storedTokens(tokens);
  const sealed: SealedOAuth = {
    v: 1,
    target: entry.target,
    authorizationServer: entry.discovery.authorizationServer,
    resource: entry.discovery.resource,
    scope: entry.discovery.scope,
    endpoints: entry.discovery.endpoints,
    client: entry.client,
    tokens: stored,
  };
  const pub = signedInPublic(sealed, stored, readPublic(row.oauth_json), entry.discovery.scope);
  const replacedStaticCredential = row.cred_ref !== null;
  // A connection holds one credential: the sign-in the admin just chose takes
  // the place of a pasted token, which would otherwise win (ruling 469(e)).
  db.prepare(
    `UPDATE org_mcp_servers SET oauth_ref = ?, oauth_json = ?, cred_ref = NULL, updated_at = ? WHERE id = ?`,
  ).run(sealSecret(JSON.stringify(sealed)), JSON.stringify(pub), new Date().toISOString(), row.id);
  recordAudit(db, {
    action: "org.mcp.oauth_connected",
    actor: input.actor,
    subjectKind: "org_mcp",
    subjectId: row.id,
    details: {
      name: row.name,
      issuer: pub.issuer,
      scope: pub.scope,
      expiresAt: stored.expires_at,
      renews: pub.renews,
      replacedStaticCredential,
    },
  });
  logger.info("mcp oauth signed in", { mcp: row.name, issuer: pub.issuer, renews: pub.renews });
  publishResourceUpdated("mcp", row.id);
  return { ok: true, mcpId: row.id, name: row.name, replacedStaticCredential };
}

/**
 * Sign out: revoke the tokens at the server when it offers revocation (the
 * refresh token first, which ends the grant), then drop the sealed half. The
 * row reads "needs sign-in" again. A revocation that fails still drops the
 * tokens here; the toast says which happened.
 */
export async function signOutMcpOAuth(
  db: DatabaseSync,
  mcpId: string,
  actor: AuditActor,
  options: { fetchImpl?: McpFetch } = {},
): Promise<{ toast: string }> {
  const row = rowById(db, mcpId);
  if (!row) throw AppError.notFound("No such MCP server.");
  const pub = readPublic(row.oauth_json);
  const opened = openOAuth(db, row);
  const sealed = opened.state === "ok" ? opened.sealed : null;
  if (!sealed?.tokens && pub?.status !== "signed_in" && pub?.status !== "expired" && opened.state !== "unreadable") {
    throw AppError.validation(`${row.name} is not signed in.`);
  }
  let revocation: "revoked" | "not offered" | "failed" | "nothing to revoke" = "nothing to revoke";
  let revocationReason: string | null = null;
  if (sealed?.tokens) {
    const discovery = discoveryOf(sealed);
    try {
      const refresh = sealed.tokens.refresh_token
        ? await revokeMcpOAuthToken(discovery, sealed.client, sealed.tokens.refresh_token, "refresh_token", options.fetchImpl)
        : false;
      const access = await revokeMcpOAuthToken(
        discovery,
        sealed.client,
        sealed.tokens.access_token,
        "access_token",
        options.fetchImpl,
      );
      revocation = refresh || access ? "revoked" : "not offered";
    } catch (error) {
      revocation = "failed";
      revocationReason = scrubSecrets(oauthFailureReason(error), secretsOf(sealed));
      logger.warn("mcp oauth revocation failed; the tokens are dropped here anyway", {
        mcp: row.name,
        reason: revocationReason,
      });
    }
  }
  writeOAuth(db, row.id, null, {
    status: "needs_sign_in",
    expiresAt: null,
    renews: false,
    issuer: pub?.issuer ?? (sealed ? hostOf(sealed.authorizationServer) : null),
    resourceMetadataUrl: pub?.resourceMetadataUrl ?? null,
    reason: null,
    // Ruling 486: the grant went with the tokens.
    scope: null,
  });
  recordAudit(db, {
    action: "org.mcp.oauth_signed_out",
    actor,
    subjectKind: "org_mcp",
    subjectId: row.id,
    details: { name: row.name, revocation, reason: revocationReason },
  });
  logger.info("mcp oauth signed out", { mcp: row.name, revocation });
  publishResourceUpdated("mcp", row.id);
  const tail =
    revocation === "revoked"
      ? " Its tokens were revoked at the server and deleted here."
      : revocation === "not offered"
        ? " The server offers no revocation, so its tokens were deleted here only."
        : revocation === "failed"
          ? ` Revoking them at the server failed (${revocationReason}), so they were deleted here only.`
          : "";
  return { toast: `${row.name} signed out.${tail}` };
}

// ------------------------------------------------------------ the token upstream

/** mcp id → the renewal in flight, so two runs that meet an expired token at
 *  once spend its refresh token once (a rotating server would refuse the
 *  second and end the sign-in). */
const renewing = new Map<string, Promise<string>>();

/** A connection that is signed in right now, as read for one request. */
interface LiveSignIn {
  row: OAuthRow;
  sealed: SealedOAuth;
  tokens: StoredTokens;
}

function expiredByClock(tokens: StoredTokens, now: number = Date.now()): boolean {
  return tokens.expires_at !== null && Date.parse(tokens.expires_at) - EXPIRY_SKEW_MS <= now;
}

/**
 * The access token for one connection, as the gateway and the probe attach it
 * upstream. Read from the row on every request, so a sign-out, a new sign-in
 * or a renewal by another run takes effect on the next request.
 *
 * `target` is the endpoint the connection it serves was opened against, and
 * the source is bound to it: once the row points anywhere else, it hands over
 * nothing (`UpstreamEndpointChanged`, and the gateway reconnects to where the
 * row points). Following the row alone let a connection held open to the old
 * endpoint send a later sign-in's tokens there, whose 401 then spent the new
 * refresh token and ended the new sign-in (R-oauth-1, 2026-09-25).
 */
export function mcpOAuthTokenSource(
  db: DatabaseSync,
  mcpId: string,
  target: string,
  options: { fetchImpl?: McpFetch } = {},
): UpstreamTokenSource {
  const current = (): LiveSignIn => {
    const row = rowById(db, mcpId);
    if (!row) throw new UpstreamConnectError("it is no longer in the org MCP registry");
    if (row.target !== target || row.transport !== "HTTP") throw new UpstreamEndpointChanged();
    const opened = openOAuth(db, row);
    if (opened.state === "unreadable") throw new UpstreamConnectError(opened.reason);
    const tokens = opened.state === "ok" ? opened.sealed.tokens : null;
    if (opened.state !== "ok" || !tokens || opened.sealed.target !== row.target) {
      throw new UpstreamConnectError(
        readPublic(row.oauth_json)?.status === "expired" ? OAUTH_SIGN_IN_EXPIRED : OAUTH_NEEDS_SIGN_IN,
      );
    }
    return { row, sealed: opened.sealed, tokens };
  };

  /**
   * End the sign-in whose stored tokens `refused` recognizes: the tokens are
   * dropped, the row reads "sign-in expired" with the reason. The row is read
   * again and written in one synchronous stretch, and only while it still
   * holds the tokens that were refused: a sign-out, a new sign-in or another
   * renewal that landed while the refusal was on the wire wins, as it does on
   * the renewal's success path. Ending whatever was read before the await
   * wiped a fresh sign-in and put the old registration back (R-oauth-3,
   * 2026-09-25). Null when the stored tokens are not the refused ones.
   *
   * The registration is kept for the next sign-in — unless the server refused
   * the client itself (`invalid_client`, `unauthorized_client`): kept, every
   * later sign-in reused the dead id and failed the same way, so the whole
   * sealed half goes and the next sign-in registers again (R-oauth-4).
   */
  const expireIf = (
    refused: (stored: StoredTokens) => boolean,
    reason: string,
    clientRejected: boolean,
  ): UpstreamConnectError | null => {
    const row = rowById(db, mcpId);
    const opened = row ? openOAuth(db, row) : null;
    if (!row || opened?.state !== "ok" || !opened.sealed.tokens || !refused(opened.sealed.tokens)) return null;
    const sealed = opened.sealed;
    const scrubbed = scrubSecrets(reason, secretsOf(sealed));
    const pub = readPublic(row.oauth_json);
    writeOAuth(db, row.id, clientRejected ? null : { ...sealed, tokens: null }, {
      status: "expired",
      expiresAt: null,
      renews: false,
      issuer: hostOf(sealed.authorizationServer),
      resourceMetadataUrl: pub?.resourceMetadataUrl ?? null,
      reason: scrubbed,
      scope: null,
    });
    auditFailure(db, row, SYSTEM_ACTOR, "refresh", scrubbed);
    logger.warn("mcp oauth sign-in expired", { mcp: row.name, reason: scrubbed });
    publishResourceUpdated("mcp", row.id);
    return new UpstreamConnectError(OAUTH_SIGN_IN_EXPIRED);
  };

  const renew = async (rejected: string): Promise<string> => {
    const { row, sealed, tokens } = current();
    // Another request renewed it already: use what it stored.
    if (tokens.access_token !== rejected && !expiredByClock(tokens)) return tokens.access_token;
    /** The pair this renewal set out from can no longer renew: end it — or,
     *  when something else was stored meanwhile, use that. */
    const endOrUseNewer = (reason: string, clientRejected: boolean): string => {
      const ended = expireIf(
        (stored) => stored.access_token === tokens.access_token && stored.refresh_token === tokens.refresh_token,
        reason,
        clientRejected,
      );
      if (ended) throw ended;
      return current().tokens.access_token;
    };
    if (!tokens.refresh_token) {
      return endOrUseNewer("the server issued no refresh token, so the sign-in cannot renew itself", false);
    }
    let fresh: OAuthTokens;
    try {
      fresh = await refreshMcpOAuthTokens(discoveryOf(sealed), sealed.client, tokens.refresh_token, options.fetchImpl);
    } catch (error) {
      const reason = oauthFailureReason(error);
      if (isDefinitiveRefusal(error)) return endOrUseNewer(reason, isClientRefusal(error));
      const scrubbed = scrubSecrets(reason, secretsOf(sealed));
      logger.warn("mcp oauth token could not be renewed now", { mcp: row.name, reason: scrubbed });
      throw new UpstreamConnectError(`could not renew the OAuth sign-in: ${scrubbed}`);
    }
    // Written only if the sign-in is still the one renewed: a sign-out or a
    // new sign-in while the refresh was on the wire wins.
    const again = rowById(db, mcpId);
    const still = again ? openOAuth(db, again) : null;
    if (!again || still?.state !== "ok" || still.sealed.tokens?.refresh_token !== tokens.refresh_token) {
      return current().tokens.access_token;
    }
    const stored = storedTokens(fresh);
    const next: SealedOAuth = { ...sealed, tokens: stored };
    // Ruling 486: a refresh reply that names a scope updates the grant; one
    // that names none keeps the grant the sign-in held.
    const previous = readPublic(again.oauth_json);
    writeOAuth(db, row.id, next, signedInPublic(next, stored, previous, tokens.scope ?? previous?.scope ?? sealed.scope));
    logger.info("mcp oauth token renewed", { mcp: row.name });
    publishResourceUpdated("mcp", row.id);
    return stored.access_token;
  };

  const renewOnce = (rejected: string): Promise<string> => {
    const inFlight = renewing.get(mcpId);
    if (inFlight) return inFlight;
    const run = renew(rejected).finally(() => {
      if (renewing.get(mcpId) === run) renewing.delete(mcpId);
    });
    renewing.set(mcpId, run);
    return run;
  };

  return {
    accessToken: async () => {
      const { tokens } = current();
      return expiredByClock(tokens) ? renewOnce(tokens.access_token) : tokens.access_token;
    },
    renewAfterRefusal: (rejected) => renewOnce(rejected),
    refusedAfterRenewal: async (rejected) => {
      const ended = expireIf(
        (stored) => stored.access_token === rejected,
        "the server refused a freshly renewed token",
        false,
      );
      if (ended) return ended;
      // The refused token is no longer the stored one: a sign-out, a new
      // sign-in or another renewal landed while this request was in flight.
      // This request fails; the next one reads what is stored now.
      try {
        current();
      } catch (error) {
        if (error instanceof UpstreamConnectError) return error;
      }
      return new UpstreamConnectError(
        "the server refused a freshly renewed OAuth token while the sign-in changed; the next request uses the new one",
      );
    },
  };
}
