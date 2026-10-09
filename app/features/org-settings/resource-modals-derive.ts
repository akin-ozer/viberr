import type { McpView } from "~/server/org/resources.server";
import { mcpSignInPhrase, type McpOAuthView } from "~/shared/mcp-oauth";

/**
 * What the MCP-server editor and its OAuth sign-in read off the row and the
 * draft (ruling 13(b), the split of `resource-modals.tsx`): what the editor
 * opens with, which refusal names the credential, when a live sign-in stands
 * in for it, when a save drops the sign-in, and the copy the editor's chrome
 * and the sign-in's status line say. Pure functions, no React.
 */

/** The connection's fields as the editor opens on them. */
export interface McpOpening {
  name: string;
  transport: McpView["transport"];
  target: string;
  /** Ruling 192: the requested scopes, as stored. */
  scopes: string;
}

/** The saved row's fields, or a new HTTP server's blanks. */
export function mcpDraftOf(initial: McpView | null): McpOpening {
  return {
    name: initial ? initial.name : "",
    transport: initial ? initial.transport : "HTTP",
    target: initial ? initial.target : "",
    scopes: initial?.requestedScope ?? "",
  };
}

/** Ruling 288: a refusal about the credential (too short, or pasted over a
 *  live sign-in this editor had not seen yet) is said at that field. */
export function credentialError(err: string | null, errField: string | null): string | null {
  return err !== null && errField === "cred" ? err : null;
}

/** Ruling 192: a signed-in HTTP server still pointed where it signed in
 *  holds its credential through the sign-in, so the credential field gives
 *  way. `initial` is the row as the panel keeps it current (ruling 192). */
export function credentialReplaced(
  initial: McpView | null,
  transport: "HTTP" | "stdio",
  target: string,
): boolean {
  const signedIn = initial?.oauth?.status === "signed_in";
  return signedIn && transport === "HTTP" && target.trim() === initial?.target;
}

/** A signed-in server moved to another transport or endpoint: saving drops
 *  its sign-in, whose tokens were issued for the old endpoint. */
export function repointDropsSignIn(
  initial: McpView | null,
  transport: "HTTP" | "stdio",
  target: string,
): boolean {
  return (
    initial?.oauth?.status === "signed_in" &&
    (transport !== initial.transport || target.trim() !== initial.target)
  );
}

/** The saved server whose OAuth sign-in (ruling 192) the editor offers: an
 *  HTTP server still edited as one. */
export function signInServer(
  initial: McpView | null,
  transport: "HTTP" | "stdio",
): McpView | null {
  return initial && initial.transport === "HTTP" && transport === "HTTP" ? initial : null;
}

export function mcpSaveLabel(busy: boolean, editing: boolean): string {
  return busy ? "Testing connection…" : editing ? "Save & re-test" : "Add & test connection";
}

export function mcpFootHint(transport: "HTTP" | "stdio"): string {
  return transport === "stdio"
    ? "spawned per run, with the server's own privileges"
    : "a real MCP handshake runs on save & test";
}

/** "needs sign-in" → "Needs sign-in". */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Ruling 192: the sign-in's status line. */
export function signInStatus(oauth: McpOAuthView | null): string {
  const signedIn = oauth?.status === "signed_in";
  const phrase = mcpSignInPhrase(oauth);
  return phrase
    ? sentenceCase(phrase) + (signedIn && oauth?.issuer ? ` · ${oauth.issuer}` : "")
    : "Not signed in. Use this when the server asks for an OAuth sign-in instead of a token.";
}

/** The sign-in state an authorization URL was fetched against: once it moves
 *  (the callback landed, or the admin signed out), the link has done its job. */
export function signInStateKey(oauth: McpOAuthView | null): string {
  return `${oauth?.status ?? "none"}|${oauth?.expiresAt ?? ""}`;
}
