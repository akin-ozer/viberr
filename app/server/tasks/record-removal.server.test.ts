import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import type { TaskFileEvent } from "~/schemas/task-file.schema";
import { taskAttachmentsDir, taskFilePath } from "~/server/files/file-store-root.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { removeTaskAttachment } from "./task-actions.server";

/**
 * Ruling 582: a project admin takes a file off a task's record. Round 1 of the
 * AWS calculator board left its answer key in AWSC-3's attachments, where
 * every agent reads, and only a shell in the container could take it away.
 * Who may is the policy matrix's (`policy-rbac.server.test.ts`).
 */

let ctx: TestDbContext;
let store: TestStore;

const JUDGE = { kind: "agent", backend: "claude", profileId: "estimate-judge", roleHint: "Estimate Judge" } as const;

function comment(occurredAt: string, over: Partial<TaskFileEvent> = {}): TaskFileEvent {
  return { occurredAt, type: "comment", actor: JUDGE, title: null, text: "x", toAgent: false, evidence: null, ...over };
}

function seedTask(timeline: TaskFileEvent[], files: Record<string, string> = {}): void {
  writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1"), timeline });
  const dir = taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

const timeline = () =>
  readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.timeline;
const attachment = (name: string) => path.join(taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot), name);
const arda = () => actorOf(store.users.arda);
const ctxOf = () => ({ dataRoot: store.dataRoot });

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
});

afterEach(() => {
  ctx.cleanup();
});

describe("removeTaskAttachment (ruling 582)", () => {
  it("deletes the file, takes its name off every entry that claimed it, and says who removed it and why", async () => {
    seedTask(
      [
        comment("2026-09-28T10:00:00.000Z", { attachments: ["golden-files.md", "notes.md"] }),
        comment("2026-09-28T09:00:00.000Z", { attachments: ["golden-files.md"] }),
      ],
      { "golden-files.md": "x".repeat(3000), "notes.md": "keep" },
    );
    const removed = await removeTaskAttachment(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", name: "golden-files.md", reason: "the answer key" },
      arda(),
      ctxOf(),
    );
    expect(removed).toEqual({ name: "golden-files.md", bytes: 3000 });
    expect(existsSync(attachment("golden-files.md"))).toBe(false);
    expect(existsSync(attachment("notes.md"))).toBe(true);
    const [note, newer, older] = timeline();
    expect(note).toMatchObject({
      type: "note",
      title: "Attachment removed",
      actor: { kind: "human", userId: store.users.arda.id },
      text: "Removed `golden-files.md` (3 KB) from this task's attachments. Why: the answer key.",
    });
    // CANARY: leave the claims and the timeline keeps a tile that opens nothing.
    expect(newer!.attachments).toEqual(["notes.md"]);
    expect(older!.attachments ?? []).toEqual([]);
    const [row] = listAuditEvents(store.db, { action: "task.attachment.removed" });
    expect(row).toMatchObject({ actorUserId: store.users.arda.id, taskKey: "VIB-1" });
    expect(row!.details).toEqual({ name: "golden-files.md", bytes: 3000, reason: "the answer key" });
  });

  it("refuses a name the task does not hold, or one outside its attachments, writing nothing", async () => {
    seedTask([comment("2026-09-28T10:00:00.000Z")]);
    const before = readFileSync(taskFilePath(store.slug, "VIB-1", store.dataRoot), "utf8");
    for (const name of ["absent.md", "../task.md"]) {
      await expect(
        removeTaskAttachment(store.db, { projectSlug: store.slug, taskKey: "VIB-1", name, reason: null }, arda(), ctxOf()),
      ).rejects.toMatchObject({ status: 404 });
    }
    expect(readFileSync(taskFilePath(store.slug, "VIB-1", store.dataRoot), "utf8")).toBe(before);
    expect(listAuditEvents(store.db, { action: "task.attachment.removed" })).toEqual([]);
  });
});
