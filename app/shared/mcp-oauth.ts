import { countLabel } from "~/shared/text/plural";

/**
 * Ruling 469: where an HTTP MCP connection stands on its OAuth sign-in, as
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
}

/** "in 52 minutes", "in 3 hours"; "" for a date that does not parse. */
export function expiresInWords(expiresAt: string, now: number = Date.now()): string {
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
export function mcpSignInNote(
  view: McpOAuthView | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!view) return null;
  if (view.status === "needs_sign_in") {
    return "It asks for an OAuth sign-in and nobody has signed it in, so runs do not mount it. An org admin signs it in from its editor in Instance settings → Agent resources (Sign in); the controller cannot.";
  }
  if (view.status === "expired") {
    return `Its OAuth sign-in expired${view.reason ? ` (${view.reason})` : ""}, so runs do not mount it. An org admin must sign it in again in Instance settings → Agent resources; the controller cannot.`;
  }
  return `${sentence(mcpSignInPhrase(view, now) ?? "signed in")} with OAuth${view.issuer ? ` at ${view.issuer}` : ""}. Viberr holds the tokens; runs reach the server through Viberr's MCP gateway and never see them.`;
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
