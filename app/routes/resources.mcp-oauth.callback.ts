import type { Route } from "./+types/resources.mcp-oauth.callback";
import { requireRoleAuth } from "~/server/auth/require-user.server";
import { getDb } from "~/server/db/sqlite.server";
import { completeMcpOAuthSignIn } from "~/server/org/mcp-oauth.server";
import { testMcpServer } from "~/server/org/resources.server";
import { errorMessage } from "~/shared/errors";
import { pageTitle } from "~/shared/page-title";

/**
 * GET /resources/mcp-oauth/callback — where an MCP server's authorization
 * server sends the admin's browser back after consent (ruling 192).
 *
 * The admin started the sign-in from the MCP editor in Instance settings,
 * which opened the authorization URL in a new tab; that tab lands here. An
 * OAuth callback is a GET by protocol, so this loader does the one mutation a
 * loader in Viberr does: it spends the `state` (once, bound to the session
 * that started it), exchanges the code with the PKCE verifier the server kept,
 * seals the tokens and audits the outcome, then probes the connection so the
 * page and the Settings row can say what the sign-in reached. Admin-only like
 * the page that starts it: a signed-out admin is sent through /login and back
 * here with the query intact.
 *
 * The page it answers with is plain HTML, because it renders nothing of the
 * app: a sentence and "you can close this tab". It carries no token, no code
 * and no state, and it is never cached or sent as a referrer.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(status: number, heading: string, lines: string[]): Response {
  const body = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeHtml(pageTitle("MCP sign-in"))}</title>`,
    "</head>",
    '<body data-screen-label="MCP sign-in">',
    "<main>",
    `<h1>${escapeHtml(heading)}</h1>`,
    ...lines.map((line) => `<p>${escapeHtml(line)}</p>`),
    '<p><a href="/org/settings">Open Instance settings</a></p>',
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const ctx = await requireRoleAuth(request, "admin");
  const query = new URL(request.url).searchParams;
  const db = getDb();
  const result = await completeMcpOAuthSignIn(db, {
    state: query.get("state"),
    code: query.get("code"),
    error: query.get("error"),
    errorDescription: query.get("error_description"),
    userId: ctx.user.id,
    sessionId: ctx.sessionId,
    actor: { userId: ctx.user.id, label: ctx.user.email },
  });
  if (!result.ok) {
    return page(400, result.name ? `${result.name} was not signed in` : "Sign-in not completed", [
      result.message,
      "You can close this tab.",
    ]);
  }
  let check: string;
  try {
    check = `Connection check: ${(await testMcpServer(db, result.mcpId)).toast}.`;
  } catch (error) {
    check = `The connection check could not run (${errorMessage(error)}). Test it from Instance settings.`;
  }
  const lines = [
    `Viberr holds the sign-in. Agent runs reach ${result.name} through its MCP gateway and never see the token.`,
  ];
  if (result.replacedStaticCredential) {
    lines.push("The pasted credential this server had before was removed: a connection holds one credential.");
  }
  lines.push(check, "You can close this tab. Instance settings already shows the new state.");
  return page(200, `Signed in to ${result.name}`, lines);
}
