import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../test-support/test-app";
import { listAuditEvents } from "../../test-support/audit-log";
import { listMcpServers } from "~/server/org/resources.server";

/**
 * Ruling 176: the MCP editor's "Write tools" section rides the `mcp-save`
 * intent as a JSON array of tool names. The list round-trips through the
 * registry column, a change is audited before → after, a save without the field
 * keeps the stored marks, and a malformed list or a name outside the MCP
 * alphabet is refused with the marks unchanged. Admin-gated like the page.
 *
 * The target is a closed local port: the save's real handshake is refused at
 * once and the server is stored as unreachable, which is all this needs.
 */

let app: AppTestContext;
let ardaId: string;
const TARGET = "http://127.0.0.1:9/mcp";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda; // org admin
});
afterAll(() => app.cleanup());

async function saveMcp(
  userId: string,
  fields: Record<string, string>,
): Promise<{ status: number; body: { ok: boolean; toast?: string; error?: string } }> {
  const { action } = await import("~/routes/org.settings");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const fd = new FormData();
  fd.set("intent", "mcp-save");
  fd.set("name", "gh-tools");
  fd.set("transport", "HTTP");
  fd.set("target", TARGET);
  fd.set("cred", "");
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  fd.set("_csrf", csrf);
  const request = app.request("/org/settings", { method: "POST", body: fd, cookie });
  try {
    const result = await action({
      request,
      url: new URL(request.url),
      pattern: "/org/settings",
      params: {},
      context: new RouterContextProvider(),
    });
    const body = "data" in result ? result.data : result;
    const status = "init" in result ? (result.init?.status ?? 200) : 200;
    return { status, body };
  } catch (thrown) {
    // requireRoleAuth throws a Response for a non-admin.
    if (thrown instanceof Response) return { status: thrown.status, body: { ok: false } };
    throw thrown;
  }
}

const server = () => listMcpServers(app.db).find((m) => m.name === "gh-tools");

describe("org-settings mcp-save carries the write-tool marks (ruling 176)", () => {
  it("an admin's list is stored, shown back and audited before → after", async () => {
    const { body } = await saveMcp(ardaId, {
      writeTools: JSON.stringify(["create_pull_request", "merge_pull_request"]),
    });
    expect(body.ok).toBe(true);
    expect(body.toast).toContain("2 marked as write tools");
    expect(server()?.writeTools).toEqual(["create_pull_request", "merge_pull_request"]);
    expect(server()?.writeToolsReviewed).toBe(true);
    const rows = listAuditEvents(app.db, { action: "org.mcp.tool_policy.changed" });
    expect(rows[0]?.details).toEqual({
      name: "gh-tools",
      before: [],
      after: ["create_pull_request", "merge_pull_request"],
    });
    expect(rows[0]?.actorLabel).toBe("arda@viberr.dev");
  });

  it("a save without the field keeps the marks", async () => {
    const id = server()!.id;
    const { body } = await saveMcp(ardaId, { mcpId: id });
    expect(body.ok).toBe(true);
    expect(server()?.writeTools).toEqual(["create_pull_request", "merge_pull_request"]);
  });

  it("refuses a malformed list and a bad name, and the marks do not move", async () => {
    const id = server()!.id;
    const malformed = await saveMcp(ardaId, { mcpId: id, writeTools: "create_pull_request" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe(
      "The write-tool list did not arrive as a list of tool names.",
    );
    const badName = await saveMcp(ardaId, {
      mcpId: id,
      writeTools: JSON.stringify(["merge pull request"]),
    });
    expect(badName.status).toBe(400);
    expect(badName.body.error).toContain("is not an MCP tool name");
    expect(server()?.writeTools).toEqual(["create_pull_request", "merge_pull_request"]);
  });
});
