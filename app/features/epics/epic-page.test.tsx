// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRoutesStub, useLoaderData, type ActionFunction } from "react-router";
import { ToastProvider } from "~/ui/toast";
import type { EpicDetail, EpicProgress } from "~/server/projections/epic-query.server";
import { EpicPage } from "./epic-page";
import type { EpicActionResult } from "./epic-parts";
import type { EpicPageView, EpicTaskView } from "./epics-query.server";

/**
 * Ruling 503(e): `/projects/:slug/epics/:epicId`, one epic the way Jira opens
 * an epic and Linear a project. The head carries the status select and Edit
 * (`manage-epics`); About is its markdown description; Tasks is its progress
 * and one row per task with the board card's status word (ruling 476(g)),
 * "waits on N", its owner and Remove (`edit-task-meta`), with Add tasks, New
 * task and the archived ones folded under the list; History; and Details,
 * with "Planned in" when the viewer may open that conversation (476(h)).
 * Ruling 651: Archive on a live row and Restore on an archived one, and
 * Archive tasks for a Done epic, to whoever may archive (`approve-transition`).
 */

afterEach(cleanup);

const STAGES = [
  { id: "triage", name: "Triage", color: "slate" },
  { id: "impl", name: "In Progress", color: "violet" },
  { id: "done", name: "Done", color: "green" },
];

function progress(patch: Partial<EpicProgress> = {}): EpicProgress {
  return { total: 0, done: 0, started: 0, notStarted: 0, held: 0, archived: 0, archivedDone: 0, byStage: [], ...patch };
}

function detail(patch: Partial<EpicDetail> = {}): EpicDetail {
  return {
    id: "epic-3",
    number: 3,
    title: "Checkout revamp",
    status: "in_progress",
    color: "teal",
    leadUserId: "u_murat",
    leadName: "Murat Yıldız",
    startDate: "2026-10-01",
    targetDate: "2026-10-15",
    description: "Ship the **new** checkout.",
    createdBy: "u_arda",
    createdByLabel: "arda@viberr.dev",
    conversationId: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    progress: progress({ total: 2, done: 1, started: 1, byStage: [{ stageId: "impl", count: 1 }, { stageId: "done", count: 1 }] }),
    history: [
      { occurredAt: "2026-09-02T10:00:00.000Z", text: "Arda Kaya added VIB-151." },
      { occurredAt: "2026-09-01T10:00:00.000Z", text: "Created by Arda Kaya." },
    ],
    ...patch,
  };
}

function task(patch: Partial<EpicTaskView> = {}): EpicTaskView {
  return {
    key: "VIB-151",
    title: "Wire the checkout",
    stageId: "impl",
    archived: false,
    status: { kind: "agent", label: "agent working", icon: null },
    owner: { name: "Selin Aksoy", initials: "SA", tone: "violet" },
    waitsOn: 0,
    ...patch,
  };
}

function pageView(patch: Partial<EpicPageView> = {}): EpicPageView {
  return {
    epic: detail(),
    stages: STAGES,
    members: [
      { userId: "u_murat", name: "Murat Yıldız" },
      { userId: "u_selin", name: "Selin Aksoy" },
    ],
    tasks: [task()],
    candidates: [],
    otherEpics: [],
    plannedIn: null,
    taskLinks: {},
    ...patch,
  };
}

interface Grants {
  canManage?: boolean;
  canEditTasks?: boolean;
  canCreateTask?: boolean;
  canArchive?: boolean;
}

function renderEpic(view: EpicPageView, grants: Grants = {}, action?: ActionFunction) {
  const page: Parameters<typeof createRoutesStub>[0][number] = {
    path: "projects/:slug/epics/:epicId",
    Component: () => (
      <ToastProvider>
        <EpicPage
          view={view}
          projectSlug="viberr-core"
          canManage={grants.canManage ?? true}
          canEditTasks={grants.canEditTasks ?? true}
          canCreateTask={grants.canCreateTask ?? true}
          canArchive={grants.canArchive ?? false}
        />
      </ToastProvider>
    ),
  };
  if (action) page.action = action;
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      loader: () => ({ csrf: "tok", theme: "system" }),
      children: [page],
    },
  ]);
  return render(<Stub initialEntries={["/projects/viberr-core/epics/epic-3"]} />);
}

/** An action that records every POST's fields and answers `replies` in turn,
 *  the last one from then on. */
function recorder(...replies: [EpicActionResult, ...EpicActionResult[]]) {
  const posted: Record<string, string>[] = [];
  const action: ActionFunction = async ({ request }) => {
    const fd = await request.formData();
    const row: Record<string, string> = {};
    for (const [k, v] of fd.entries()) if (!(v instanceof File)) row[k] = v;
    posted.push(row);
    return replies[Math.min(posted.length, replies.length) - 1];
  };
  return { posted, action };
}

/** The page under a loader, as the route serves it: a POST answers `reply`,
 *  and the reload after it, which the route runs after every write, reads
 *  `after`. */
function renderReloading(first: EpicPageView, after: EpicPageView, reply: EpicActionResult) {
  let view = first;
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      loader: () => ({ csrf: "tok", theme: "system" }),
      children: [
        {
          path: "projects/:slug/epics/:epicId",
          loader: () => view,
          action: () => {
            view = after;
            return reply;
          },
          Component: function Loaded() {
            const data = useLoaderData<EpicPageView>();
            return (
              <ToastProvider>
                <EpicPage view={data} projectSlug="viberr-core" canManage canEditTasks canCreateTask canArchive />
              </ToastProvider>
            );
          },
        },
      ],
    },
  ]);
  return render(<Stub initialEntries={["/projects/viberr-core/epics/epic-3"]} />);
}

/** A section of the page, by its heading. */
async function section(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name, level: 2 });
  const found = heading.closest<HTMLElement>("section");
  if (!found) throw new Error(`no section around ${name}`);
  return found;
}

/** The live task list's rows, by task key. */
async function liveRows(): Promise<(string | null)[]> {
  const list = await screen.findByRole("list", { name: "Tasks in epic-3" });
  return Array.from(list.querySelectorAll("li[data-task]")).map((li) => li.getAttribute("data-task"));
}

function rowOf(key: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`li[data-task="${key}"]`);
  if (!row) throw new Error(`no row for ${key}`);
  return row;
}

describe("ruling 503(e): the epic page's head", () => {
  it("carries the status select and Edit for someone who may manage epics, and neither for anyone else", async () => {
    renderEpic(pageView(), { canManage: true });
    const select = await screen.findByRole("combobox", { name: "Status" });
    expect(select).toHaveProperty("value", "in_progress");
    expect(Array.from(select.querySelectorAll("option")).map((o) => o.textContent)).toEqual([
      "Planned",
      "In progress",
      "Paused",
      "Done",
      "Cancelled",
    ]);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByText("50% done · 2 tasks")).toBeTruthy();
    cleanup();
    renderEpic(pageView(), { canManage: false });
    await screen.findByRole("heading", { name: "Checkout revamp", level: 1 });
    // CANARY: drop the `canManage &&` guard around the head's controls and a
    // viewer is handed a status select the server refuses.
    expect(screen.queryByRole("combobox", { name: "Status" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("the status select posts update-epic with the status alone", async () => {
    const { posted, action } = recorder({ ok: true, toast: "Updated epic-3: set the status to Paused." });
    renderEpic(pageView(), {}, action);
    fireEvent.change(await screen.findByRole("combobox", { name: "Status" }), { target: { value: "paused" } });
    expect(await screen.findByText("Updated epic-3: set the status to Paused.")).toBeTruthy();
    // CANARY: make `setStatus` post the title beside the status and the head's
    // select writes over a rename made in the Edit dialog meanwhile.
    expect(posted).toEqual([{ _csrf: "tok", intent: "update-epic", status: "paused" }]);
  });

  it("Edit opens the epic dialog holding what the epic is", async () => {
    renderEpic(pageView());
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    // CANARY: open the head's dialog with `epic={null}` and Edit shows an
    // empty New epic form.
    const dialog = await screen.findByRole("dialog", { name: "Edit epic-3" });
    expect(within(dialog).getByLabelText(/Name/)).toHaveProperty("value", "Checkout revamp");
    expect(within(dialog).getByLabelText(/Description/)).toHaveProperty("value", "Ship the **new** checkout.");
    expect(within(dialog).getByLabelText("Status")).toHaveProperty("value", "in_progress");
    expect(within(dialog).getByLabelText("Lead")).toHaveProperty("value", "u_murat");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("Save toasts the answer and leaves through the dialog's exit, posting once, and focus goes back to Edit", async () => {
    const RENAMED = 'Updated epic-3: renamed it from "Checkout revamp" to "Checkout v2".';
    const PAUSED = "Updated epic-3: set the status to Paused.";
    const { posted, action } = recorder({ ok: true, toast: RENAMED }, { ok: true, toast: PAUSED });
    renderEpic(pageView(), {}, action);
    const edit = await screen.findByRole("button", { name: "Edit" });
    edit.focus();
    fireEvent.click(edit);
    const dialog = await screen.findByRole("dialog", { name: "Edit epic-3" });
    // The sheet's `dialog[data-closing]` clock, which jsdom has no stylesheet
    // to read: the exit plays until its transitionend.
    dialog.style.transitionDuration = "10s";
    const name = within(dialog).getByLabelText(/Name/);
    fireEvent.change(name, { target: { value: "Checkout v2" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(await screen.findByText(RENAMED)).toBeTruthy();
    // An edit's answer is the dialog's own (ruling 695(c)). CANARY: drop
    // `close()` from EpicDialog's own result handler and the dialog stays
    // open over its toast.
    expect(dialog.hasAttribute("data-closing")).toBe(true);
    // Ruling 459: a second Enter on the closing dialog posts nothing. CANARY:
    // drop `fetcher.data?.ok` from submit's guard and the fade posts
    // update-epic again.
    fireEvent.keyDown(name, { key: "Enter" });
    fireEvent.transitionEnd(dialog);
    expect(screen.queryByRole("dialog", { name: "Edit epic-3" })).toBeNull();
    expect(document.activeElement).toBe(edit);
    // A later post's answer: once it shows, a post the second Enter made
    // would have reached the action before it.
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "paused" } });
    expect(await screen.findByText(PAUSED)).toBeTruthy();
    expect(posted).toEqual([
      expect.objectContaining({ intent: "update-epic", title: "Checkout v2" }),
      { _csrf: "tok", intent: "update-epic", status: "paused" },
    ]);
  });
});

describe("ruling 615: the head says the status once and scrolls with the panels", () => {
  /** The head's status line: the one that says how far along the epic is. */
  const statusLine = () => screen.getByText("50% done · 2 tasks").parentElement!;

  it("the status line carries the select for someone who may change the status, and the pill for anyone else", async () => {
    renderEpic(pageView(), { canManage: true });
    await screen.findByRole("combobox", { name: "Status" });
    // CANARY: render the pill beside the select again and the head says
    // "In progress" twice, three times with the Details row.
    expect(within(statusLine()).getByRole("combobox", { name: "Status" })).toBeTruthy();
    expect(statusLine().querySelector("[data-epic-status]")).toBeNull();
    cleanup();
    renderEpic(pageView(), { canManage: false });
    await screen.findByRole("heading", { name: "Checkout revamp", level: 1 });
    expect(within(statusLine()).getByText("In progress").closest("[data-epic-status]")).not.toBeNull();
  });

  it("the head is in the page's one scroller with the panels", async () => {
    renderEpic(pageView());
    const title = await screen.findByRole("heading", { name: "Checkout revamp", level: 1 });
    const scroller = title.closest(".policy-wrap");
    // CANARY: lift the head out of `.policy-wrap` again and wherever the page
    // scrolls, the scroller's 10px scrollbar pulls the panels in under an Edit
    // that keeps its place. Only this suite sees it: headless Chromium hides
    // scrollbars, so the e2e layout checks measure no gutter.
    expect(scroller).not.toBeNull();
    expect((await section("Details")).closest(".policy-wrap")).toBe(scroller);
  });
});

describe("ruling 503(e): About, History and Details", () => {
  it("About renders the description as markdown", async () => {
    renderEpic(pageView());
    const about = await section("About");
    // CANARY: print `epic.description` as plain text instead of through
    // `Markdown` and the bold reads as literal asterisks.
    expect(within(about).getByText("new").tagName).toBe("STRONG");
    expect(about.textContent).not.toContain("**");
  });

  it("an empty description says so, and offers the edit only to someone who may manage epics", async () => {
    renderEpic(pageView({ epic: detail({ description: "  " }) }), { canManage: true });
    const about = await section("About");
    expect(about.textContent).toContain("No description yet.");
    fireEvent.click(within(about).getByRole("button", { name: "Say what this epic is for" }));
    expect(await screen.findByRole("dialog", { name: "Edit epic-3" })).toBeTruthy();
    cleanup();
    renderEpic(pageView({ epic: detail({ description: "" }) }), { canManage: false });
    const readOnly = await section("About");
    expect(readOnly.textContent).toContain("No description yet.");
    // CANARY: drop the `canManage &&` around "Say what this epic is for" and
    // a viewer is offered an edit the server refuses.
    expect(within(readOnly).queryByRole("button")).toBeNull();
  });

  it("History shows the newest eight entries under their days, with Show more for the rest, and links the tasks it names", async () => {
    // Local hours of fixed past days, so every zone reads the same days.
    const at = (day: number, hour: number) => new Date(2024, 8, day, hour).toISOString();
    const history = [
      { occurredAt: at(20, 12), text: "Arda Kaya added VIB-151." },
      { occurredAt: at(20, 11), text: "Entry 9" },
      ...Array.from({ length: 8 }, (_, i) => ({ occurredAt: at(19 - i, 12), text: `Entry ${8 - i}` })),
    ];
    renderEpic(pageView({ epic: detail({ history }), taskLinks: { "VIB-151": "/projects/viberr-core/tasks/VIB-151" } }));
    const panel = await section("History");
    // CANARY: drop the `slice(0, HISTORY_PREVIEW)` and a long history opens in
    // full, pushing Details off the first screen.
    expect(panel.querySelectorAll("li")).toHaveLength(8);
    // CANARY: render the entries without `daySections` and the two Sep 20
    // entries lose the day they share.
    expect([...panel.querySelectorAll(".epic-history-day")].map((day) => day.textContent)).toEqual([
      "Sep 20",
      "Sep 19",
      "Sep 18",
      "Sep 17",
      "Sep 16",
      "Sep 15",
      "Sep 14",
    ]);
    expect(within(panel).getByRole("link", { name: "VIB-151" }).getAttribute("href")).toBe(
      "/projects/viberr-core/tasks/VIB-151",
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Show 2 more" }));
    expect(panel.querySelectorAll("li")).toHaveLength(10);
    expect(within(panel).getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("a new line leaves the rows already drawn in place, so a task chip in them keeps the focus", async () => {
    // Local hours of one fixed past day, so every zone reads one day. The
    // eight lines fill the preview, so the new one pushes the oldest out.
    const at = (hour: number) => new Date(2024, 8, 20, hour).toISOString();
    const earlier = [
      { occurredAt: at(11), text: "Arda Kaya added VIB-151." },
      ...Array.from({ length: 7 }, (_, i) => ({ occurredAt: at(10 - i), text: `Entry ${7 - i}` })),
    ];
    const latest = { occurredAt: at(12), text: "Arda Kaya set the status to Paused." };
    const taskLinks = { "VIB-151": "/projects/viberr-core/tasks/VIB-151" };
    renderReloading(
      pageView({ epic: detail({ history: earlier }), taskLinks }),
      pageView({ epic: detail({ status: "paused", history: [latest, ...earlier] }), taskLinks }),
      { ok: true },
    );
    const panel = await section("History");
    const chip = within(panel).getByRole("link", { name: "VIB-151" });
    chip.focus();
    // The line reaches the open page the way every write does, by the reload;
    // a change event leaves the focus on the chip.
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "paused" } });
    expect(await within(panel).findByText(latest.text)).toBeTruthy();
    // CANARY: key a row by its place in its day again, or count it from the end
    // of `entries` (a full preview stays eight long), and the new line re-keys
    // every row under it: the chip's row remounts and the focus falls to <body>.
    expect(chip.isConnected).toBe(true);
    expect(document.activeElement).toBe(chip);
  });

  it("Details names the status, the lead, the dates and the creator", async () => {
    renderEpic(pageView());
    const details = await section("Details");
    const rows = Array.from(details.querySelectorAll(".kv-row")).map((row) => [
      row.querySelector(".k")?.textContent,
      row.querySelector(".v")?.textContent,
    ]);
    // CANARY: drop the Lead row from Details and nobody can see who the
    // epic's notices reach.
    expect(rows.slice(0, 4)).toEqual([
      ["Status", "In progress"],
      ["Lead", "Murat Yıldız"],
      ["Start date", "2026-10-01"],
      ["Target date", "2026-10-15"],
    ]);
    expect(rows[4]?.[0]).toBe("Created");
    expect(rows[4]?.[1]).toContain("arda@viberr.dev");
    expect(rows).toHaveLength(5);
    cleanup();
    renderEpic(pageView({ epic: detail({ leadUserId: null, leadName: null, startDate: null, targetDate: null }) }));
    const bare = await section("Details");
    expect(Array.from(bare.querySelectorAll(".prop-empty")).map((e) => e.textContent)).toEqual([
      "Nobody",
      "Not set",
      "Not set",
    ]);
  });

  it("Details links the conversation the epic was planned in when the view carries it (476(h))", async () => {
    renderEpic(
      pageView({
        plannedIn: {
          id: "cnv_1",
          title: "Plan the checkout",
          href: "/projects/viberr-core/controller?c=cnv_1",
          scopeLabel: "This board",
        },
      }),
    );
    const details = await section("Details");
    // CANARY: drop the Planned in row from Details and the reasoning behind
    // the epic's tasks is unreachable from the epic.
    const planned = details.querySelector<HTMLElement>("[data-epic-planned]");
    expect(planned?.textContent).toBe("Planned inPlan the checkout · This board");
    expect(planned && within(planned).getByRole("link", { name: "Plan the checkout" }).getAttribute("href")).toBe(
      "/projects/viberr-core/controller?c=cnv_1",
    );
    cleanup();
    renderEpic(pageView({ plannedIn: null }));
    const without = await section("Details");
    expect(without.textContent).not.toContain("Planned in");
  });
});

describe("ruling 503(e): the Tasks section", () => {
  const TASKS = [
    task({ key: "VIB-151", stageId: "impl", waitsOn: 2 }),
    task({
      key: "VIB-166",
      title: "Pick the provider",
      stageId: "triage",
      status: { kind: "you", label: "waiting on you", icon: "hand" },
      owner: null,
    }),
    task({ key: "VIB-170", title: "From a removed stage", stageId: "qa", status: null, owner: null }),
  ];

  it("each row names its task, its stage, the board card's status word, what it waits on and its owner", async () => {
    renderEpic(pageView({ tasks: TASKS }));
    expect(await liveRows()).toEqual(["VIB-151", "VIB-166", "VIB-170"]);
    // The section opens on the epic's progress, in the project's stage colours.
    const tasks = await section("Tasks");
    expect(within(tasks).getByRole("img", { name: "0 triage · 1 in progress · 1 done" })).toBeTruthy();
    expect(within(tasks).getByText("1 of 2 done")).toBeTruthy();
    const working = rowOf("VIB-151");
    const link = within(working).getByRole("link");
    expect(link.getAttribute("href")).toBe("/projects/viberr-core/tasks/VIB-151");
    expect(link.textContent).toBe("VIB-151Wire the checkout");
    expect(working.querySelector(".epic-task-stage")?.textContent).toBe("In Progress");
    expect(working.querySelector(".epic-task-stage [data-stage-color]")?.getAttribute("data-stage-color")).toBe("violet");
    // CANARY: drop the `task.status` chip from EpicTaskRow and the row no
    // longer says what the task's board card says.
    const chip = working.querySelector(".chip.st");
    expect(chip?.className).toContain("agent");
    expect(chip?.textContent).toBe("agent working");
    expect(within(working).getByText("waits on 2")).toBeTruthy();
    expect(within(working).getByRole("img", { name: "Owner: Selin Aksoy" })).toBeTruthy();

    const mine = rowOf("VIB-166");
    expect(mine.querySelector(".chip.st.you")?.textContent).toBe("waiting on you");
    expect(within(mine).queryByText(/waits on/)).toBeNull();
    expect(within(mine).getByRole("img", { name: "Owner: unassigned" })).toBeTruthy();

    // A stage the project no longer has is named by its id; no word, no chip.
    const orphan = rowOf("VIB-170");
    expect(orphan.querySelector(".epic-task-stage")?.textContent).toBe("qa");
    expect(orphan.querySelector(".chip.st")).toBeNull();
  });

  it("Remove posts remove-task for its task", async () => {
    const { posted, action } = recorder({ ok: true, toast: "VIB-166 is no longer in an epic." });
    renderEpic(pageView({ tasks: TASKS }), {}, action);
    await liveRows();
    fireEvent.click(within(rowOf("VIB-166")).getByRole("button", { name: "Take VIB-166 out of epic-3" }));
    expect(await screen.findByText("VIB-166 is no longer in an epic.")).toBeTruthy();
    // CANARY: set the row's key under another name in `rowAct` (the action
    // reads `taskKey`) and Remove is refused as naming no task.
    expect(posted).toEqual([{ _csrf: "tok", intent: "remove-task", taskKey: "VIB-166" }]);
  });

  it("offers Remove and Add tasks only to someone who may edit task metadata", async () => {
    renderEpic(pageView({ tasks: TASKS }), { canEditTasks: false, canCreateTask: false });
    expect(await liveRows()).toEqual(["VIB-151", "VIB-166", "VIB-170"]);
    // CANARY: render Remove whatever `canEditTasks` says and a viewer is
    // offered a button the server refuses.
    expect(screen.queryByRole("button", { name: /^Take .* out of epic-3$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add tasks" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
  });

  it("Add tasks lists every candidate, says which epic each is in now, and which will move", async () => {
    const { posted, action } = recorder({ ok: true, toast: "VIB-148 and VIB-153 are now in epic-3 (Checkout revamp)." });
    renderEpic(
      pageView({
        candidates: [
          { key: "VIB-148", title: "Pay with a saved card", epicId: null },
          { key: "VIB-153", title: "Receipt email", epicId: "epic-1" },
          { key: "VIB-160", title: "Refund flow", epicId: "epic-9" },
        ],
        otherEpics: [{ id: "epic-1", title: "Onboarding" }],
      }),
      {},
      action,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add tasks" }));
    const dialog = await screen.findByRole("dialog", { name: "Add tasks to epic-3" });
    const list = within(dialog).getByRole("list", { name: "Tasks" });
    expect(Array.from(list.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
      "VIB-148Pay with a saved card",
      "VIB-153Receipt emailin epic-1 (Onboarding)",
      "VIB-160Refund flowin epic-9",
    ]);
    const hint = within(dialog).getByRole("status");
    expect(hint.textContent).toBe("A task is in at most one epic.");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /VIB-148/ }));
    expect(hint.textContent).toBe("1 task picked.");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /VIB-153/ }));
    // CANARY: drop the `moving` clause from the Add tasks foot and nobody is
    // told VIB-153 leaves epic-1.
    expect(hint.textContent).toBe("2 tasks picked; VIB-153 will move here from its epic.");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /VIB-160/ }));
    expect(hint.textContent).toBe("3 tasks picked; VIB-153, VIB-160 will move here from their epic.");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /VIB-160/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add 2 tasks" }));
    expect(await screen.findByText("VIB-148 and VIB-153 are now in epic-3 (Checkout revamp).")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add tasks to epic-3" })).toBeNull());
    expect(posted).toEqual([{ _csrf: "tok", intent: "add-tasks", taskKeys: "VIB-148,VIB-153" }]);
  });

  it("Add tasks narrows by key or title, and says when every live task is in already", async () => {
    renderEpic(
      pageView({
        candidates: [
          { key: "VIB-148", title: "Pay with a saved card", epicId: null },
          { key: "VIB-153", title: "Receipt email", epicId: null },
        ],
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add tasks" }));
    const dialog = await screen.findByRole("dialog", { name: "Add tasks to epic-3" });
    const filter = within(dialog).getByRole("searchbox", { name: "Filter tasks" });
    // CANARY: drop the title from the Add tasks filter and "receipt" finds
    // nothing.
    fireEvent.change(filter, { target: { value: "receipt" } });
    expect(within(dialog).getAllByRole("checkbox").map((c) => c.closest("label")?.textContent)).toEqual([
      "VIB-153Receipt email",
    ]);
    fireEvent.change(filter, { target: { value: "vib-148" } });
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(within(dialog).getByText("No task matches “zzz”.")).toBeTruthy();
    cleanup();
    renderEpic(pageView({ candidates: [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Add tasks" }));
    const none = await screen.findByRole("dialog", { name: "Add tasks to epic-3" });
    expect(within(none).getByText("Every live task in this project is already in this epic.")).toBeTruthy();
    expect(within(none).getByRole("button", { name: "Add task" })).toHaveProperty("disabled", true);
  });

  it("New task makes a task in the epic, and refuses a title under three characters before posting", async () => {
    const { posted, action } = recorder({ ok: true, toast: "VIB-171 created in Triage, in epic-3." });
    renderEpic(pageView(), { canCreateTask: true }, action);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    const dialog = await screen.findByRole("dialog", { name: "New task in epic-3" });
    expect(dialog.textContent).toContain(
      "In Checkout revamp. It starts in Triage, where its goal is refined before work begins.",
    );
    fireEvent.change(within(dialog).getByLabelText(/Title/), { target: { value: "ab" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    // CANARY: drop the `valid` check from NewTaskInEpicDialog's submit and a
    // two-letter title is posted for the server to refuse.
    expect(within(dialog).getByRole("alert").textContent).toBe("A title needs at least 3 characters.");
    expect(posted).toEqual([]);
    fireEvent.change(within(dialog).getByLabelText(/Title/), { target: { value: "Wire the button" } });
    fireEvent.change(within(dialog).getByLabelText(/Goal/), { target: { value: "Done when it is clicked." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task" }));
    expect(await screen.findByText("VIB-171 created in Triage, in epic-3.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task in epic-3" })).toBeNull());
    expect(posted).toEqual([
      { _csrf: "tok", intent: "create-task", title: "Wire the button", goal: "Done when it is clicked." },
    ]);
  });

  it("archived tasks fold under the list: no live row, no Remove", async () => {
    renderEpic(
      pageView({
        tasks: [
          task({ key: "VIB-151" }),
          task({
            key: "VIB-139",
            title: "Old checkout",
            stageId: "done",
            archived: true,
            status: { kind: "archived", label: "archived", icon: "archive" },
          }),
        ],
      }),
      { canEditTasks: true },
    );
    expect(await liveRows()).toEqual(["VIB-151"]);
    const folded = document.querySelector<HTMLElement>("details.epic-archived");
    expect(folded?.querySelector("summary")?.textContent).toBe("1 archived task");
    const archived = folded?.querySelector<HTMLElement>('li[data-task="VIB-139"]');
    expect(archived?.querySelector(".chip.st")?.textContent).toBe("archived");
    // CANARY: drop `&& !task.archived` from EpicTasks' `onRemove` and a task
    // whose planning metadata is frozen is offered a Remove the server refuses.
    expect(screen.queryByRole("button", { name: "Take VIB-139 out of epic-3" })).toBeNull();
    expect(screen.getByRole("button", { name: "Take VIB-151 out of epic-3" })).toBeTruthy();
  });

  it("an epic with no live task says so, and how tasks join to someone who can add them", async () => {
    const onlyArchived = [task({ key: "VIB-139", archived: true, status: { kind: "archived", label: "archived", icon: "archive" } })];
    renderEpic(pageView({ tasks: onlyArchived }), { canEditTasks: true });
    const tasks = await section("Tasks");
    // CANARY: say "No tasks in this epic yet" whatever the fold holds and an
    // epic whose every task is archived claims it has none (ruling 651).
    expect(tasks.textContent).toContain("Every task in this epic is archived.");
    expect(tasks.textContent).not.toContain("No tasks in this epic yet");
    expect(screen.queryByRole("list", { name: "Tasks in epic-3" })).toBeNull();
    cleanup();
    renderEpic(pageView({ tasks: [] }), { canEditTasks: true });
    // CANARY: drop the `live.length === 0` sentence and an epic with no task
    // shows an empty list that explains nothing.
    expect((await section("Tasks")).textContent).toContain(
      "No tasks in this epic yet. Add existing tasks or make a new one here; a task can also join from its own page.",
    );
    cleanup();
    renderEpic(pageView({ tasks: [] }), { canEditTasks: false, canCreateTask: false });
    const readOnly = await section("Tasks");
    expect(readOnly.textContent).toContain("No tasks in this epic yet.");
    expect(readOnly.textContent).not.toContain("Add existing tasks");
  });
});

describe("ruling 651: archiving from the epic page", () => {
  const OPEN = task({ key: "VIB-151", title: "Wire the checkout", stageId: "impl" });
  const DONE = task({ key: "VIB-160", title: "Receipt email", stageId: "done", status: { kind: "done", label: "done", icon: "check" } });
  const FILED = task({
    key: "VIB-139",
    title: "Old checkout",
    stageId: "done",
    archived: true,
    status: { kind: "archived", label: "archived", icon: "archive" },
  });

  it("archives a done task from its row in one click; an open one asks first, naming where it stands", async () => {
    const { posted, action } = recorder({ ok: true, toast: "Archived." });
    renderEpic(pageView({ tasks: [OPEN, DONE] }), { canArchive: true }, action);
    await liveRows();
    fireEvent.click(within(rowOf("VIB-160")).getByRole("button", { name: "Archive VIB-160" }));
    await waitFor(() => expect(posted).toEqual([{ _csrf: "tok", intent: "archive-task", taskKey: "VIB-160" }]));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(within(rowOf("VIB-151")).getByRole("button", { name: "Archive VIB-151" }));
    // CANARY: archive every row in one click (drop the `isTerminalStage`
    // check in `archiveRow`) and an open task's decision and runs end unasked.
    const dialog = await screen.findByRole("alertdialog", { name: "Archive VIB-151?" });
    expect(dialog.textContent).toContain("It is still open, at In Progress.");
    expect(posted).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive VIB-151" }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({ _csrf: "tok", intent: "archive-task", taskKey: "VIB-151" });
  });

  it("restores an archived task from its row in the fold, and offers neither control without the grant", async () => {
    const { posted, action } = recorder({ ok: true, toast: "VIB-139 restored to Done." });
    renderEpic(pageView({ tasks: [OPEN, FILED] }), { canArchive: true }, action);
    await liveRows();
    const fold = await screen.findByRole("list", { name: "Archived tasks in epic-3" });
    fireEvent.click(within(fold).getByRole("button", { name: "Restore VIB-139" }));
    expect(await screen.findByText("VIB-139 restored to Done.")).toBeTruthy();
    expect(posted).toEqual([{ _csrf: "tok", intent: "restore-task", taskKey: "VIB-139" }]);
    expect(within(fold).queryByRole("button", { name: "Archive VIB-139" })).toBeNull();
    cleanup();
    renderEpic(pageView({ tasks: [OPEN, FILED] }), { canArchive: false });
    await liveRows();
    // CANARY: pass the row actions whatever `canArchive` says and a
    // contributor is offered archives the server refuses.
    expect(screen.queryByRole("button", { name: /^(Archive|Restore) VIB-/ })).toBeNull();
  });

  it("offers Archive tasks in the Tasks head of a Done epic whose tasks are all done, and posts it for this epic", async () => {
    const { posted, action } = recorder({ ok: true, toast: "1 task in epic-3 archived. Find it under Archived on the board." });
    const shipped = detail({ status: "done", progress: progress({ total: 2, done: 2, archived: 1, archivedDone: 1 }) });
    renderEpic(pageView({ epic: shipped, tasks: [DONE, FILED] }), { canArchive: true }, action);
    const tasks = await section("Tasks");
    fireEvent.click(within(tasks).getByRole("button", { name: "Archive tasks" }));
    // One live task left on the board: the count the dialog names.
    const dialog = await screen.findByRole("alertdialog", { name: "Archive the task in epic-3?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive 1 task" }));
    expect(await screen.findByText("1 task in epic-3 archived. Find it under Archived on the board.")).toBeTruthy();
    expect(posted).toEqual([{ _csrf: "tok", intent: "archive-epic-tasks", epicId: "epic-3" }]);
    cleanup();
    renderEpic(pageView({ epic: detail({ status: "in_progress", progress: progress({ total: 1, done: 1 }) }), tasks: [DONE] }), {
      canArchive: true,
    });
    // CANARY: drop the `status === "done"` check in `archivableTasks` and an
    // epic still in progress offers its tasks to the archive.
    expect(within(await section("Tasks")).queryByRole("button", { name: "Archive tasks" })).toBeNull();
  });

  it("the row's answer is toasted after the row moves into the fold", async () => {
    // The page reloads after the action: the archived row leaves the live
    // list for the fold, a new element.
    renderReloading(
      pageView({ tasks: [DONE] }),
      pageView({ tasks: [{ ...DONE, archived: true, status: FILED.status }] }),
      { ok: true, toast: "VIB-160 archived. Find it under Archived on the board." },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Archive VIB-160" }));
    // CANARY: give `EpicTaskRow` its own fetcher again and the toast is lost
    // when the row unmounts into the fold.
    expect(await screen.findByText("VIB-160 archived. Find it under Archived on the board.")).toBeTruthy();
    expect(await screen.findByRole("list", { name: "Archived tasks in epic-3" })).toBeTruthy();
  });
});

describe("ruling 503(e): screen labels", () => {
  it("the page and each of its dialogs carry a data-screen-label", async () => {
    renderEpic(pageView({ candidates: [{ key: "VIB-148", title: "Pay with a saved card", epicId: null }] }));
    const page = (await screen.findByRole("heading", { name: "Checkout revamp", level: 1 })).closest("[data-screen-label]");
    expect(page?.getAttribute("data-screen-label")).toBe("Epic");
    // CANARY: drop `data-screen-label` from any one of the three dialogs and
    // its screen goes unnamed in the design review's captures.
    const opened: (string | null)[] = [];
    for (const [button, dialog] of [
      ["Edit", "Edit epic-3"],
      ["Add tasks", "Add tasks to epic-3"],
      ["New task", "New task in epic-3"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name: button }));
      const shown = await screen.findByRole("dialog", { name: dialog });
      opened.push(shown.getAttribute("data-screen-label"));
      fireEvent.click(within(shown).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: dialog })).toBeNull());
    }
    expect(opened).toEqual(["Edit epic dialog", "Add tasks dialog", "New task in epic dialog"]);
  });
});
