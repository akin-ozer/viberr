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
import { diskFoldsUnicodeForms } from "../../../test-support/unicode-forms";
import type { TaskFileEvent } from "~/schemas/task-file.schema";
import { taskAttachmentsDir, taskFilePath } from "~/server/files/file-store-root.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { removeTaskAttachment } from "./task-edits.server";

/**
 * Ruling 80: a project admin takes a file off a task's record. Round 1 of the
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

describe("removeTaskAttachment (ruling 80)", () => {
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

  it("ruling 80: removes a file named in either Unicode form, and its claims in both", async () => {
    // CANARY: take the claim off by its bytes and an entry that named the
    // file in the other form keeps a tile that opens nothing.
    const composed = "Çözüm Anahtarı.md";
    const decomposed = composed.normalize("NFD");
    // A name with no letter that decomposes would make this test prove nothing.
    expect(decomposed).not.toBe(composed);
    seedTask(
      [
        comment("2026-09-28T10:00:00.000Z", { attachments: [composed, "notes.md"] }),
        comment("2026-09-28T09:00:00.000Z", { attachments: [decomposed] }),
      ],
      { [decomposed]: "the answers", "notes.md": "keep" },
    );
    await removeTaskAttachment(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", name: composed, reason: null },
      arda(),
      ctxOf(),
    );
    expect(existsSync(attachment(decomposed))).toBe(false);
    const [, newer, older] = timeline();
    expect(newer!.attachments).toEqual(["notes.md"]);
    expect(older!.attachments ?? []).toEqual([]);
  });

  it.skipIf(diskFoldsUnicodeForms)("ruling 80: removing one of two files that differ only in Unicode form keeps the other's claims", async () => {
    // A folder can hold both: a person's upload stored decomposed before
    // names were composed, and a file a run's shell wrote under the composed
    // name. They are two files on the disk this runs on in production.
    // CANARY: take claims off by composed name alone and the run's file loses
    // its tile and its place among the files an upload may not overwrite.
    const composed = "Çözüm Anahtarı.md";
    const decomposed = composed.normalize("NFD");
    seedTask(
      [
        comment("2026-09-28T10:00:00.000Z", { attachments: [composed] }),
        comment("2026-09-28T09:00:00.000Z", { attachments: [decomposed] }),
      ],
      { [decomposed]: "a person's upload" },
    );
    writeFileSync(attachment(composed), "a run's own file");
    await removeTaskAttachment(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", name: decomposed, reason: null },
      arda(),
      ctxOf(),
    );
    expect(existsSync(attachment(composed))).toBe(true);
    expect(existsSync(attachment(decomposed))).toBe(false);
    const [, newer, older] = timeline();
    expect(newer!.attachments).toEqual([composed]);
    expect(older!.attachments ?? []).toEqual([]);
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
