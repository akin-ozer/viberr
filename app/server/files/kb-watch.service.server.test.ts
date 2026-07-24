import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  isKbWatcherAlive,
  kbDirOfChange,
  startKbWatcher,
  stopKbWatcher,
} from "./kb-watch.service.server";
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
    const { kb } = await saveKnowledgeBase(
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
    await saveKnowledgeBase(
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

describe("startKbWatcher — live watcher (R-D/P11-60)", () => {
  const ctx = createTestDbContext();
  afterEach(() => {
    stopKbWatcher();
    ctx.cleanup();
  });

  function kbFile(dataRoot: string, dir: string, file: string, body = "x") {
    const abs = path.join(dataRoot, "kb", dir);
    mkdirSync(abs, { recursive: true });
    writeFileSync(path.join(abs, file), body);
    return path.join(abs, file);
  }

  it("re-indexes an 'on change' KB when a store file changes (debounced)", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    kbFile(dataRoot, "notes", "a.md");
    await saveKnowledgeBase(
      db,
      { name: "Notes", refresh: "on change" },
      { userId: "u", label: "u" },
      { dataRoot },
    );
    // Pin `last_indexed_at` to a deterministic OLD sentinel. saveKnowledgeBase's
    // initial index and the watcher re-index can land in the SAME wall-clock
    // millisecond (their ISO strings then compare equal → flaky). Seeding an
    // old value makes the re-index's `now` provably different without depending
    // on sub-millisecond timing.
    const OLD = "2000-01-01T00:00:00.000Z";
    db.prepare(`UPDATE org_knowledge_bases SET last_indexed_at = ? WHERE dir='notes'`).run(OLD);

    const watcher = startKbWatcher({ dataRoot, db });
    expect(watcher).not.toBeNull();

    // Add a doc; the watcher debounces (250ms) then re-indexes. Poll until the
    // sentinel is overwritten (or time out) so the assertion never races.
    //
    // The budget is deliberately generous. This is the one test in the suite
    // that waits on a real OS filesystem event, and the path is
    // fsevents-latency + 250 ms debounce + a re-index — none of which the test
    // controls. Under a full parallel `npm test` it overran the old 2 s cap and
    // failed, while passing every time in isolation. A tight bound on an
    // uncontrolled latency does not test anything extra; it just fails on a
    // loaded machine. The loop still exits the instant the value changes, so
    // the common case stays sub-second.
    kbFile(dataRoot, "notes", "b.md", "more");
    let after = { last_indexed_at: OLD as string | null };
    for (let i = 0; i < 200 && after.last_indexed_at === OLD; i++) {
      await new Promise((r) => setTimeout(r, 50));
      after = db
        .prepare(`SELECT last_indexed_at FROM org_knowledge_bases WHERE dir='notes'`)
        .get() as { last_indexed_at: string | null };
    }
    expect(after.last_indexed_at).not.toBe(OLD);
    expect(after.last_indexed_at).not.toBeNull();
    // Vitest's default 5 s per-test timeout would cut the poll budget short and
    // report a timeout instead of the real assertion.
  }, 15_000);

  it("is a HMR-safe singleton — a second start on the same root reuses the watcher", () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    mkdirSync(path.join(dataRoot, "kb"), { recursive: true });
    const first = startKbWatcher({ dataRoot, db });
    const second = startKbWatcher({ dataRoot, db });
    expect(second).toBe(first); // same handle, not a stacked duplicate
  });

  it("returns null when the kb root does not exist", () => {
    const db = ctx.makeDb();
    // A temp dir with NO kb/ subdir.
    const dataRoot = ctx.makeTempDir();
    expect(startKbWatcher({ dataRoot, db })).toBeNull();
  });

  it("isKbWatcherAlive tracks the handle for /resources/health parity (DM-2)", () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    mkdirSync(path.join(dataRoot, "kb"), { recursive: true });
    expect(isKbWatcherAlive()).toBe(false); // not started yet
    startKbWatcher({ dataRoot, db });
    expect(isKbWatcherAlive()).toBe(true);
    stopKbWatcher();
    expect(isKbWatcherAlive()).toBe(false);
  });
});
