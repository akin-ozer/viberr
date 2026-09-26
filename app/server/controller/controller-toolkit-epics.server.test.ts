import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { callToolText, publishedSchemas } from "../../../test-support/mcp-tool-meta";
import { setupAppTest, type AppTestContext } from "../../../test-support/test-app";
import { listAuditEvents } from "../../../test-support/audit-log";
import type { JsonValue } from "~/features/runtime/runtime-types";
import type { ControllerToolkitDeps } from "./controller-toolkit.server";
import type { ControllerToolUser } from "./controller-tool-guards.server";

/**
 * Ruling 503(f): the controller's epic tools.
 *
 * Goal chains became epics, and the controller's four goal tools became four
 * epic tools: `list_epics`, `get_epic`, `create_epic` (whose `tasks` puts
 * existing tasks in as it is made) and `update_epic` (every field, `addTasks`,
 * `removeTasks`, and no delete). The task tools name the epic (`list_tasks`
 * with its `epicId` filter, `get_task`), `create_task` and `update_task` take
 * `epic`, `get_project` summarises the epics, and the per-turn board context
 * lists the open ones where it listed the chains (ruling 121).
 *
 * Every tool acts with the ASKER's authority (ruling 99): creating an epic and
 * changing what it is needs `manage-epics`, moving a task in or out needs
 * `edit-task-meta`, and both are held by the contributor and not the viewer.
 *
 * Fixture roles on viberr-core (demo seed): arda = project admin + org admin,
 * murat = maintainer, selin = contributor, deniz = a member of nothing, and a
 * viewer added in setup. Each test makes the epics it reads and parses their
 * ids from the replies, so no case leans on how epics are numbered; the seed's
 * ten tasks are shared, and a case puts a task where it needs it first.
 */

let app: AppTestContext;
const SLUG = "viberr-core";

interface Actors {
  orgAdmin: string; // arda
  maintainer: string; // murat
  contributor: string; // selin
  nonMember: string; // deniz
  viewer: string; // added in setup
}
let ids: Actors;

/** The server modules the cases read the store through, imported after
 *  `setupAppTest` points the process at this file's data root. */
async function loadModules() {
  const [epicWriter, taskWriter, projectWriter, epicSchema, epicActions, context, deps, users] =
    await Promise.all([
      import("~/server/files/epic-writer.server"),
      import("~/server/files/task-writer.server"),
      import("~/server/files/project-writer.server"),
      import("~/schemas/epic-file.schema"),
      import("~/server/tasks/epic-actions.server"),
      import("./controller-context.server"),
      import("~/server/tasks/dependencies.server"),
      import("~/server/auth/user-store.server"),
    ]);
  return {
    readEpicFile: epicWriter.readEpicFile,
    listEpicIds: epicWriter.listEpicIds,
    readTaskFile: taskWriter.readTaskFile,
    readProjectFile: projectWriter.readProjectFile,
    defaultEpicColor: epicSchema.defaultEpicColor,
    createEpic: epicActions.createEpic,
    gatherControllerContext: context.gatherControllerContext,
    setTaskDependencies: deps.setTaskDependencies,
    findUserById: users.findUserById,
  };
}
let mods: Awaited<ReturnType<typeof loadModules>>;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { seedDefaultAgentAssets } = await import("~/server/seed/default-assets.server");
  seedDefaultAgentAssets(app.dataRoot);
  const { insertUser } = await import("~/server/auth/user-store.server");
  const viewer = insertUser(app.db, {
    id: "u_epic_viewer",
    email: "epic-viewer@viberr.test",
    name: "Epic Viewer",
    role: "member",
  });
  const { updateProjectFile } = await import("~/server/files/project-writer.server");
  await updateProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot }, (p) => {
    p.frontmatter.members.push({ userId: viewer.id, role: "viewer" });
  });
  const { rebuildProject } = await import("~/server/projections/rebuilder.server");
  rebuildProject(app.db, SLUG, { dataRoot: app.dataRoot });
  ids = {
    orgAdmin: userIds.arda,
    maintainer: userIds.murat,
    contributor: userIds.selin,
    nonMember: userIds.deniz,
    viewer: viewer.id,
  };
  mods = await loadModules();
});
afterAll(() => app.cleanup());

/** The asking person as the toolkit and the context read take them. */
function asker(userId: string): ControllerToolUser {
  const user = mods.findUserById(app.db, userId);
  expect(user, `no user ${userId}`).not.toBeNull();
  return { id: userId, email: user?.email ?? "", name: user?.name ?? "" };
}

/** Build the toolkit AS one user, optionally inside a conversation. */
async function toolkitFor(userId: string, conversationId?: string) {
  const { buildControllerToolkit } = await import("./controller-toolkit.server");
  const deps: ControllerToolkitDeps = {
    db: app.db,
    ctx: { dataRoot: app.dataRoot },
    user: asker(userId),
    projectSlug: SLUG,
  };
  if (conversationId) deps.conversationId = conversationId;
  return buildControllerToolkit(deps);
}

/** Call one tool AS one user; returns the text reply. */
async function call(
  userId: string,
  toolName: string,
  args: Record<string, JsonValue> = {},
  conversationId?: string,
): Promise<string> {
  return callToolText((await toolkitFor(userId, conversationId)).tools, toolName, args);
}

/** A reply that must be JSON, parsed through the fields the case reads. */
function parsed<Out>(schema: z.ZodType<Out>, reply: string): Out {
  expect(reply.startsWith("[denied]") || reply.startsWith("[error]"), reply).toBe(false);
  return schema.parse(JSON.parse(reply));
}

/** The epic a `create_epic` reply names. */
function createdEpicId(reply: string): string {
  const id = /\[done\] Created (epic-\d+) /.exec(reply)?.[1];
  expect(id, reply).toBeDefined();
  return id ?? "";
}

/** The task a `create_task` reply names. */
function createdTaskKey(reply: string): string {
  const key = /\[done\] (VIB-\d+) created in /.exec(reply)?.[1];
  expect(key, reply).toBeDefined();
  return key ?? "";
}

/** Make an epic as the maintainer, with tasks in it when given (an empty
 *  `tasks` is the tool's "none"). */
async function makeEpic(title: string, tasks: string[] = []): Promise<string> {
  return createdEpicId(await call(ids.maintainer, "create_epic", { title, tasks }));
}

function epicFile(epicId: string, projectSlug = SLUG) {
  const file = mods.readEpicFile({ projectSlug, epicId, dataRoot: app.dataRoot });
  expect(file, `${epicId} has no file`).not.toBeNull();
  if (!file) throw new Error(`${epicId} has no file`);
  return file.parsed;
}

function taskFile(taskKey: string) {
  const file = mods.readTaskFile({ projectSlug: SLUG, taskKey, dataRoot: app.dataRoot });
  if (!file) throw new Error(`${taskKey} has no file`);
  return file.parsed;
}

/** The newest "Epic" note on a task's timeline. */
function epicNote(taskKey: string) {
  return taskFile(taskKey).timeline.find((e) => e.title === "Epic");
}

const progressSchema = z.object({
  done: z.number(),
  total: z.number(),
  started: z.number(),
  notStarted: z.number(),
  held: z.number(),
  archived: z.number(),
});
const epicRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  lead: z.string().nullable(),
  startDate: z.string().nullable(),
  targetDate: z.string().nullable(),
  progress: progressSchema,
});
const epicListSchema = z.array(epicRowSchema);
const epicDetailSchema = epicRowSchema.extend({
  description: z.string(),
  color: z.string(),
  createdBy: z.string(),
  byStage: z.array(z.object({ stageId: z.string(), count: z.number() })),
  tasks: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      stage: z.string(),
      readiness: z.string(),
      waiting: z.string(),
      owner: z.string().nullable(),
      archived: z.boolean(),
      waitsOn: z.array(z.string()),
    }),
  ),
  history: z.array(z.string()),
});
/** `epic` is nullable, never optional: a row without the key fails the parse. */
const taskListSchema = z.array(
  z.object({ key: z.string(), stage: z.string(), archived: z.boolean(), epic: z.string().nullable() }),
);
const taskReadSchema = z.object({
  task: z.object({ key: z.string(), epicId: z.string().nullable() }),
  epic: z.object({ id: z.string(), title: z.string().nullable() }).nullable(),
});
const projectReadSchema = z.object({ epics: epicListSchema });
/** The one field of `update_task`'s published input schema the case reads. */
const updateTaskEpicFieldSchema = z.object({
  properties: z.object({ epic: z.object({ type: z.string(), description: z.string() }) }),
});

const RETIRED_GOAL_TOOLS = ["list_goals", "get_goal", "create_goal", "update_goal"];

// ------------------------------------------------------------- the surface

describe("ruling 503(f): the epic tools replace the goal tools", () => {
  it("registers list_epics, get_epic, create_epic and update_epic, no goal tool, and no way to delete an epic", async () => {
    // CANARY: register `create_goal` again.
    const names = (await toolkitFor(ids.orgAdmin)).tools.map((t) => t.name);
    for (const retired of RETIRED_GOAL_TOOLS) expect(names).not.toContain(retired);
    expect(names.filter((n) => n.includes("goal"))).toEqual([]);
    // Exactly the four: an epic is closed by its status, never deleted.
    expect(names.filter((n) => n.includes("epic")).sort()).toEqual(
      ["create_epic", "get_epic", "list_epics", "update_epic"],
    );
  });

  it("no tool description or published argument sends the model to a retired goal tool", async () => {
    // CANARY: leave a retired goal tool's name in a description, and the model
    // is sent to a tool that no longer exists.
    const toolkit = await toolkitFor(ids.orgAdmin);
    const published = await publishedSchemas(toolkit.mcpServers.viberr_controller);
    const text =
      toolkit.tools.map((t) => t.description).join("\n") + JSON.stringify([...published.values()]);
    for (const retired of RETIRED_GOAL_TOOLS) expect(text).not.toContain(retired);
  });
});

// ------------------------------------------------------------- create_epic

describe("ruling 503(f): create_epic acts with the asker's authority", () => {
  it("a viewer is refused with nothing written; a contributor's epic takes the defaults", async () => {
    const before = mods.listEpicIds(SLUG, app.dataRoot);
    // CANARY: drop the `manage-epics` gate from `createEpic`.
    expect(await call(ids.viewer, "create_epic", { title: "Viewer's epic" })).toBe(
      "[denied] Your project role (viewer) cannot create epics.",
    );
    expect(mods.listEpicIds(SLUG, app.dataRoot)).toEqual(before);

    const reply = await call(ids.contributor, "create_epic", { title: "Onboarding polish" });
    expect(reply).toMatch(/^\[done\] Created epic-\d+ \(Onboarding polish\)\.$/);
    const epicId = createdEpicId(reply);
    const file = epicFile(epicId);
    // The defaults: planned, the colour its number draws, no lead, no dates.
    expect(file.frontmatter).toMatchObject({
      id: epicId,
      title: "Onboarding polish",
      status: "planned",
      color: mods.defaultEpicColor(epicId),
      leadUserId: null,
      startDate: null,
      targetDate: null,
      createdBy: ids.contributor,
      createdByLabel: "selin@viberr.dev · via controller",
      conversationId: null,
      convertedFrom: null,
    });
    expect(file.description).toBe("");
    expect(file.timeline.map((e) => e.text)).toEqual(["Created by Selin Aksoy (via the controller)."]);
    // Audited under the asking person, the controller named as the instrument.
    const audit = listAuditEvents(app.db, { action: "epic.created" }).find((r) => r.subjectId === epicId);
    expect(audit?.actorUserId).toBe(ids.contributor);
    expect(audit?.actorLabel).toBe("selin@viberr.dev · via controller");
    expect(audit?.details).toEqual({ title: "Onboarding polish", status: "planned", total: 0 });
  });

  it("records every field and the turn's conversation, and `tasks` puts existing tasks in, moving one from another epic", async () => {
    const source = await makeEpic("Legacy checkout", ["VIB-160"]);
    // CANARY: drop create_epic's `input.taskKeys = args.tasks`.
    const reply = await call(
      ids.maintainer,
      "create_epic",
      {
        title: "Payments rework",
        description: "Move every payment path onto the new ledger.",
        status: "in_progress",
        color: "teal",
        lead: "selin@viberr.dev",
        startDate: "2026-10-01",
        targetDate: "2026-11-15",
        // Keys are read case-blind, as a person types them.
        tasks: ["VIB-148", "vib-160"],
      },
      "conv_epic_probe",
    );
    const epicId = createdEpicId(reply);
    expect(reply).toBe(`[done] Created ${epicId} (Payments rework) with VIB-148, VIB-160 in it.`);
    const file = epicFile(epicId);
    expect(file.frontmatter).toMatchObject({
      title: "Payments rework",
      status: "in_progress",
      color: "teal",
      leadUserId: ids.contributor,
      startDate: "2026-10-01",
      targetDate: "2026-11-15",
      createdBy: ids.maintainer,
      conversationId: "conv_epic_probe",
    });
    expect(file.description).toBe("Move every payment path onto the new ledger.");
    // Membership lives on the task.
    expect(taskFile("VIB-148").frontmatter.epic).toBe(epicId);
    expect(taskFile("VIB-160").frontmatter.epic).toBe(epicId);
    expect(epicNote("VIB-148")?.text).toBe(`Added to **${epicId}** (Payments rework).`);
    expect(epicNote("VIB-160")?.text).toBe(
      `Moved from **${source}** (Legacy checkout) to **${epicId}** (Payments rework).`,
    );
    // One history line per epic touched, newest first.
    expect(file.timeline.map((e) => e.text)).toEqual([
      `Murat Yıldız (via the controller) added VIB-148 and moved VIB-160 here from ${source}.`,
      "Created by Murat Yıldız (via the controller).",
    ]);
    expect(epicFile(source).timeline[0]?.text).toBe(
      `Murat Yıldız (via the controller) moved VIB-160 to ${epicId}.`,
    );
  });

  it("a `tasks` key or a lead the store refuses leaves no epic behind", async () => {
    const before = mods.listEpicIds(SLUG, app.dataRoot);
    // CANARY: check the `tasks` keys after `withEpicsLock` mints the id.
    expect(await call(ids.maintainer, "create_epic", { title: "Ghost work", tasks: ["VIB-999"] })).toBe(
      "[error] Task VIB-999 not found.",
    );
    // A lead is someone its notices can reach: a member of the project.
    expect(await call(ids.maintainer, "create_epic", { title: "Ghost lead", lead: "deniz@viberr.dev" })).toBe(
      "[error] An epic's lead must be a member of this project.",
    );
    expect(mods.listEpicIds(SLUG, app.dataRoot)).toEqual(before);
  });
});

// ------------------------------------------------------ list_epics, get_epic

describe("ruling 503(f): list_epics and get_epic", () => {
  let epicId = "";

  beforeAll(async () => {
    // Done, in progress, not started (and waiting on work), and archived.
    epicId = await makeEpic("Timeline compaction", ["VIB-139", "VIB-151", "VIB-166", "VIB-168"]);
    await mods.setTaskDependencies(
      app.db,
      { projectSlug: SLUG, taskKey: "VIB-166", blockedBy: ["VIB-151"] },
      { userId: ids.orgAdmin, label: "arda@viberr.dev" },
      { dataRoot: app.dataRoot },
    );
    const { setTaskArchived } = await import("~/server/tasks/task-actions.server");
    await setTaskArchived(
      app.db,
      { projectSlug: SLUG, taskKey: "VIB-168", archived: true },
      { userId: ids.orgAdmin, label: "arda@viberr.dev" },
      { dataRoot: app.dataRoot },
    );
  });

  it("list_epics counts each epic's progress from its tasks for any member, and hides the project from a non-member", async () => {
    // CANARY: count archived tasks into an epic's `total`.
    const listed = parsed(epicListSchema, await call(ids.viewer, "list_epics"));
    expect(listed.find((e) => e.id === epicId)).toEqual({
      id: epicId,
      title: "Timeline compaction",
      status: "planned",
      lead: null,
      startDate: null,
      targetDate: null,
      progress: { done: 1, total: 3, started: 1, notStarted: 1, held: 1, archived: 1 },
    });
    // Epics are numbered: the list reads in that order.
    const numbers = listed.map((e) => Number(e.id.slice("epic-".length)));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(await call(ids.nonMember, "list_epics")).toBe(`[denied] No project "${SLUG}" is visible to you.`);
  });

  it("get_epic reads one epic whole: its tasks with stage, readiness, owner and waits, progress by stage, and its history", async () => {
    // CANARY: read the epic's tasks without `includeArchived: true`.
    const epic = parsed(epicDetailSchema, await call(ids.viewer, "get_epic", { epicId }));
    expect(epic.progress).toEqual({ done: 1, total: 3, started: 1, notStarted: 1, held: 1, archived: 1 });
    // The bar's segments, in the board's stage order; the archived task is not one.
    expect(epic.byStage).toEqual([
      { stageId: "triage", count: 1 },
      { stageId: "impl", count: 1 },
      { stageId: "done", count: 1 },
    ]);
    expect(epic.tasks.map((t) => [t.key, t.stage, t.owner, t.archived, t.waitsOn])).toEqual([
      ["VIB-139", "done", "Elif Demir", false, []],
      ["VIB-151", "impl", "Selin Aksoy", false, []],
      ["VIB-166", "triage", null, false, ["VIB-151 (open)"]],
      ["VIB-168", "triage", null, true, []],
    ]);
    expect(epic.createdBy).toBe("murat@viberr.dev · via controller");
    expect(epic.history).toHaveLength(2);
    expect(epic.history[0]).toMatch(
      / · Murat Yıldız \(via the controller\) added VIB-139, VIB-151, VIB-166 and VIB-168\.$/,
    );
    expect(epic.history[1]).toMatch(/ · Created by Murat Yıldız \(via the controller\)\.$/);
  });

  it("get_epic refuses an unknown id and names the read that lists them", async () => {
    // CANARY: drop get_epic's not-found refusal, answering `null` instead.
    expect(await call(ids.viewer, "get_epic", { epicId: "epic-999" })).toBe(
      `[error] No epic epic-999 in ${SLUG}; list_epics names them.`,
    );
    expect(await call(ids.nonMember, "get_epic", { epicId })).toBe(
      `[denied] No project "${SLUG}" is visible to you.`,
    );
  });
});

// ------------------------------------------------------------- update_epic

describe("ruling 503(f): update_epic", () => {
  it("changes every field and clears the lead and the dates; a viewer is refused", async () => {
    // An explicit colour, so the change below is one whichever number the
    // epic draws (the default colour follows the number).
    const epicId = createdEpicId(
      await call(ids.contributor, "create_epic", { title: "Search revamp", color: "teal" }),
    );
    // CANARY: drop the `manage-epics` gate from `updateEpic`.
    expect(await call(ids.viewer, "update_epic", { epicId, title: "Viewer rename" })).toBe(
      "[denied] Your project role (viewer) cannot edit epics.",
    );
    expect(epicFile(epicId).frontmatter.title).toBe("Search revamp");

    const edited = await call(ids.contributor, "update_epic", {
      epicId,
      title: "Search revamp phase two",
      description: "Ranking and facets.",
      status: "in_progress",
      color: "rose",
      lead: "murat@viberr.dev",
      startDate: "2026-10-01",
      targetDate: "2026-12-01",
    });
    expect(edited).toBe(
      `[done] Updated ${epicId}: renamed it from "Search revamp" to "Search revamp phase two", ` +
        "rewrote the description, set the status to In progress, changed the colour to rose, " +
        "made Murat Yıldız the lead, set the start date to 2026-10-01 and set the target date to 2026-12-01.",
    );
    const file = epicFile(epicId);
    expect(file.frontmatter).toMatchObject({
      title: "Search revamp phase two",
      status: "in_progress",
      color: "rose",
      leadUserId: ids.maintainer,
      startDate: "2026-10-01",
      targetDate: "2026-12-01",
    });
    expect(file.description).toBe("Ranking and facets.");
    expect(file.timeline[0]?.text).toContain("Selin Aksoy (via the controller) renamed it from");
    const audit = listAuditEvents(app.db, { action: "epic.updated" }).find((r) => r.subjectId === epicId);
    expect(audit?.actorUserId).toBe(ids.contributor);
    expect(audit?.actorLabel).toBe("selin@viberr.dev · via controller");

    // "none" clears the lead and a blank clears a date.
    expect(await call(ids.contributor, "update_epic", { epicId, lead: "none", startDate: "", targetDate: "" })).toBe(
      `[done] Updated ${epicId}: cleared the lead, cleared the start date and cleared the target date.`,
    );
    expect(epicFile(epicId).frontmatter).toMatchObject({ leadUserId: null, startDate: null, targetDate: null });

    expect(await call(ids.contributor, "update_epic", { epicId })).toBe(
      "[error] Pass a field to change (title, description, status, color, lead, startDate, targetDate) or tasks to add or remove.",
    );
    expect(await call(ids.contributor, "update_epic", { epicId: "epic-999", title: "Nowhere" })).toBe(
      `[error] No epic epic-999 in ${SLUG}; list_epics names them.`,
    );
  });

  it("addTasks and removeTasks move tasks in and out, and a removeTasks key not in the epic refuses the whole call", async () => {
    const from = await makeEpic("Operator packets", ["VIB-141"]);
    const epicId = await makeEpic("Review queue");
    // Moving a task is the task's planning metadata: edit-task-meta.
    expect(await call(ids.viewer, "update_epic", { epicId, addTasks: ["VIB-142"] })).toBe(
      "[denied] Your project role (viewer) cannot put tasks in an epic.",
    );
    expect(taskFile("VIB-142").frontmatter.epic).toBeNull();

    expect(await call(ids.contributor, "update_epic", { epicId, addTasks: ["VIB-142", "VIB-141"] })).toBe(
      `[done] VIB-142 and VIB-141 are now in ${epicId} (Review queue).`,
    );
    expect(taskFile("VIB-142").frontmatter.epic).toBe(epicId);
    expect(taskFile("VIB-141").frontmatter.epic).toBe(epicId);
    expect(epicFile(epicId).timeline[0]?.text).toBe(
      `Selin Aksoy (via the controller) added VIB-142 and moved VIB-141 here from ${from}.`,
    );
    expect(epicFile(from).timeline[0]?.text).toBe(`Selin Aksoy (via the controller) moved VIB-141 to ${epicId}.`);

    // CANARY: drop update_epic's removeTasks check, which runs before `updateEpic`.
    expect(
      await call(ids.contributor, "update_epic", { epicId, title: "Should not land", removeTasks: ["VIB-142", "VIB-153"] }),
    ).toBe(`[error] VIB-153 is not in ${epicId}; nothing was changed.`);
    expect(epicFile(epicId).frontmatter.title).toBe("Review queue");
    expect(taskFile("VIB-142").frontmatter.epic).toBe(epicId);

    expect(await call(ids.contributor, "update_epic", { epicId, removeTasks: ["vib-142"] })).toBe(
      "[done] VIB-142 is no longer in an epic.",
    );
    expect(taskFile("VIB-142").frontmatter.epic).toBeNull();
    expect(epicNote("VIB-142")?.text).toBe(`Removed from **${epicId}** (Review queue).`);
    // VIB-141, done, is all that is left, so the all-done line may sit above it.
    expect(epicFile(epicId).timeline.map((e) => e.text)).toContain(
      "Selin Aksoy (via the controller) removed VIB-142.",
    );

    // Fields and tasks in one call, each reported.
    expect(await call(ids.contributor, "update_epic", { epicId, status: "paused", addTasks: ["VIB-153"] })).toBe(
      `[done] Updated ${epicId}: set the status to Paused. VIB-153 is now in ${epicId} (Review queue).`,
    );
  });

  it("a call refused for one of its task keys writes none of its fields either", async () => {
    // An `[error]` reply is how the model learns that nothing happened, so it
    // cannot sit beside a rename that landed. The removeTasks stray check
    // already runs before `updateEpic`; a key `setTasksEpic` refuses (one that
    // does not exist, or an archived one) has to be caught there too.
    const adding = await makeEpic("Atomic adds");
    const removing = await makeEpic("Atomic removes");
    const key = createdTaskKey(
      await call(ids.contributor, "create_task", { title: "Archived inside an epic", epic: removing }),
    );
    const { setTaskArchived } = await import("~/server/tasks/task-actions.server");
    await setTaskArchived(
      app.db,
      { projectSlug: SLUG, taskKey: key, archived: true },
      { userId: ids.orgAdmin, label: "arda@viberr.dev" },
      { dataRoot: app.dataRoot },
    );
    // CANARY: leave the add and remove keys to `setTasksEpic`, after `updateEpic` writes (today).
    expect(
      await call(ids.contributor, "update_epic", { epicId: adding, title: "Half landed", addTasks: ["VIB-999"] }),
    ).toBe("[error] Task VIB-999 not found.");
    expect(
      await call(ids.contributor, "update_epic", { epicId: removing, status: "paused", removeTasks: [key] }),
    ).toBe(`[error] ${key} is archived; restore it before changing its epic.`);
    expect([epicFile(adding).frontmatter.title, epicFile(removing).frontmatter.status]).toEqual([
      "Atomic adds",
      "planned",
    ]);
  });

  it("there is no delete: a closed epic stays readable, keeps its tasks and can be reopened", async () => {
    const epicId = await makeEpic("Board filters", ["VIB-145"]);
    // CANARY: have `listEpics` skip closed epics.
    expect(await call(ids.maintainer, "update_epic", { epicId, status: "done" })).toBe(
      `[done] Updated ${epicId}: set the status to Done.`,
    );
    const closed = parsed(epicListSchema, await call(ids.viewer, "list_epics")).find((e) => e.id === epicId);
    expect(closed?.status).toBe("done");
    expect(parsed(epicDetailSchema, await call(ids.viewer, "get_epic", { epicId })).tasks.map((t) => t.key)).toEqual([
      "VIB-145",
    ]);
    expect(await call(ids.maintainer, "update_epic", { epicId, status: "in_progress" })).toBe(
      `[done] Updated ${epicId}: set the status to In progress.`,
    );
  });
});

// ------------------------------------------------------- the task tools

describe("ruling 503(f): the task tools name the epic", () => {
  it("list_tasks names each task's epic and filters by epicId, `none` for the tasks in no epic", async () => {
    const epicId = await makeEpic("Specialist continuity", ["VIB-153"]);
    const all = parsed(taskListSchema, await call(ids.viewer, "list_tasks"));
    expect(all.find((t) => t.key === "VIB-153")?.epic).toBe(epicId);
    expect(parsed(taskListSchema, await call(ids.viewer, "list_tasks", { epicId })).map((t) => t.key)).toEqual([
      "VIB-153",
    ]);
    const inNone = all.filter((t) => t.epic === null).map((t) => t.key);
    expect(inNone.length).toBeGreaterThan(0);
    // CANARY: read `epicId: "none"` as an epic's id rather than "in no epic".
    for (const spelling of ["none", "NONE"]) {
      const rows = parsed(taskListSchema, await call(ids.viewer, "list_tasks", { epicId: spelling }));
      expect(rows.map((t) => t.key)).toEqual(inNone);
      expect(rows.every((t) => t.epic === null)).toBe(true);
    }
  });

  it("get_task names the epic by id and title, and null for a task in none", async () => {
    const epicId = await makeEpic("Card revalidation", ["VIB-145"]);
    // CANARY: drop the `epic` field from get_task's reply.
    const inEpic = parsed(taskReadSchema, await call(ids.viewer, "get_task", { taskKey: "VIB-145" }));
    expect(inEpic.task.epicId).toBe(epicId);
    expect(inEpic.epic).toEqual({ id: epicId, title: "Card revalidation" });
    const key = createdTaskKey(await call(ids.contributor, "create_task", { title: "A task in no epic" }));
    expect(parsed(taskReadSchema, await call(ids.viewer, "get_task", { taskKey: key })).epic).toBeNull();
  });

  it("create_task with `epic` makes the task in it; an unknown epic is refused before a key is allocated", async () => {
    const epicId = await makeEpic("Epic-born work");
    // CANARY: drop create_task's `taskInput.epic = args.epic.trim()`.
    const reply = await call(ids.contributor, "create_task", { title: "Born in an epic", epic: epicId });
    const key = createdTaskKey(reply);
    expect(reply).toBe(`[done] ${key} created in Triage: Born in an epic. In ${epicId}.`);
    expect(taskFile(key).frontmatter.epic).toBe(epicId);
    expect(epicNote(key)?.text).toBe(`Added to **${epicId}** (Epic-born work).`);

    const counter = () =>
      mods.readProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot })?.parsed.frontmatter.nextTaskNumber;
    const before = counter();
    // Refused before `allocateTaskKey`, so no task number is burnt.
    expect(await call(ids.contributor, "create_task", { title: "Orphaned", epic: "epic-999" })).toBe(
      "[error] epic-999 is not an epic in this project. An epic is named like epic-3; list_epics or the Epics page names them.",
    );
    expect(counter()).toBe(before);
  });

  it("update_task with `epic` moves the task, `\"\"` takes it out, and a viewer is refused", async () => {
    const first = await makeEpic("Pre-flight checks");
    const second = await makeEpic("Scope validation");
    const key = createdTaskKey(await call(ids.contributor, "create_task", { title: "Validate the scopes" }));

    expect(await call(ids.viewer, "update_task", { taskKey: key, epic: first })).toBe(
      "[denied] Your project role (viewer) cannot put tasks in an epic.",
    );
    // CANARY: drop the `epic` arm of update_task.
    expect(await call(ids.contributor, "update_task", { taskKey: key, epic: first })).toBe(
      `[done] ${key} updated: epic (${first}).`,
    );
    expect(await call(ids.contributor, "update_task", { taskKey: key, epic: second })).toBe(
      `[done] ${key} updated: epic (${second}).`,
    );
    expect(taskFile(key).frontmatter.epic).toBe(second);
    expect(epicNote(key)?.text).toBe(`Moved from **${first}** (Pre-flight checks) to **${second}** (Scope validation).`);
    expect(await call(ids.contributor, "update_task", { taskKey: key, epic: second })).toBe(
      `[noop] ${key}: epic already had that value; nothing was written.`,
    );
    expect(await call(ids.contributor, "update_task", { taskKey: key, epic: "" })).toBe(
      `[done] ${key} updated: epic (taken out).`,
    );
    expect(taskFile(key).frontmatter.epic).toBeNull();
    expect(epicNote(key)?.text).toBe(`Removed from **${second}** (Scope validation).`);
    expect(await call(ids.contributor, "update_task", { taskKey: key, epic: "epic-999" })).toBe(
      "[error] epic-999 is not an epic in this project. An epic is named like epic-3; list_epics or the Epics page names them.",
    );

    // The published argument says how it clears, which is the only spelling
    // the model can learn it from.
    const toolkit = await toolkitFor(ids.contributor);
    const published = await publishedSchemas(toolkit.mcpServers.viberr_controller);
    const field = updateTaskEpicFieldSchema.parse(published.get("update_task")).properties.epic;
    expect(field.type).toBe("string");
    expect(field.description).toContain('or "" to take it out of its epic');
  });

  it("get_project summarises the epics, each with its status, lead, dates and progress", async () => {
    const epicId = await makeEpic("Release notes", ["VIB-141", "VIB-142"]);
    // CANARY: drop `epics` from get_project's reply.
    const project = parsed(projectReadSchema, await call(ids.viewer, "get_project"));
    const row = project.epics.find((e) => e.id === epicId)!;
    expect(row).toMatchObject({ id: epicId, title: "Release notes", status: "planned", lead: null, startDate: null, targetDate: null });
    expect(row.progress).toMatchObject({ done: 1, total: 2 });
    // The same rows `list_epics` reads, in the same order.
    expect(project.epics).toEqual(parsed(epicListSchema, await call(ids.viewer, "list_epics")));
  });
});

// ------------------------------------------------------- the context read

describe("ruling 503(f): the per-turn context lists the open epics where it listed the chains", () => {
  /** The per-turn read for a turn in `projectSlug`, anchored on a task when given. */
  function contextRead(projectSlug: string, taskKey: string | null = null) {
    return mods.gatherControllerContext(app.db, {
      projectSlug,
      taskKey,
      user: asker(ids.orgAdmin),
      dataRoot: app.dataRoot,
    });
  }

  it("the board context lists the open epics with their progress, at most BOARD_CONTEXT_EPICS (20), and names list_epics for the rest", async () => {
    // A project of its own, so the epics this file makes elsewhere neither
    // push these past the cap nor count toward it.
    const PIPELINE = "deploy-pipeline";
    const arda = { userId: ids.orgAdmin, label: "arda@viberr.dev" };
    const ctx = { dataRoot: app.dataRoot };
    // Two closed epics first, so the open ones start at epic-3.
    await mods.createEpic(app.db, { projectSlug: PIPELINE, title: "Shipped pipeline", status: "done" }, arda, ctx);
    await mods.createEpic(app.db, { projectSlug: PIPELINE, title: "Dropped pipeline", status: "cancelled" }, arda, ctx);
    for (let n = 1; n <= 22; n += 1) {
      const input = {
        projectSlug: PIPELINE,
        title: `Open pipeline epic ${String(n).padStart(2, "0")}`,
        status: n % 2 === 0 ? "paused" : "in_progress",
        taskKeys: n === 1 ? ["DEP-31"] : [],
      };
      await mods.createEpic(app.db, input, arda, ctx);
    }
    // A second task in the first open epic, waiting on DEP-31: held.
    const born = await call(ids.orgAdmin, "create_task", {
      projectSlug: PIPELINE,
      title: "Roll the pipeline out",
      blockedBy: ["DEP-31"],
      epic: "epic-3",
    });
    expect(born).toMatch(/ In epic-3\. Waits on DEP-31;/);

    const read = contextRead(PIPELINE);
    // CANARY: drop the `BOARD_CONTEXT_EPICS` slice from the open-epics block.
    const lines = read.text.split("\n").filter((l) => l.startsWith("- epic-"));
    expect(lines).toHaveLength(20);
    // The held count rides on the line.
    expect(lines[0]).toBe("- epic-3 · Open pipeline epic 01 · in_progress · 0 of 2 done, 1 held");
    expect(lines[1]).toBe("- epic-4 · Open pipeline epic 02 · paused · 0 of 0 done");
    expect(lines[19]).toBe("- epic-22 · Open pipeline epic 20 · paused · 0 of 0 done");
    expect(read.text).toContain("\n- ... 2 more open epics; list_epics reads them");
    // Done and cancelled epics are not listed.
    expect(read.text).not.toContain("Shipped pipeline");
    expect(read.text).not.toContain("Dropped pipeline");
    expect(read.text).toContain("open epics: \n- epic-3 ·");
    expect(read.text).not.toMatch(/goal chain/i);
  });

  it("a board with no open epic says so", () => {
    // CANARY: drop the `none` arm of the open-epics block.
    expect(contextRead("billing-service").text).toContain("open epics: none");
  });

  it("a task-anchored context names the task's epic", async () => {
    const epicId = await makeEpic("Anchored work", ["VIB-148"]);
    // CANARY: drop the ` · epic <id>` clause from the task header.
    const read = contextRead(SLUG, "VIB-148");
    expect(read.scope).toBe("task");
    expect(read.text).toContain(`open packet: none · epic ${epicId}`);
  });
});
