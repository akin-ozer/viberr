import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { kbDirOfChange } from "./kb-watch.service.server";
import { reindexKnowledgeBaseByDir, saveKnowledgeBase } from "~/server/org/resources.server";

describe("kbDirOfChange", () => {
  const root = "/data/kb";
  it("returns the top-level KB dir of a nested change", () => {
    expect(kbDirOfChange(root, "architecture-notes/decisions/adr.md")).toBe(
      "architecture-notes",
    );
    expect(kbDirOfChange(root, "api-contracts/openapi.yaml")).toBe("api-contracts");
  });
  it("ignores dotfiles and out-of-tree paths", () => {
    expect(kbDirOfChange(root, ".git/HEAD")).toBeNull();
    expect(kbDirOfChange(root, "../secrets/x")).toBeNull();
    expect(kbDirOfChange(root, "")).toBeNull();
  });
});

describe("reindexKnowledgeBaseByDir (R-D watcher re-index)", () => {
  const ctx = createTestDbContext();
  afterEach(ctx.cleanup);

  function makeKbDir(dataRoot: string, dir: string, files: string[]) {
    const abs = path.join(dataRoot, "kb", dir);
    mkdirSync(abs, { recursive: true });
    for (const f of files) writeFileSync(path.join(abs, f), "content");
    return abs;
  }

  it("re-indexes an 'on change' KB by dir and moves last_indexed_at", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    makeKbDir(dataRoot, "notes", ["a.md"]);
    const { kb } = saveKnowledgeBase(
      db,
      { name: "Notes", refresh: "on change" },
      { userId: "u", label: "u" },
      { dataRoot },
    );
    expect(kb.dir).toBe("notes");
    // Add a second file, then re-index by dir (what the watcher does).
    writeFileSync(path.join(dataRoot, "kb", "notes", "b.md"), "more");
    const result = reindexKnowledgeBaseByDir(db, "notes", { dataRoot });
    expect(result).toEqual({ name: "Notes", docCount: 2 });
    const row = db
      .prepare(`SELECT last_indexed_at FROM org_knowledge_bases WHERE dir='notes'`)
      .get() as { last_indexed_at: string };
    expect(row.last_indexed_at).not.toBeNull();
  });

  it("skips a 'manual' KB (pinned to explicit re-scan)", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    makeKbDir(dataRoot, "pinned", ["a.md"]);
    saveKnowledgeBase(
      db,
      { name: "Pinned", refresh: "manual" },
      { userId: "u", label: "u" },
      { dataRoot },
    );
    expect(reindexKnowledgeBaseByDir(db, "pinned", { dataRoot })).toBeNull();
  });

  it("returns null for an unknown dir", () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    expect(reindexKnowledgeBaseByDir(db, "ghost", { dataRoot })).toBeNull();
  });
});
