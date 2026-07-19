import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
} from "../../../test-support/test-store";
import {
  projectFilePath,
  taskFilePath,
} from "~/server/files/file-store-root.server";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import { onProjectionEvent } from "~/server/events/projection-events.server";
import { rebuildAll, rebuildPath, rebuildProject } from "./rebuilder.server";
import { getBoard, listProjectTasks } from "./board-query.server";
import { getTaskDetail } from "./task-query.server";

/** A second project alongside the store's default, for scope tests. */
function writeSecondProject(store: ReturnType<typeof setupTestStore>, slug: string) {
  writeProject(store.dataRoot, {
    name: "Other Project",
    slug,
    repo: "acme/other",
    defaultBranch: "main",
    taskPrefix: "OTH",
    nextTaskNumber: 2,
    stages: GOVERNED_TEMPLATE.stages,
    workflow: GOVERNED_TEMPLATE.workflow,
    members: [],
    agents: [],
    credentialPolicy: null,
    guardrails: [],
  });
}

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("rebuilder", () => {
  it("full rescan projects projects, members and tasks", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "ready" }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2"),
    });

    const summary = rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(summary.projects).toBe(1);
    expect(summary.tasks).toBe(2);
    expect(summary.changed).toBe(3);
    expect(summary.errors).toBe(0);

    const board = getBoard(store.db, store.slug);
    expect(board?.project.name).toBe("Viberr Core");
    expect(board?.members).toHaveLength(4);
    expect(board?.columns.map((c) => c.tasks.length)).toEqual([1, 1, 0, 0, 0]);
    // Store-relative display path (ruling 3).
    const task = board?.columns[1]?.tasks[0];
    expect(task?.filePath).toBe("projects/viberr-core/tasks/VIB-1/task.md");
  });

  it("content-hash short-circuit: unchanged files are not re-projected", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const provenanceBefore = store.db
      .prepare(`SELECT count(*) AS c FROM provenance`)
      .get() as { c: number };

    const second = rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(second.changed).toBe(0);
    expect(second.unchanged).toBe(2); // project + task

    // Unchanged files record no per-file provenance; only the rescan summary row.
    const provenanceAfter = store.db
      .prepare(`SELECT count(*) AS c FROM provenance`)
      .get() as { c: number };
    expect(provenanceAfter.c).toBe(provenanceBefore.c + 1);
  });

  it("single-file incremental rebuild picks up an external edit", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const events: string[] = [];
    const off = onProjectionEvent((e) => events.push(e.type));

    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        title: "Edited directly on disk",
        stage: "impl",
      }),
    });
    const absPath = taskFilePath(store.slug, "VIB-1", store.dataRoot);
    const result = rebuildPath(store.db, absPath, { dataRoot: store.dataRoot });
    off();

    expect(result.action).toBe("projected");
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.title).toBe("Edited directly on disk");
    expect(detail?.stage).toBe("impl");
    expect(events).toContain("task.updated");
  });

  it("user rename reflects in the projected timeline at READ time — no reprojection (E1)", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline: [
        {
          occurredAt: "2026-07-02T09:41:00.000Z",
          type: "comment",
          actor: { kind: "human", userId: store.users.murat.id, nameHint: null },
          title: null,
          text: "Looks good.",
          toAgent: false,
          evidence: null,
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // Rename AFTER projection — the baked actor_json still holds the old
    // name and the content-hash short-circuit prevents any reprojection.
    store.db
      .prepare(`UPDATE users SET name = ? WHERE id = ?`)
      .run("Murat Kaya", store.users.murat.id);

    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.actor).toMatchObject({
      kind: "human",
      userId: store.users.murat.id,
      name: "Murat Kaya",
      initials: "MK",
    });

    // Deleted user → the baked snapshot is the fallback identity.
    store.db.prepare(`DELETE FROM users WHERE id = ?`).run(store.users.murat.id);
    const after = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(after?.timeline[0]?.actor).toMatchObject({
      kind: "human",
      name: "Murat Test",
    });
  });

  it("deleting a task file removes its projection rows + records provenance", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const absPath = taskFilePath(store.slug, "VIB-1", store.dataRoot);
    rmSync(absPath);
    const result = rebuildPath(store.db, absPath, { dataRoot: store.dataRoot });
    expect(result.action).toBe("removed");
    expect(listProjectTasks(store.db, store.slug)).toEqual([]);
    const removedRow = store.db
      .prepare(`SELECT action FROM provenance ORDER BY id DESC LIMIT 1`)
      .get() as { action: string };
    expect(removedRow.action).toBe("removed");
  });

  it("malformed file → diagnostics + readiness downgrade, task never dropped", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "no-such-stage",
        readiness: "ready",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail).not.toBeNull();
    // unknown stage reference → warning → floors input_required
    expect(detail?.readiness).toBe("input_required");
    expect(
      detail?.diagnostics.some((d) => d.code === "reference.unknown_stage"),
    ).toBe(true);
    // ends up in the orphan bucket, not silently dropped
    const board = getBoard(store.db, store.slug);
    expect(board?.orphanTasks.map((t) => t.key)).toEqual(["VIB-1"]);
  });

  it("resolves human actors and flags non-member commenters as guests", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline: [
        { occurredAt: "2026-07-04T07:12:00.000Z", type: "comment",
          actor: { kind: "human", userId: store.users.deniz.id, nameHint: null },
          title: null, text: "Following from the platform team.", toAgent: false, evidence: null },
        { occurredAt: "2026-07-04T07:00:00.000Z", type: "comment",
          actor: { kind: "human", userId: store.users.arda.id, nameHint: null },
          title: null, text: "Member comment.", toAgent: false, evidence: null },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    const [guest, member] = detail!.timeline;
    expect(guest?.actor).toMatchObject({ kind: "human", guest: true });
    expect(member?.actor.kind).toBe("human");
    expect("guest" in (member?.actor ?? {})).toBe(false);
    // Denormalized snapshot: name resolved from the users table.
    expect(guest?.actor).toMatchObject({ name: "Deniz Test" });
  });

  it("membership change in project.md cascades guest flags onto tasks", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline: [
        { occurredAt: "2026-07-04T07:00:00.000Z", type: "comment",
          actor: { kind: "human", userId: store.users.elif.id, nameHint: null },
          title: null, text: "Was a member when written.", toAgent: false, evidence: null },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    let detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect("guest" in (detail!.timeline[0]!.actor as object)).toBe(false);

    // Remove elif from the project file → her events re-render as guest.
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    project.parsed.frontmatter.members = project.parsed.frontmatter.members.filter(
      (m) => m.userId !== store.users.elif.id,
    );
    const { writeFileAtomic } = await import("~/server/files/atomic-file.server");
    const { serializeProjectFile } = await import("~/server/files/project-file.server");
    writeFileAtomic(project.absPath, serializeProjectFile(project.parsed));

    rebuildPath(store.db, project.absPath, { dataRoot: store.dataRoot });
    detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail!.timeline[0]!.actor).toMatchObject({ guest: true });
  });

  it("adding a missing stage to project.md clears the task's unknown-stage warning", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "qa", readiness: "ready" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    let detail = getTaskDetail(store.db, store.slug, "VIB-1");
    // Unknown stage → warning → readiness floors at input_required.
    expect(detail?.readiness).toBe("input_required");
    expect(
      detail?.diagnostics.some((d) => d.code === "reference.unknown_stage"),
    ).toBe(true);

    // Fix the PROJECT file only — the task file stays byte-identical, so
    // only a project→task cascade can clear the warning.
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    const { writeFileAtomic } = await import("~/server/files/atomic-file.server");
    const { serializeProjectFile } = await import("~/server/files/project-file.server");
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    project.parsed.frontmatter.stages = [
      ...project.parsed.frontmatter.stages,
      { id: "qa", name: "QA", color: "#187574" },
    ];
    writeFileAtomic(project.absPath, serializeProjectFile(project.parsed));

    rebuildAll(store.db, { dataRoot: store.dataRoot });
    detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(
      detail?.diagnostics.some((d) => d.code === "reference.unknown_stage"),
    ).toBe(false);
    expect(detail?.readiness).toBe("ready");
  });

  it("removing a stage tasks sit in flags them on the next rescan", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "ready", readiness: "ready" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    let detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.readiness).toBe("ready");
    expect(detail?.diagnostics).toEqual([]);

    const { readProjectFile } = await import("~/server/files/project-writer.server");
    const { writeFileAtomic } = await import("~/server/files/atomic-file.server");
    const { serializeProjectFile } = await import("~/server/files/project-file.server");
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    project.parsed.frontmatter.stages = project.parsed.frontmatter.stages.filter(
      (s) => s.id !== "ready",
    );
    writeFileAtomic(project.absPath, serializeProjectFile(project.parsed));

    rebuildAll(store.db, { dataRoot: store.dataRoot });
    detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(
      detail?.diagnostics.some((d) => d.code === "reference.unknown_stage"),
    ).toBe(true);
    expect(detail?.readiness).toBe("input_required");
  });

  it("task projected before its project.md picks up the project repo once it lands", () => {
    const store = setupTestStore(ctx);
    const slug = "fresh-proj";
    // Fresh project dir copied in: the task file is projected FIRST (no
    // project row yet) — e.g. the watcher fires for task.md before project.md.
    writeTask(store.dataRoot, slug, {
      frontmatter: baseTaskFrontmatter("FRS-1"),
    });
    rebuildPath(store.db, taskFilePath(slug, "FRS-1", store.dataRoot), {
      dataRoot: store.dataRoot,
    });

    const repoOf = () =>
      (
        store.db
          .prepare(
            `SELECT repo FROM task_projections WHERE project_slug = ? AND task_key = ?`,
          )
          .get(slug, "FRS-1") as { repo: string | null }
      ).repo;
    expect(repoOf()).toBeNull();

    // project.md lands afterwards — its first projection must cascade.
    writeProject(store.dataRoot, {
      name: "Fresh Project",
      slug,
      repo: "acme/fresh",
      defaultBranch: "main",
      taskPrefix: "FRS",
      nextTaskNumber: 2,
      stages: GOVERNED_TEMPLATE.stages,
      workflow: GOVERNED_TEMPLATE.workflow,
      members: [],
      agents: [],
      credentialPolicy: null,
      guardrails: [],
    });
    rebuildPath(store.db, projectFilePath(slug, store.dataRoot), {
      dataRoot: store.dataRoot,
    });

    expect(repoOf()).toBe("acme/fresh");
  });
});

describe("scoped project rescan (F20)", () => {
  it("reprojects ONLY the target project, leaving other projects' rows untouched", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { title: "A original" }),
    });
    writeSecondProject(store, "other-proj");
    writeTask(store.dataRoot, "other-proj", {
      frontmatter: baseTaskFrontmatter("OTH-1", { title: "B original" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // Edit a task in BOTH projects directly on disk.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { title: "A edited" }),
    });
    writeTask(store.dataRoot, "other-proj", {
      frontmatter: baseTaskFrontmatter("OTH-1", { title: "B edited" }),
    });

    // Scoped rescan of project A only.
    const summary = rebuildProject(store.db, store.slug, { dataRoot: store.dataRoot });
    expect(summary.projects).toBe(1);
    expect(summary.tasks).toBe(1); // only A's task is walked
    expect(summary.changed).toBe(1); // A's edited task

    // A picked up its edit; B's stale projection is deliberately NOT touched —
    // proving the effect is confined to the authorized project.
    expect(getTaskDetail(store.db, store.slug, "VIB-1")?.title).toBe("A edited");
    expect(getTaskDetail(store.db, "other-proj", "OTH-1")?.title).toBe("B original");
  });

  it("prunes only the target project's vanished task rows, never another project's", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    writeSecondProject(store, "other-proj");
    writeTask(store.dataRoot, "other-proj", {
      frontmatter: baseTaskFrontmatter("OTH-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // Delete a task file in the OTHER project, then rescan only project A.
    rmSync(taskFilePath("other-proj", "OTH-1", store.dataRoot));
    rebuildProject(store.db, store.slug, { dataRoot: store.dataRoot });

    // A's task survives; B's deleted task is NOT pruned by A's scoped rescan.
    expect(listProjectTasks(store.db, store.slug).map((t) => t.key)).toEqual(["VIB-1"]);
    expect(getTaskDetail(store.db, "other-proj", "OTH-1")).not.toBeNull();

    // A scoped rescan of B DOES prune it.
    const summary = rebuildProject(store.db, "other-proj", { dataRoot: store.dataRoot });
    expect(summary.removed).toBe(1);
    expect(getTaskDetail(store.db, "other-proj", "OTH-1")).toBeNull();
  });

  it("emits a project-scoped projection.rebuilt event", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const scopes: string[] = [];
    const off = onProjectionEvent((e) => {
      if (e.type === "projection.rebuilt") scopes.push(e.scope);
    });
    rebuildProject(store.db, store.slug, { dataRoot: store.dataRoot });
    off();

    expect(scopes).toContain("project");
    expect(scopes).not.toContain("full");
  });
});
