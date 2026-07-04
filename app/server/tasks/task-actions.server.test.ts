import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "~/server/audit/audit-recorder.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { getTaskDetail } from "~/server/projections/task-query.server";
import {
  appendComment,
  createTask,
  DEFAULT_GOAL,
  releaseOwner,
  setOwner,
} from "./task-actions.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function actor(user: { id: string; email: string }) {
  return { userId: user.id, label: user.email };
}

function prepared(): TestStore {
  const store = setupTestStore(ctx);
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

describe("createTask", () => {
  it("writes task.md with the mock create defaults and projects it", async () => {
    const store = prepared();
    const result = await createTask(
      store.db,
      { projectSlug: store.slug, title: "A brand new task" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    expect(result.key).toBe("VIB-100"); // per-project counter
    expect(result.stageName).toBe("Triage");
    expect(result.task.stage).toBe("triage");
    expect(result.task.readiness).toBe("input_required");
    expect(result.task.waiting).toBe("human");
    expect(result.task.validation).toBe("none");
    expect(result.task.urgent).toBe(false);
    expect(result.task.operator).toBeNull(); // no operator in triage
    expect(result.task.goal).toBe(DEFAULT_GOAL);
    expect(result.task.filePath).toBe(
      "projects/viberr-core/tasks/VIB-100/task.md",
    );

    // The file is canonical truth — verify it exists and parses clean.
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-100",
      dataRoot: store.dataRoot,
    });
    expect(file?.diagnostics).toEqual([]);
    expect(file?.parsed.frontmatter.title).toBe("A brand new task");

    const audit = listAuditEvents(store.db, { action: "task.created" });
    expect(audit[0]?.taskKey).toBe("VIB-100");
  });

  it("assigns the operator when created outside triage", async () => {
    const store = prepared();
    const result = await createTask(
      store.db,
      { projectSlug: store.slug, title: "Straight to ready", stageId: "ready" },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(result.task.operator).toMatchObject({
      assignedAtStageId: "ready",
      sinceLabel: "stage 2",
    });
  });

  it("allocates unique keys under concurrency and persists the counter", async () => {
    const store = prepared();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createTask(
          store.db,
          { projectSlug: store.slug, title: `Concurrent task ${i}` },
          actor(store.users.arda),
          { dataRoot: store.dataRoot },
        ),
      ),
    );
    const keys = results.map((r) => r.key);
    expect(new Set(keys).size).toBe(8);
    expect(keys.sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `VIB-${100 + i}`).sort(),
    );
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    });
    expect(project?.parsed.frontmatter.nextTaskNumber).toBe(108);
  });

  it("falls back to a directory max-scan when the counter is stale", async () => {
    const store = prepared();
    // A task numbered ABOVE the stored counter (external tool created it).
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-250"),
    });
    const result = await createTask(
      store.db,
      { projectSlug: store.slug, title: "After external task" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.key).toBe("VIB-251");
  });

  it("rejects viewers, non-members, bad stages and short titles", async () => {
    const store = prepared();
    await expect(
      createTask(
        store.db,
        { projectSlug: store.slug, title: "Viewer attempt" },
        actor(store.users.elif), // project viewer
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createTask(
        store.db,
        { projectSlug: store.slug, title: "Guest attempt" },
        actor(store.users.deniz), // not a member
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createTask(
        store.db,
        { projectSlug: store.slug, title: "Done create", stageId: "done" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createTask(
        store.db,
        { projectSlug: store.slug, title: "ab" },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("appendComment", () => {
  function withTask(store: TestStore): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  it("appends a comment event (newest first) and reprojects", async () => {
    const store = prepared();
    withTask(store);
    const result = await appendComment(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "First comment" },
      actor(store.users.selin),
      { dataRoot: store.dataRoot },
    );
    expect(result.toAgent).toBe(false);
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({
      type: "comment",
      text: "First comment",
      toAgent: false,
    });
    expect(detail?.commentCount).toBe(1);
  });

  it("routes @operator mentions to the agent side (toagent tint)", async () => {
    const store = prepared();
    withTask(store);
    const result = await appendComment(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@operator widen the PAT scope please" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.toAgent).toBe(true);
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.toAgent).toBe(true);
  });

  it("guests (registered non-members) may comment — app-wide commenting", async () => {
    const store = prepared();
    withTask(store);
    await appendComment(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "Following from the platform team." },
      actor(store.users.deniz),
      { dataRoot: store.dataRoot },
    );
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.actor).toMatchObject({ guest: true });
  });

  it("fans out mention notifications by email local-part / first name — never to self", async () => {
    const store = prepared();
    withTask(store);
    const handle = store.users.selin.email.split("@")[0];
    const result = await appendComment(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: `@${handle} can you take the acceptance gate? @operator fyi` },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.mentionedUserIds).toEqual([store.users.selin.id]);
    const rows = store.db
      .prepare(`SELECT user_id, kind, task_key, read_at FROM notifications`)
      .all() as { user_id: string; kind: string; task_key: string; read_at: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: store.users.selin.id,
      kind: "mention",
      task_key: "VIB-1",
      read_at: null,
    });
  });
});

describe("ownership", () => {
  function withTask(store: TestStore, ownerUserId: string | null = null): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { ownerUserId }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  it("take (unowned) — exact assign-event copy", async () => {
    const store = prepared();
    withTask(store);
    const task = await setOwner(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", targetUserId: store.users.selin.id },
      actor(store.users.selin),
      { dataRoot: store.dataRoot },
    );
    expect(task.owner).toMatchObject({ userId: store.users.selin.id });
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]).toMatchObject({
      type: "assign",
      text: "Took task ownership — owner is the human reviewer and acceptance authority for this task.",
    });
  });

  it("take-over (owned by other) — copy names the previous owner", async () => {
    const store = prepared();
    withTask(store, store.users.murat.id);
    await setOwner(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", targetUserId: store.users.arda.id },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.text).toBe(
      `Took over task ownership from **${store.users.murat.name}** — owner is the human reviewer and acceptance authority.`,
    );
  });

  it("hand off requires being owner or admin; target must be a member", async () => {
    const store = prepared();
    withTask(store, store.users.murat.id);
    // selin is neither the owner nor an admin
    await expect(
      setOwner(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", targetUserId: store.users.arda.id },
        actor(store.users.selin),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    // owner hands off to a NON-member → rejected
    await expect(
      setOwner(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", targetUserId: store.users.deniz.id },
        actor(store.users.murat),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });
    // owner hands off to a member — exact copy
    await setOwner(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", targetUserId: store.users.selin.id },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.text).toBe(
      `Handed task ownership to **${store.users.selin.name}** — they hold review & acceptance for this task now.`,
    );
  });

  it("self release + admin release-anyone (exact copy, audited as forced)", async () => {
    const store = prepared();
    withTask(store, store.users.selin.id);
    // murat (maintainer, not owner, not admin) cannot release selin
    await expect(
      releaseOwner(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1" },
        actor(store.users.murat),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // admin releases selin
    const task = await releaseOwner(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(task.owner).toBeNull();
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.text).toBe(
      `Released **${store.users.selin.name}** from task ownership (admin) — the seat is open to any project member.`,
    );
    const audit = listAuditEvents(store.db, {
      action: "task.ownership.admin_released",
    });
    expect(audit[0]?.details).toMatchObject({ forced: true });

    // releasing an unowned task is an idempotent no-op (no duplicate event)
    const before = getTaskDetail(store.db, store.slug, "VIB-1")!.timeline.length;
    await releaseOwner(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(getTaskDetail(store.db, store.slug, "VIB-1")!.timeline).toHaveLength(before);

    // self release copy
    withTask(store, store.users.selin.id);
    await releaseOwner(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.selin),
      { dataRoot: store.dataRoot },
    );
    expect(getTaskDetail(store.db, store.slug, "VIB-1")?.timeline[0]?.text).toBe(
      "Released task ownership — review & acceptance stall until another member takes the seat.",
    );
  });
});
