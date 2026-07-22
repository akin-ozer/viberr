import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { unreachableFetch } from "../../../test-support/fake-github";
import { createTestDbContext } from "../../../test-support/test-db";
import { kbDirPath, skillDirPath } from "~/server/files/file-store-root.server";
import {
  deleteKnowledgeBase,
  deleteMcpServer,
  deleteSkill,
  discoverStdioMcpTools,
  getKnowledgeBase,
  getSkill,
  listKnowledgeBases,
  listSkills,
  type McpSpawn,
  probeMcpTarget,
  reindexKnowledgeBase,
  saveKnowledgeBase,
  saveMcpServer,
  saveSkill,
  testMcpServer,
} from "./resources.server";

/**
 * A fake stdio MCP server: answers the JSON-RPC `initialize` and `tools/list`
 * handshake with `tools` tools — no real process spawned.
 */
function fakeMcpSpawn(tools: number): McpSpawn {
  return () => {
    const stdout = new EventEmitter();
    const emit = (obj: unknown) =>
      queueMicrotask(() =>
        stdout.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`)),
      );
    return {
      stdin: {
        write(data: string) {
          for (const line of data.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            const msg = JSON.parse(t) as { method?: string };
            if (msg.method === "initialize") {
              emit({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
            } else if (msg.method === "tools/list") {
              emit({
                jsonrpc: "2.0",
                id: 2,
                result: {
                  tools: Array.from({ length: tools }, (_, i) => ({ name: `t${i}` })),
                },
              });
            }
          }
        },
        end() {},
      },
      stdout: { on: (event, cb) => stdout.on(event, cb) },
      on() {},
      kill() {},
    };
  };
}

/** A stdio spawn that never answers (exercises the timeout path). */
const silentSpawn: McpSpawn = () => ({
  stdin: { write() {}, end() {} },
  stdout: { on() {} },
  on() {},
  kill() {},
});

/** A spawn that fails immediately (command not found). */
const failingSpawn: McpSpawn = () => {
  throw new Error("ENOENT");
};

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
    expect(reindexed.toast).toBe("Architecture notes re-scanned — 1 docs");
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

  it("an EMPTY submitted body keeps the existing SKILL.md (E4 — no blanking)", () => {
    const { db, dataRoot, ctx } = setup();
    const { skill } = saveSkill(
      db,
      { name: "api-design", summary: "REST rules.", body: "# precious content" },
      ACTOR,
      ctx,
    );

    // Summary-only edit round-trips an empty body (e.g. the modal field was
    // cleared / never loaded) — the on-disk body must survive.
    const updated = saveSkill(
      db,
      { id: skill.id, name: "api-design", summary: "Updated summary.", body: "" },
      ACTOR,
      ctx,
    );
    expect(updated.toast).toBe(
      "Skill api-design updated — existing SKILL.md kept",
    );
    const onDisk = path.join(skillDirPath("api-design", dataRoot), "SKILL.md");
    expect(readFileSync(onDisk, "utf8")).toBe("# precious content");
    expect(updated.skill.summary).toBe("Updated summary.");

    // The explicit clear flag is the ONLY way to blank it.
    const cleared = saveSkill(
      db,
      {
        id: skill.id,
        name: "api-design",
        summary: "Updated summary.",
        body: "",
        clearBody: true,
      },
      ACTOR,
      ctx,
    );
    expect(cleared.toast).toBe("Skill api-design updated — SKILL.md rewritten");
    expect(readFileSync(onDisk, "utf8")).toBe("");
  });

  it("refuses to write a body when the on-disk SKILL.md exceeds the read cap (E4)", () => {
    const { db, dataRoot, ctx } = setup();
    const { skill } = saveSkill(
      db,
      { name: "big-skill", summary: "Huge on disk.", body: "seed" },
      ACTOR,
      ctx,
    );
    // Grow SKILL.md past the 256 KB editor read cap — from here on, any body
    // the UI round-trips is a TRUNCATED copy of the file.
    const onDisk = path.join(skillDirPath("big-skill", dataRoot), "SKILL.md");
    writeFileSync(onDisk, "x".repeat(256 * 1024 + 10));

    expect(() =>
      saveSkill(
        db,
        { id: skill.id, name: "big-skill", summary: "Huge on disk.", body: "truncated round-trip" },
        ACTOR,
        ctx,
      ),
    ).toThrowError(/256 KB/);
    // Nothing was written.
    expect(readFileSync(onDisk, "utf8")).toHaveLength(256 * 1024 + 10);

    // A body-keeping save (empty body, e.g. summary edit) still works.
    const kept = saveSkill(
      db,
      { id: skill.id, name: "big-skill", summary: "New summary here.", body: "" },
      ACTOR,
      ctx,
    );
    expect(kept.toast).toContain("existing SKILL.md kept");
    expect(readFileSync(onDisk, "utf8")).toHaveLength(256 * 1024 + 10);
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

    // stdio save runs a REAL best-effort tool-count discovery (fake spawn).
    const stdio = await saveMcpServer(
      db,
      { name: "postgres-readonly", transport: "stdio", target: "npx -y @mcp/pg", cred: "" },
      ACTOR,
      { spawnImpl: fakeMcpSpawn(7) },
    );
    expect(stdio.mcp).toMatchObject({ up: true, tools: 7 });
    expect(stdio.toast).toBe(
      "postgres-readonly saved — 7 tools discovered · spawned per run",
    );

    // A command that never answers → honest unreachable, count stays null.
    const dead = await saveMcpServer(
      db,
      { name: "broken-stdio", transport: "stdio", target: "npx -y @mcp/nope", cred: "" },
      ACTOR,
      { spawnImpl: silentSpawn, timeoutMs: 20 },
    );
    expect(dead.mcp).toMatchObject({ up: false, tools: null });
    expect(dead.toast).toContain("didn't respond");

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

    const healthy = await testMcpServer(db, mcp.id, { fetchImpl: respondingFetch });
    expect(healthy.toast).toMatch(/^github-mcp healthy — 14 tools · \d+ms$/);

    const dead = await testMcpServer(db, mcp.id, { fetchImpl: unreachableFetch() });
    expect(dead.mcp.up).toBe(false);
    expect(dead.toast).toContain("github-mcp unreachable");

    const { toast } = deleteMcpServer(db, mcp.id, ACTOR);
    expect(toast).toBe("github-mcp removed");
  });

  it("stdio test discovers a real tool count; a dead command is unreachable", async () => {
    const { db } = setup();
    const { mcp } = await saveMcpServer(
      db,
      { name: "postgres-readonly", transport: "stdio", target: "npx -y @mcp/pg", cred: "" },
      ACTOR,
      { spawnImpl: silentSpawn, timeoutMs: 20 }, // saved unreachable first
    );
    expect(mcp.up).toBe(false);

    const healthy = await testMcpServer(db, mcp.id, {
      spawnImpl: fakeMcpSpawn(3),
    });
    expect(healthy.mcp).toMatchObject({ up: true, tools: 3 });
    expect(healthy.toast).toMatch(/^postgres-readonly healthy — 3 tools · \d+ms$/);

    const dead = await testMcpServer(db, mcp.id, {
      spawnImpl: failingSpawn,
    });
    expect(dead.mcp).toMatchObject({ up: false, tools: null });
    expect(dead.toast).toBe("postgres-readonly unreachable — command not found");
  });

  it("discoverStdioMcpTools: handshake success, timeout, spawn failure", async () => {
    expect(
      await discoverStdioMcpTools("mcp-server", { spawnImpl: fakeMcpSpawn(5) }),
    ).toMatchObject({ kind: "up", tools: 5 });
    expect(
      await discoverStdioMcpTools("mcp-server", {
        spawnImpl: silentSpawn,
        timeoutMs: 20,
      }),
    ).toMatchObject({ kind: "down", reason: "timed out" });
    expect(
      await discoverStdioMcpTools("mcp-server", { spawnImpl: failingSpawn }),
    ).toMatchObject({ kind: "down", reason: "command not found" });
  });
});

describe("disk is truth (finding #7)", () => {
  it("lists an on-disk skill folder that has no metadata row, with defaults", () => {
    const { db, dataRoot, ctx } = setup();
    // A skill folder that appeared on disk outside org settings (like the
    // shipped *-expertise skills), with frontmatter description.
    const dir = skillDirPath("developer-expertise", dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\nname: developer-expertise\ndescription: Implement a task's stage work.\n---\n# body",
    );

    const skills = listSkills(db, ctx);
    const disk = skills.find((s) => s.name === "developer-expertise")!;
    expect(disk).toBeTruthy();
    expect(disk.id).toBe("disk:developer-expertise");
    expect(disk.summary).toBe("Implement a task's stage work.");
    expect(disk.updatedAt).toBeNull();
    // getSkill resolves the synthetic id (StoreBrowser / edit rely on this).
    expect(getSkill(db, disk.id, ctx)!.body).toContain("# body");
  });

  it("editing a disk-only skill adopts it into a real metadata row", () => {
    const { db, dataRoot, ctx } = setup();
    const dir = skillDirPath("reviewer-expertise", dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "# original");

    const before = getSkill(db, "disk:reviewer-expertise", ctx)!;
    const { skill, toast } = saveSkill(
      db,
      { id: before.id, name: "reviewer-expertise", summary: "Review verdicts.", body: "# edited" },
      ACTOR,
      ctx,
    );
    expect(toast).toBe("Skill reviewer-expertise updated — SKILL.md rewritten");
    expect(skill.id).toMatch(/^sk_/); // now a real row, not synthetic
    expect(skill.summary).toBe("Review verdicts.");
    // Only ONE entry — no duplicate between disk + row.
    expect(listSkills(db, ctx).filter((s) => s.name === "reviewer-expertise")).toHaveLength(1);
  });

  it("delete removes a disk-only skill folder even with no row", () => {
    const { db, dataRoot, ctx } = setup();
    const dir = skillDirPath("orphan-expertise", dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "# body");

    const { toast } = deleteSkill(db, "disk:orphan-expertise", ACTOR, ctx);
    expect(toast).toBe("Skill orphan-expertise deleted");
    expect(existsSync(dir)).toBe(false);
    expect(listSkills(db, ctx)).toHaveLength(0);
  });

  it("re-indexing a disk-only KB adopts it so the timestamp sticks", () => {
    const { db, dataRoot, ctx } = setup();
    const dir = kbDirPath("runbooks", dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "deploy.md"), "# runbook");

    const before = listKnowledgeBases(db, ctx).find((k) => k.dir === "runbooks")!;
    expect(before.id).toBe("disk:runbooks");
    expect(before.lastIndexedAt).toBeNull();

    reindexKnowledgeBase(db, before.id, ACTOR, ctx);
    const after = listKnowledgeBases(db, ctx).find((k) => k.dir === "runbooks")!;
    expect(after.id).toMatch(/^kb_/);
    expect(after.lastIndexedAt).not.toBeNull();
  });

  it("a fresh create refuses to clobber an existing on-disk skill folder", () => {
    const { db, dataRoot, ctx } = setup();
    const dir = skillDirPath("api-design", dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), "# keep me");

    expect(() =>
      saveSkill(
        db,
        { name: "api-design", summary: "New skill.", body: "" },
        ACTOR,
        ctx,
      ),
    ).toThrowError(/already exists/);
    // Original content untouched.
    expect(getSkill(db, "disk:api-design", ctx)!.body).toContain("# keep me");
  });

  it("rejects a path-traversal disk id instead of escaping the store root", () => {
    const { db, ctx } = setup();
    // A crafted synthetic id must NOT resolve to a path outside the store.
    for (const evil of [
      "disk:../../etc/passwd",
      "disk:..",
      "disk:a/b",
      "disk:a\\b",
    ]) {
      expect(() => deleteSkill(db, evil, ACTOR, ctx)).toThrowError(/No such skill/);
      expect(() => deleteKnowledgeBase(db, evil, ACTOR, ctx)).toThrowError(
        /No such knowledge base/,
      );
    }
  });
});
