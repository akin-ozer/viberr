import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { staleViewOf } from "../../../test-support/stale-mount";
import { logger } from "../logging/logger.server";
import { writeFileAtomic } from "./atomic-file.server";
import { freshestContent, writeAndRemember } from "./write-cache.server";

/**
 * The stale-read shield that every canonical file writer (task.md, project.md,
 * epics/*.md) reads through. Nothing imported it before pass 33, so the guard
 * could be deleted and every gate would stay green — ruling 8: a ruling whose
 * guard cannot go red gets reverted in silence.
 *
 * What it really promises is narrow, and these tests hold it to exactly that:
 * a read that disagrees with what THIS process last wrote to the same absolute
 * path is repaired ONLY while the path still shows the file that write put
 * there or the file it replaced (ruling 18). It is not a cache, not a
 * write-back buffer and not a lock — any other writer wins however soon after
 * ours it lands, and an unstattable path is never repaired at all.
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

/** What the store held before our write: another writer's file, stamped ten
 *  seconds back like a file that has sat in the store. */
function storeHeld(abs: string, content: string): void {
  writeFileAtomic(abs, content);
  const tenSecondsAgo = (Date.now() - 10_000) / 1000;
  utimesSync(abs, tenSecondsAgo, tenSecondsAgo);
}

const taskFile = { kind: "task-file", id: "VIB-1" };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "viberr-write-cache-"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("freshestContent — the read-your-own-writes repair", () => {
  /** A cached mount's stale views of our write, each returning the bytes the
   *  locked read got. */
  const staleViews: [string, (abs: string) => string][] = [
    [
      "fresh attributes over the bytes it replaced",
      (abs) => {
        writeAndRemember(abs, OURS);
        return STALE;
      },
    ],
    [
      "the file it replaced, old bytes and old stamp",
      (abs) => {
        storeHeld(abs, STALE);
        const stale = staleViewOf(abs);
        writeAndRemember(abs, OURS);
        stale.serve();
        return readFileSync(abs, "utf8");
      },
    ],
    [
      "fresh attributes over the bytes it replaced, with this process's clock 10 s behind the file system's",
      (abs) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() - 10_000);
        writeAndRemember(abs, OURS);
        return STALE;
      },
    ],
  ];

  it.each(staleViews)("repairs a stale read of our own write (%s), and says so in the log", (_view, readStale) => {
    // THE defect this module exists for: a locked read-modify-write that sees
    // the pre-write bytes serializes them back and erases the earlier write
    // permanently (VIB-1). Canaries: return `diskContent` at the end of
    // freshestContent (every row); leave the identity our write put there out
    // of the remembered ones (rows 1 and 3) or the one it replaced (row 2).
    // Row 3 is ruling 18's second half: the repair reads no clock. The mtime
    // window this module used to keep compared the file's stamp with
    // `Date.now()` at the write, so a container clock behind the host's by
    // more than 100 ms switched the repair off; bring any such comparison
    // back and row 3 goes red.
    const abs = path.join(dir, "task.md");
    const read = readStale(abs);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(abs, read, taskFile)).toBe(OURS);

    // The repair is never silent — an incident is only diagnosable if the warn
    // names the file, so the field key follows the caller's kind.
    expect(warn.mock.calls[0]?.[0]).toBe(
      "stale task-file read repaired from the in-process write cache",
    );
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ taskKey: "VIB-1", absPath: abs });
  });

  /** Another writer landing straight after our write, each returning the
   *  bytes it left at the path. */
  const otherWriters: [string, (abs: string) => string][] = [
    [
      "a restore or re-seed puts back, as a new file, exactly the bytes ours replaced",
      (abs) => {
        // The file ours replaced is stamped ten seconds back: a re-seed inside
        // the tick THAT file was stamped in, given its freed inode number, is
        // the blind spot the module states, not this row.
        storeHeld(abs, STALE);
        writeAndRemember(abs, OURS);
        writeFileAtomic(abs, STALE);
        return STALE;
      },
    ],
    [
      "a person's editor saves over ours in place",
      (abs) => {
        writeAndRemember(abs, OURS);
        writeFileSync(abs, HUMAN);
        return HUMAN;
      },
    ],
  ];

  it.each(otherWriters)("another writer wins however soon after ours it lands: %s", (_writer, write) => {
    // Ruling 18. The shield must not turn into a write-back cache that
    // reverts a restore, a person editing task.md or a test's re-seed to what
    // the app last wrote. The 100 ms window this module used to keep reverted
    // every writer inside it, and comparing contents cannot tell row 1 from a
    // stale view: those are the very bytes a stale mount serves. Only the
    // file's identity can. Canaries: repair whatever identity the path shows;
    // bring back a window of time after our write.
    const abs = path.join(dir, "task.md");
    const theirs = write(abs);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(abs, theirs, taskFile)).toBe(theirs);
    expect(warn).not.toHaveBeenCalled();
  });

  it("REFUSES to repair a path it cannot stat — a vanished file is not resurrected", () => {
    // Staleness is only provable against the file at the path. With no file to
    // stat (the task was deleted, the data root went away, ESTALE on the
    // mount) the module has no evidence and must hand back what the caller
    // read rather than resurrect bytes into a file that no longer exists.
    const abs = path.join(dir, "gone", "task.md");
    writeAndRemember(abs, OURS);
    rmSync(path.dirname(abs), { recursive: true, force: true });
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
    writeAndRemember(ours, OURS);
    writeFileSync(other, STALE);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(other, STALE, { kind: "task-file", id: "VIB-2" })).toBe(STALE);
    expect(warn).not.toHaveBeenCalled();
  });

  it("an agreeing read is returned as-is and logs nothing — no warn noise on the happy path", () => {
    // The overwhelmingly common case is disk == our write. It must cost no log
    // line, or the warn stops meaning "a stale read really happened".
    const abs = path.join(dir, "task.md");
    writeAndRemember(abs, OURS);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(abs, OURS, taskFile)).toBe(OURS);
    expect(warn).not.toHaveBeenCalled();
  });

  it("the LATEST write is the one restored — a superseded write never comes back", () => {
    // Two back-to-back writes (pass-31 gotcha 10: two link-status writes on a
    // cached mount) must converge on the second, even while the mount still
    // serves the first. Restoring the first would be the same data loss with
    // extra steps.
    const abs = path.join(dir, "epic-1.md");
    writeAndRemember(abs, "first write\n");
    const stale = staleViewOf(abs);
    writeAndRemember(abs, "second write\n");
    stale.serve();
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(abs, "first write\n", { kind: "epic-file", id: "epic-1" })).toBe("second write\n");
  });

  it("names the file by its caller's own key: projectSlug for project.md, epicId for an epic", () => {
    // Three writers share one module; a warn that called every id "taskKey"
    // would be ungreppable during the next incident. Ruling 17: the epic
    // writer took the goal writer's place.
    const project = path.join(dir, "project.md");
    const epic = path.join(dir, "epic-1.md");
    writeAndRemember(project, OURS);
    writeAndRemember(epic, OURS);
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

describe("writeAndRemember — the bound", () => {
  /** Write `count` filler paths through the one door the writers use. */
  function writeMany(count: number, start = 0): void {
    for (let i = start; i < start + count; i++) {
      writeAndRemember(path.join(dir, `filler-${i}.md`), `filler ${i}\n`);
    }
  }

  it("holds at most 500 paths — the oldest is dropped, the newest still repairs", () => {
    // The map is process-lifetime state in a long-running server: unbounded, it
    // would hold the full text of every file ever written. The bound is the
    // reason it is safe to remember every write, so it has to actually bind.
    // (Whatever earlier tests left in the map is older still, so it goes
    // first.)
    const oldest = path.join(dir, "oldest.md");
    writeAndRemember(oldest, OURS);
    writeMany(499); // 500 entries of this test's, the cap
    const newest = path.join(dir, "newest.md");
    writeAndRemember(newest, OURS); // evicts `oldest`
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(oldest, STALE, taskFile)).toBe(STALE);
    expect(freshestContent(newest, STALE, taskFile)).toBe(OURS);
  });

  it("re-writing a path refreshes it to the tail — a hot file is not the one evicted", () => {
    // The file being written every few seconds is precisely the file a stale
    // read will hit. If re-writing did not move it to the tail, the busiest
    // task.md in the instance would be the first one dropped.
    const hot = path.join(dir, "hot.md");
    writeAndRemember(hot, "v1\n");
    writeMany(499); // 500 entries of this test's; `hot` is the oldest
    writeAndRemember(hot, OURS); // re-write: no eviction, moves to the tail
    writeMany(1, 499); // one new path evicts the oldest, which is no longer `hot`
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(freshestContent(hot, STALE, taskFile)).toBe(OURS);
  });
});
