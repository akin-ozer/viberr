import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupAppTest, type AppTestContext } from "../../../test-support/test-app";
import type { SeedUserIds } from "../../../test-support/demo-data";
import { EPIC_FILTER_NONE, matchesEpicFilter } from "~/features/board/board-filters";
import { cardStatus } from "~/features/board/card-status";
import type { CreateEpicInput } from "~/server/tasks/epic-actions.server";

/**
 * Ruling 503(e) through the real route modules: the Epics list and one
 * epic's page (loaders and every intent they answer), the task page's Epic
 * menu (`set-task-epic`) and the board's epic filter. The markdown files are
 * the truth, so a write is checked on the file as well as on the page that
 * reads its projection.
 *
 * One seed for the file. Each case makes its own epics and keeps to its own
 * tasks (a task is in at most one epic, so a shared one would move), so the
 * cases hold in any order.
 */

let app: AppTestContext;
let ids: SeedUserIds;
const SLUG = "viberr-core";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  ids = (await runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;
  // The demo seed has no viewer on viberr-core: Deniz, an org member on no
  // project, becomes one, in the file the route guards read and in its
  // projection the loaders read.
  const { updateProjectFile } = await import("~/server/files/project-writer.server");
  const { reprojectProject } = await import("~/server/projections/rebuilder.server");
  await updateProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot }, (parsed) => {
    parsed.frontmatter.members.push({ userId: ids.deniz, role: "viewer" });
  });
  reprojectProject(app.db, { dataRoot: app.dataRoot }, SLUG);
});
afterAll(() => app.cleanup());

/** The whole envelope a server loader or action is handed, so the direct
 *  calls below are checked against the real route signatures. */
function routeArgs<Params extends Record<string, string>>(
  path: string,
  pattern: string,
  params: Params,
  init: RequestInit & { cookie?: string },
) {
  const request = app.request(path, init);
  return { request, url: new URL(request.url), params, pattern, context: new RouterContextProvider() };
}

const EPICS_PATTERN = "/projects/:slug/epics";
const EPIC_PATTERN = "/projects/:slug/epics/:epicId";

async function epicsPage(userId: string) {
  const { loader } = await import("~/routes/project.epics");
  const { cookie } = await app.sessionFor(userId);
  return loader(routeArgs(`/projects/${SLUG}/epics`, EPICS_PATTERN, { slug: SLUG }, { cookie }));
}

async function epicPage(userId: string, epicId: string) {
  const { loader } = await import("~/routes/project.epic");
  const { cookie } = await app.sessionFor(userId);
  return loader(
    routeArgs(`/projects/${SLUG}/epics/${epicId}`, EPIC_PATTERN, { slug: SLUG, epicId }, { cookie }),
  );
}

async function board(userId: string, search = "") {
  const { loader } = await import("~/routes/project.board");
  const { cookie } = await app.sessionFor(userId);
  const loaded = await loader(
    routeArgs(`/projects/${SLUG}/board${search}`, "/projects/:slug/board", { slug: SLUG }, { cookie }),
  );
  return { cards: [...loaded.columns.flatMap((c) => c.tasks), ...loaded.orphanTasks], epics: loaded.epics };
}

function postBody(csrf: string, fields: Record<string, string>) {
  return new URLSearchParams({ _csrf: csrf, ...fields });
}

async function postEpics(userId: string, fields: Record<string, string>) {
  const { action } = await import("~/routes/project.epics");
  const { cookie, csrf } = await app.sessionFor(userId);
  return action(
    routeArgs(`/projects/${SLUG}/epics`, EPICS_PATTERN, { slug: SLUG }, {
      method: "POST",
      cookie,
      body: postBody(csrf, fields),
    }),
  );
}

async function postEpic(userId: string, epicId: string, fields: Record<string, string>) {
  const { action } = await import("~/routes/project.epic");
  const { cookie, csrf } = await app.sessionFor(userId);
  return action(
    routeArgs(`/projects/${SLUG}/epics/${epicId}`, EPIC_PATTERN, { slug: SLUG, epicId }, {
      method: "POST",
      cookie,
      body: postBody(csrf, fields),
    }),
  );
}

async function postTask(userId: string, key: string, fields: Record<string, string>) {
  const { action } = await import("~/routes/project.task");
  const { cookie, csrf } = await app.sessionFor(userId);
  return action(
    routeArgs(`/projects/${SLUG}/tasks/${key}`, "/projects/:slug/tasks/:key", { slug: SLUG, key }, {
      method: "POST",
      cookie,
      body: postBody(csrf, fields),
    }),
  );
}

/** An intent's success: the toast, and a create's new epic id. */
const acceptedSchema = z.object({
  ok: z.literal(true),
  toast: z.string(),
  epicId: z.string().optional(),
});

/** An intent's refusal, as `appErrorResponse` answers it. */
const refusedSchema = z.object({
  data: z.object({ ok: z.literal(false), error: z.string() }),
  init: z.object({ status: z.number() }),
});

function actorOf(userId: string) {
  const handle = Object.entries(ids).find(([, id]) => id === userId)?.[0] ?? "someone";
  return { userId, label: `${handle}@viberr.dev` };
}

/** An epic made the way every door makes one (`createEpic`). */
async function makeEpic(userId: string, input: Omit<CreateEpicInput, "projectSlug">) {
  const { createEpic } = await import("~/server/tasks/epic-actions.server");
  const made = await createEpic(app.db, { projectSlug: SLUG, ...input }, actorOf(userId));
  return made.epic.id;
}

/** A fresh task at the entry stage, in no epic. */
async function makeTask(title: string) {
  const { createTask } = await import("~/server/tasks/task-actions.server");
  return (await createTask(app.db, { projectSlug: SLUG, title }, actorOf(ids.arda))).key;
}

/** The epic a task's own file names: the truth every page projects. */
async function fileEpicOf(taskKey: string) {
  const { readTaskFile } = await import("~/server/files/task-writer.server");
  return readTaskFile({ projectSlug: SLUG, taskKey, dataRoot: app.dataRoot })?.parsed.frontmatter.epic;
}

async function epicFile(epicId: string) {
  const { readEpicFile } = await import("~/server/files/epic-writer.server");
  return readEpicFile({ projectSlug: SLUG, epicId, dataRoot: app.dataRoot })?.parsed;
}

describe("ruling 503(e): the Epics pages' loaders", () => {
  it("the epics loader lists this project's epics, each with its progress, the stages and the members", async () => {
    const listed = await makeEpic(ids.arda, {
      title: "Loader lists me",
      status: "in_progress",
      leadUserId: ids.murat,
      targetDate: "2026-12-01",
      taskKeys: ["VIB-166", "VIB-139"],
    });
    // Another project's epic is not this project's.
    const { createEpic } = await import("~/server/tasks/epic-actions.server");
    await createEpic(app.db, { projectSlug: "deploy-pipeline", title: "Elsewhere" }, actorOf(ids.arda));

    const page = await epicsPage(ids.selin);
    expect(page.epics.map((e) => e.title)).not.toContain("Elsewhere");
    const epic = page.epics.find((e) => e.id === listed);
    expect(epic).toMatchObject({
      title: "Loader lists me",
      status: "in_progress",
      leadUserId: ids.murat,
      leadName: "Murat Yıldız",
      targetDate: "2026-12-01",
    });
    // CANARY: stop counting the terminal stage as done in `progressByEpic`
    // (epic-query.server.ts) and VIB-139, at Done, is counted as started.
    expect(epic?.progress).toEqual({
      total: 2,
      done: 1,
      started: 0,
      notStarted: 1,
      held: 0,
      archived: 0,
      byStage: [
        { stageId: "triage", count: 1 },
        { stageId: "done", count: 1 },
      ],
    });
    expect(page.stages.map((s) => s.id)).toEqual(["triage", "ready", "impl", "review", "done"]);
    expect(page.members.map((m) => m.name)).toEqual(["Arda Kaya", "Deniz Şahin", "Elif Demir", "Murat Yıldız", "Selin Aksoy"]);
  });

  it("the epic loader returns the epic's view: its history, its tasks, the tasks that could join and the other epics", async () => {
    const other = await makeEpic(ids.arda, { title: "Some other epic" });
    const lower = await makeTask("Shown first");
    const higher = await makeTask("Shown second");
    const shown = await makeEpic(ids.arda, { title: "Shown in full", taskKeys: [higher, lower] });
    const view = await epicPage(ids.selin, shown);
    expect(view.epic).toMatchObject({ id: shown, title: "Shown in full", status: "planned", createdBy: ids.arda });
    // Newest first, from the file.
    expect(view.epic.history.map((h) => h.text)).toEqual([
      `Arda Kaya added ${higher} and ${lower}.`,
      "Created by Arda Kaya.",
    ]);
    // CANARY: drop the `t.epicId === epicId` filter in `getEpicPage` and every
    // task of the project is listed as the epic's.
    expect(view.tasks.map((t) => t.key)).toEqual([lower, higher]);
    expect(view.tasks.find((t) => t.key === lower)).toMatchObject({ title: "Shown first", stageId: "triage", archived: false });
    expect(view.candidates.map((c) => c.key)).not.toContain(lower);
    expect(view.candidates.map((c) => c.key)).toContain("VIB-148");
    expect(view.otherEpics).toContainEqual({ id: other, title: "Some other epic" });
    expect(view.otherEpics.map((e) => e.id)).not.toContain(shown);
    // The page and the file agree on the epic's history.
    expect((await epicFile(shown))?.timeline.map((h) => h.text)).toEqual(view.epic.history.map((h) => h.text));
  });

  it("the epic loader answers 404 for an id the project has no epic by", async () => {
    // CANARY: drop the `if (!epic) throw data(…, { status: 404 })` in
    // `getEpicPage` and the loader fails on the missing epic instead.
    await expect(epicPage(ids.selin, "epic-999")).rejects.toMatchObject({
      data: "No epic epic-999 in projects/viberr-core.",
      init: { status: 404 },
    });
  });

  it("an archived task still names its epic: listed apart, counted apart, offered to no epic", async () => {
    const kept = await makeTask("Archived in an epic");
    const live = await makeTask("Live in an epic");
    const epicId = await makeEpic(ids.arda, { title: "Holds an archived task", taskKeys: [kept, live] });
    const { setTaskArchived } = await import("~/server/tasks/task-actions.server");
    await setTaskArchived(app.db, { projectSlug: SLUG, taskKey: kept, archived: true }, actorOf(ids.arda));

    const view = await epicPage(ids.arda, epicId);
    // CANARY: drop the `archived` flag from the rows `getEpicPage` builds and
    // the page cannot fold the archived task under its list.
    expect(view.tasks.find((t) => t.key === kept)).toMatchObject({ archived: true, status: { kind: "archived" } });
    expect(view.tasks.find((t) => t.key === live)).toMatchObject({ archived: false });
    expect(view.epic.progress).toMatchObject({ total: 1, archived: 1 });
    expect(view.candidates.map((c) => c.key)).not.toContain(kept);
  });

  it("476(g): each task row carries the word the board card for that task shows, for the viewer reading it", async () => {
    const epicId = await makeEpic(ids.arda, {
      title: "Rows say what the board says",
      taskKeys: ["VIB-142", "VIB-151", "VIB-141", "VIB-160", "VIB-145"],
    });
    for (const viewer of [ids.arda, ids.selin]) {
      const view = await epicPage(viewer, epicId);
      const { cards } = await board(viewer);
      expect(view.tasks.map((t) => t.key)).toEqual(["VIB-141", "VIB-142", "VIB-145", "VIB-151", "VIB-160"]);
      for (const row of view.tasks) {
        const card = cards.find((c) => c.key === row.key);
        expect(card).toBeDefined();
        if (card) expect(row.status, row.key).toEqual(cardStatus(card));
      }
    }
    // The word is the viewer's own: VIB-142's decision is Arda's to make, not
    // Selin's.
    // CANARY: build the card in `boardStatuses` (epics-query.server.ts)
    // without `waitingOnMe` and Arda's VIB-142 row reads "waiting on a human"
    // while her board card reads "waiting on you".
    const arda = await epicPage(ids.arda, epicId);
    expect(arda.tasks.find((t) => t.key === "VIB-142")?.status?.label).toBe("waiting on you");
    const selin = await epicPage(ids.selin, epicId);
    expect(selin.tasks.find((t) => t.key === "VIB-142")?.status?.label).toBe("waiting on a human");
    expect(selin.tasks.find((t) => t.key === "VIB-151")?.status?.label).toBe("agent working");
  });

  it("476(h): Planned in names the conversation to its owner and an org admin, never to another member", async () => {
    const { createConversation } = await import("~/server/controller/controller-conversations.server");
    const planning = createConversation(app.db, { userId: ids.murat, userLabel: "murat@viberr.dev", projectSlug: SLUG });
    const epicId = await makeEpic(ids.murat, { title: "Planned with the controller", conversationId: planning.id });
    const expected = {
      id: planning.id,
      title: "New conversation",
      href: `/projects/${SLUG}/controller?c=${planning.id}`,
      scopeLabel: "This board",
    };
    expect((await epicPage(ids.murat, epicId)).plannedIn).toEqual(expected);
    // An org admin may open anyone's conversation (ruling 100).
    expect((await epicPage(ids.arda, epicId)).plannedIn).toEqual(expected);
    // CANARY: drop the `canAccessConversation` check in `plannedConversation`
    // (epics-query.server.ts) and Selin is handed Murat's conversation.
    expect((await epicPage(ids.selin, epicId)).plannedIn).toBeNull();
    expect((await epicPage(ids.deniz, epicId)).plannedIn).toBeNull();
  });
});

describe("ruling 503(e): the epic intents", () => {
  it("create-epic (Epics page) makes the epic the dialog describes", async () => {
    const made = acceptedSchema.parse(
      await postEpics(ids.selin, {
        intent: "create-epic",
        title: "Checkout revamp",
        description: "Ship the new checkout.",
        status: "in_progress",
        color: "rose",
        leadUserId: ids.murat,
        startDate: "2026-10-01",
        targetDate: "2026-11-15",
      }),
    );
    const epicId = made.epicId ?? "";
    expect(epicId).toMatch(/^epic-\d+$/);
    expect(made.toast).toBe(`Created ${epicId} (Checkout revamp).`);
    // CANARY: stop reading `leadUserId` in `epicFormFields` (epic-form.server.ts)
    // and the epic is created with nobody leading it.
    expect((await epicFile(epicId))?.frontmatter).toMatchObject({
      title: "Checkout revamp",
      status: "in_progress",
      color: "rose",
      leadUserId: ids.murat,
      startDate: "2026-10-01",
      targetDate: "2026-11-15",
      createdBy: ids.selin,
    });
    const listed = (await epicsPage(ids.selin)).epics.find((e) => e.id === epicId);
    expect(listed).toMatchObject({ description: "Ship the new checkout.", leadName: "Murat Yıldız", color: "rose" });
  });

  it("create-epic is refused for a viewer, and no epic is made", async () => {
    const before = (await epicsPage(ids.arda)).epics.length;
    const refused = refusedSchema.parse(await postEpics(ids.deniz, { intent: "create-epic", title: "A viewer's epic" }));
    // CANARY: drop the `manage-epics` check (`requireEpicAction`) from
    // `createEpic` and the viewer's epic is made.
    expect(refused.init.status).toBe(403);
    expect(refused.data.error).toBe("Your project role (viewer) cannot create epics.");
    expect((await epicsPage(ids.arda)).epics.length).toBe(before);
  });

  it("update-epic writes only the fields the form carries: the head's select posts the status alone", async () => {
    const epicId = await makeEpic(ids.selin, {
      title: "Edit me",
      leadUserId: ids.murat,
      startDate: "2026-11-01",
      targetDate: "2026-12-01",
    });
    const status = acceptedSchema.parse(await postEpic(ids.murat, epicId, { intent: "update-epic", status: "paused" }));
    expect(status.toast).toBe(`Updated ${epicId}: set the status to Paused.`);
    const view = await epicPage(ids.murat, epicId);
    // CANARY: make `epicFormFields` read an absent field as a blank one and the
    // status alone clears the lead and both dates.
    expect(view.epic).toMatchObject({
      status: "paused",
      title: "Edit me",
      leadUserId: ids.murat,
      startDate: "2026-11-01",
      targetDate: "2026-12-01",
    });
    expect(view.epic.history[0]?.text).toBe("Murat Yıldız set the status to Paused.");

    // The Edit dialog posts every field; a blank lead or date clears it.
    const edit = acceptedSchema.parse(
      await postEpic(ids.murat, epicId, {
        intent: "update-epic",
        title: "Edited",
        description: "Now described.",
        status: "paused",
        leadUserId: "",
        startDate: "2026-11-01",
        targetDate: "",
      }),
    );
    expect(edit.toast).toBe(
      `Updated ${epicId}: renamed it from "Edit me" to "Edited", rewrote the description, cleared the lead and cleared the target date.`,
    );
    expect((await epicFile(epicId))?.frontmatter).toMatchObject({
      title: "Edited",
      leadUserId: null,
      startDate: "2026-11-01",
      targetDate: null,
    });
  });

  it("add-tasks puts several tasks in, moving one from its other epic", async () => {
    const source = await makeEpic(ids.arda, { title: "Source epic", taskKeys: ["VIB-153"] });
    const target = await makeEpic(ids.arda, { title: "Target epic" });
    // CANARY: stop splitting `taskKeys` in the `add-tasks` intent
    // (project.epic.tsx) and "VIB-148,VIB-153" is refused as one unknown task.
    const added = acceptedSchema.parse(
      await postEpic(ids.selin, target, { intent: "add-tasks", taskKeys: "VIB-148,VIB-153" }),
    );
    expect(added.toast).toBe(`VIB-148 and VIB-153 are now in ${target} (Target epic).`);
    const view = await epicPage(ids.selin, target);
    expect(view.tasks.map((t) => t.key)).toEqual(["VIB-148", "VIB-153"]);
    expect(view.epic.history[0]?.text).toBe(`Selin Aksoy added VIB-148 and moved VIB-153 here from ${source}.`);
    expect((await epicPage(ids.selin, source)).tasks).toEqual([]);
    expect((await epicFile(source))?.timeline[0]?.text).toBe(`Selin Aksoy moved VIB-153 to ${target}.`);
    expect(await fileEpicOf("VIB-153")).toBe(target);
  });

  it("remove-task takes a task out of the epic, and it is offered again", async () => {
    const epicId = await makeEpic(ids.arda, { title: "Remove from me", taskKeys: ["VIB-168"] });
    const removed = acceptedSchema.parse(await postEpic(ids.selin, epicId, { intent: "remove-task", taskKey: "VIB-168" }));
    // CANARY: pass `params.epicId` instead of null to `setTasksEpic` in the
    // `remove-task` intent (project.epic.tsx) and VIB-168 stays in the epic.
    expect(removed.toast).toBe("VIB-168 is no longer in an epic.");
    expect(await fileEpicOf("VIB-168")).toBeNull();
    const view = await epicPage(ids.selin, epicId);
    expect(view.tasks).toEqual([]);
    expect(view.candidates.find((c) => c.key === "VIB-168")).toMatchObject({ epicId: null });
    expect(view.epic.history[0]?.text).toBe("Selin Aksoy removed VIB-168.");
  });

  it("remove-task takes a task out of THIS epic only: one moved to another epic meanwhile stays there", async () => {
    // Selin's page for `stale` lists the task; Murat then moves it to `moved`.
    const key = await makeTask("Moved while the page was open");
    const stale = await makeEpic(ids.arda, { title: "Page left open", taskKeys: [key] });
    const moved = await makeEpic(ids.murat, { title: "Moved on", taskKeys: [key] });
    expect(await fileEpicOf(key)).toBe(moved);
    const result = await postEpic(ids.selin, stale, { intent: "remove-task", taskKey: key });
    // CANARY: let `remove-task` call `setTasksEpic` with `epicId: null` and no
    // check that the task is in `params.epicId` (as project.epic.tsx does
    // today) and "Take it out of epic-A" takes it out of epic-B instead. The
    // controller's `update_epic.removeTasks` refuses the same case by name.
    expect(await fileEpicOf(key)).toBe(moved);
    expect(acceptedSchema.safeParse(result).success).toBe(false);
    expect((await epicFile(moved))?.timeline.map((h) => h.text)).not.toContain(`Selin Aksoy removed ${key}.`);
  });

  it("create-task makes a task that is in the epic from its first line", async () => {
    const epicId = await makeEpic(ids.arda, { title: "Born here" });
    const created = acceptedSchema.parse(
      await postEpic(ids.selin, epicId, { intent: "create-task", title: "Born in the epic", goal: "Done when it exists." }),
    );
    const key = /^(VIB-\d+) created in Triage, in /.exec(created.toast)?.[1] ?? "";
    expect(created.toast).toBe(`${key} created in Triage, in ${epicId}.`);
    // CANARY: drop `epic: params.epicId` from the `create-task` intent
    // (project.epic.tsx) and the task is born in no epic.
    expect(await fileEpicOf(key)).toBe(epicId);
    const view = await epicPage(ids.selin, epicId);
    expect(view.tasks).toEqual([expect.objectContaining({ key, title: "Born in the epic", stageId: "triage" })]);
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const timeline = readTaskFile({ projectSlug: SLUG, taskKey: key, dataRoot: app.dataRoot })?.parsed.timeline ?? [];
    expect(timeline.find((e) => e.type === "note" && e.title === "Epic")).toMatchObject({
      text: `Added to **${epicId}** (Born here).`,
    });
  });

  it("create-task is refused for a viewer, and no task is made", async () => {
    const epicId = await makeEpic(ids.arda, { title: "Viewer cannot create here" });
    const refused = refusedSchema.parse(
      await postEpic(ids.deniz, epicId, { intent: "create-task", title: "A viewer's task", goal: "" }),
    );
    // CANARY: drop the `create-task` check (`requireAction`) from `createTask`
    // and the viewer's task is born in the epic.
    expect(refused.init.status).toBe(403);
    expect(refused.data.error).toBe("Your project role (viewer) cannot create tasks.");
    expect((await epicPage(ids.arda, epicId)).tasks).toEqual([]);
    expect((await board(ids.arda)).cards.map((c) => c.title)).not.toContain("A viewer's task");
  });

  it("the task page's set-task-epic puts a task in an epic, and an empty pick takes it out", async () => {
    const epicId = await makeEpic(ids.arda, { title: "Task page menu" });
    const key = await makeTask("Picked from the menu");
    const joined = acceptedSchema.parse(await postTask(ids.murat, key, { intent: "set-task-epic", epic: epicId }));
    expect(joined.toast).toBe(`${key} is now in ${epicId} (Task page menu).`);
    expect(await fileEpicOf(key)).toBe(epicId);
    expect((await board(ids.murat)).cards.find((c) => c.key === key)?.epicId).toBe(epicId);
    expect((await epicPage(ids.murat, epicId)).tasks.map((t) => t.key)).toEqual([key]);

    // "No epic" posts an empty `epic`.
    // CANARY: drop the `|| null` in the `set-task-epic` intent (project.task.tsx)
    // and "No epic" is refused as an unknown epic instead of taking the task out.
    const left = acceptedSchema.parse(await postTask(ids.murat, key, { intent: "set-task-epic", epic: "" }));
    expect(left.toast).toBe(`${key} is no longer in an epic.`);
    expect(await fileEpicOf(key)).toBeNull();
    expect((await board(ids.murat)).cards.find((c) => c.key === key)?.epicId).toBeNull();
    expect((await epicPage(ids.murat, epicId)).tasks).toEqual([]);
  });
});

describe("ruling 503(e): the board's epic filter", () => {
  it("the loader ships each card's epic and the epic options; ?epic=<id> and ?epic=none select through them", async () => {
    const first = await makeTask("Filtered in, one");
    const second = await makeTask("Filtered in, two");
    const loose = await makeTask("In no epic");
    const epicId = await makeEpic(ids.arda, { title: "Filter me", taskKeys: [first, second] });

    // The filter is the board page's (`matchesEpicFilter` over the cards), so
    // the loader's part is the facts it reads: each card's epic, and the
    // project's epics for the menu.
    const byEpic = await board(ids.arda, `?epic=${epicId}`);
    for (const card of byEpic.cards) {
      expect(card.epicId, card.key).toBe((await fileEpicOf(card.key)) ?? null);
    }
    const listed = (await epicsPage(ids.arda)).epics;
    expect(byEpic.epics).toEqual(listed.map((e) => ({ id: e.id, title: e.title, color: e.color, status: e.status })));
    // CANARY: drop `epicId` from `toBoardCard` (board-card.ts) and ?epic=<id>
    // selects no card while ?epic=none selects every one.
    const selected = byEpic.cards.filter((c) => matchesEpicFilter(c, epicId)).map((c) => c.key);
    expect(selected.sort()).toEqual([first, second].sort());

    const byNone = await board(ids.arda, `?epic=${EPIC_FILTER_NONE}`);
    const none = byNone.cards.filter((c) => matchesEpicFilter(c, EPIC_FILTER_NONE)).map((c) => c.key);
    expect(none).toContain(loose);
    expect(none).not.toContain(first);
    expect(none).not.toContain(second);
    expect(none.length).toBeGreaterThan(0);
    expect(none.length).toBeLessThan(byNone.cards.length);
  });
});
