import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defaultEpicColor, type EpicFrontmatter } from "~/schemas/epic-file.schema";
import { createEpicFile, updateEpicFile } from "~/server/files/epic-writer.server";
import { epicFilePath } from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { updateTaskFile } from "~/server/files/task-writer.server";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import {
  epicTaskKeys,
  epicTaskRows,
  getEpic,
  getEpicDetail,
  listEpicChips,
  listEpics,
  type EpicProgress,
} from "./epic-query.server";
import {
  rebuildAll,
  rebuildEpicFile,
  rebuildPath,
  rebuildProject,
  rebuildTaskFile,
} from "./rebuilder.server";

/**
 * Ruling 503(a)/(b): the epic read models. An epic's row is its file
 * (`epic_projections`, written by the rebuilder); its PROGRESS is counted from
 * the task rows whose `epic_id` names it, at read time, never stored, with
 * archived tasks counted apart and left out of the total.
 *
 * Fixture (governed board: triage → ready → impl → review → done): epic-1
 * holds eight tasks across every state progress distinguishes, epic-2 one and
 * epic-10 none; VIB-9 is in no epic, and a second project has an epic-1 of its
 * own with one done task, which must count nowhere here.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const SIDE = "side-project";
const CREATED = "2026-09-01T09:00:00.000Z";

const EMPTY: EpicProgress = {
  total: 0,
  done: 0,
  started: 0,
  notStarted: 0,
  held: 0,
  archived: 0,
  archivedDone: 0,
  byStage: [],
};

async function writeEpic(
  store: TestStore,
  id: string,
  patch: Partial<EpicFrontmatter> = {},
  description = "",
  slug = store.slug,
): Promise<void> {
  await createEpicFile(
    { projectSlug: slug, epicId: id, dataRoot: store.dataRoot },
    {
      frontmatter: {
        id,
        title: `Epic ${id}`,
        status: "planned",
        color: defaultEpicColor(id),
        leadUserId: null,
        startDate: null,
        targetDate: null,
        createdBy: store.users.arda.id,
        createdByLabel: store.users.arda.email,
        conversationId: null,
        convertedFrom: null,
        createdAt: CREATED,
        updatedAt: CREATED,
        ...patch,
      },
      description,
    },
  );
}

async function seed(store: TestStore): Promise<void> {
  const tasks: [string, Parameters<typeof baseTaskFrontmatter>[1]][] = [
    ["VIB-1", { stage: "triage", epic: "epic-1" }],
    ["VIB-2", { stage: "ready", epic: "epic-1" }],
    ["VIB-3", { stage: "impl", epic: "epic-1", blockedBy: ["VIB-1"], waiting: "none" }],
    ["VIB-4", { stage: "done", epic: "epic-1", waiting: "none" }],
    ["VIB-5", { stage: "impl", epic: "epic-1", archived: true }],
    ["VIB-6", { stage: "triage", epic: "epic-1", blockedBy: ["VIB-2"], waiting: "none" }],
    // A stage this board no longer has.
    ["VIB-7", { stage: "qa", epic: "epic-1" }],
    ["VIB-8", { stage: "review", epic: "epic-2" }],
    ["VIB-9", { stage: "impl" }],
    ["VIB-10", { stage: "done", epic: "epic-1", waiting: "none" }],
  ];
  for (const [key, patch] of tasks) {
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter(key, patch) });
  }
  const main = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...main.parsed.frontmatter,
    name: "Side project",
    slug: SIDE,
    taskPrefix: "SIDE",
    nextTaskNumber: 2,
  });
  writeTask(store.dataRoot, SIDE, {
    frontmatter: baseTaskFrontmatter("SIDE-1", { stage: "done", epic: "epic-1" }),
  });
  await writeEpic(store, "epic-10", { title: "Later", status: "done" });
  await writeEpic(store, "epic-2", { title: "Search" });
  await writeEpic(
    store,
    "epic-1",
    {
      title: "Checkout redesign",
      status: "in_progress",
      color: "teal",
      leadUserId: store.users.selin.id,
      startDate: "2026-10-01",
      targetDate: "2026-12-15",
      conversationId: "conv_plan",
    },
    "Rebuild the checkout.",
  );
  await writeEpic(store, "epic-1", { title: "Side epic" }, "", SIDE);
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

async function seeded(): Promise<TestStore> {
  const store = setupTestStore(ctx);
  await seed(store);
  return store;
}

describe("ruling 503(b): listEpics", () => {
  it("lists a project's epics by number, each with its own progress", async () => {
    // CANARY: order listEpics by `epic_id` (text order puts epic-10 before
    // epic-2).
    const store = await seeded();
    const epics = listEpics(store.db, store.slug);
    expect(epics.map((e) => e.id)).toEqual(["epic-1", "epic-2", "epic-10"]);
    expect(epics.map((e) => e.number)).toEqual([1, 2, 10]);
    expect(epics[0]?.progress.total).toBe(7);
    expect(epics[1]?.progress).toEqual({
      ...EMPTY,
      total: 1,
      started: 1,
      byStage: [{ stageId: "review", count: 1 }],
    });
    expect(epics[2]?.progress).toEqual(EMPTY);
    // The other project's epic-1 is its own, with its own count.
    const side = listEpics(store.db, SIDE);
    expect(side.map((e) => [e.id, e.title])).toEqual([["epic-1", "Side epic"]]);
    expect(side[0]?.progress).toEqual({
      ...EMPTY,
      total: 1,
      done: 1,
      byStage: [{ stageId: "done", count: 1 }],
    });
  });
});

describe("ruling 503(b): getEpic", () => {
  it("counts progress from the task rows: archived apart and out of the total, held inside the others, an unknown stage its own segment last", async () => {
    // CANARY: drop the `if (!terminal) continue` after `progress.archived +=
    // row.n` in progressByEpic (the unfinished archived task joins the total
    // and its stage).
    const store = await seeded();
    expect(getEpic(store.db, store.slug, "epic-1")?.progress).toEqual({
      total: 7,
      done: 2,
      started: 3,
      notStarted: 2,
      held: 2,
      archived: 1,
      archivedDone: 0,
      byStage: [
        { stageId: "triage", count: 2 },
        { stageId: "ready", count: 1 },
        { stageId: "impl", count: 1 },
        { stageId: "done", count: 2 },
        { stageId: "qa", count: 1 },
      ],
    });
  });

  it("ruling 651: a task archived at the terminal stage still counts as done, in the total and its band; one archived unfinished stays out", async () => {
    // CANARY: put back the `continue` for every archived row in
    // progressByEpic and VIB-11 drops out of the total, done and its band.
    const store = await seeded();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-11", { stage: "done", epic: "epic-1", archived: true, waiting: "none" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(getEpic(store.db, store.slug, "epic-1")?.progress).toMatchObject({
      total: 8,
      done: 3,
      started: 3,
      notStarted: 2,
      held: 2,
      archived: 2,
      archivedDone: 1,
    });
    expect(getEpic(store.db, store.slug, "epic-1")?.progress.byStage.find((b) => b.stageId === "done")).toEqual({
      stageId: "done",
      count: 3,
    });
  });

  it("reads every field of the epic's row, the lead's display name at request time, and null for an epic the project does not have", async () => {
    // CANARY: resolve `leadName` from `created_by` instead of `lead_user_id`
    // in toSummary.
    const store = await seeded();
    expect(getEpic(store.db, store.slug, "epic-1")).toMatchObject({
      id: "epic-1",
      number: 1,
      title: "Checkout redesign",
      status: "in_progress",
      color: "teal",
      leadUserId: store.users.selin.id,
      leadName: store.users.selin.name,
      startDate: "2026-10-01",
      targetDate: "2026-12-15",
      description: "Rebuild the checkout.",
      createdBy: store.users.arda.id,
      createdByLabel: store.users.arda.email,
      conversationId: "conv_plan",
      createdAt: CREATED,
      updatedAt: CREATED,
    });
    expect(getEpic(store.db, store.slug, "epic-2")).toMatchObject({
      leadUserId: null,
      leadName: null,
      startDate: null,
      targetDate: null,
    });
    expect(getEpic(store.db, store.slug, "epic-99")).toBeNull();
    expect(getEpic(store.db, SIDE, "epic-1")?.progress.total).toBe(1);
  });

  it("is read, never stored: a task moving stage or leaving for another epic changes the count with no write to the epic", async () => {
    // CANARY: count progress once in rebuildEpicFile and read it back from
    // the epic's row (the counts go stale until the epic file changes).
    const store = await seeded();
    const move = async (taskKey: string, patch: { stage?: string; epic?: string }) => {
      await updateTaskFile({ projectSlug: store.slug, taskKey, dataRoot: store.dataRoot }, (parsed) => {
        Object.assign(parsed.frontmatter, patch);
      });
      rebuildTaskFile(store.db, store.slug, taskKey, { dataRoot: store.dataRoot });
    };
    await move("VIB-1", { stage: "done" });
    await move("VIB-2", { epic: "epic-2" });
    expect(getEpic(store.db, store.slug, "epic-1")?.progress).toMatchObject({
      total: 6,
      done: 3,
      started: 2,
      notStarted: 1,
      held: 2,
      archived: 1,
    });
    expect(getEpic(store.db, store.slug, "epic-2")?.progress).toMatchObject({
      total: 2,
      started: 2,
      byStage: [
        { stageId: "ready", count: 1 },
        { stageId: "review", count: 1 },
      ],
    });
  });
});

describe("ruling 503(b): an epic's tasks", () => {
  it("epicTaskRows and epicTaskKeys list them by key number, archived ones included", async () => {
    // CANARY: order epicTaskRows by `task_key` (text order puts VIB-10 right
    // after VIB-1).
    const store = await seeded();
    const keys = ["VIB-1", "VIB-2", "VIB-3", "VIB-4", "VIB-5", "VIB-6", "VIB-7", "VIB-10"];
    expect(epicTaskKeys(store.db, store.slug, "epic-1")).toEqual(keys);
    const rows = epicTaskRows(store.db, store.slug, "epic-1");
    expect(rows.map((r) => r.key)).toEqual(keys);
    expect(rows.find((r) => r.key === "VIB-3")).toEqual({
      key: "VIB-3",
      title: "Task VIB-3",
      stage: "impl",
      archived: false,
      blockedBy: ["VIB-1"],
    });
    expect(rows.find((r) => r.key === "VIB-5")).toMatchObject({ archived: true, blockedBy: [] });
    expect(epicTaskKeys(store.db, store.slug, "epic-10")).toEqual([]);
    expect(epicTaskRows(store.db, SIDE, "epic-1").map((r) => r.key)).toEqual(["SIDE-1"]);
  });

  it("listEpicChips names each of the project's epics as a chip draws it, by number", async () => {
    // CANARY: drop `WHERE project_slug = ?` from listEpicChips (the side
    // project's epic-1 joins the menu).
    const store = await seeded();
    expect(listEpicChips(store.db, store.slug)).toEqual([
      { id: "epic-1", title: "Checkout redesign", color: "teal", status: "in_progress" },
      { id: "epic-2", title: "Search", color: defaultEpicColor("epic-2"), status: "planned" },
      { id: "epic-10", title: "Later", color: defaultEpicColor("epic-10"), status: "done" },
    ]);
  });
});

describe("ruling 503(e): getEpicDetail", () => {
  it("adds the file's history, newest first, to the row's description and progress", async () => {
    // CANARY: drop `dataRoot: options.dataRoot` from getEpicDetail's
    // readEpicFile (the history is read from another store, and comes back
    // empty).
    const store = await seeded();
    const ref = { projectSlug: store.slug, epicId: "epic-1", dataRoot: store.dataRoot };
    await updateEpicFile(ref, () => "Selin Test set the status to In progress.");
    await updateEpicFile(ref, () => "Arda Test added VIB-10.");
    rebuildEpicFile(store.db, store.slug, "epic-1", { dataRoot: store.dataRoot });
    const detail = getEpicDetail(store.db, store.slug, "epic-1", { dataRoot: store.dataRoot });
    expect(detail?.description).toBe("Rebuild the checkout.");
    expect(detail?.progress.total).toBe(7);
    expect(detail?.history.map((h) => h.text)).toEqual([
      "Arda Test added VIB-10.",
      "Selin Test set the status to In progress.",
      `Created by ${store.users.arda.email}.`,
    ]);
    expect(detail?.history[2]?.occurredAt).toBe(CREATED);
    expect(getEpicDetail(store.db, store.slug, "epic-99", { dataRoot: store.dataRoot })).toBeNull();
  });
});

describe("ruling 503(a): the rebuilder projects epic files", () => {
  it("rebuildEpicFile projects an epic file into epic_projections, again only when it changed, and the watcher's path router sends epic files there", async () => {
    // CANARY: drop the EPIC_PATH_RE branch from rebuildPath (an edited epic
    // file is ignored by the watcher).
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const options = { dataRoot: store.dataRoot };
    await writeEpic(store, "epic-4", { title: "Projected" });
    expect(getEpic(store.db, store.slug, "epic-4")).toBeNull();
    expect(rebuildEpicFile(store.db, store.slug, "epic-4", options)).toEqual({
      action: "projected",
      kind: "epic",
      projectSlug: store.slug,
      epicId: "epic-4",
    });
    expect(getEpic(store.db, store.slug, "epic-4")?.title).toBe("Projected");
    expect(rebuildEpicFile(store.db, store.slug, "epic-4", options)).toMatchObject({
      action: "unchanged",
    });

    await updateEpicFile({ projectSlug: store.slug, epicId: "epic-4", dataRoot: store.dataRoot }, (epic) => {
      epic.frontmatter.title = "Renamed on disk";
      return "Renamed it.";
    });
    expect(
      rebuildPath(store.db, epicFilePath(store.slug, "epic-4", store.dataRoot), options),
    ).toMatchObject({ action: "projected", kind: "epic", epicId: "epic-4" });
    expect(getEpic(store.db, store.slug, "epic-4")?.title).toBe("Renamed on disk");
  });

  it("a full rescan prunes the row of an epic whose file is gone, and so does the project-scoped rescan", async () => {
    // CANARY: drop the `epicRows` prune loop from rebuildAll.
    const store = await seeded();
    const options = { dataRoot: store.dataRoot };
    rmSync(epicFilePath(store.slug, "epic-2", store.dataRoot));
    expect(rebuildAll(store.db, options).removed).toBe(1);
    expect(getEpic(store.db, store.slug, "epic-2")).toBeNull();
    expect(listEpics(store.db, store.slug).map((e) => e.id)).toEqual(["epic-1", "epic-10"]);

    rmSync(epicFilePath(store.slug, "epic-10", store.dataRoot));
    expect(rebuildProject(store.db, store.slug, options).removed).toBe(1);
    expect(listEpics(store.db, store.slug).map((e) => e.id)).toEqual(["epic-1"]);
    // The other project's epic of the same number is not this project's.
    expect(getEpic(store.db, SIDE, "epic-1")?.title).toBe("Side epic");
  });

  it("a file the schema rejects, or one naming another epic, projects nothing: the last good row stands and the reason is recorded", async () => {
    // CANARY: drop `idMismatch` from rebuildEpicFileNow (epic-3.md, which says
    // it is epic-1, overwrites epic-1's row).
    const store = await seeded();
    const options = { dataRoot: store.dataRoot };
    const diagnostics = (sourcePath: string) =>
      z
        .array(z.object({ code: z.string(), path: z.string().nullable(), hard_stop: z.number() }))
        .parse(
          store.db
            .prepare(`SELECT code, path, hard_stop FROM diagnostics WHERE source_path = ? ORDER BY id`)
            .all(sourcePath),
        );

    const epic2 = epicFilePath(store.slug, "epic-2", store.dataRoot);
    writeFileSync(epic2, readFileSync(epic2, "utf8").replace("status: planned", "status: finished"));
    expect(rebuildEpicFile(store.db, store.slug, "epic-2", options)).toMatchObject({
      action: "error",
      kind: "epic",
    });
    expect(getEpic(store.db, store.slug, "epic-2")?.status).toBe("planned");
    expect(diagnostics("projects/viberr-core/epics/epic-2.md")).toEqual([
      { code: "frontmatter.invalid_field", path: "status", hard_stop: 1 },
    ]);

    const impostor = readFileSync(epicFilePath(store.slug, "epic-1", store.dataRoot), "utf8").replace(
      "title: Checkout redesign",
      "title: Impostor",
    );
    writeFileSync(epicFilePath(store.slug, "epic-3", store.dataRoot), impostor);
    expect(rebuildEpicFile(store.db, store.slug, "epic-3", options)).toMatchObject({ action: "error" });
    expect(getEpic(store.db, store.slug, "epic-3")).toBeNull();
    expect(getEpic(store.db, store.slug, "epic-1")?.title).toBe("Checkout redesign");
    expect(diagnostics("projects/viberr-core/epics/epic-3.md")).toEqual([
      { code: "frontmatter.invalid_field", path: "id", hard_stop: 1 },
    ]);
  });
});
