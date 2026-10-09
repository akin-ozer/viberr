import { countLabel } from "~/shared/text/plural";

/**
 * Ruling 192: where an HTTP MCP connection stands on its OAuth sign-in, as
 * every surface shows it: the Settings row and editor, the probe's toast, the
 * controller's `list_mcp_servers`. One home for the words, so the row and the
 * controller never describe the same sign-in differently.
 *
 * Never a token: this is the public half of what the registry keeps, and the
 * sealed half never leaves the server.
 */

export const MCP_OAUTH_STATUSES = ["needs_sign_in", "signed_in", "expired"] as const;
export type McpOAuthStatus = (typeof MCP_OAUTH_STATUSES)[number];

export interface McpOAuthView {
  /** `needs_sign_in`: the server answered the MCP authorization challenge and
   *  holds no token here. `signed_in`: an access token is sealed. `expired`:
   *  the sign-in could not be renewed, and an admin must sign in again. */
  status: McpOAuthStatus;
  /** When the current access token runs out (ISO), when the server said. */
  expiresAt: string | null;
  /** Whether a refresh token is held, so the sign-in renews itself. */
  renews: boolean;
  /** The authorization server's host ("mcp.cloudflare.com"). */
  issuer: string | null;
  /** Why the sign-in expired, in the authorization server's words. */
  reason: string | null;
  /**
   * Ruling 192: the scope the authorization server granted, space-joined as
   * it returned it (or, when its token reply named none, the scope Viberr
   * asked for, which RFC 6749 §5.1 says it then granted). Null while no
   * sign-in is held, or when neither side named one. Not a secret.
   */
  scope: string | null;
}

// ------------------------------------------------------------ the grant (ruling 192)

/**
 * The action words that only read. A scope is named `<resource>.<action>`
 * (Cloudflare's `workers-scripts.read`) or `<resource>:<action>` (its
 * `user:read`); these four actions change nothing. `monitoring` and `report`
 * are on the list because Cloudflare's own consent screen counts them as
 * read-only (its read-only template, `isReadOnlyScope` in cloudflare/mcp), and
 * its live read-only grant carries `teams-connector-cloudflared.monitoring`
 * and `teams.report` among its 194 scopes.
 */
const READ_ACTIONS = new Set(["read", "metadata_read", "monitoring", "report"]);

/** Scopes that grant no action on any resource: the refresh token's. */
const NEUTRAL_SCOPES = new Set(["offline_access"]);

/**
 * Whether one OAuth scope lets its holder change something. A write is any
 * scope whose action is not a read (`.read`, `.metadata_read`, `:read`,
 * `.monitoring`, `.report`) and that is not `offline_access`.
 */
export function isWriteScope(scope: string): boolean {
  if (NEUTRAL_SCOPES.has(scope)) return false;
  const action = scope.split(/[.:]/).at(-1) ?? scope;
  return !READ_ACTIONS.has(action);
}

export interface McpGrantSummary {
  /** Every scope granted, in the order the server named them, once each. */
  scopes: string[];
  /** The ones that write (`isWriteScope`). */
  writes: string[];
}

/** A granted scope string as its scopes and its writes; null when there is none. */
export function summarizeMcpGrant(scope: string | null | undefined): McpGrantSummary | null {
  const scopes = [...new Set((scope ?? "").split(/\s+/).filter(Boolean))];
  if (scopes.length === 0) return null;
  return { scopes, writes: scopes.filter(isWriteScope) };
}

/** "read-only · 194 scopes", or "194 scopes · 12 writes"; null with no grant. */
export function mcpGrantPhrase(scope: string | null | undefined): string | null {
  const grant = summarizeMcpGrant(scope);
  if (!grant) return null;
  const scopes = countLabel(grant.scopes.length, "scope");
  return grant.writes.length === 0
    ? `read-only · ${scopes}`
    : `${scopes} · ${countLabel(grant.writes.length, "write")}`;
}

/**
 * Ruling 192: the sentence a gateway-relayed authorization refusal gains
 * on a connection whose sign-in granted only reads. Null when the connection
 * is not signed in, its grant is unknown, or the grant holds a write.
 */
export function mcpReadOnlyRefusal(view: McpOAuthView | null | undefined): string | null {
  if (view?.status !== "signed_in") return null;
  const grant = summarizeMcpGrant(view.scope);
  if (!grant || grant.writes.length > 0) return null;
  return `This connection's sign-in granted read-only scopes (${grant.scopes.length}); an admin must sign it in again with write scopes in Instance settings → Agent resources.`;
}

/** RFC 6749 §3.3: a scope token is printable ASCII without space, `"` or `\`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/** Ruling 192: "Requested scopes" read for the authorization request. */
export interface RequestedScopes {
  /** Space-joined, each scope once; null when none was typed. */
  scope: string | null;
  /** Every token RFC 6749 does not allow as a scope. */
  invalid: string[];
}

/**
 * Ruling 192: the editor's "Requested scopes" as the authorization request
 * sends them: split on spaces, commas and newlines, each once, space-joined;
 * null when empty. `invalid` names every token RFC 6749 does not allow.
 */
export function parseRequestedScopes(raw: string): RequestedScopes {
  const tokens = [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
  return {
    scope: tokens.length > 0 ? tokens.join(" ") : null,
    invalid: tokens.filter((token) => !SCOPE_TOKEN.test(token)),
  };
}

/** "in 52 minutes", "in 3 hours"; "" for a date that does not parse. */
function expiresInWords(expiresAt: string, now: number = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms)) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 90) return `in ${countLabel(minutes, "minute")}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${countLabel(hours, "hour")}`;
  return `in ${countLabel(Math.round(hours / 24), "day")}`;
}

/**
 * The sign-in in one phrase: "needs sign-in", "signed in (expires in 52
 * minutes, renews itself)", "sign-in expired: an admin must sign in again".
 * Null for a connection that is not an OAuth one.
 */
export function mcpSignInPhrase(
  view: McpOAuthView | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!view) return null;
  if (view.status === "needs_sign_in") return "needs sign-in";
  if (view.status === "expired") return "sign-in expired: an admin must sign in again";
  if (!view.expiresAt) return view.renews ? "signed in (renews itself)" : "signed in";
  if (Date.parse(view.expiresAt) <= now) {
    return view.renews
      ? "signed in (the token renews on its next use)"
      : "signed in (the token has run out and cannot renew: sign in again)";
  }
  const expires = `expires ${expiresInWords(view.expiresAt, now)}`;
  return `signed in (${view.renews ? `${expires}, renews itself` : expires})`;
}

/**
 * The same state as a sentence the controller relays (`list_mcp_servers`,
 * `save_mcp_server`): what it means for runs, and that signing in is an org
 * admin's act in Instance settings, which the controller cannot perform.
 */
export function mcpSignInNote(view: McpOAuthView | null | undefined): string | null {
  if (!view) return null;
  if (view.status === "needs_sign_in") {
    return "It asks for an OAuth sign-in and nobody has signed it in, so runs do not mount it. An org admin signs it in from its editor in Instance settings → Agent resources (Sign in); the controller cannot.";
  }
  if (view.status === "expired") {
    return `Its OAuth sign-in expired${view.reason ? ` (${view.reason})` : ""}, so runs do not mount it. An org admin must sign it in again in Instance settings → Agent resources; the controller cannot.`;
  }
  return `${sentence(mcpSignInPhrase(view) ?? "signed in")} with OAuth${view.issuer ? ` at ${view.issuer}` : ""}. Viberr holds the tokens; runs reach the server through Viberr's MCP gateway and never see them. ${grantSentence(view.scope)}`;
}

/** Ruling 192: what the sign-in may do, as the controller relays it. */
function grantSentence(scope: string | null): string {
  const grant = summarizeMcpGrant(scope);
  if (!grant) return "The server did not say which scopes it granted.";
  if (grant.writes.length === 0) {
    return `Its grant is read-only (${countLabel(grant.scopes.length, "scope")}): the server refuses any call that writes, until an org admin signs it in again with write scopes (Requested scopes in its editor, Instance settings → Agent resources); the controller cannot.`;
  }
  return `Its grant: ${countLabel(grant.scopes.length, "scope")}, ${countLabel(grant.writes.length, "write")} among them.`;
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
