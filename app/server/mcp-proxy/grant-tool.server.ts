import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { isWriteScope, mcpSignInPhrase, summarizeMcpGrant, type McpOAuthView } from "~/shared/mcp-oauth";
import { countLabel } from "~/shared/text/plural";

/**
 * Ruling 192 (live verification 2026-09-25, F40-66): the one tool Viberr's MCP
 * gateway answers itself. A run's prompt carries only a summary of an OAuth
 * sign-in's grant ("384 scopes · 192 writes"), because listing every scope in
 * every prompt is bloat. That left an agent unable to tell whether the write it
 * needed (`workers-kv-storage.write`) was granted, and it asked the owner. On
 * every OAuth-signed-in connection the gateway now adds this tool to the
 * server's `tools/list`: it returns the granted scopes, writes and reads listed
 * apart, and when the sign-in's access token expires. It is read from the
 * registry row's public half, so it never holds token material. It is never
 * forwarded upstream, never refused as a withheld write tool and never audited
 * as a write call.
 *
 * The `viberr_` prefix keeps it clear of a server's own tools. On a connection
 * that offers it, the gateway drops an upstream tool of the same name from the
 * listing, so the run never sees two tools with one name.
 */
export const MCP_GRANT_TOOL_NAME = "viberr_connection_grant";

export const MCP_GRANT_TOOL: Tool = {
  name: MCP_GRANT_TOOL_NAME,
  title: "Connection grant",
  description:
    "Answered by Viberr's MCP gateway, not by this server: the OAuth scopes this connection's " +
    "sign-in was granted, with writes and reads listed apart, and when the sign-in's access " +
    "token expires. Call it before you assume a call will be refused or accepted. It sends " +
    "nothing to the server and changes nothing.",
  inputSchema: { type: "object", properties: {} },
  annotations: {
    title: "Connection grant",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** The tool's answer for `server`, whose registry row reads `view` now. */
export function mcpGrantToolResult(server: string, view: McpOAuthView, now: number = Date.now()): CallToolResult {
  return { content: [{ type: "text", text: grantToolText(server, view, now) }] };
}

function grantToolText(server: string, view: McpOAuthView, now: number): string {
  if (view.status !== "signed_in") {
    const why = view.status === "expired" ? "its sign-in expired" : "it needs a sign-in";
    return (
      `${server} is not signed in with OAuth now (${why}), so its connection grants nothing ` +
      "until an org admin signs it in again in Instance settings → Agent resources."
    );
  }
  const issuer = view.issuer ? ` at ${view.issuer}` : "";
  const expiry = view.expiresAt ? `; the access token expires at ${view.expiresAt}` : "";
  const heading = `${server}: ${mcpSignInPhrase(view, now) ?? "signed in"} with OAuth${issuer}${expiry}.`;
  const grant = summarizeMcpGrant(view.scope);
  if (!grant) {
    return (
      `${heading}\nThe server did not say which scopes it granted, so Viberr cannot list them. ` +
      "The server still enforces its grant and refuses a call the grant does not cover."
    );
  }
  const reads = grant.scopes.filter((scope) => !isWriteScope(scope));
  return [
    heading,
    `Granted ${countLabel(grant.scopes.length, "scope")}: ${countLabel(grant.writes.length, "write")} ` +
      `and ${countLabel(reads.length, "read")}. The server enforces this grant: a call that needs a ` +
      "scope not listed here is refused.",
    "",
    grant.writes.length > 0
      ? `Writes (${grant.writes.length}):\n${grant.writes.join("\n")}`
      : "Writes: none. The grant is read-only, so the server refuses any call that writes.",
    "",
    reads.length > 0 ? `Reads (${reads.length}):\n${reads.join("\n")}` : "Reads: none.",
  ].join("\n");
}
