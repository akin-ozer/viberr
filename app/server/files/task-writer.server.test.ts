import {
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { staleViewOf } from "../../../test-support/stale-mount";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import type { TaskFileEvent } from "~/schemas/task-file.schema";
import { AppError } from "~/server/errors/app-error.server";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "./task-writer.server";

/**
 * Read-your-own-writes repair (VIB-1 incident, 2026-07-17): on cached bind
 * mounts (Docker Desktop VirtioFS) a read milliseconds after our own atomic
 * rename can return the PREVIOUS content — the next read-modify-write then
 * silently erases the earlier write (the reviewer's reply comment vanished
 * this way). updateTaskFile repairs a provably-stale read from the
 * in-process write cache, while a genuine EXTERNAL edit wins. What counts as
 * provably stale, and how soon another writer may land, is write-cache's own
 * test (ruling 513); these two prove the writer reads through it.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function comment(text: string): TaskFileEvent {
  return {
    occurredAt: new Date().toISOString(),
    type: "comment",
    actor: { kind: "operator" },
    title: null,
    text,
    toAgent: false,
    evidence: null,
  };
}

describe("updateTaskFile stale-read repair", () => {
  it("a stale (pre-write) disk read is repaired — the earlier write survives", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { title: "Repair probe" }),
    });
    const ref = { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot };
    const absPath = resolveTaskFilePath(ref);
    const stale = staleViewOf(absPath);

    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift(comment("REVIEWER FINDINGS — must survive"));
    });

    // The VirtioFS stale cache: the mount goes on serving the file our write
    // replaced, pre-write bytes and all.
    stale.serve();

    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift(comment("VERDICT — second write"));
    });

    const texts = readTaskFile(ref)!.parsed.timeline.map((e) => e.text);
    expect(texts).toContain("REVIEWER FINDINGS — must survive");
    expect(texts).toContain("VERDICT — second write");
  });

  it("a genuine external edit wins over the write cache", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { title: "External edit probe" }),
    });
    const ref = { projectSlug: store.slug, taskKey: "VIB-2", dataRoot: store.dataRoot };
    const absPath = resolveTaskFilePath(ref);

    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift(comment("app write"));
    });

    // A human edits task.md directly AFTER our write: disk must win, no
    // resurrection. (The stamp well past ours keeps this about the writer;
    // an edit landing straight after ours is write-cache's own row.)
    const external = readFileSync(absPath, "utf8").replace(
      "app write",
      "app write (hand-edited)",
    );
    writeFileSync(absPath, external);
    const future = (statSync(absPath).mtimeMs + 5_000) / 1000;
    utimesSync(absPath, future, future);

    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift(comment("after external edit"));
    });

    const texts = readTaskFile(ref)!.parsed.timeline.map((e) => e.text);
    expect(texts).toContain("app write (hand-edited)");
    expect(texts).toContain("after external edit");
    expect(texts).not.toContain("app write");
  });
});

/**
 * Gap 22 — a hand-edited task.md that no longer parses used to be DESTROYED by
 * the next app write. Parsing is tolerant by design (a broken file must never
 * crash the app or drop a task), so `readTaskFile` returns fallback defaults —
 * and `updateTaskFile` is a read-modify-write, so appending a single comment
 * serialized those defaults over the human's file. With an unterminated `---`
 * fence the parsed body is empty, so the goal and the whole timeline went with
 * it. The store is DESIGNED to be hand-edited (FR10); a truncated editor write
 * is an expected event, not an exotic one.
 */
describe("updateTaskFile refuses to write an untrusted file", () => {
  const TRUNCATED = `---
key: VIB-7
title: Truncated by an editor
stage: impl
`;

  const BROKEN_YAML = `---
key: VIB-8
title: Botched
\tstage: impl
---

## Goal

Do not lose me.

## Timeline

### 2026-08-01T10:00:00.000Z · comment · human:u_arda

Context nobody wants to lose.
`;

  it("refuses — and leaves the bytes untouched — when the fence is truncated", async () => {
    const store = setupTestStore(ctx);
    const ref = { projectSlug: store.slug, taskKey: "VIB-7", dataRoot: store.dataRoot };
    const absPath = resolveTaskFilePath(ref);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, TRUNCATED, "utf8");

    await expect(
      updateTaskFile(ref, (parsed) => {
        parsed.timeline.unshift(comment("this write must not land"));
      }),
    ).rejects.toMatchObject({ code: "file_not_trusted", status: 409 });

    // The human's bytes are exactly as they were — nothing was rewritten.
    expect(readFileSync(absPath, "utf8")).toBe(TRUNCATED);
  });

  it("refuses on unparseable frontmatter, keeping the goal and the timeline", async () => {
    const store = setupTestStore(ctx);
    const ref = { projectSlug: store.slug, taskKey: "VIB-8", dataRoot: store.dataRoot };
    const absPath = resolveTaskFilePath(ref);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, BROKEN_YAML, "utf8");

    let thrown: unknown;
    try {
      await updateTaskFile(ref, (parsed) => {
        parsed.timeline.unshift(comment("this write must not land"));
      });
    } catch (error) {
      thrown = error;
    }
    // The refusal names the task and the parse error, and points at the doctor.
    if (!(thrown instanceof AppError)) throw thrown;
    expect(thrown.code).toBe("file_not_trusted");
    const userMessage = thrown.userMessage;
    expect(userMessage).toContain("VIB-8");
    expect(userMessage).toMatch(/unparseable/i);
    expect(userMessage).toContain("npm run store:check");

    expect(readFileSync(absPath, "utf8")).toBe(BROKEN_YAML);
  });

  it("still writes a file whose problems the parser genuinely round-trips", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", { title: "Odd but readable" }),
      extraSections: [{ title: "Scratch", raw: "hand-written notes" }],
    });
    const ref = { projectSlug: store.slug, taskKey: "VIB-9", dataRoot: store.dataRoot };

    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift(comment("ordinary write"));
    });

    const after = readTaskFile(ref)!;
    expect(after.parsed.timeline.map((e) => e.text)).toContain("ordinary write");
    // Unknown sections are round-trip safe, so they are not a write blocker.
    expect(after.parsed.extraSections.map((s) => s.title)).toContain("Scratch");
  });
});
