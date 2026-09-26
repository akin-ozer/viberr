// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRoutesStub, useLocation, useParams, type ActionFunction } from "react-router";
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
 * `manage-epics`.
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
  return { total: 0, done: 0, started: 0, notStarted: 0, held: 0, archived: 0, byStage: [], ...patch };
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
  opts: { epics?: EpicSummary[]; canManage?: boolean; search?: string; action?: ActionFunction } = {},
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
        />
        <SearchProbe />
      </ToastProvider>
    ),
  };
  if (opts.action) page.action = opts.action;
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      loader: () => ({ csrf: "tok", theme: "system" }),
      children: [page, { path: "projects/:slug/epics/:epicId", Component: EpicStandIn }],
    },
  ]);
  return render(<Stub initialEntries={[`/projects/viberr-core/epics${opts.search ?? ""}`]} />);
}

/** The head's count line ("5 epics · 3 open"). The toast host is a status
 *  region too, so the head's is read from under the page heading. */
function headCount(): string | null {
  const head = screen.getByRole("heading", { name: "Epics", level: 1 }).parentElement;
  return head ? within(head).getByRole("status").textContent : null;
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
    const row = await screen.findByRole("link", { name: /Checkout revamp/ });
    expect(row.getAttribute("href")).toBe("/projects/viberr-core/epics/epic-3");
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
    const shipped = await screen.findByRole("link", { name: /Shipped/ });
    // CANARY: drop `isEpicOpen(epic.status)` from the row's target date and
    // the done epic still reads "due Oct 15".
    expect(within(shipped).queryByText(/due/)).toBeNull();
    expect(within(screen.getByRole("link", { name: /Only archived/ })).getByText("No open tasks · 2 archived")).toBeTruthy();
    const empty = screen.getByRole("link", { name: /Nothing yet/ });
    expect(within(empty).getByText("No tasks yet")).toBeTruthy();
    expect(within(empty).queryByTitle(/Led by/)).toBeNull();
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
    // CANARY: drop `onCreated` from EpicsPage's dialog and the page stays on
    // the list after the epic is made.
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
    expect(headCount()).toBe("No epics yet");
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
