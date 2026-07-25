import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { buildResourceCatalog } from "./resource-catalog.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("buildResourceCatalog (item-2: live resource picker)", () => {
  it("lists real on-disk skills + KB folders and org MCP servers, not a mock", () => {
    const store = setupTestStore(ctx);
    // Create real store folders + an org MCP row.
    const skillDir = path.join(store.dataRoot, "skills", "my-house-rules");
    const kbDir = path.join(store.dataRoot, "kb", "runbooks");
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "# rules", "utf8");
    writeFileSync(path.join(kbDir, "deploy.md"), "# runbook", "utf8");
    const now = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO org_mcp_servers (id, name, transport, target, cred_ref, created_at, updated_at)
         VALUES ('mcp_x', 'github-mcp', 'HTTP', 'https://mcp.example/sse', NULL, ?, ?)`,
      )
      .run(now, now);

    const catalog = buildResourceCatalog(store.db, store.dataRoot);
    const group = (key: string) => catalog.find((g) => g.key === key)!;
    const ids = (key: string) => group(key).items.map((i) => i.id);

    // Skills: the real on-disk folder shows up (unlike the mock's fictional ids).
    expect(ids("skills")).toContain("my-house-rules");
    // KB: the real on-disk folder.
    expect(ids("kb")).toContain("runbooks");
    // MCP: the org registry row, and ONLY the registry (P14-KM-14).
    expect(ids("mcps")).toContain("github-mcp");
    expect(ids("mcps")).not.toContain("viberr");
  });

  it("unions org_knowledge_bases rows — a KB row without a folder stays grantable (E7)", () => {
    const store = setupTestStore(ctx);
    const now = new Date().toISOString();
    // A managed KB row whose folder vanished (or was never created on this
    // disk) — org-settings still lists it, so the grant picker must too.
    store.db
      .prepare(
        `INSERT INTO org_knowledge_bases (id, name, dir, refresh, created_at, updated_at)
         VALUES ('kb_x', 'Ghost KB', 'ghost-kb', 'manual', ?, ?)`,
      )
      .run(now, now);

    const catalog = buildResourceCatalog(store.db, store.dataRoot);
    const kbIds = catalog.find((g) => g.key === "kb")!.items.map((i) => i.id);
    expect(kbIds).toContain("ghost-kb");
  });

  it("excludes the reserved viberr operator toolkit from the SPECIALIST catalog (F7-RES3)", () => {
    const store = setupTestStore(ctx);
    const now = new Date().toISOString();
    // A real org MCP row a specialist SHOULD be able to attach.
    store.db
      .prepare(
        `INSERT INTO org_mcp_servers (id, name, transport, target, cred_ref, created_at, updated_at)
         VALUES ('mcp_y', 'notes-fixture', 'HTTP', 'https://mcp.example/sse', NULL, ?, ?)`,
      )
      .run(now, now);

    // P14-KM-14: the catalog is the REGISTRY, identical for every profile kind.
    // `viberr` is offered to nobody — the operator toolkit mounts it whatever the
    // grants say and the specialist resolver skips the name, so a toggle for it
    // governed nothing in either direction.
    const mcps = buildResourceCatalog(store.db, store.dataRoot)
      .find((g) => g.key === "mcps")!
      .items.map((i) => i.id);
    expect(mcps).not.toContain("viberr");
    expect(mcps).toContain("notes-fixture");
  });

  it("handles a store with no resources without throwing", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-empty-"));
    const store = setupTestStore(ctx);
    const catalog = buildResourceCatalog(store.db, dataRoot);
    // Three groups always present; all three are empty in an empty store — the
    // reserved `viberr` name is no longer synthesized into the MCP group.
    expect(catalog.map((g) => g.key).sort()).toEqual(["kb", "mcps", "skills"]);
    expect(catalog.find((g) => g.key === "mcps")!.items).toEqual([]);
  });
});
