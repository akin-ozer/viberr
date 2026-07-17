import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import type { TaskFileEvent } from "~/schemas/task-file.schema";
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
 * in-process write cache, while a genuine EXTERNAL edit (newer mtime) wins.
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
    const preContent = readFileSync(absPath, "utf8");

    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift(comment("REVIEWER FINDINGS — must survive"));
    });

    // Simulate the VirtioFS stale cache: disk "reverts" to the pre-write
    // content with an mtime OLDER than our write.
    writeFileSync(absPath, preContent);
    const past = (Date.now() - 10_000) / 1000;
    utimesSync(absPath, past, past);

    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift(comment("VERDICT — second write"));
    });

    const texts = readTaskFile(ref)!.parsed.timeline.map((e) => e.text);
    expect(texts).toContain("REVIEWER FINDINGS — must survive");
    expect(texts).toContain("VERDICT — second write");
  });

  it("a genuine external edit (newer mtime) wins over the write cache", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { title: "External edit probe" }),
    });
    const ref = { projectSlug: store.slug, taskKey: "VIB-2", dataRoot: store.dataRoot };
    const absPath = resolveTaskFilePath(ref);

    await updateTaskFile(ref, (parsed) => {
      parsed.timeline.unshift(comment("app write"));
    });

    // A human edits task.md directly AFTER our write: content differs from
    // the cache and mtime is newer — disk must win, no resurrection.
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
