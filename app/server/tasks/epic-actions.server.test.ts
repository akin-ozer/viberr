import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EPIC_COLORS, defaultEpicColor } from "~/schemas/epic-file.schema";
import { epicHref } from "~/shared/epic-href";
import { listAuditEvents } from "../../../test-support/audit-log";
import { waitFor } from "../../../test-support/polling";
import { setupAppTest, type AppTestContext } from "../../../test-support/test-app";
import type { CreateEpicInput, UpdateEpicInput } from "./epic-actions.server";
import type { TaskActionContext, TaskActionDeps } from "./task-actions.server";
import type { TaskActor } from "./task-mutation.server";

/**
 * Ruling 503(a)–(d): the epic actions, end to end against the real store.
 * `createEpic` and `updateEpic` change what an epic is (`manage-epics`);
 * `setTasksEpic` is the one writer of a task's `epic` after creation
 * (`edit-task-meta`), and `createTask` can make a task in one. Every move
 * writes the task's "Epic" note, one history line per epic touched, a
 * `task.epic.changed` row and a notice to the epic's lead (or its creator
 * while nobody leads it), never to the person who moved it. When the last
 * open task of an open epic is done, archived or taken out, the history says
 * "Every task is done (N tasks)." once and the lead is told.
 *
 * Fixture: the demo seed's viberr-core (arda = org admin + project admin,
 * elif = project admin, murat = maintainer, selin = contributor, deniz = a
 * member of nothing) plus a viewer added here. The tests share the store, so
 * each one makes its own tasks and epics and reads notices by the epic they
 * open.
 */

let app: AppTestContext;
const SLUG = "viberr-core";

interface People {
  arda: string;
  elif: string;
  murat: string;
  selin: string;
  deniz: string;
  viewer: string;
}
let ids: People;

let epicActions: typeof import("./epic-actions.server");
let taskActions: typeof import("./task-actions.server");
let epicWriter: typeof import("~/server/files/epic-writer.server");
let taskWriter: typeof import("~/server/files/task-writer.server");
let projectWriter: typeof import("~/server/files/project-writer.server");
let fileStore: typeof import("~/server/files/file-store-root.server");
let epicQuery: typeof import("~/server/projections/epic-query.server");
let notifications: typeof import("~/server/projections/notifications.server");
let rebuilder: typeof import("~/server/projections/rebuilder.server");

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { insertUser } = await import("~/server/auth/user-store.server");
  const viewer = insertUser(app.db, {
    id: "u_epic_viewer",
    email: "viewer@viberr.test",
    name: "View Only",
    role: "member",
  });
  epicActions = await import("./epic-actions.server");
  taskActions = await import("./task-actions.server");
  epicWriter = await import("~/server/files/epic-writer.server");
  taskWriter = await import("~/server/files/task-writer.server");
  projectWriter = await import("~/server/files/project-writer.server");
  fileStore = await import("~/server/files/file-store-root.server");
  epicQuery = await import("~/server/projections/epic-query.server");
  notifications = await import("~/server/projections/notifications.server");
  rebuilder = await import("~/server/projections/rebuilder.server");
  await projectWriter.updateProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot }, (project) => {
    project.frontmatter.members.push({ userId: viewer.id, role: "viewer" });
  });
  rebuilder.rebuildProject(app.db, SLUG, { dataRoot: app.dataRoot });
  ids = { ...userIds, viewer: viewer.id };
});
afterAll(() => app.cleanup());

/** Who acts: their id, with an address as the audit label. */
function actor(who: keyof People): TaskActor {
  return { userId: ids[who], label: `${who}@viberr.dev` };
}

// Creating a task hands it to the operator (fire-and-forget); the seam keeps
// that hand-off from writing to the store while a test reads it.
const runOperator = vi.fn<NonNullable<TaskActionDeps["runOperator"]>>(async () => ({
  runId: null,
  queued: false,
  backend: "claude",
  autonomy: "supervised",
}));

function ctx(): TaskActionContext {
  return { dataRoot: app.dataRoot, deps: { runOperator } };
}

function create(input: Omit<CreateEpicInput, "projectSlug">, who: TaskActor, slug = SLUG) {
  return epicActions.createEpic(app.db, { projectSlug: slug, ...input }, who, ctx());
}

async function newEpic(who: keyof People, input: Omit<CreateEpicInput, "projectSlug">): Promise<string> {
  return (await create(input, actor(who))).epic.id;
}

function edit(input: Omit<UpdateEpicInput, "projectSlug">, who: TaskActor, slug = SLUG) {
  return epicActions.updateEpic(app.db, { projectSlug: slug, ...input }, who, ctx());
}

function move(
  taskKeys: string[],
  epicId: string | null,
  who: TaskActor,
  options: { operator?: boolean; slug?: string } = {},
) {
  return epicActions.setTasksEpic(
    app.db,
    { projectSlug: options.slug ?? SLUG, taskKeys, epicId },
    who,
    { ...ctx(), operatorAuthorized: options.operator === true },
  );
}

async function newTask(title: string): Promise<string> {
  const { key } = await taskActions.createTask(app.db, { projectSlug: SLUG, title }, actor("arda"), ctx());
  return key;
}

function taskRef(taskKey: string) {
  return { projectSlug: SLUG, taskKey, dataRoot: app.dataRoot };
}

function epicRef(epicId: string) {
  return { projectSlug: SLUG, epicId, dataRoot: app.dataRoot };
}

function taskFile(taskKey: string) {
  return taskWriter.readTaskFile(taskRef(taskKey))!.parsed;
}

function rawTask(taskKey: string): string {
  return readFileSync(taskWriter.resolveTaskFilePath(taskRef(taskKey)), "utf8");
}

function epicOf(taskKey: string): string | null {
  return taskFile(taskKey).frontmatter.epic;
}

/** The task's "Epic" notes, newest first. */
function epicNotes(taskKey: string) {
  return taskFile(taskKey).timeline.filter((event) => event.title === "Epic");
}

function epicFile(epicId: string) {
  return epicWriter.readEpicFile(epicRef(epicId))!.parsed;
}

function rawEpic(epicId: string): string {
  return readFileSync(fileStore.epicFilePath(SLUG, epicId, app.dataRoot), "utf8");
}

/** The epic's history, newest first. */
function history(epicId: string): string[] {
  return epicFile(epicId).timeline.map((entry) => entry.text);
}

/** One person's `epic` notices about one epic, newest first. */
function notices(who: keyof People, epicId: string) {
  return notifications
    .listNotifications(app.db, ids[who], { limit: 1000 })
    .filter((n) => n.kind === "epic" && n.href === epicHref(SLUG, epicId));
}

function audits(action: string, subjectId: string) {
  return listAuditEvents(app.db, { action, limit: 1000 }).filter((row) => row.subjectId === subjectId);
}

/** Put a task at the terminal stage through its file, the way a hand edit
 *  would: no hook fires. */
async function closeToDone(taskKey: string): Promise<void> {
  await taskWriter.updateTaskFile(taskRef(taskKey), (parsed) => {
    parsed.frontmatter.previousStageId = parsed.frontmatter.stage;
    parsed.frontmatter.stage = "done";
    parsed.frontmatter.waiting = "none";
  });
  rebuilder.rebuildTaskFile(app.db, SLUG, taskKey, { dataRoot: app.dataRoot });
}

/**
 * The all-done hook is fire-and-forget, and when it has anything to check it
 * requests the epic file's lock synchronously, as it fires. A no-op locked
 * update queued after that request is granted only once the hook's locked
 * read-modify-write has run (Web Locks grant one name's requests in order),
 * so whatever the hook wrote, or chose not to, is on disk when this returns.
 */
async function settled(epicId: string): Promise<void> {
  await epicWriter.updateEpicFile(epicRef(epicId), () => undefined);
}

const NOT_AN_EPIC = (id: string) =>
  `${id} is not an epic in this project. An epic is named like epic-3; list_epics or the Epics page names them.`;

describe("ruling 503(a): createEpic", () => {
  it("defaults to planned, the default colour for its id and no lead or dates, opens its history with who made it, and records epic.created", async () => {
    // CANARY: default `status` to "in_progress" instead of "planned" in
    // createEpic.
    const result = await create({ title: "  Onboarding   revamp " }, actor("selin"));
    const id = result.epic.id;
    expect(result.message).toBe(`Created ${id} (Onboarding revamp).`);
    expect(epicFile(id).frontmatter).toMatchObject({
      id,
      title: "Onboarding revamp",
      status: "planned",
      color: defaultEpicColor(id),
      leadUserId: null,
      startDate: null,
      targetDate: null,
      createdBy: ids.selin,
      createdByLabel: "selin@viberr.dev",
      conversationId: null,
      convertedFrom: null,
    });
    expect(epicFile(id).description).toBe("");
    expect(history(id)).toEqual(["Created by Selin Aksoy."]);
    // Projected before it returns: the result is read back from the row.
    expect(result.epic).toMatchObject({
      id,
      title: "Onboarding revamp",
      status: "planned",
      progress: { total: 0 },
      history: [{ text: "Created by Selin Aksoy." }],
    });
    const rows = audits("epic.created", id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: ids.selin,
      actorLabel: "selin@viberr.dev",
      subjectKind: "epic",
      projectSlug: SLUG,
      details: { title: "Onboarding revamp", status: "planned", total: 0 },
    });
  });

  it("keeps what it is given, and tells a lead named by someone else that they lead it", async () => {
    // CANARY: drop the `notifyEpicLead` call from createEpic.
    const id = await newEpic("arda", {
      title: "Payments",
      description: "Card payments, end to end.",
      status: "in_progress",
      color: "amber",
      leadUserId: ids.murat,
      startDate: "2026-10-01",
      targetDate: "2026-11-30",
      conversationId: "conv_payments",
    });
    expect(epicFile(id).frontmatter).toMatchObject({
      status: "in_progress",
      color: "amber",
      leadUserId: ids.murat,
      startDate: "2026-10-01",
      targetDate: "2026-11-30",
      conversationId: "conv_payments",
    });
    expect(epicFile(id).description).toBe("Card payments, end to end.");
    const told = notices("murat", id);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      kind: "epic",
      title: `${id} · Payments`,
      text: `Arda Kaya created **${id}** (Payments) with you as its lead.`,
      projectSlug: SLUG,
      from: { kind: "human", name: "Arda Kaya" },
    });
    // Naming yourself tells nobody.
    const own = await newEpic("selin", { title: "Self-led", leadUserId: ids.selin });
    expect(notices("selin", own)).toEqual([]);
  });

  it("refuses a short or long title, a bad status, colour or date, a target before the start and a lead who is not a member, and writes nothing", async () => {
    // CANARY: drop `requireDateOrder` from createEpic (the epic whose target
    // is before its start is made).
    const before = epicWriter.listEpicIds(SLUG, app.dataRoot);
    const createdRows = listAuditEvents(app.db, { action: "epic.created", limit: 1000 }).length;
    const refusals: [Omit<CreateEpicInput, "projectSlug">, string][] = [
      [{ title: "ab" }, "Give the epic a name of at least 3 characters."],
      [{ title: "   a    " }, "Give the epic a name of at least 3 characters."],
      [
        { title: "x".repeat(121) },
        "An epic's name is at most 120 characters; put the rest in its description.",
      ],
      [
        { title: "Valid name", status: "finished" },
        `"finished" is not an epic status. Use one of: planned, in_progress, paused, done, cancelled.`,
      ],
      [
        { title: "Valid name", color: "chartreuse" },
        `"chartreuse" is not an epic colour. Use one of: ${EPIC_COLORS.join(", ")}.`,
      ],
      [
        { title: "Valid name", startDate: "2026-02-30" },
        `The start date must be a calendar date (YYYY-MM-DD); got "2026-02-30".`,
      ],
      [
        { title: "Valid name", targetDate: "next week" },
        `The target date must be a calendar date (YYYY-MM-DD); got "next week".`,
      ],
      [
        { title: "Valid name", startDate: "2026-12-01", targetDate: "2026-11-01" },
        "The target date (2026-11-01) is before the start date (2026-12-01).",
      ],
      [{ title: "Valid name", leadUserId: ids.deniz }, "An epic's lead must be a member of this project."],
    ];
    for (const [input, message] of refusals) {
      await expect(create(input, actor("selin")), message).rejects.toMatchObject({
        status: 400,
        userMessage: message,
      });
    }
    expect(epicWriter.listEpicIds(SLUG, app.dataRoot)).toEqual(before);
    expect(listAuditEvents(app.db, { action: "epic.created", limit: 1000 })).toHaveLength(createdRows);
    // The bounds themselves are accepted.
    const longest = await newEpic("selin", {
      title: "y".repeat(120),
      startDate: "2026-11-01",
      targetDate: "2026-11-01",
    });
    expect(epicFile(longest).frontmatter.title).toHaveLength(120);
  });

  it("taskKeys puts existing tasks in as it is made: one history line, each task's Epic note, and the audit counts them", async () => {
    // CANARY: drop the `setTasksEpic` call from createEpic (the epic is made
    // empty).
    const a = await newTask("Seeded member one");
    const b = await newTask("Seeded member two");
    const result = await create({ title: "Seeded", taskKeys: [` ${a.toLowerCase()} `, b, b] }, actor("selin"));
    const id = result.epic.id;
    expect(result.message).toBe(`Created ${id} (Seeded) with ${a}, ${b} in it.`);
    expect([epicOf(a), epicOf(b)]).toEqual([id, id]);
    expect(history(id)).toEqual([`Selin Aksoy added ${a} and ${b}.`, "Created by Selin Aksoy."]);
    expect(epicNotes(a).map((event) => event.text)).toEqual([`Added to **${id}** (Seeded).`]);
    expect(audits("epic.created", id)[0]?.details).toEqual({ title: "Seeded", status: "planned", total: 2 });
    expect(result.epic.progress).toMatchObject({ total: 2, notStarted: 2 });
    expect(epicQuery.epicTaskKeys(app.db, SLUG, id)).toEqual([a, b]);
  });

  it("a task key that does not resolve, or an archived task, leaves no epic file behind", async () => {
    // CANARY: move createEpic's `requireMovableTask` loop below
    // `withEpicsLock` (the refused epic's file stays behind).
    const member = await newTask("Would-be member");
    const archived = await newTask("Archived would-be member");
    await taskActions.setTaskArchived(
      app.db,
      { projectSlug: SLUG, taskKey: archived, archived: true },
      actor("arda"),
      ctx(),
    );
    const before = epicWriter.listEpicIds(SLUG, app.dataRoot);
    await expect(create({ title: "Never made", taskKeys: [member, "VIB-99999"] }, actor("selin"))).rejects.toMatchObject({
      status: 404,
      userMessage: "Task VIB-99999 not found.",
    });
    await expect(create({ title: "Never made", taskKeys: [member, archived] }, actor("selin"))).rejects.toMatchObject({
      status: 400,
      userMessage: `${archived} is archived; restore it before changing its epic.`,
    });
    expect(epicWriter.listEpicIds(SLUG, app.dataRoot)).toEqual(before);
    expect(epicOf(member)).toBeNull();
    expect(epicNotes(member)).toEqual([]);
  });

  it("two creations at once mint two ids", async () => {
    // CANARY: call `nextEpicId` before taking `withEpicsLock` in createEpic
    // (both mint the same id and the second write is refused).
    const [one, two] = await Promise.all([
      create({ title: "Parallel one" }, actor("selin")),
      create({ title: "Parallel two" }, actor("murat")),
    ]);
    expect(one.epic.id).not.toBe(two.epic.id);
    expect(epicFile(one.epic.id).frontmatter.title).toBe("Parallel one");
    expect(epicFile(two.epic.id).frontmatter.title).toBe("Parallel two");
  });
});

describe("ruling 503(a): updateEpic", () => {
  it("changes every field in one edit, told in one history sentence and one epic.updated row", async () => {
    // CANARY: write one history line per changed field in updateEpic instead
    // of joining the clauses into one sentence.
    const id = await newEpic("arda", { title: "Old name", description: "Old words.", color: "rose" });
    const result = await edit(
      {
        epicId: id,
        title: "New name",
        description: "New words.",
        status: "in_progress",
        color: "teal",
        leadUserId: ids.murat,
        startDate: "2026-10-01",
        targetDate: "2026-12-15",
      },
      actor("selin"),
    );
    const summary =
      `renamed it from "Old name" to "New name", rewrote the description, set the status to In progress, ` +
      `changed the colour to teal, made Murat Yıldız the lead, set the start date to 2026-10-01 ` +
      `and set the target date to 2026-12-15`;
    expect(result.message).toBe(`Updated ${id}: ${summary}.`);
    expect(result.changed).toHaveLength(7);
    expect(history(id)).toEqual([`Selin Aksoy ${summary}.`, "Created by Arda Kaya."]);
    expect(epicFile(id).frontmatter).toMatchObject({
      title: "New name",
      status: "in_progress",
      color: "teal",
      leadUserId: ids.murat,
      startDate: "2026-10-01",
      targetDate: "2026-12-15",
    });
    expect(epicFile(id).description).toBe("New words.");
    expect(result.epic).toMatchObject({
      title: "New name",
      status: "in_progress",
      leadName: "Murat Yıldız",
      description: "New words.",
    });
    const rows = audits("epic.updated", id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: ids.selin,
      subjectKind: "epic",
      details: { title: "New name", summary, status: "in_progress" },
    });
  });

  it("clears what it is asked to clear, and its audit row names a status only when the status changed", async () => {
    // CANARY: put `status` in epic.updated's details whenever the edit named
    // one, changed or not.
    const id = await newEpic("arda", {
      title: "Clearable",
      description: "Words.",
      leadUserId: ids.murat,
      startDate: "2026-10-01",
      targetDate: "2026-12-15",
    });
    await edit(
      { epicId: id, status: "planned", description: "  ", leadUserId: null, startDate: "", targetDate: null },
      actor("selin"),
    );
    const summary = "cleared the description, cleared the lead, cleared the start date and cleared the target date";
    expect(history(id)[0]).toBe(`Selin Aksoy ${summary}.`);
    expect(epicFile(id).frontmatter).toMatchObject({ leadUserId: null, startDate: null, targetDate: null });
    expect(epicFile(id).description).toBe("");
    expect(audits("epic.updated", id).map((row) => row.details)).toEqual([{ title: "Clearable", summary }]);
  });

  it("an edit that changes nothing says the epic already reads that way and writes nothing", async () => {
    // CANARY: record the epic.updated row outside the `changed.length > 0`
    // guard in updateEpic.
    const id = await newEpic("arda", { title: "Settled", status: "in_progress", color: "rose" });
    const raw = rawEpic(id);
    const result = await edit(
      {
        epicId: id,
        title: " Settled ",
        description: "",
        status: "in_progress",
        color: "rose",
        leadUserId: null,
        startDate: "",
        targetDate: null,
      },
      actor("selin"),
    );
    expect(result).toMatchObject({ changed: [], message: `${id} already reads that way; nothing changed.` });
    expect(rawEpic(id)).toBe(raw);
    expect(audits("epic.updated", id)).toEqual([]);
  });

  it("tells a new lead they lead it, and the lead (or, with none, the creator) when someone else changes the status, never when they change it themselves", async () => {
    // CANARY: pass `exceptUserId: null` for the status notice in updateEpic
    // (the lead is told of their own change).
    const id = await newEpic("arda", { title: "Led work" });
    await edit({ epicId: id, leadUserId: ids.murat }, actor("selin"));
    expect(notices("murat", id).map((n) => n.text)).toEqual([
      `Selin Aksoy made you the lead of **${id}** (Led work).`,
    ]);
    await edit({ epicId: id, status: "paused" }, actor("selin"));
    expect(notices("murat", id).map((n) => n.text)).toEqual([
      `Selin Aksoy set **${id}** (Led work) to Paused.`,
      `Selin Aksoy made you the lead of **${id}** (Led work).`,
    ]);
    await edit({ epicId: id, status: "in_progress" }, actor("murat"));
    expect(history(id)[0]).toBe("Murat Yıldız set the status to In progress.");
    expect(notices("murat", id)).toHaveLength(2);

    const unled = await newEpic("arda", { title: "Unled work" });
    await edit({ epicId: unled, status: "done" }, actor("selin"));
    expect(notices("arda", unled).map((n) => n.text)).toEqual([
      `Selin Aksoy set **${unled}** (Unled work) to Done.`,
    ]);
  });

  it("checks every value before writing any: one bad value fails the whole edit", async () => {
    // CANARY: compare a new target date only against a start date given in
    // the same edit (drop the `current.frontmatter.startDate` fallback in
    // updateEpic).
    const id = await newEpic("arda", { title: "Dated", startDate: "2026-10-01" });
    const raw = rawEpic(id);
    await expect(edit({ epicId: id, title: "Renamed", targetDate: "2026-09-01" }, actor("selin"))).rejects.toMatchObject({
      status: 400,
      userMessage: "The target date (2026-09-01) is before the start date (2026-10-01).",
    });
    await expect(edit({ epicId: id, title: "Renamed", leadUserId: ids.deniz }, actor("selin"))).rejects.toMatchObject({
      status: 400,
      userMessage: "An epic's lead must be a member of this project.",
    });
    await expect(edit({ epicId: id, title: "Renamed", status: "finished" }, actor("selin"))).rejects.toMatchObject({
      status: 400,
      userMessage: `"finished" is not an epic status. Use one of: planned, in_progress, paused, done, cancelled.`,
    });
    expect(rawEpic(id)).toBe(raw);
    await expect(edit({ epicId: "epic-99999", title: "Renamed" }, actor("selin"))).rejects.toMatchObject({
      status: 404,
      userMessage: NOT_AN_EPIC("epic-99999"),
    });
  });
});

describe("ruling 503(b): setTasksEpic, the one writer of a task's epic", () => {
  it("adds, moves and removes a task, each move noted on the task, on every epic it touched, in the audit and to each lead", async () => {
    // CANARY: drop `if (change.from) touched.add(change.from);` from
    // setTasksEpic (the epic a task left never hears of it).
    const task = await newTask("Wandering task");
    const first = await newEpic("selin", { title: "First home", leadUserId: ids.murat });
    const second = await newEpic("arda", { title: "Second home" });
    const selin = actor("selin");

    const added = await move([task], first, selin);
    expect(added).toEqual({
      changed: [{ taskKey: task, from: null, to: first }],
      unchanged: [],
      message: `${task} is now in ${first} (First home).`,
    });
    expect(epicOf(task)).toBe(first);
    expect(epicNotes(task)[0]).toMatchObject({
      type: "note",
      title: "Epic",
      text: `Added to **${first}** (First home).`,
      actor: { kind: "human", userId: ids.selin },
    });
    expect(history(first)[0]).toBe(`Selin Aksoy added ${task}.`);
    expect(notices("murat", first)[0]).toMatchObject({
      text: `Selin Aksoy added ${task} in **${first}** (First home).`,
      taskKey: task,
    });

    await move([task], second, selin);
    expect(epicOf(task)).toBe(second);
    expect(epicNotes(task)[0]?.text).toBe(`Moved from **${first}** (First home) to **${second}** (Second home).`);
    expect(history(first)[0]).toBe(`Selin Aksoy moved ${task} to ${second}.`);
    expect(history(second)[0]).toBe(`Selin Aksoy moved ${task} here from ${first}.`);
    expect(notices("murat", first)[0]?.text).toBe(`Selin Aksoy moved ${task} to ${second} in **${first}** (First home).`);
    expect(notices("arda", second)[0]?.text).toBe(
      `Selin Aksoy moved ${task} here from ${first} in **${second}** (Second home).`,
    );

    const removed = await move([task], null, selin);
    expect(removed.message).toBe(`${task} is no longer in an epic.`);
    expect(epicOf(task)).toBeNull();
    expect(epicNotes(task)[0]?.text).toBe(`Removed from **${second}** (Second home).`);
    expect(history(second)[0]).toBe(`Selin Aksoy removed ${task}.`);
    expect(notices("arda", second)[0]?.text).toBe(`Selin Aksoy removed ${task} in **${second}** (Second home).`);

    expect(epicNotes(task)).toHaveLength(3);
    const rows = audits("task.epic.changed", task);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.details)).toEqual(
      expect.arrayContaining([
        { from: null, to: first, title: "First home" },
        { from: first, to: second, title: "Second home" },
        { from: second, to: null, title: "Second home" },
      ]),
    );
    for (const row of rows) {
      expect(row).toMatchObject({ actorUserId: ids.selin, taskKey: task, projectSlug: SLUG });
    }
    // The projection follows each write.
    expect(epicQuery.epicTaskKeys(app.db, SLUG, second)).toEqual([]);
  });

  it("leaves a task already where it was asked to be alone and writes nothing", async () => {
    // CANARY: drop the `from === to` branch from planTasksEpic (a repeat
    // writes a second note and history line).
    const task = await newTask("Settled member");
    const id = await newEpic("selin", { title: "Stable home", leadUserId: ids.murat, taskKeys: [task] });
    const taskBefore = rawTask(task);
    const epicBefore = rawEpic(id);
    const auditsBefore = audits("task.epic.changed", task).length;
    const noticesBefore = notices("murat", id).length;
    expect(await move([task.toLowerCase()], id, actor("selin"))).toEqual({
      changed: [],
      unchanged: [task],
      message: `${task} is already in ${id}.`,
    });
    expect(rawTask(task)).toBe(taskBefore);
    expect(rawEpic(id)).toBe(epicBefore);
    expect(audits("task.epic.changed", task)).toHaveLength(auditsBefore);
    expect(notices("murat", id)).toHaveLength(noticesBefore);

    const loose = await newTask("Loose task");
    const looseBefore = rawTask(loose);
    expect(await move([loose], null, actor("selin"))).toEqual({
      changed: [],
      unchanged: [loose],
      message: `${loose} is in no epic already.`,
    });
    expect(rawTask(loose)).toBe(looseBefore);
  });

  it("refuses an archived task, a missing task, an unknown epic by name and an empty list, before anything is written", async () => {
    // CANARY: move `requireMovableTask` from planTasksEpic into setTasksEpic's
    // write loop (the batch's first task moves before the bad key is met).
    const live = await newTask("Live candidate");
    const archived = await newTask("Archived candidate");
    await taskActions.setTaskArchived(
      app.db,
      { projectSlug: SLUG, taskKey: archived, archived: true },
      actor("arda"),
      ctx(),
    );
    const id = await newEpic("selin", { title: "Picky home" });
    const epicBefore = rawEpic(id);
    await expect(move([live, archived], id, actor("selin"))).rejects.toMatchObject({
      status: 400,
      userMessage: `${archived} is archived; restore it before changing its epic.`,
    });
    await expect(move([live, "VIB-99999"], id, actor("selin"))).rejects.toMatchObject({
      status: 404,
      userMessage: "Task VIB-99999 not found.",
    });
    for (const missing of ["epic-99999", "goal-1"]) {
      await expect(move([live], missing, actor("selin"))).rejects.toMatchObject({
        status: 404,
        userMessage: NOT_AN_EPIC(missing),
      });
    }
    for (const none of [[], ["  "]]) {
      await expect(move(none, id, actor("selin"))).rejects.toMatchObject({
        status: 400,
        userMessage: "Name at least one task.",
      });
    }
    expect(epicOf(live)).toBeNull();
    expect(epicNotes(live)).toEqual([]);
    expect(audits("task.epic.changed", live)).toEqual([]);
    expect(rawEpic(id)).toBe(epicBefore);
  });

  it("with fromEpicId, takes tasks out of that epic only: a task that has moved on, or is in none, is refused and nothing is written", async () => {
    // CANARY: drop the `fromEpicId` check from planTasksEpic (a stale epic
    // page takes a task out of the epic it has since moved to).
    const stays = await newTask("Stays put");
    const movedOn = await newTask("Moved on");
    const loose = await newTask("Never joined");
    const page = await newEpic("selin", { title: "Stale page", taskKeys: [stays, movedOn] });
    const elsewhere = await newEpic("selin", { title: "Elsewhere" });
    await move([movedOn], elsewhere, actor("selin"));
    const removeFromPage = (taskKeys: string[]) =>
      epicActions.setTasksEpic(
        app.db,
        { projectSlug: SLUG, taskKeys, epicId: null, fromEpicId: page },
        actor("selin"),
        ctx(),
      );
    await expect(removeFromPage([stays, movedOn])).rejects.toMatchObject({
      status: 400,
      userMessage: `${movedOn} is not in ${page}; nothing was changed.`,
    });
    await expect(removeFromPage([loose])).rejects.toMatchObject({
      status: 400,
      userMessage: `${loose} is not in ${page}; nothing was changed.`,
    });
    expect([epicOf(stays), epicOf(movedOn), epicOf(loose)]).toEqual([page, elsewhere, null]);
    expect((await removeFromPage([stays])).changed).toEqual([{ taskKey: stays, from: page, to: null }]);
    expect(epicOf(stays)).toBeNull();
  });

  it("writes one history line and at most one notice per epic touched, however many tasks moved", async () => {
    // CANARY: write the epic's history line inside setTasksEpic's per-task
    // loop instead of once per touched epic.
    const a = await newTask("Batch a");
    const b = await newTask("Batch b");
    const c = await newTask("Batch c");
    const from = await newEpic("arda", { title: "Old batch home", leadUserId: ids.murat, taskKeys: [c] });
    const to = await newEpic("arda", { title: "New batch home", leadUserId: ids.elif });
    const fromLines = history(from).length;
    const toLines = history(to).length;
    const fromNotices = notices("murat", from).length;
    const toNotices = notices("elif", to).length;

    const result = await move([a, b, c], to, actor("selin"));
    expect(result.message).toBe(`${a}, ${b} and ${c} are now in ${to} (New batch home).`);
    expect(history(to)).toHaveLength(toLines + 1);
    expect(history(to)[0]).toBe(`Selin Aksoy added ${a} and ${b} and moved ${c} here from ${from}.`);
    expect(history(from)).toHaveLength(fromLines + 1);
    expect(history(from)[0]).toBe(`Selin Aksoy moved ${c} to ${to}.`);
    expect(notices("elif", to)).toHaveLength(toNotices + 1);
    expect(notices("elif", to)[0]).toMatchObject({
      text: `Selin Aksoy added ${a} and ${b} and moved ${c} here from ${from} in **${to}** (New batch home).`,
      // Three tasks: the notice opens the epic, not one of them.
      taskKey: null,
    });
    expect(notices("murat", from)).toHaveLength(fromNotices + 1);
    expect(notices("murat", from)[0]).toMatchObject({
      text: `Selin Aksoy moved ${c} to ${to} in **${from}** (Old batch home).`,
      taskKey: c,
    });
    // Each task still carries its own note and audit row.
    for (const key of [a, b, c]) {
      expect(epicOf(key)).toBe(to);
      expect(audits("task.epic.changed", key).filter((row) => row.details?.to === to)).toHaveLength(1);
    }
  });

  it("tells the epic's lead, or its creator while nobody leads it, and never the person who moved the task", async () => {
    // CANARY: address an epic notice to `fm.createdBy` whatever the lead
    // (`fm.leadUserId ?? fm.createdBy` in notifyEpicLead).
    const t1 = await newTask("Heard by the creator");
    const t2 = await newTask("Moved by the creator");
    const t3 = await newTask("Heard by the lead");
    const id = await newEpic("arda", { title: "Who hears" });

    await move([t1], id, actor("selin"));
    expect(notices("arda", id).map((n) => n.text)).toEqual([`Selin Aksoy added ${t1} in **${id}** (Who hears).`]);
    await move([t2], id, actor("arda"));
    expect(notices("arda", id)).toHaveLength(1);

    await edit({ epicId: id, leadUserId: ids.murat }, actor("arda"));
    await move([t3], id, actor("selin"));
    expect(notices("murat", id).map((n) => n.text)).toEqual([
      `Selin Aksoy added ${t3} in **${id}** (Who hears).`,
      `Arda Kaya made you the lead of **${id}** (Who hears).`,
    ]);
    // Somebody leads it now, so its creator hears no more.
    expect(notices("arda", id)).toHaveLength(1);
    await move([t3], null, actor("murat"));
    expect(notices("murat", id)).toHaveLength(2);
  });

  it("the operator's own move reads as the operator's: the history line, the note's actor, the audit row and the notice", async () => {
    // CANARY: name the actor with `actorProseName` in whoOf even under
    // operator authority (the history names the operator's placeholder
    // account instead of "The operator").
    const task = await newTask("Operator's task");
    const id = await newEpic("selin", { title: "Operator home" });
    const result = await move([task], id, taskActions.OPERATOR_TASK_ACTOR, { operator: true });
    expect(result.changed).toEqual([{ taskKey: task, from: null, to: id }]);
    expect(history(id)[0]).toBe(`The operator added ${task}.`);
    expect(epicNotes(task)[0]).toMatchObject({
      text: `Added to **${id}** (Operator home).`,
      actor: { kind: "operator" },
    });
    expect(audits("task.epic.changed", task)[0]).toMatchObject({
      actorUserId: null,
      actorLabel: "operator",
      details: { from: null, to: id, title: "Operator home" },
    });
    // No person moved it, so the creator of an epic nobody leads hears of it.
    expect(notices("selin", id)).toEqual([
      expect.objectContaining({
        text: `The operator added ${task} in **${id}** (Operator home).`,
        from: { kind: "agent", name: "Operator" },
      }),
    ]);
  });
});

describe("ruling 503(c): who may", () => {
  it("a viewer may neither create nor edit an epic, nor put a task in one or take it out", async () => {
    // CANARY: gate planTasksEpic on `comment` (viewers included) instead of
    // `edit-task-meta`.
    const inside = await newTask("Viewer's target inside");
    const outside = await newTask("Viewer's target outside");
    const id = await newEpic("selin", { title: "Viewer-proof", taskKeys: [inside] });
    const viewer = actor("viewer");
    await expect(create({ title: "Viewer's epic" }, viewer)).rejects.toMatchObject({
      status: 403,
      userMessage: "Your project role (viewer) cannot create epics.",
    });
    await expect(edit({ epicId: id, title: "Viewer's rename" }, viewer)).rejects.toMatchObject({
      status: 403,
      userMessage: "Your project role (viewer) cannot edit epics.",
    });
    await expect(move([outside], id, viewer)).rejects.toMatchObject({
      status: 403,
      userMessage: "Your project role (viewer) cannot put tasks in an epic.",
    });
    await expect(move([inside], null, viewer)).rejects.toMatchObject({
      status: 403,
      userMessage: "Your project role (viewer) cannot take tasks out of an epic.",
    });
    expect(epicOf(inside)).toBe(id);
    expect(epicOf(outside)).toBeNull();
    expect(epicFile(id).frontmatter.title).toBe("Viewer-proof");
  });

  it("a contributor may create and edit an epic, and move tasks in and out of it", async () => {
    // CANARY: drop C from the `manage-epics` roles in app/shared/rbac.ts.
    const task = await newTask("Contributor's task");
    const selin = actor("selin");
    const { epic } = await create({ title: "Contributor's epic" }, selin);
    await edit({ epicId: epic.id, status: "in_progress", targetDate: "2026-12-31" }, selin);
    expect(epicFile(epic.id).frontmatter).toMatchObject({ status: "in_progress", targetDate: "2026-12-31" });
    await move([task], epic.id, selin);
    expect(epicOf(task)).toBe(epic.id);
    await move([task], null, selin);
    expect(epicOf(task)).toBeNull();
  });

  it("an archived project is read-only: no epic is made or edited there, and no task moves, not even by the operator", async () => {
    // CANARY: drop `requireProjectMutable` from requireEpicAction.
    const DEPLOY = "deploy-pipeline";
    const arda = actor("arda");
    const { epic } = await create({ title: "Frozen plans" }, arda, DEPLOY);
    await projectWriter.updateProjectFile({ projectSlug: DEPLOY, dataRoot: app.dataRoot }, (project) => {
      project.frontmatter.archived = true;
    });
    rebuilder.rebuildProject(app.db, DEPLOY, { dataRoot: app.dataRoot });
    const frozen = (what: string) => ({
      status: 409,
      userMessage: `This project is archived (read-only). Restore it before you ${what}.`,
    });
    await expect(create({ title: "Thawed plans" }, arda, DEPLOY)).rejects.toMatchObject(frozen("create epics"));
    await expect(edit({ epicId: epic.id, title: "Thawed plans" }, arda, DEPLOY)).rejects.toMatchObject(
      frozen("edit epics"),
    );
    await expect(move(["DEP-31"], epic.id, arda, { slug: DEPLOY })).rejects.toMatchObject(
      frozen("put tasks in an epic"),
    );
    await expect(
      move(["DEP-31"], epic.id, taskActions.OPERATOR_TASK_ACTOR, { slug: DEPLOY, operator: true }),
    ).rejects.toMatchObject(frozen("put tasks in an epic"));
    expect(epicWriter.listEpicIds(DEPLOY, app.dataRoot)).toEqual([epic.id]);
    expect(
      epicWriter.readEpicFile({ projectSlug: DEPLOY, epicId: epic.id, dataRoot: app.dataRoot })?.parsed.frontmatter
        .title,
    ).toBe("Frozen plans");
    expect(
      taskWriter.readTaskFile({ projectSlug: DEPLOY, taskKey: "DEP-31", dataRoot: app.dataRoot })?.parsed.frontmatter
        .epic,
    ).toBeNull();
  });
});

describe("ruling 503(b): a task born in an epic", () => {
  it("createTask with `epic` makes the task in it, with the Epic note a later join writes", async () => {
    // CANARY: leave `epic` out of the frontmatter createTask writes (the note
    // says it joined; the task is in none).
    const id = await newEpic("selin", { title: "Nursery" });
    const { key } = await taskActions.createTask(
      app.db,
      { projectSlug: SLUG, title: "Born in an epic", epic: ` ${id} ` },
      actor("selin"),
      ctx(),
    );
    expect(epicOf(key)).toBe(id);
    expect(epicNotes(key)).toEqual([
      expect.objectContaining({
        type: "note",
        text: `Added to **${id}** (Nursery).`,
        actor: expect.objectContaining({ kind: "human", userId: ids.selin }),
      }),
    ]);
    expect(epicQuery.epicTaskKeys(app.db, SLUG, id)).toEqual([key]);
    expect(epicQuery.getEpic(app.db, SLUG, id)?.progress).toMatchObject({ total: 1, notStarted: 1 });
    expect(audits("task.created", key)[0]?.details).toMatchObject({ epic: id });
  });

  it("the epic's history and its lead hear of a task made in it, as of one added later", async () => {
    // CANARY: drop the `noteTaskMadeInEpic` call from createTask.
    const id = await newEpic("selin", { title: "Nursery wing", leadUserId: ids.murat });
    const { key } = await taskActions.createTask(
      app.db,
      { projectSlug: SLUG, title: "Made in the wing", epic: id },
      actor("selin"),
      ctx(),
    );
    expect(history(id)[0]).toBe(`Selin Aksoy made ${key} in this epic.`);
    expect(notices("murat", id).map((n) => n.text)).toContain(`Selin Aksoy made ${key} in **${id}** (Nursery wing).`);
    // The person who made it is not told of their own act.
    expect(notices("selin", id)).toEqual([]);
    // Made by the lead: the history still says so, and nobody is told.
    const { key: own } = await taskActions.createTask(
      app.db,
      { projectSlug: SLUG, title: "The lead's own", epic: id },
      actor("murat"),
      ctx(),
    );
    expect(history(id)[0]).toBe(`Murat Yıldız made ${own} in this epic.`);
    expect(notices("murat", id).filter((n) => n.text.includes(own))).toEqual([]);
    // A task made in no epic touches none.
    const before = history(id);
    await newTask("In no epic");
    expect(history(id)).toEqual(before);
  });

  it("an epic the project does not have is refused before a task key is allocated", async () => {
    // CANARY: call `requireEpicForNewTask` after `allocateTaskKey` in
    // createTask (every refusal burns a key).
    const nextNumber = () =>
      projectWriter.readProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot })!.parsed.frontmatter
        .nextTaskNumber;
    const before = nextNumber();
    for (const epic of ["epic-99999", "goal-2"]) {
      await expect(
        taskActions.createTask(app.db, { projectSlug: SLUG, title: "Orphan", epic }, actor("selin"), ctx()),
      ).rejects.toMatchObject({ status: 404, userMessage: NOT_AN_EPIC(epic) });
    }
    expect(nextNumber()).toBe(before);
    const { key } = await taskActions.createTask(
      app.db,
      { projectSlug: SLUG, title: "Next in line" },
      actor("selin"),
      ctx(),
    );
    expect(key).toBe(`VIB-${before}`);
  });
});

describe("ruling 503(d): when every task of an open epic is done", () => {
  /** An open epic led by murat with two tasks: one already done by hand
   *  (no hook fired), one still open. */
  async function epicWithOneTaskLeft(title: string, status = "in_progress") {
    const done = await newTask(`${title}, done`);
    const open = await newTask(`${title}, open`);
    const id = await newEpic("selin", { title, status, leadUserId: ids.murat, taskKeys: [done, open] });
    await closeToDone(done);
    return { id, done, open };
  }

  /** The last open task reaches the terminal stage: an admin's acceptance. */
  async function accept(taskKey: string): Promise<void> {
    await taskActions.forceAcceptCompletion(app.db, { projectSlug: SLUG, taskKey }, actor("arda"), ctx());
  }

  function allDoneLines(epicId: string): string[] {
    return history(epicId).filter((text) => text.startsWith("Every task is done"));
  }

  function allDoneNotices(epicId: string) {
    return notices("murat", epicId).filter((n) => n.text.startsWith("Every task in"));
  }

  it("when the last open task reaches the terminal stage, the history says so once and the lead is told; the status stays theirs", async () => {
    // CANARY: drop the `maybeNoteEpicComplete` call from applyAcceptanceWrite.
    const { id, open } = await epicWithOneTaskLeft("Finish line");
    expect(allDoneLines(id)).toEqual([]);
    await accept(open);
    expect(taskFile(open).frontmatter.stage).toBe("done");
    await waitFor(() => allDoneNotices(id).length > 0, "the lead's all-done notice");
    expect(history(id)[0]).toBe("Every task is done (2 tasks).");
    expect(allDoneLines(id)).toEqual(["Every task is done (2 tasks)."]);
    expect(allDoneNotices(id)).toEqual([
      expect.objectContaining({
        text: `Every task in **${id}** (Finish line) is done. Set the epic to Done once the work has landed.`,
        from: { kind: "system", name: "Viberr" },
      }),
    ]);
    expect(epicFile(id).frontmatter.status).toBe("in_progress");
  });

  it("does not say it again when the hook fires a second time on an epic already all done", async () => {
    // CANARY: drop the `file.timeline[0]?.text === line` check from
    // noteEpicCompleteIfDone.
    const { id, open } = await epicWithOneTaskLeft("Said once");
    await accept(open);
    await waitFor(() => allDoneNotices(id).length === 1, "the lead's all-done notice");
    epicActions.maybeNoteEpicComplete(app.db, ctx(), SLUG, open);
    await settled(id);
    expect(allDoneLines(id)).toEqual(["Every task is done (2 tasks)."]);
    expect(allDoneNotices(id)).toHaveLength(1);
  });

  it("does not say it again when a task that was already done is archived afterwards", async () => {
    // CANARY: red today (the reported bug): setTaskArchived fires the
    // all-done hook for a task that was already done, and the new count
    // defeats noteEpicCompleteIfDone's same-line check.
    const { id, done, open } = await epicWithOneTaskLeft("Tidied up");
    await accept(open);
    await waitFor(() => allDoneNotices(id).length === 1, "the lead's all-done notice");
    await taskActions.setTaskArchived(
      app.db,
      { projectSlug: SLUG, taskKey: done, archived: true },
      actor("arda"),
      ctx(),
    );
    await settled(id);
    expect(allDoneLines(id)).toEqual(["Every task is done (2 tasks)."]);
    expect(allDoneNotices(id)).toHaveLength(1);
  });

  it("does not say it again when a task that was already done is taken out afterwards", async () => {
    // CANARY: red today (the reported bug): setTasksEpic runs
    // noteEpicCompleteIfDone for every epic a task left, done or not, and its
    // own "removed" line defeats the same-line check.
    const { id, done, open } = await epicWithOneTaskLeft("Pruned");
    await accept(open);
    await waitFor(() => allDoneNotices(id).length === 1, "the lead's all-done notice");
    await move([done], null, actor("selin"));
    expect(allDoneLines(id)).toEqual(["Every task is done (2 tasks)."]);
    expect(history(id)[0]).toBe(`Selin Aksoy removed ${done}.`);
    expect(allDoneNotices(id)).toHaveLength(1);
  });

  it("says nothing for an epic that is done or cancelled", async () => {
    // CANARY: drop the `isEpicOpen` checks from noteEpicCompleteIfDone.
    for (const status of ["done", "cancelled"]) {
      const { id, open } = await epicWithOneTaskLeft(`Closed as ${status}`, status);
      await accept(open);
      await settled(id);
      expect(allDoneLines(id), status).toEqual([]);
      expect(allDoneNotices(id), status).toEqual([]);
    }
  });

  it("says it when the only open task is taken out of the epic", async () => {
    // CANARY: drop the `noteEpicCompleteIfDone` loop over `change.from` at the
    // end of setTasksEpic.
    const { id, open } = await epicWithOneTaskLeft("Trimmed scope");
    await move([open], null, actor("selin"));
    expect(history(id).slice(0, 2)).toEqual(["Every task is done (1 task).", `Selin Aksoy removed ${open}.`]);
    expect(allDoneNotices(id)).toHaveLength(1);
  });

  it("says it when the only open task is archived", async () => {
    // CANARY: drop the `maybeNoteEpicComplete` call from setTaskArchived.
    const { id, open } = await epicWithOneTaskLeft("Abandoned tail");
    await taskActions.setTaskArchived(
      app.db,
      { projectSlug: SLUG, taskKey: open, archived: true },
      actor("arda"),
      ctx(),
    );
    await waitFor(() => allDoneNotices(id).length === 1, "the lead's all-done notice");
    expect(allDoneLines(id)).toEqual(["Every task is done (1 task)."]);
  });
});
