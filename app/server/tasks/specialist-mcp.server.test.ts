import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { saveOrgSecret } from "~/server/secrets/org-secret-store.server";
import {
  mcpBackendSupport,
  resolveSpecialistMcpServers,
} from "./specialist-mcp.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);
const ACTOR = { userId: "u_admin", label: "admin@test" };

function addMcp(
  db: ReturnType<typeof setupTestStore>["db"],
  name: string,
  transport: "HTTP" | "stdio",
  target: string,
  auth: Record<string, string> = {},
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO org_mcp_servers
       (id, name, transport, target, auth_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`mcp_${name}`, name, transport, target, JSON.stringify(auth), now, now);
}

describe("resolveSpecialistMcpServers", () => {
  it("injects HTTP headers from encrypted refs only at spawn", () => {
    const store = setupTestStore(ctx);
    const { secret } = saveOrgSecret(
      store.db,
      { name: "billing-key", value: "billing-plaintext" },
      ACTOR,
    );
    addMcp(store.db, "billing-api", "HTTP", "https://mcp.example/sse", {
      "X-API-Key": secret.ref,
    });
    const servers = resolveSpecialistMcpServers(
      store.db,
      ["billing-api"],
      "claude",
    );
    expect(servers["billing-api"]).toEqual({
      type: "http",
      url: "https://mcp.example/sse",
      headers: { "X-API-Key": "billing-plaintext" },
    });
    const row = store.db
      .prepare("SELECT auth_json FROM org_mcp_servers WHERE name = 'billing-api'")
      .get() as { auth_json: string };
    expect(row.auth_json).not.toContain("billing-plaintext");
  });

  it("parses quoted stdio argv and injects env refs", () => {
    const store = setupTestStore(ctx);
    const { secret } = saveOrgSecret(
      store.db,
      { name: "pg-token", value: "pg-plaintext" },
      ACTOR,
    );
    addMcp(
      store.db,
      "pg-ro",
      "stdio",
      `node "server path/main.js" --scope 'read only'`,
      { PG_TOKEN: secret.ref },
    );
    const servers = resolveSpecialistMcpServers(store.db, ["pg-ro"], "codex");
    expect(servers["pg-ro"]).toEqual({
      command: "node",
      args: ["server path/main.js", "--scope", "read only"],
      env: { PG_TOKEN: "pg-plaintext" },
    });
  });

  it("labels and rejects authenticated HTTP for Codex", () => {
    const store = setupTestStore(ctx);
    const { secret } = saveOrgSecret(
      store.db,
      { name: "token", value: "plaintext" },
      ACTOR,
    );
    const auth = { Authorization: secret.ref };
    addMcp(store.db, "private-http", "HTTP", "https://mcp.example", auth);
    expect(mcpBackendSupport({ transport: "HTTP", auth })).toMatchObject({
      claude: true,
      codex: false,
    });
    expect(() =>
      resolveSpecialistMcpServers(store.db, ["private-http"], "codex"),
    ).toThrow(/route this profile to Claude/);
  });

  it("skips the operator MCP and unknown names", () => {
    const store = setupTestStore(ctx);
    expect(
      resolveSpecialistMcpServers(store.db, ["viberr", "does-not-exist"]),
    ).toEqual({});
  });
});
