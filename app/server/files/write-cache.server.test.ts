import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logging/logger.server";
import { freshestContent, rememberWrite, resetWriteCacheForTests } from "./write-cache.server";

/**
 * The stale-read shield that every canonical file writer (task.md, project.md,
 * epics/*.md) reads through. Nothing imported it before pass 33, so the guard
 * could be deleted and every gate would stay green — ruling 65: a ruling whose
 * guard cannot go red gets reverted in silence.
 *
 * What it really promises is narrow, and these tests hold it to exactly that:
 * a read that disagrees with what THIS process last wrote to the same absolute
 * path is repaired ONLY while the file's mtime has not advanced past that
 * write (plus 100 ms of slack). It is not a cache, not a write-back buffer and
 * not a lock — an external writer still wins, and an unstattable path is never
 * repaired at all.
 *
 * The live defect it exists for (VIB-1, 2026-07-17): the reviewer's reply
 * comment landed on disk, the verdict's locked read-modify-write 2 ms later
 * read the pre-comment bytes off the VirtioFS cache, and its write erased the
 * comment permanently.
 */

const OURS = "---\nkey: VIB-1\n---\n\nthe write that must survive\n";
const STALE = "---\nkey: VIB-1\n---\n\nthe pre-write bytes the mount handed back\n";
const HUMAN = "---\nkey: VIB-1\n---\n\nedited by a human in an editor\n";

let dir = "";

/** Put the file's mtime at an exact wall-clock instant (ms). */
function setMtime(abs: string, atMs: number): void {
  const seconds = atMs / 1000;
  utimesSync(abs, seconds, seconds);
}

/** Our own write really landed on disk, and we remembered it. */
function ourWriteLanded(abs: string, content: string): void {
  writeFileSync(abs, content);
  rememberWrite(abs, content);
}

/** The cached mount hands a reader older bytes, with the pre-write mtime. */
function mountServesStaleBytes(abs: string, content: string): void {
  writeFileSync(abs, content);
  setMtime(abs, Date.now() - 10_000);
}

const taskFile = { kind: "task-file", id: "VIB-1" };

beforeEach(() => {
  resetWriteCacheForTests();
  dir = mkdtempSync(path.join(tmpdir(), "viberr-write-cache-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  resetWriteCacheForTests();
});

describe("freshestContent — the read-your-own-writes repair", () => {
  it("repairs a stale read of our own write, and says so in the log", () => {
    // THE defect this module exists for: a locked read-modify-write that sees
    // the pre-write bytes serializes them back and erases the earlier write
    // permanently (VIB-1). Canary: return `diskContent` at the end of
    // freshestContent instead of `remembered.content`.
    const abs = path.join(dir, "task.md");
    ourWriteLanded(abs, OURS);
    mountServesStaleBytes(abs, STALE);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(abs, STALE, taskFile)).toBe(OURS);

    // The repair is never silent — an incident is only diagnosable if the warn
    // names the file, so the field key follows the caller's kind.
    expect(warn.mock.calls[0]?.[0]).toBe(
      "stale task-file read repaired from the in-process write cache",
    );
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ taskKey: "VIB-1", absPath: abs });
  });

  it("an EXTERNAL edit wins — a newer mtime is a writer we must not overwrite", () => {
    // The shield must not turn into a write-back cache that reverts a human
    // editing task.md (or another process) back to what the app last wrote.
    // Canary: drop the `mtimeMs > wroteAtMs + slack` check.
    const abs = path.join(dir, "task.md");
    ourWriteLanded(abs, OURS);
    writeFileSync(abs, HUMAN);
    setMtime(abs, Date.now() + 60_000);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(abs, HUMAN, taskFile)).toBe(HUMAN);
    expect(warn).not.toHaveBeenCalled();
  });

  it("REFUSES to repair a path it cannot stat — a vanished file is not resurrected", () => {
    // Staleness is only provable against an mtime. With no file to stat (the
    // task was deleted, the data root went away, ESTALE on the mount) the
    // module has no evidence and must hand back what the caller read rather
    // than resurrect bytes into a file that no longer exists.
    const abs = path.join(dir, "gone", "task.md");
    rememberWrite(abs, OURS);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(abs, "", taskFile)).toBe("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("a path this process never wrote is disk-truth, even with a sibling write remembered", () => {
    // The memory is keyed by absolute path. One task's write must never leak
    // into another task's read — that would be a far worse defect than the one
    // being repaired.
    const ours = path.join(dir, "VIB-1.md");
    const other = path.join(dir, "VIB-2.md");
    ourWriteLanded(ours, OURS);
    mountServesStaleBytes(other, STALE);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(other, STALE, { kind: "task-file", id: "VIB-2" })).toBe(STALE);
    expect(warn).not.toHaveBeenCalled();
  });

  it("nothing remembered at all — the disk read passes through untouched", () => {
    const abs = path.join(dir, "task.md");
    writeFileSync(abs, STALE);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(abs, STALE, taskFile)).toBe(STALE);
    expect(warn).not.toHaveBeenCalled();
  });

  it("an agreeing read is returned as-is and logs nothing — no warn noise on the happy path", () => {
    // The overwhelmingly common case is disk == our write. It must cost no log
    // line, or the warn stops meaning "a stale read really happened".
    const abs = path.join(dir, "task.md");
    ourWriteLanded(abs, OURS);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(abs, OURS, taskFile)).toBe(OURS);
    expect(warn).not.toHaveBeenCalled();
  });

  it("the LATEST write is the one restored — a superseded write never comes back", () => {
    // Two back-to-back writes (pass-31 gotcha 10: two link-status writes on a
    // cached mount) must converge on the second. Restoring the first would be
    // the same data loss with extra steps.
    const abs = path.join(dir, "epic-1.md");
    ourWriteLanded(abs, "first write\n");
    ourWriteLanded(abs, "second write\n");
    mountServesStaleBytes(abs, STALE);
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(abs, STALE, { kind: "epic-file", id: "epic-1" })).toBe("second write\n");
  });

  it("an edit landing INSIDE the 100 ms slack loses — the deliberate trade, stated", () => {
    // Honest documentation of the limit, not an endorsement: mtime granularity
    // and clock skew between the write and the rename's recorded time force
    // ~100 ms of slack, so an external edit within that window is
    // indistinguishable from our own stale cache and is discarded. The module
    // chooses "never lose our own write" over "never lose a same-instant
    // external edit". Move MTIME_SLACK_MS to 0 and this test goes red — which
    // is the point: the size of the window is a decision, not an accident.
    const abs = path.join(dir, "task.md");
    const before = Date.now();
    ourWriteLanded(abs, OURS);
    writeFileSync(abs, HUMAN);
    setMtime(abs, before + 50);
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(abs, HUMAN, taskFile)).toBe(OURS);

    // One second past the write is unambiguously another writer, and wins.
    setMtime(abs, before + 1_000);
    expect(freshestContent(abs, HUMAN, taskFile)).toBe(HUMAN);
  });

  it("names the file by its caller's own key: projectSlug for project.md, epicId for an epic", () => {
    // Three writers share one module; a warn that called every id "taskKey"
    // would be ungreppable during the next incident. Ruling 503: the epic
    // writer took the goal writer's place.
    const project = path.join(dir, "project.md");
    const epic = path.join(dir, "epic-1.md");
    ourWriteLanded(project, OURS);
    ourWriteLanded(epic, OURS);
    mountServesStaleBytes(project, STALE);
    mountServesStaleBytes(epic, STALE);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    freshestContent(project, STALE, { kind: "project-file", id: "viberr-core" });
    freshestContent(epic, STALE, { kind: "epic-file", id: "epic-1" });

    expect(warn.mock.calls[0]?.[0]).toBe(
      "stale project-file read repaired from the in-process write cache",
    );
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ projectSlug: "viberr-core" });
    expect(warn.mock.calls[1]?.[0]).toBe("stale epic-file read repaired from the in-process write cache");
    expect(warn.mock.calls[1]?.[1]).toMatchObject({ epicId: "epic-1" });
  });
});

describe("rememberWrite — the bound", () => {
  /** Remember `count` synthetic paths; only `real` ones exist on disk. */
  function rememberMany(count: number, start = 0): string[] {
    const paths: string[] = [];
    for (let i = start; i < start + count; i++) {
      const abs = path.join(dir, `filler-${i}.md`);
      rememberWrite(abs, `filler ${i}\n`);
      paths.push(abs);
    }
    return paths;
  }

  it("holds at most 500 paths — the oldest is dropped, the newest still repairs", () => {
    // The map is process-lifetime state in a long-running server: unbounded, it
    // would hold the full text of every file ever written. The bound is the
    // reason it is safe to remember every write, so it has to actually bind.
    const oldest = path.join(dir, "oldest.md");
    ourWriteLanded(oldest, OURS);
    rememberMany(499); // 500 entries total, the cap
    const newest = path.join(dir, "newest.md");
    ourWriteLanded(newest, OURS); // evicts `oldest`
    mountServesStaleBytes(oldest, STALE);
    mountServesStaleBytes(newest, STALE);
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(oldest, STALE, taskFile)).toBe(STALE);
    expect(freshestContent(newest, STALE, taskFile)).toBe(OURS);
  });

  it("re-writing a path refreshes it to the tail — a hot file is not the one evicted", () => {
    // The file being written every few seconds is precisely the file a stale
    // read will hit. If re-writing did not move it to the tail, the busiest
    // task.md in the instance would be the first one dropped.
    const hot = path.join(dir, "hot.md");
    ourWriteLanded(hot, "v1\n");
    rememberMany(499); // 500 entries; `hot` is the oldest
    ourWriteLanded(hot, OURS); // re-write: no eviction, moves to the tail
    rememberMany(1, 499); // one new path evicts the oldest, which is no longer `hot`
    mountServesStaleBytes(hot, STALE);
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(hot, STALE, taskFile)).toBe(OURS);
  });
});
