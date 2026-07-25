import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import {
  resolveSpecialistMcpServers,
  resolveSpecialistMcpServersDetailed,
} from "./specialist-mcp.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function addMcp(
  db: ReturnType<typeof setupTestStore>["db"],
  name: string,
  transport: "HTTP" | "stdio",
  target: string,
  sealedCred: string | null = null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO org_mcp_servers (id, name, transport, target, cred_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`mcp_${name}`, name, transport, target, sealedCred, now, now);
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

  it("P14-KM-15: skips `viberr_agent` too, so a hand-edited row can't shadow the toolkit", () => {
    const store = setupTestStore(ctx);
    // Unreachable through the UI (the save guard refuses the name), but a row
    // written straight into the DB would mount on Claude and not on Codex — the
    // two backends would then disagree about the agent's tools.
    addMcp(store.db, "viberr_agent", "HTTP", "https://evil.example/sse");
    addMcp(store.db, "viberr-agent", "HTTP", "https://evil.example/sse");
    const resolved = resolveSpecialistMcpServersDetailed(store.db, [
      "viberr_agent",
      "viberr-agent",
    ]);
    expect(resolved.servers).toEqual({});
    // Reserved names are BUILT elsewhere, not broken grants — nothing to report.
    expect(resolved.unresolved).toEqual([]);
  });

  it("P14-KM-04: a quoted stdio command keeps its arguments whole", () => {
    const store = setupTestStore(ctx);
    addMcp(store.db, "quoted", "stdio", `"/opt/my tools/mcp" --config '{"a": 1}'`);
    expect(resolveSpecialistMcpServers(store.db, ["quoted"])).toEqual({
      quoted: { command: "/opt/my tools/mcp", args: ["--config", '{"a": 1}'] },
    });
  });
});

/* ---------------------------- unresolvable grants are reportable (P14-LV-09) */

describe("resolveSpecialistMcpServersDetailed", () => {
  it("reports a grant that names no registry row, alongside the ones that resolved", () => {
    const store = setupTestStore(ctx);
    addMcp(store.db, "billing-api", "HTTP", "https://mcp.example/sse");
    // The live shape of the KM-01 orphan: the server was renamed, the grant was
    // not, and the run advertised a server that exposed zero tools while only a
    // server log said so.
    const resolved = resolveSpecialistMcpServersDetailed(store.db, [
      "billing-api",
      "vm-memory",
    ]);
    expect(Object.keys(resolved.servers)).toEqual(["billing-api"]);
    expect(resolved.unresolved).toEqual([
      { name: "vm-memory", reason: "no MCP server by that name in the org registry" },
    ]);
  });

  it("reports a registered stdio server whose command is unusable", () => {
    const store = setupTestStore(ctx);
    addMcp(store.db, "broken", "stdio", '""');
    const resolved = resolveSpecialistMcpServersDetailed(store.db, ["broken"]);
    expect(resolved.servers).toEqual({});
    expect(resolved.unresolved).toEqual([
      { name: "broken", reason: "the registered stdio command is empty" },
    ]);
  });

  it("reports nothing when every grant resolves", () => {
    const store = setupTestStore(ctx);
    addMcp(store.db, "billing-api", "HTTP", "https://mcp.example/sse");
    expect(
      resolveSpecialistMcpServersDetailed(store.db, ["billing-api"]).unresolved,
    ).toEqual([]);
  });

  it("returns nothing for an empty declaration", () => {
    const store = setupTestStore(ctx);
    expect(resolveSpecialistMcpServers(store.db, [])).toEqual({});
  });

  it("F7-MCP1: injects a sealed HTTP credential as an Authorization header", async () => {
    const { sealSecret } = await import("~/server/secrets/secret-box.server");
    const store = setupTestStore(ctx);
    addMcp(store.db, "billing-api", "HTTP", "https://mcp.example/sse", sealSecret("tok_live_123"));
    const servers = resolveSpecialistMcpServers(store.db, ["billing-api"]);
    expect(servers["billing-api"]).toEqual({
      type: "http",
      url: "https://mcp.example/sse",
      headers: { Authorization: "Bearer tok_live_123" },
    });
  });

  it("F7-MCP1: injects a sealed stdio credential as the MCP_CREDENTIAL env var", async () => {
    const { sealSecret } = await import("~/server/secrets/secret-box.server");
    const store = setupTestStore(ctx);
    addMcp(store.db, "pg-ro", "stdio", "npx -y @mcp/server-postgres", sealSecret("pg_secret"));
    const servers = resolveSpecialistMcpServers(store.db, ["pg-ro"]);
    expect(servers["pg-ro"]).toEqual({
      command: "npx",
      args: ["-y", "@mcp/server-postgres"],
      env: { MCP_CREDENTIAL: "pg_secret" },
    });
  });

  it("F7-MCP1: a legacy plaintext cred_ref is ignored, never leaked as auth", () => {
    const store = setupTestStore(ctx);
    // A pre-F7-MCP1 row stored a `secret://…` reference in cleartext — it is not
    // a sealed box, so getMcpCredential returns null and no header is injected.
    addMcp(store.db, "legacy", "HTTP", "https://mcp.example/sse", "secret://mcp/legacy");
    const servers = resolveSpecialistMcpServers(store.db, ["legacy"]);
    expect(servers["legacy"]).toEqual({ type: "http", url: "https://mcp.example/sse" });
  });
});
