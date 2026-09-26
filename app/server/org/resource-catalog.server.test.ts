import { randomBytes } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
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

  /**
   * C5/pass-16 switched the store LISTINGS to a non-dereferencing lister so a
   * symlinked folder is not a resource. The picker kept its own private
   * `statSync` copy, which dereferences — so a linked folder was offered as
   * grantable here while org settings hid it and every run refused to read it.
   * The two now share one lister and cannot disagree again.
   */
  it("does not offer a symlinked KB or skill folder the store listings hide", () => {
    const store = setupTestStore(ctx);
    const outside = ctx.makeTempDir();
    writeFileSync(path.join(outside, "SKILL.md"), "outside the store");
    mkdirSync(path.join(store.dataRoot, "skills"), { recursive: true });
    mkdirSync(path.join(store.dataRoot, "kb"), { recursive: true });
    symlinkSync(outside, path.join(store.dataRoot, "skills", "linked-skill"));
    symlinkSync(outside, path.join(store.dataRoot, "kb", "linked-kb"));

    const groups = buildResourceCatalog(store.db, store.dataRoot);
    const offered = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(offered).not.toContain("linked-skill");
    expect(offered).not.toContain("linked-kb");
  });

  /**
   * Ruling 479(b) (F40-37): live, `cloudflare-api` needed an OAuth sign-in, so
   * every run dropped it, while the Agents page painted its chip like its
   * healthy neighbours. The catalog carries the registry's word against a
   * server, in the run resolver's order. Canary: drop `mcpRunWarning`'s oauth
   * branch and the first expectation reads undefined.
   */
  it("carries why a run gets none of a server's tools: sign-in, credential, reachability", () => {
    const store = setupTestStore(ctx);
    const now = new Date().toISOString();
    const insert = store.db.prepare(
      `INSERT INTO org_mcp_servers (id, name, transport, target, cred_ref, oauth_json, up, created_at, updated_at)
       VALUES (?, ?, 'HTTP', 'https://mcp.example/mcp', ?, ?, ?, ?, ?)`,
    );
    insert.run("m1", "cloudflare-api", null, JSON.stringify({ status: "needs_sign_in" }), 0, now, now);
    insert.run("m2", "expired-api", null, JSON.stringify({ status: "expired" }), 1, now, now);
    insert.run("m3", "legacy-cred", "plaintext-token", null, 1, now, now);
    insert.run("m4", "down-mcp", null, null, 0, now, now);
    insert.run("m5", "cloudflare-docs", null, null, 1, now, now);
    insert.run("m6", "signed-in", null, JSON.stringify({ status: "signed_in" }), 1, now, now);

    const items = buildResourceCatalog(store.db, store.dataRoot).find((g) => g.key === "mcps")!.items;
    const warning = (id: string) => items.find((i) => i.id === id)?.warning;
    // A sign-in outranks the failed probe it also carries: the run drops it first.
    expect(warning("cloudflare-api")).toEqual({
      note: "needs sign-in",
      title:
        "Runs do not mount cloudflare-api until an org admin signs it in (Instance settings → Agent resources).",
    });
    expect(warning("expired-api")?.note).toBe("sign-in expired");
    expect(warning("expired-api")?.title).toContain("signs it in again");
    expect(warning("legacy-cred")?.note).toBe("credential unreadable");
    expect(warning("down-mcp")?.note).toBe("unreachable");
    // Healthy rows claim nothing, and carry no key at all.
    expect(items.find((i) => i.id === "cloudflare-docs")).toEqual({ id: "cloudflare-docs", def: false });
    expect(warning("signed-in")).toBeUndefined();
  });

  it("handles a store with no resources without throwing", () => {
    const dataRoot = ctx.makeTempDir();
    const store = setupTestStore(ctx);
    const catalog = buildResourceCatalog(store.db, dataRoot);
    // Three groups always present; all three are empty in an empty store — the
    // reserved `viberr` name is no longer synthesized into the MCP group.
    expect(catalog.map((g) => g.key).sort()).toEqual(["kb", "mcps", "skills"]);
    expect(catalog.find((g) => g.key === "mcps")!.items).toEqual([]);
  });
});
