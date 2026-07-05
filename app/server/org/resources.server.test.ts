import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unreachableFetch } from "../../../test-support/fake-github";
import { createTestDbContext } from "../../../test-support/test-db";
import { kbDirPath, skillDirPath } from "~/server/files/file-store-root.server";
import {
  deleteKnowledgeBase,
  deleteMcpServer,
  deleteSkill,
  getKnowledgeBase,
  getSkill,
  listKnowledgeBases,
  probeMcpTarget,
  reindexKnowledgeBase,
  saveKnowledgeBase,
  saveMcpServer,
  saveSkill,
  testMcpServer,
} from "./resources.server";

/**
 * Agent-resource CRUD: every KB/skill mutation is a REAL folder mutation
 * under the temp data root; scans read straight from disk (external edits
 * appear); MCP health probes are injectable + honest.
 */

const dbCtx = createTestDbContext();
afterEach(dbCtx.cleanup);

const ACTOR = { userId: "u_t", label: "t@test" };

function setup() {
  const db = dbCtx.makeDb();
  const dataRoot = dbCtx.makeTempDir();
  return { db, dataRoot, ctx: { dataRoot } };
}

/** An "up" probe transport: any HTTP response counts as reachable. */
const respondingFetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;

describe("knowledge bases", () => {
  it("create makes the real folder; scan sees files added outside Viberr", () => {
    const { db, dataRoot, ctx } = setup();
    const { kb, toast } = saveKnowledgeBase(
      db,
      { name: "Architecture notes", refresh: "on change" },
      ACTOR,
      ctx,
    );
    expect(toast).toBe(
      "Architecture notes created — folder ready at store://kb/architecture-notes/",
    );
    const dir = kbDirPath("architecture-notes", dataRoot);
    expect(existsSync(dir)).toBe(true);
    expect(kb.fileCount).toBe(0);

    // External edit → visible on the next read (the def-note promise).
    mkdirSync(path.join(dir, "decisions"), { recursive: true });
    writeFileSync(path.join(dir, "decisions", "adr-001.md"), "# ADR");
    const fresh = getKnowledgeBase(db, kb.id, ctx)!;
    expect(fresh.fileCount).toBe(1);
    expect(fresh.tree[0]).toMatchObject({ type: "dir", name: "decisions" });

    const reindexed = reindexKnowledgeBase(db, kb.id, ACTOR, ctx);
    expect(reindexed.toast).toBe("Architecture notes re-indexed — 1 docs");
  });

  it("rename moves the folder; collisions are refused", () => {
    const { db, dataRoot, ctx } = setup();
    const a = saveKnowledgeBase(db, { name: "Alpha", refresh: "manual" }, ACTOR, ctx);
    saveKnowledgeBase(db, { name: "Beta", refresh: "manual" }, ACTOR, ctx);
    writeFileSync(path.join(kbDirPath("alpha", dataRoot), "x.md"), "x");

    const renamed = saveKnowledgeBase(
      db,
      { id: a.kb.id, name: "Alpha Two", refresh: "manual" },
      ACTOR,
      ctx,
    );
    expect(renamed.kb.dir).toBe("alpha-two");
    expect(existsSync(kbDirPath("alpha", dataRoot))).toBe(false);
    expect(existsSync(path.join(kbDirPath("alpha-two", dataRoot), "x.md"))).toBe(true);

    expect(() =>
      saveKnowledgeBase(db, { id: a.kb.id, name: "Beta", refresh: "manual" }, ACTOR, ctx),
    ).toThrowError(/already exists/);
  });

  it("delete removes the folder and the row", () => {
    const { db, dataRoot, ctx } = setup();
    const { kb } = saveKnowledgeBase(db, { name: "Gone Soon", refresh: "manual" }, ACTOR, ctx);
    const { toast } = deleteKnowledgeBase(db, kb.id, ACTOR, ctx);
    expect(toast).toBe("Gone Soon deleted — agents lose it on next context load");
    expect(existsSync(kbDirPath("gone-soon", dataRoot))).toBe(false);
    expect(listKnowledgeBases(db, ctx)).toHaveLength(0);
  });
});

describe("skills", () => {
  it("create writes a real SKILL.md; body round-trips from disk", () => {
    const { db, dataRoot, ctx } = setup();
    const { skill, toast } = saveSkill(
      db,
      {
        name: "Terraform Review",
        summary: "Module review checklist.",
        body: "## Review checklist\n- state safety",
      },
      ACTOR,
      ctx,
    );
    expect(toast).toBe("Skill terraform-review created — SKILL.md written");
    const skillMd = path.join(skillDirPath("terraform-review", dataRoot), "SKILL.md");
    expect(existsSync(skillMd)).toBe(true);
    expect(skill.body).toContain("state safety");
    expect(skill.tree.map((n) => n.name)).toContain("SKILL.md");

    const updated = saveSkill(
      db,
      { id: skill.id, name: "terraform-review", summary: "Updated.", body: "## New body" },
      ACTOR,
      ctx,
    );
    expect(updated.toast).toBe("Skill terraform-review updated — SKILL.md rewritten");
    expect(getSkill(db, skill.id, ctx)!.body).toBe("## New body");
  });

  it("rename moves the skill folder; delete removes it", () => {
    const { db, dataRoot, ctx } = setup();
    const { skill } = saveSkill(
      db,
      { name: "api-design", summary: "REST rules.", body: "# body" },
      ACTOR,
      ctx,
    );
    const renamed = saveSkill(
      db,
      { id: skill.id, name: "api-guidelines", summary: "REST rules.", body: "# body" },
      ACTOR,
      ctx,
    );
    expect(renamed.skill.name).toBe("api-guidelines");
    expect(existsSync(skillDirPath("api-design", dataRoot))).toBe(false);

    const { toast } = deleteSkill(db, skill.id, ACTOR, ctx);
    expect(toast).toBe("Skill api-guidelines deleted");
    expect(existsSync(skillDirPath("api-guidelines", dataRoot))).toBe(false);
  });
});

describe("mcp servers", () => {
  it("probe is honest: any HTTP response = up, network error = down, stdio = skipped", async () => {
    expect(
      await probeMcpTarget("HTTP", "https://mcp.internal:1/sse", {
        fetchImpl: respondingFetch,
      }),
    ).toMatchObject({ kind: "up" });
    expect(
      await probeMcpTarget("HTTP", "https://mcp.internal:1/sse", {
        fetchImpl: unreachableFetch(),
      }),
    ).toMatchObject({ kind: "down" });
    expect(await probeMcpTarget("stdio", "npx -y whatever")).toEqual({
      kind: "skipped",
    });
    expect(
      await probeMcpTarget("HTTP", "not a url", { fetchImpl: respondingFetch }),
    ).toMatchObject({ kind: "down" });
  });

  it("save probes HTTP targets and never fabricates tool counts", async () => {
    const { db } = setup();
    const up = await saveMcpServer(
      db,
      { name: "GitHub MCP", transport: "HTTP", target: "https://x.dev/sse", cred: "" },
      ACTOR,
      { fetchImpl: respondingFetch },
    );
    expect(up.mcp).toMatchObject({ name: "github-mcp", up: true, tools: null });
    expect(up.toast).toContain("endpoint reachable");

    const down = await saveMcpServer(
      db,
      { name: "browserbase", transport: "HTTP", target: "https://y.dev/sse", cred: "secret://mcp/bb" },
      ACTOR,
      { fetchImpl: unreachableFetch() },
    );
    expect(down.mcp.up).toBe(false);
    expect(down.toast).toContain("unreachable");

    const stdio = await saveMcpServer(
      db,
      { name: "postgres-readonly", transport: "stdio", target: "npx -y @mcp/pg", cred: "" },
      ACTOR,
    );
    expect(stdio.mcp.up).toBeNull();
    expect(stdio.toast).toBe("postgres-readonly saved — spawned per run, sandboxed");

    // Duplicate name guard.
    await expect(
      saveMcpServer(
        db,
        { name: "github-mcp", transport: "HTTP", target: "https://z.dev", cred: "" },
        ACTOR,
        { fetchImpl: respondingFetch },
      ),
    ).rejects.toThrowError(/already exists/);
  });

  it("test updates health and includes known tool counts in the toast", async () => {
    const { db } = setup();
    const { mcp } = await saveMcpServer(
      db,
      { name: "github-mcp", transport: "HTTP", target: "https://x.dev/sse", cred: "" },
      ACTOR,
      { fetchImpl: respondingFetch },
    );
    // Seeded rows carry demo tool counts — emulate one.
    db.prepare(`UPDATE org_mcp_servers SET tools_count = 14 WHERE id = ?`).run(mcp.id);

    const healthy = await testMcpServer(db, mcp.id, ACTOR, { fetchImpl: respondingFetch });
    expect(healthy.toast).toMatch(/^github-mcp healthy — 14 tools · \d+ms$/);

    const dead = await testMcpServer(db, mcp.id, ACTOR, { fetchImpl: unreachableFetch() });
    expect(dead.mcp.up).toBe(false);
    expect(dead.toast).toContain("github-mcp unreachable");

    const { toast } = deleteMcpServer(db, mcp.id, ACTOR);
    expect(toast).toBe("github-mcp removed");
  });
});
