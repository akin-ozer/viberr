import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  isKbWatcherAlive,
  kbDirOfChange,
  startKbWatcher,
  stopKbWatcher,
} from "./kb-watch.service.server";
import { reindexKnowledgeBaseByDir, saveKnowledgeBase } from "~/server/org/resources.server";
import { getSseBrokerStats } from "~/server/events/sse-broker.server";

/** node:sqlite hands back an untyped column bag, so the one column these tests
 *  read is fetched through a single place rather than re-named per call site. */
function lastIndexedAt(db: DatabaseSync): SQLOutputValue {
  return db
    .prepare(`SELECT last_indexed_at FROM org_knowledge_bases WHERE dir='notes'`)
    .get()!.last_indexed_at;
}

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
    const before = getSseBrokerStats().bufferedEvents;
    const result = reindexKnowledgeBaseByDir(db, "notes", { dataRoot });
    expect(result).toEqual({ name: "Notes", docCount: 2 });
    expect(lastIndexedAt(db)).not.toBeNull();
    // F32-2 (pass 32): the re-index PUBLISHES — the Settings page revalidates
    // instead of showing "re-scanned just now" over a stale doc count until a
    // manual reload. Canary: drop the publishResourceUpdated call in
    // reindexKnowledgeBaseByDir.
    expect(getSseBrokerStats().bufferedEvents).toBe(before + 1);
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
    // Chokidar arms asynchronously: a write landing inside the initial scan
    // is treated as pre-existing (ignoreInitial) and never emits. Wait for
    // `ready` — attached in the same synchronous frame as the start, so the
    // event cannot have fired yet — before mutating the store.
    await new Promise<void>((resolve) => watcher!.once("ready", () => resolve()));

    // Add a doc; the watcher debounces (250ms) then re-indexes. Poll until the
    // sentinel is overwritten (or time out) so the assertion never races.
    //
    // The budget is deliberately large, and that is the point. This is the ONLY
    // test in the suite whose subject is a real OS filesystem event: the path is
    // FSEvents delivery + a 250 ms debounce + a re-index, and the test controls
    // none of it. macOS coalesces FSEvents under load, and a full parallel
    // `npm test` has ~186 files churning temp directories — delivery was
    // measured past 10 s there while the same test passes in well under a
    // second alone. Two separate work streams hit this flake independently
    // before it was bounded properly.
    //
    // A tight bound does not make the assertion stronger; it just converts an
    // uncontrolled OS latency into a red suite, which trains people to re-run
    // instead of read. The loop exits the instant the value changes, so a
    // healthy run pays nothing for the headroom.
    kbFile(dataRoot, "notes", "b.md", "more");
    const deadline = Date.now() + 30_000;
    let after: SQLOutputValue = OLD;
    let lastTouch = Date.now();
    let touches = 0;
    while (after === OLD && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      // macOS can DROP (not just delay) a coalesced FSEvent outright when the
      // whole machine is churning temp dirs — observed under back-to-back full
      // suite runs. Re-offer the event every few seconds: a swallowed delivery
      // gets another chance, while a broken debounce/re-index path still never
      // converges and times out.
      if (Date.now() - lastTouch > 5_000) {
        lastTouch = Date.now();
        touches += 1;
        kbFile(dataRoot, "notes", "b.md", `more v${touches}`);
      }
      after = lastIndexedAt(db);
    }

    // Distinguish "the OS never delivered the event" from "the wiring is
    // broken" — otherwise a real regression and a slow machine produce the
    // identical failure message and the next person guesses.
    expect(
      after,
      isKbWatcherAlive()
        ? "watcher alive but no re-index within 30s — FSEvents never delivered, or the debounce/re-index path is broken"
        : "the watcher handle died before the change landed",
    ).not.toBe(OLD);
    expect(after).not.toBeNull();
  }, 45_000);

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
