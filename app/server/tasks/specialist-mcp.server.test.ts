import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { resolveSpecialistMcpServers } from "./specialist-mcp.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function addMcp(
  db: ReturnType<typeof setupTestStore>["db"],
  name: string,
  transport: "HTTP" | "stdio",
  target: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO org_mcp_servers (id, name, transport, target, cred_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run(`mcp_${name}`, name, transport, target, now, now);
}

describe("resolveSpecialistMcpServers (item-1: MCP wiring)", () => {
  it("builds an HTTP mcpServer config from an org MCP row", () => {
    const store = setupTestStore(ctx);
    addMcp(store.db, "billing-api", "HTTP", "https://mcp.example/sse");
    const servers = resolveSpecialistMcpServers(store.db, ["billing-api"]);
    expect(servers["billing-api"]).toEqual({ type: "http", url: "https://mcp.example/sse" });
  });

  it("builds a stdio mcpServer config (command + args) from a stdio row", () => {
    const store = setupTestStore(ctx);
    addMcp(store.db, "pg-ro", "stdio", "npx -y @mcp/server-postgres");
    const servers = resolveSpecialistMcpServers(store.db, ["pg-ro"]);
    expect(servers["pg-ro"]).toEqual({ command: "npx", args: ["-y", "@mcp/server-postgres"] });
  });

  it("skips the operator's in-process `viberr` server and unknown names", () => {
    const store = setupTestStore(ctx);
    expect(resolveSpecialistMcpServers(store.db, ["viberr", "does-not-exist"])).toEqual({});
  });

  it("returns nothing for an empty declaration", () => {
    const store = setupTestStore(ctx);
    expect(resolveSpecialistMcpServers(store.db, [])).toEqual({});
  });
});
