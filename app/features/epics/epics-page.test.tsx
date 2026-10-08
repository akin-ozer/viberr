// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRoutesStub, useLoaderData, useLocation, useParams, type ActionFunction } from "react-router";
import { ToastProvider } from "~/ui/toast";
import type { EpicProgress, EpicSummary } from "~/server/projections/epic-query.server";
import { EpicsPage } from "./epics-page";
import type { EpicMemberView, EpicStageView } from "./epics-query.server";

/**
 * Ruling 503(e): `/projects/:slug/epics`, the project's epics the way Linear
 * lists a team's projects. Each row is its epic's page (its colour and name,
 * its status, its progress in the project's own stage colours, its lead and,
 * while it is open, its target date); open epics come first by default, with
 * Closed and All one click away; New epic is offered to whoever may
 * `manage-epics`. A Done epic whose tasks are all done offers Archive tasks
 * to whoever may archive them (ruling 651).
 */

afterEach(cleanup);

const STAGES: EpicStageView[] = [
  { id: "triage", name: "Triage", color: "slate" },
  { id: "impl", name: "In Progress", color: "violet" },
  { id: "done", name: "Done", color: "green" },
];

const MEMBERS: EpicMemberView[] = [
  { userId: "u_murat", name: "Murat Yıldız" },
  { userId: "u_selin", name: "Selin Aksoy" },
];

function progress(patch: Partial<EpicProgress> = {}): EpicProgress {
  return { total: 0, done: 0, started: 0, notStarted: 0, held: 0, archived: 0, archivedDone: 0, byStage: [], ...patch };
}

function epic(patch: Partial<EpicSummary> = {}): EpicSummary {
  return {
    id: "epic-1",
    number: 1,
    title: "Checkout revamp",
    status: "in_progress",
    color: "teal",
    leadUserId: "u_murat",
    leadName: "Murat Yıldız",
    startDate: null,
    targetDate: null,
    description: "",
    createdBy: "u_arda",
    createdByLabel: "arda@viberr.dev",
    conversationId: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    progress: progress(),
    ...patch,
  };
}

/** Where the list sends a person: the epic's own page. */
function EpicStandIn() {
  const { epicId } = useParams();
  return <p>Epic page for {epicId}</p>;
}

/** The address bar, so a filter pick can be read where it lands. */
function SearchProbe() {
  return <output data-testid="search">{useLocation().search}</output>;
}

function renderEpics(
  opts: {
    epics?: EpicSummary[];
    canManage?: boolean;
    canArchive?: boolean;
    search?: string;
    action?: ActionFunction;
  } = {},
) {
  const page: Parameters<typeof createRoutesStub>[0][number] = {
    path: "projects/:slug/epics",
    Component: () => (
      <ToastProvider>
        <EpicsPage
          projectSlug="viberr-core"
          epics={opts.epics ?? []}
          stages={STAGES}
          members={MEMBERS}
          canManage={opts.canManage ?? true}
          canArchive={opts.canArchive ?? false}
        />
        <SearchProbe />
      </ToastProvider>
    ),
  };
  if (opts.action) page.action = opts.action;
  // The root loader runs again after every post, as the app's loaders do: a
  // test that must know an answer has landed waits on the count.
  let rootLoads = 0;
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      loader: () => {
        rootLoads += 1;
        return { csrf: "tok", theme: "system" };
      },
      children: [page, { path: "projects/:slug/epics/:epicId", Component: EpicStandIn }],
    },
  ]);
  render(<Stub initialEntries={[`/projects/viberr-core/epics${opts.search ?? ""}`]} />);
  return { rootLoads: () => rootLoads };
}

/** The head's count line ("5 epics · 3 open"). The toast host is a status
 *  region too, so the head's is read from under the page heading. */
function headCount(): string | null {
  const head = screen.getByRole("heading", { name: "Epics", level: 1 }).parentElement;
  return head ? within(head).getByRole("status").textContent : null;
}

/** One epic's row, by id. */
function rowOf(epicId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`li[data-epic="${epicId}"]`);
  if (!row) throw new Error(`no row for ${epicId}`);
  return row;
}

/** The ids of the rows a list shows, in order. */
function rowIds(list: HTMLElement): (string | null)[] {
  return Array.from(list.querySelectorAll("[data-epic]")).map((row) => row.getAttribute("data-epic"));
}

describe("ruling 503(e): each row of the Epics list is its epic", () => {
  it("draws the colour dot and the name as a link to the epic, its status, its progress, its lead and its target date", async () => {
    renderEpics({
      epics: [
        epic({
          id: "epic-3",
          title: "Checkout revamp",
          status: "in_progress",
          color: "teal",
          leadName: "Murat Yıldız",
          targetDate: "2026-10-15",
          progress: progress({
            total: 4,
            done: 1,
            started: 2,
            notStarted: 1,
            held: 1,
            archived: 1,
            byStage: [
              { stageId: "triage", count: 1 },
              { stageId: "impl", count: 2 },
              { stageId: "done", count: 1 },
            ],
          }),
        }),
      ],
    });
    const link = await screen.findByRole("link", { name: /Checkout revamp/ });
    expect(link.getAttribute("href")).toBe("/projects/viberr-core/epics/epic-3");
    const row = rowOf("epic-3");
    expect(row.querySelector(".epic-dot")?.getAttribute("data-stage-color")).toBe("teal");
    expect(within(row).getByText("epic-3")).toBeTruthy();
    expect(within(row).getByText("In progress").closest("[data-epic-status]")?.getAttribute("data-epic-status")).toBe(
      "in_progress",
    );
    // CANARY: drop `EpicProgressBar` from `EpicRow` and the row loses its
    // stage-coloured meter and its "N of M done".
    const meter = within(row).getByRole("img", { name: "1 triage · 2 in progress · 1 done" });
    expect(Array.from(meter.children).map((band) => band.getAttribute("data-stage-color"))).toEqual([
      "slate",
      "violet",
      "green",
    ]);
    expect(within(row).getByText("1 of 4 done · 1 waiting on other work · 1 archived")).toBeTruthy();
    expect(within(row).getByTitle("Led by Murat Yıldız").textContent).toBe("Murat Yıldız");
    expect(within(row).getByText("due Oct 15")).toBeTruthy();
  });

  it("names no target date on a closed epic, and says when an epic has no tasks", async () => {
    renderEpics({
      search: "?show=all",
      epics: [
        epic({ id: "epic-1", title: "Shipped", status: "done", targetDate: "2026-10-15" }),
        epic({ id: "epic-2", title: "Only archived", status: "planned", progress: progress({ archived: 2 }) }),
        epic({ id: "epic-3", title: "Nothing yet", status: "planned", leadName: null }),
      ],
    });
    await screen.findByRole("link", { name: /Shipped/ });
    // CANARY: drop `isEpicOpen(epic.status)` from the row's target date and
    // the done epic still reads "due Oct 15".
    expect(within(rowOf("epic-1")).queryByText(/due/)).toBeNull();
    expect(within(rowOf("epic-2")).getByText("No open tasks · 2 archived")).toBeTruthy();
    const empty = rowOf("epic-3");
    expect(within(empty).getByText("No tasks yet")).toBeTruthy();
    expect(within(empty).queryByTitle(/Led by/)).toBeNull();
  });
});

describe("ruling 651: Archive tasks on a Done epic", () => {
  const SHIPPED = epic({
    id: "epic-1",
    title: "Shipped",
    status: "done",
    progress: progress({ total: 3, done: 3, byStage: [{ stageId: "done", count: 3 }] }),
  });

  it("is offered on a Done epic whose tasks are all done and still on the board, to someone who may archive", async () => {
    renderEpics({
      search: "?show=all",
      canArchive: true,
      epics: [
        SHIPPED,
        epic({ id: "epic-2", title: "Running", status: "in_progress", progress: progress({ total: 2, done: 2 }) }),
        epic({ id: "epic-3", title: "Done but one open", status: "done", progress: progress({ total: 2, done: 1, started: 1 }) }),
        epic({
          id: "epic-4",
          title: "Filed away",
          status: "done",
          progress: progress({ total: 2, done: 2, archived: 2, archivedDone: 2 }),
        }),
      ],
    });
    await screen.findByRole("link", { name: /Shipped/ });
    const button = within(rowOf("epic-1")).getByRole("button", { name: "Archive tasks" });
    // A button may not sit inside a link: the row's link is its name.
    expect(button.closest("a")).toBeNull();
    // CANARY: drop the `done === total` check in `archivableTasks` and the
    // Done epic with an open task offers it too.
    for (const id of ["epic-2", "epic-3", "epic-4"]) {
      expect(within(rowOf(id)).queryByRole("button", { name: "Archive tasks" }), id).toBeNull();
    }
    expect(within(rowOf("epic-4")).getByText("2 of 2 done · 2 archived")).toBeTruthy();
    cleanup();
    renderEpics({ search: "?show=all", canArchive: false, epics: [SHIPPED] });
    await screen.findByRole("link", { name: /Shipped/ });
    expect(screen.queryByRole("button", { name: "Archive tasks" })).toBeNull();
  });

  it("asks once, naming how many, posts archive-epic-tasks, and toasts the answer after the row stops offering it", async () => {
    const posted: Record<string, string>[] = [];
    // The list reloads after the action, as the route's loader does: the
    // epic's tasks are archived and its row offers the button no more.
    let epics = [SHIPPED];
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        loader: () => ({ csrf: "tok", theme: "system" }),
        children: [
          {
            path: "projects/:slug/epics",
            loader: () => ({ epics }),
            action: async ({ request }) => {
              const fd = await request.formData();
              const row: Record<string, string> = {};
              for (const [k, v] of fd.entries()) if (!(v instanceof File)) row[k] = v;
              posted.push(row);
              epics = [{ ...SHIPPED, progress: progress({ total: 3, done: 3, archived: 3, archivedDone: 3 }) }];
              return { ok: true, toast: "3 tasks in epic-1 archived. Find them under Archived on the board." };
            },
            Component: function Loaded() {
              const data = useLoaderData<{ epics: EpicSummary[] }>();
              return (
                <ToastProvider>
                  <EpicsPage
                    projectSlug="viberr-core"
                    epics={data.epics}
                    stages={STAGES}
                    members={MEMBERS}
                    canManage
                    canArchive
                  />
                </ToastProvider>
              );
            },
          },
        ],
      },
    ]);
    render(<Stub initialEntries={["/projects/viberr-core/epics?show=closed"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Archive tasks" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Archive the 3 tasks in epic-1?" });
    expect(posted).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive 3 tasks" }));
    // CANARY: hold the fetcher in `ArchiveEpicTasksButton` instead of the page
    // (`useArchiveEpicTasks`) and the answer's toast is lost with the button.
    expect(await screen.findByText("3 tasks in epic-1 archived. Find them under Archived on the board.")).toBeTruthy();
    expect(within(rowOf("epic-1")).queryByRole("button", { name: "Archive tasks" })).toBeNull();
    expect(posted).toEqual([{ _csrf: "tok", intent: "archive-epic-tasks", epicId: "epic-1" }]);
  });
});

describe("ruling 503(e): Open, Closed and All", () => {
  const MIXED = [
    epic({ id: "epic-1", title: "Running", status: "in_progress" }),
    epic({ id: "epic-2", title: "Landed", status: "done" }),
    epic({ id: "epic-3", title: "Queued up", status: "planned" }),
    epic({ id: "epic-4", title: "Dropped", status: "cancelled" }),
    epic({ id: "epic-5", title: "Parked", status: "paused" }),
  ];

  it("shows the open epics first by default, and Closed and All are one click away on ?show=", async () => {
    renderEpics({ epics: MIXED });
    // CANARY: default `show` to "all" when `?show=` is absent and the done and
    // cancelled epics show on first load.
    const open = await screen.findByRole("list", { name: "Open epics" });
    expect(rowIds(open)).toEqual(["epic-1", "epic-3", "epic-5"]);
    expect(headCount()).toBe("5 epics · 3 open");
    const group = screen.getByRole("group", { name: "Which epics" });
    expect(within(group).getByRole("button", { name: "Open" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(group).getByRole("button", { name: "Closed" }));
    expect(rowIds(await screen.findByRole("list", { name: "Closed epics" }))).toEqual(["epic-2", "epic-4"]);
    expect(screen.getByTestId("search").textContent).toBe("?show=closed");
    expect(within(group).getByRole("button", { name: "Closed" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(within(group).getByRole("button", { name: "All" }));
    expect(rowIds(await screen.findByRole("list", { name: "All epics" }))).toEqual([
      "epic-1",
      "epic-2",
      "epic-3",
      "epic-4",
      "epic-5",
    ]);

    // Open is the default, so it leaves the address bare.
    fireEvent.click(within(group).getByRole("button", { name: "Open" }));
    expect(rowIds(await screen.findByRole("list", { name: "Open epics" }))).toEqual(["epic-1", "epic-3", "epic-5"]);
    expect(screen.getByTestId("search").textContent).toBe("");
  });

  it("opens on the view the address names, and on Open for a value it does not know", async () => {
    renderEpics({ epics: MIXED, search: "?show=closed" });
    // CANARY: stop reading `?show=` (always "open") and a shared Closed link
    // opens on the open epics.
    expect(rowIds(await screen.findByRole("list", { name: "Closed epics" }))).toEqual(["epic-2", "epic-4"]);
    cleanup();
    renderEpics({ epics: MIXED, search: "?show=everything" });
    expect(rowIds(await screen.findByRole("list", { name: "Open epics" }))).toEqual(["epic-1", "epic-3", "epic-5"]);
  });

  it("says so when a view holds no epic", async () => {
    renderEpics({ epics: [epic({ id: "epic-1", status: "done" }), epic({ id: "epic-2", status: "cancelled" })] });
    // CANARY: drop the `shown.length === 0` sentence and an all-closed
    // project's Open view is a blank panel.
    expect(await screen.findByText("Every epic is done or cancelled.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Open epics" })).toBeNull();
    cleanup();
    renderEpics({ epics: [epic({ id: "epic-1", status: "planned" })], search: "?show=closed" });
    expect(await screen.findByText("No epic is done or cancelled yet.")).toBeTruthy();
  });
});

describe("ruling 503(e): New epic, for manage-epics", () => {
  it("is offered to someone who may manage epics, and to nobody else", async () => {
    renderEpics({ epics: [epic()], canManage: true });
    fireEvent.click(await screen.findByRole("button", { name: "New epic" }));
    const dialog = await screen.findByRole("dialog", { name: "New epic" });
    expect(dialog.getAttribute("data-screen-label")).toBe("New epic dialog");
    cleanup();
    renderEpics({ epics: [epic()], canManage: false });
    await screen.findByRole("list", { name: "Open epics" });
    // CANARY: drop the `canManage &&` guard on the head's New epic button and
    // a viewer is offered a create the server refuses.
    expect(screen.queryByRole("button", { name: "New epic" })).toBeNull();
  });

  it("posts create-epic from the dialog and opens the epic it made", async () => {
    const posted: Record<string, string>[] = [];
    renderEpics({
      epics: [epic()],
      action: async ({ request }) => {
        const fd = await request.formData();
        const row: Record<string, string> = {};
        for (const [k, v] of fd.entries()) if (!(v instanceof File)) row[k] = v;
        posted.push(row);
        return { ok: true, epicId: "epic-7", toast: "Created epic-7 (Launch)." };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "New epic" }));
    const dialog = await screen.findByRole("dialog", { name: "New epic" });
    fireEvent.change(within(dialog).getByLabelText(/Name/), { target: { value: "Launch" } });
    fireEvent.change(within(dialog).getByLabelText("Lead"), { target: { value: "u_selin" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create epic" }));
    // CANARY: drop the `navigate` from useCreateEpic's result handler and the
    // page stays on the list after the epic is made.
    expect(await screen.findByText("Epic page for epic-7")).toBeTruthy();
    expect(posted).toEqual([
      {
        _csrf: "tok",
        intent: "create-epic",
        title: "Launch",
        description: "",
        status: "planned",
        leadUserId: "u_selin",
        startDate: "",
        targetDate: "",
      },
    ]);
  });
});

describe("ruling 696(c): each opening of New epic is a create of its own", () => {
  /** Opens New epic, names the epic and presses Create epic. */
  async function create(title: string): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole("button", { name: "New epic" }));
    const dialog = await screen.findByRole("dialog", { name: "New epic" });
    fireEvent.change(within(dialog).getByLabelText(/Name/), { target: { value: title } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create epic" }));
    return dialog;
  }

  it("drops the answer to a create cancelled while it posted, and the next opening makes its own epic", async () => {
    const posted: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { rootLoads } = renderEpics({
      epics: [epic()],
      action: async ({ request }) => {
        const title = String((await request.formData()).get("title"));
        posted.push(title);
        const id = `epic-${6 + posted.length}`;
        // The first create answers only once its dialog has been cancelled.
        if (posted.length === 1) await held;
        return { ok: true, epicId: id, toast: `Created ${id} (${title}).` };
      },
    });
    const first = await create("Launch");
    await waitFor(() => expect(posted).toEqual(["Launch"]));
    fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "New epic" })).toBeNull();
    release();
    // The answer has landed once the list has reloaded for it.
    await waitFor(() => expect(rootLoads()).toBe(2));
    // CANARY: key useCreateEpic's fetcher by a constant instead of the opening
    // (or drop the key) and a cancelled create still opens its epic: the page
    // leaves for epic-7, and the next opening, handed that made answer, posts
    // nothing.
    await create("Beta");
    expect(await screen.findByText("Epic page for epic-8")).toBeTruthy();
    expect(posted).toEqual(["Launch", "Beta"]);
  });

  it("opens again with the foot's own sentence, not the last opening's refusal", async () => {
    renderEpics({ epics: [epic()], action: async () => ({ ok: false, error: "No such lead." }) });
    const refused = await create("Launch");
    // The refusal stays in the dialog's foot, beside the form it refuses.
    expect((await within(refused).findByRole("alert")).textContent).toBe("No such lead.");
    fireEvent.click(within(refused).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "New epic" }));
    const again = await screen.findByRole("dialog", { name: "New epic" });
    // CANARY: key useCreateEpic's fetcher by a constant instead of the opening
    // (or drop the key) and a reopened dialog shows the old refusal.
    expect(within(again).queryByRole("alert")).toBeNull();
    expect(within(again).getByText("The epic id is assigned automatically.")).toBeTruthy();
  });
});

describe("ruling 503(e): the empty Epics page", () => {
  it("says there are no epics yet, and offers New epic to who may create one", async () => {
    renderEpics({ epics: [], canManage: true });
    // CANARY: drop the `epics.length === 0` empty state from EpicsPage and a
    // project with no epics shows a bare panel that explains nothing.
    const hero = (await screen.findByRole("heading", { name: "No epics yet" })).closest<HTMLElement>(
      "[data-screen-label]",
    );
    expect(hero?.getAttribute("data-screen-label")).toBe("Empty state");
    expect(hero?.textContent).toContain("Create one here, or ask the controller to plan one.");
    expect(hero && within(hero).getByRole("button", { name: "New epic" })).toBeTruthy();
    // Ruling 625: said once and offered once. CANARY: put the head's "No epics
    // yet" back, or drop `epics.length > 0` from the head's New epic button,
    // and the page says it twice and offers two primary buttons.
    expect(headCount()).toBe("");
    expect(screen.getAllByRole("button", { name: "New epic" })).toHaveLength(1);
    // No views to pick between when there is nothing to show.
    expect(screen.queryByRole("group", { name: "Which epics" })).toBeNull();
  });

  it("tells someone who may not create one who can, and offers no button", async () => {
    renderEpics({ epics: [], canManage: false });
    const hero = (await screen.findByRole("heading", { name: "No epics yet" })).closest<HTMLElement>(
      "[data-screen-label]",
    );
    expect(hero?.textContent).toContain("A contributor or a maintainer can create one.");
    // CANARY: drop the `canManage &&` around the empty state's New epic button
    // and a viewer is offered a create the server refuses.
    expect(screen.queryByRole("button", { name: "New epic" })).toBeNull();
    expect(document.querySelector('[data-screen-label="Epics"]')).not.toBeNull();
  });
});
