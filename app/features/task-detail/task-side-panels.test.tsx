// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createRoutesStub, useLoaderData } from "react-router";
import type { TaskDetail } from "~/server/projections/task-query.server";
import { ToastProvider } from "~/ui/toast";
import { toISODate } from "~/ui/iso-date";
import type { DependencyCandidatesView } from "~/routes/task-dependency-candidates";
import { CurrentStatePanel } from "./task-side-panels";
import { TaskDetailsPanel } from "./task-details-panel";
import type { EpicOption } from "~/ui/epic-chip";
import { Icon, type IconName } from "~/ui/icon";
import { acceptanceAffordance, taskDetail } from "../../../test-support/task-detail";

/**
 * Pass-19 gap 10 — the task page showed stage, readiness, validation, owner and
 * repo, and nowhere in the app could a supervisor find out WHEN anything last
 * happened on a task. `TaskSummary.updatedAt` was projected and read by nothing
 * at task level, and it would have been the wrong answer anyway (see the essay
 * in app/server/projections/task-activity.server.ts).
 */

afterEach(cleanup);

const ACCEPTANCE = acceptanceAffordance({ hasAuthority: false, atBoundary: false, canAccept: false });

function detail(patch: Partial<TaskDetail> = {}): TaskDetail {
  return taskDetail({
    goal: "Keep the timeline readable.",
    // The file-write stamp is deliberately FRESH in every fixture here: it is
    // the value the panel must NOT be reading.
    updatedAt: new Date().toISOString(),
    ...patch,
  });
}

function renderPanel(patch: Partial<TaskDetail> = {}, myRole = "viewer") {
  const task = detail(patch);
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <CurrentStatePanel
          task={task}
          stage={task.stages[1]}
          meId="u-arda"
          myRole={myRole}
          archived={task.archived === true}
          acceptance={ACCEPTANCE}
          ownerBusy={false}
          onOwner={() => {}}
          onRelease={() => {}}
          onArchive={() => {}}
          onAccept={() => {}}
          onTransition={() => {}}
          transitionBusy={false}
          acceptInFlight={null}
          dispositionBusy={false}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

/** Same panel, as a CONTRIBUTOR (the tier that may take the owner seat) — or
 *  any role passed in. */
function renderAsContributor(patch: Partial<TaskDetail> = {}, myRole = "contributor") {
  return renderPanel(patch, myRole);
}

/**
 * Ruling 137 — the owner seat is also the RUN PRINCIPAL: every agent run on a
 * task bills the owner's own Claude and Codex accounts. The Current-state row
 * is where a person sees and releases that seat, so it is where the widened
 * meaning has to be stated; the run controls in the execution profile then
 * name the owner when a backend of theirs is not connected.
 */
describe("the owner row states what the seat now means (ruling 137)", () => {
  it("names the acceptance authority AND whose accounts the agents run on", () => {
    const { container } = renderPanel({
      owner: {
        kind: "human",
        userId: "u-arda",
        name: "Arda Kaya",
        initials: "AK",
        tone: "",
      },
    });
    const seat = container.querySelector(".rev-stack")!;
    expect(seat.getAttribute("title")).toBe(
      "Human owner: reviews and accepts this task, and its agent runs use their own Claude and Codex accounts",
    );
  });
});

describe("owner seat on closed and archived tasks (D32-16 / E32-9)", () => {
  it("offers Assign me on an open unowned task, withholds it once closed or archived", () => {
    const open = renderAsContributor({ owner: null });
    expect(open.queryByText("Assign me")).not.toBeNull();
    open.unmount();
    // Canary: drop `!closed` from the owner cell and the accepted task offers it.
    const accepted = renderAsContributor({ owner: null, displayReadiness: "accepted" });
    expect(accepted.queryByText("Assign me")).toBeNull();
    accepted.unmount();
    const merged = renderAsContributor({ owner: null, displayReadiness: "merged" });
    expect(merged.queryByText("Assign me")).toBeNull();
    merged.unmount();
    const archived = renderAsContributor({ owner: null, archived: true });
    expect(archived.queryByText("Assign me")).toBeNull();
  });

  it("ruling 50: an ADMIN may still take a closed seat for the record, never an archived one", () => {
    const closedAsAdmin = renderAsContributor({ owner: null, displayReadiness: "accepted" }, "admin");
    expect(closedAsAdmin.queryByText("Assign me")).not.toBeNull();
    closedAsAdmin.unmount();
    const archivedAsAdmin = renderAsContributor({ owner: null, archived: true }, "admin");
    expect(archivedAsAdmin.queryByText("Assign me")).toBeNull();
  });
});

/** The kv-row value for a given label. */
function kv(container: HTMLElement, label: string): string {
  const row = [...container.querySelectorAll(".kv-row")].find(
    (r) => r.querySelector(".k")?.textContent === label,
  );
  if (!row) throw new Error(`no "${label}" row in the Current state panel`);
  return row.querySelector(".v")!.textContent!.trim();
}

describe("gap-10: Current state shows when anything last happened", () => {
  it("renders a Last activity row from the newest timeline stamp", () => {
    const { container } = renderPanel({
      lastActivityAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    });
    // LocalRelative fills in after hydration; the row exists and is not blank.
    expect(kv(container, "Last activity")).toMatch(/ago|yesterday|just now/);
  });

  it("adds the quiet note only once the task has crossed its threshold", () => {
    const at = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    const quiet = renderPanel({ lastActivityAt: at, quiet: true });
    expect(quiet.container.textContent).toContain("No activity");
    // Stated as the two facts the detector actually has.
    expect(quiet.container.textContent).toContain("no run is in flight");
    cleanup();

    const moving = renderPanel({ lastActivityAt: at, quiet: false });
    // Same stamp on screen, no cue — the threshold, not the timestamp, is what
    // makes it a signal.
    expect(moving.container.textContent).not.toContain("No activity");
    expect(kv(moving.container, "Last activity")).toMatch(
      /ago|yesterday|just now/,
    );
  });
});

function renderDetails(
  patch: Partial<TaskDetail>,
  canEdit: boolean,
  queuedQuestions: { id: string; profileId: string; decidedByLabel: string }[] = [],
) {
  const task = detail(patch);
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <TaskDetailsPanel
            task={task}
            canEdit={canEdit}
            queuedQuestions={queuedQuestions}
          />
        </ToastProvider>
      ),
      action: async () => ({ ok: true }),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("ruling 55: the Current-state Waiting-on row names the other work", () => {
  it("reads 'Other work: …' while waiting is none and the list is non-empty; 'Nothing' otherwise", () => {
    // Canary: drop the `blockedBy` arm and the row reads "Nothing".
    const { container } = renderPanel({
      waiting: "none",
      blockedBy: [
        { ref: "JC-2", label: "JC-2", state: "open", taskKey: "JC-2" },
        { ref: "JC-3", label: "JC-3", state: "done", taskKey: "JC-3" },
      ],
    });
    // Ruling 58: JC-3 is done in the fixture, and reads as done (CANARY:
    // print the bare labels again).
    expect(kv(container, "Waiting on")).toBe("Other work: JC-2 and JC-3 (done)");
    const row = [...container.querySelectorAll(".kv-row")].find((r) => r.querySelector(".k")?.textContent === "Waiting on")!;
    expect(row.querySelector(".v span")?.getAttribute("title")).toBe("JC-2 · open · JC-3 · done");
    // A human still owed something wins over the wait.
    const { container: human } = renderPanel({ waiting: "human", blockedBy: [{ ref: "JC-3", label: "JC-3", state: "open", taskKey: "JC-3" }] });
    expect(kv(human, "Waiting on")).toBe("a human");
    const { container: none } = renderPanel({ waiting: "none" });
    expect(kv(none, "Waiting on")).toBe("Nothing");
  });
});

/** The Details panel, capturing every form it posts. `candidates` is what the
 *  Blocked by picker's read answers (ruling 59). */
function renderCapturing(
  patch: Partial<TaskDetail>,
  canEdit: boolean,
  candidates: DependencyCandidatesView = { ok: true, tasks: [] },
) {
  const task = detail(patch);
  const posted: Record<string, string>[] = [];
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <TaskDetailsPanel
            task={task}
            canEdit={canEdit}
            labelSuggestions={["qa", "codex"]}
            dependencyCandidatesUrl="/projects/viberr-core/tasks/VIB-151/dependency-candidates"
          />
        </ToastProvider>
      ),
      action: async ({ request }) => {
        const fd = await request.formData();
        posted.push(Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)])));
        return { ok: true };
      },
    },
    { path: "/projects/:slug/tasks/:key/dependency-candidates", loader: () => candidates },
  ]);
  return { ...render(<Stub initialEntries={["/"]} />), posted };
}

/** A property's trigger: named by its row's label and its value. */
const trigger = (view: { getByRole: ReturnType<typeof render>["getByRole"] }, label: string) =>
  view.getByRole("button", { name: new RegExp(`^${label} `) });

describe("ruling 55: the Details panel's Blocked by row and its own form", () => {
  const entries = [
    { ref: "JC-3", label: "JC-3", state: "done" as const, taskKey: "JC-3" },
    { ref: "JC-6", label: "JC-6", state: "failed" as const, taskKey: "JC-6" },
    { ref: "JC-7", label: "JC-7", state: "open" as const, taskKey: "JC-7" },
  ];

  it("reads the wait as a kv row with each entry's state, and its status ring", () => {
    const { container } = renderCapturing({ blockedBy: entries }, false);
    expect(kv(container, "Blocked by")).toBe("JC-3 · doneJC-6 · archivedJC-7");
    // Ruling 309: a viewer's chips carry no cross. CANARY: hand the row its
    // crosses without the edit grant.
    expect(container.querySelectorAll("button")).toHaveLength(0);
    // Ruling 309: each entry is a chip carrying its state for the sheet's ring.
    // CANARY: drop `data-wait-state` and the done and dead rings lose their tone.
    const chips = [...container.querySelectorAll(".wait-chip")];
    expect(chips.map((c) => c.getAttribute("data-wait-state"))).toEqual(["done", "failed", "open"]);
    expect(chips.every((c) => c.querySelector("svg.ico"))).toBe(true);
    const { container: bare } = renderCapturing({}, false);
    expect(kv(bare, "Blocked by")).toBe("Nothing");
  });

  it("an archived task offers no dependency editor", () => {
    const { queryByRole } = renderCapturing({ blockedBy: entries, archived: true }, true);
    expect(queryByRole("button", { name: /^Blocked by/ })).toBeNull();
    expect(queryByRole("button", { name: /^Remove / })).toBeNull();
  });
});

/**
 * Ruling 59: the wait's editor works the way the Owner row releases its
 * owner. Each entry is the row's chip with a remove cross, the field finds the
 * project's tasks from the picker's own read, and Save still posts the FULL
 * list through the wait's own form and intent (ruling 55). Which tasks the
 * read bars, and why, is the read model's suite.
 */
describe("ruling 59: the Blocked by editor finds tasks and takes entries out by their cross", () => {
  const entries = [
    { ref: "JC-3", label: "JC-3", state: "done" as const, taskKey: "JC-3" },
    { ref: "JC-6", label: "JC-6", state: "failed" as const, taskKey: "JC-6" },
    { ref: "JC-7", label: "JC-7", state: "open" as const, taskKey: "JC-7" },
  ];
  const CANDIDATES: DependencyCandidatesView = {
    ok: true,
    tasks: [
      { key: "JC-90", title: "Refund flow", stage: "Review", bar: null },
      { key: "JC-80", title: "Invoice export", stage: "Review", bar: null },
      { key: "JC-12", title: "Pricing table", stage: "Review", bar: null },
      { key: "JC-9", title: "Search index", stage: "Triage", bar: null },
      { key: "JC-8", title: "Checkout flow", stage: "Done", bar: "done" },
      { key: "JC-6", title: "Old importer", stage: "Triage", bar: "archived" },
      { key: "JC-5", title: "Search facets", stage: "Triage", bar: "cycle", chain: ["VIB-151", "JC-5", "VIB-151"] },
      { key: "JC-3", title: "Login form", stage: "Done", bar: "done" },
    ],
  };

  /** The editor, opened: its dialog and its field, once the picker's chunk
   *  is in. */
  async function openEditor(view: ReturnType<typeof renderCapturing>) {
    fireEvent.click(trigger(view, "Blocked by"));
    const dialog = view.getByRole("dialog", { name: "Blocked by" });
    return { dialog, field: await within(dialog).findByRole("combobox", { name: "What this task waits on" }) };
  }
  const chips = (dialog: HTMLElement) => [...dialog.querySelectorAll(".wait-chip")].map((c) => c.textContent);
  const options = (dialog: HTMLElement) =>
    within(dialog).queryAllByRole("option").map((o) => o.textContent);

  it("posts the full list once a cross takes an entry out and a picked task joins it", async () => {
    // CANARY: drop the picker's focus as it mounts and the editor opens on
    // Cancel; drop the note and the archived JC-6 is refused only after Save;
    // bar the done JC-3 the wait holds and, taken out, it cannot go back in
    // although the writer would keep it; drop the hidden list and Save posts
    // no wait at all.
    const view = renderCapturing({ blockedBy: entries }, true, CANDIDATES);
    const { dialog, field } = await openEditor(view);
    // The picker takes the focus in an effect as it mounts, which a loaded
    // suite runs after `findByRole` has returned.
    await waitFor(() => expect(document.activeElement).toBe(field));
    // Archived JC-6 is refused on every Save while it is listed (ruling 59).
    expect(within(dialog).getByText("JC-6 can never complete: take it out to save.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove JC-6" }));
    expect(within(dialog).queryByText(/can never complete/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove JC-3" }));
    fireEvent.mouseDown(await within(dialog).findByRole("option", { name: /^JC-3 / }));
    fireEvent.mouseDown(within(dialog).getByRole("option", { name: /^JC-12 / }));
    expect(chips(dialog)).toEqual(["JC-7", "JC-3 · done", "JC-12"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(view.posted).toHaveLength(1));
    expect(view.posted[0]).toMatchObject({ intent: "set-task-dependencies", blockedBy: "JC-7, JC-3, JC-12" });
    expect(Object.keys(view.posted[0]!).sort()).toEqual(["_csrf", "blockedBy", "intent"]);
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  it("finds tasks by key or title, lists a barred one only once typed, and adds none the writer would refuse", async () => {
    // CANARY: offer the barred tasks with nothing typed and JC-8 and JC-5 join
    // the first list; drop the bar check from the pick and JC-5 goes in; list
    // the free matches before the key typed and Enter on "jc-8" adds JC-80;
    // highlight a match for a key already listed and Enter adds JC-90.
    const view = renderCapturing({}, true, CANDIDATES);
    const { dialog, field } = await openEditor(view);
    const status = within(dialog).getByRole("status");
    await waitFor(() =>
      expect(options(dialog)).toEqual([
        "JC-90 Refund flow Review",
        "JC-80 Invoice export Review",
        "JC-12 Pricing table Review",
        "JC-9 Search index Triage",
      ]),
    );
    fireEvent.change(field, { target: { value: "search" } });
    expect(options(dialog)).toEqual(["JC-9 Search index Triage", "JC-5 Search facets waits on VIB-151"]);
    const barred = within(dialog).getByRole("option", { name: /^JC-5 / });
    expect(barred.getAttribute("aria-disabled")).toBe("true");
    fireEvent.mouseDown(barred);
    expect(chips(dialog)).toEqual([]);
    // The writer's own sentence (the read carries the cycle it would close).
    expect(status.textContent).toBe("Waiting on JC-5 would close a cycle: VIB-151 waits on JC-5 waits on VIB-151.");
    // A key typed in full is that task, barred or not, never the next match.
    fireEvent.change(field, { target: { value: "jc-8" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(chips(dialog)).toEqual([]);
    expect(status.textContent).toBe("JC-8 is already done, so waiting on it holds nothing. Leave it off the list.");
    // Enter adds the best match of what is typed.
    fireEvent.change(field, { target: { value: "jc-9" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(chips(dialog)).toEqual(["JC-9"]);
    // Typed again, the key already listed highlights nothing.
    fireEvent.change(field, { target: { value: "jc-9" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(chips(dialog)).toEqual(["JC-9"]);
    expect(status.textContent).toBe("JC-9 is already on the list.");
    // A pasted list goes in key by key; a key the writer refuses stays typed.
    fireEvent.change(field, { target: { value: "JC-12, JC-8, " } });
    expect(chips(dialog)).toEqual(["JC-9", "JC-12"]);
    expect(field).toHaveProperty("value", "JC-8, ");
  });

  it("takes the last entry out on Backspace, posts nothing for an unchanged Save, and an empty list for a cleared one", async () => {
    // CANARY: drop the unchanged check and the first Save posts a no-op; keep
    // the pointer's highlight once it leaves the list and the Enter below adds
    // JC-12 instead of saving.
    const view = renderCapturing({ blockedBy: [entries[2]!] }, true, CANDIDATES);
    fireEvent.click(within((await openEditor(view)).dialog).getByRole("button", { name: "Save" }));
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.posted).toHaveLength(0);
    const { dialog, field } = await openEditor(view);
    fireEvent.mouseMove(await within(dialog).findByRole("option", { name: /^JC-12 / }));
    fireEvent.mouseLeave(within(dialog).getByRole("listbox"));
    fireEvent.keyDown(field, { key: "Enter" });
    expect(chips(dialog)).toEqual(["JC-7"]);
    fireEvent.keyDown(field, { key: "Backspace" });
    expect(chips(dialog)).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(view.posted).toHaveLength(1));
    // Ruling 57: an empty list clears the wait, which for a person IS the release.
    expect(view.posted[0]).toMatchObject({ intent: "set-task-dependencies", blockedBy: "" });
  });

  it("takes a key typed in full when the project's tasks cannot be loaded, and leaves it to Save to check", async () => {
    // CANARY: refuse every key while the list is missing and the wait can
    // only be cleared, never edited, until the read comes back.
    const view = renderCapturing({}, true, { ok: false, reason: "The project's tasks could not be loaded." });
    const { dialog, field } = await openEditor(view);
    await within(dialog).findByText(/could not be loaded\. A key typed in full still goes in/);
    fireEvent.change(field, { target: { value: "jc-40" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(chips(dialog)).toEqual(["JC-40"]);
  });
});

describe("TaskDetailsPanel", () => {
  it("reads the metadata as kv rows, matching the side-panel style", () => {
    // A due date in the FUTURE relative to now, so the row always reads "due …"
    // (a hardcoded past date rots into "overdue · …" once that day passes).
    const future = new Date(Date.now() + 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const { container } = renderDetails(
      { priority: "high", labels: ["qa", "codex"], dueDate: future },
      false,
    );
    // Panel head + the three rows.
    expect(container.querySelector(".panel-head h2")?.textContent).toBe("Details");
    expect(kv(container, "Priority")).toContain("high");
    expect(kv(container, "Labels")).toContain("qa");
    expect(kv(container, "Labels")).toContain("codex");
    // "due <Mon> <day>", never the "overdue · …" a past date would render.
    expect(kv(container, "Due date")).toMatch(/^due /);
  });

  /**
   * Ruling 66 (F37-68): a question the hold refused is put when the hold
   * lifts, and the wait has to say so. Without this the only trace is one
   * timeline note, and a promise a person made and cannot see is the defect
   * this pass kept finding.
   */
  it("names the queued question under the wait, by the reviewer's NAME", () => {
    const { container } = renderDetails(
      {
        blockedBy: [{ ref: "VIB-9", label: "VIB-9", state: "open", taskKey: "VIB-9" }],
        reviewers: [
          {
            kind: "agent",
            profileId: "rev",
            backend: "codex",
            name: "Codex",
            role: "Code review",
            profileName: "Integration Verifier",
          },
        ],
      },
      false,
      [{ id: "qq_1", profileId: "rev", decidedByLabel: "Arda" }],
    );
    // Ruling 70: a handle is a NAME. CANARY: fall back to `q.profileId` first
    // and this reads "rev", which names nobody a person can search for.
    expect(kv(container, "When it clears")).toContain("Integration Verifier");
    expect(kv(container, "When it clears")).toContain("Arda");
    expect(kv(container, "When it clears")).toContain("before the operator gets the task back");
  });

  it("says nothing about queued questions when there are none", () => {
    // CANARY: render the row unconditionally and every task grows a "When it
    // clears" line about a question nobody asked for.
    const { container } = renderDetails({}, false);
    expect(container.querySelector("[data-queued-questions]")).toBeNull();
  });

  it("shows 'Normal / None / None / None' for a bare task, quietly", () => {
    const { container } = renderDetails({}, false);
    expect(kv(container, "Priority")).toContain("Normal");
    expect(kv(container, "Labels")).toContain("None");
    expect(kv(container, "Epic")).toBe("None");
    expect(kv(container, "Due date")).toContain("None");
    // Ruling 309: an empty value is the quiet line, never the bold fact the
    // owner's screenshot showed four times. CANARY: print them bare in `.v`.
    // Ruling 325's Epic row is the fifth.
    expect(container.querySelectorAll(".kv-row .prop-empty")).toHaveLength(5);
  });
});

/**
 * Ruling 325: the Details panel's Epic row. A viewer reads the epic as a
 * chip that opens its page; an editor gets a menu of "No epic" and the open
 * epics (the current one kept even when closed), and a pick posts the one
 * field.
 */
describe("ruling 325: the Details panel's Epic row", () => {
  const EPICS: EpicOption[] = [
    { id: "epic-1", title: "Checkout revamp", color: "teal", status: "in_progress" },
    { id: "epic-2", title: "Search", color: "violet", status: "done" },
    { id: "epic-3", title: "Onboarding", color: "amber", status: "planned" },
  ];

  function renderEpicRow(epicId: string | null, canEdit: boolean, epics: EpicOption[] = EPICS) {
    const task = detail({ epicId });
    const posted: Record<string, string>[] = [];
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <ToastProvider>
            <TaskDetailsPanel task={task} canEdit={canEdit} epics={epics} />
          </ToastProvider>
        ),
        action: async ({ request }) => {
          const fd = await request.formData();
          posted.push(Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)])));
          return { ok: true };
        },
      },
    ]);
    return { ...render(<Stub initialEntries={["/"]} />), posted };
  }

  it("a viewer reads the epic as a chip linking to its page", () => {
    // CANARY: render the viewer's chip without `to`.
    const { container } = renderEpicRow("epic-1", false);
    const row = [...container.querySelectorAll(".kv-row")].find((r) => r.querySelector(".k")?.textContent === "Epic")!;
    const chip = row.querySelector<HTMLAnchorElement>("a.epic-chip")!;
    expect(chip.getAttribute("href")).toBe("/projects/viberr-core/epics/epic-1");
    expect(chip.textContent).toBe("Epic Checkout revamp");
    expect(row.querySelector("button")).toBeNull();
  });

  it("an editor's button is named once: the row's label, then the epic", () => {
    // CANARY: drop `inLabelledControl` from the editor's chip, and the button
    // reads "Epic Epic Checkout revamp" (the row's label, then the chip's own
    // spoken prefix). Found by the browser pass: the e2e spec asked for it.
    const view = renderEpicRow("epic-1", true);
    expect(view.getByRole("button", { name: "Epic Checkout revamp" })).toBeTruthy();
  });

  it("an editor's menu offers No epic first, then the open epics and the current closed one", async () => {
    // CANARY: offer every epic, closed ones included, or drop the current one when it is closed.
    const view = renderEpicRow("epic-2", true);
    fireEvent.click(trigger(view, "Epic"));
    const items = await waitFor(() => {
      const found = [...view.container.querySelectorAll<HTMLButtonElement>('.epic-menu [role="menuitemradio"]')];
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(items.map((b) => b.textContent)).toEqual([
      "No epic",
      "Checkout revamp",
      "Search · Done",
      "Onboarding",
    ]);
    expect(items.filter((b) => b.getAttribute("aria-checked") === "true").map((b) => b.dataset.epic)).toEqual(["epic-2"]);
    fireEvent.click(items[1]!);
    await waitFor(() => expect(view.posted).toHaveLength(1));
    expect(view.posted[0]).toMatchObject({ intent: "set-task-epic", epic: "epic-1" });
  });

  it("No epic posts an empty epic, and a task in none invites Add to epic", async () => {
    const view = renderEpicRow("epic-1", true);
    fireEvent.click(trigger(view, "Epic"));
    const none = await view.findByRole("menuitemradio", { name: "No epic" });
    fireEvent.click(none);
    await waitFor(() => expect(view.posted).toHaveLength(1));
    expect(view.posted[0]).toMatchObject({ intent: "set-task-epic", epic: "" });
    cleanup();
    const bare = renderEpicRow(null, true);
    expect(kv(bare.container, "Epic")).toBe("Add to epic");
  });

  it("a project with no open epic offers no menu, only the text", () => {
    const closed: EpicOption[] = [{ id: "epic-2", title: "Search", color: "violet", status: "done" }];
    const view = renderEpicRow(null, true, closed);
    expect(view.queryByRole("button", { name: /^Epic / })).toBeNull();
    expect(kv(view.container, "Epic")).toBe("None");
  });
});

/**
 * Ruling 309 (the owner's follow-up, "add the × on the row chips too"): for an
 * editor the Blocked by row's own chips carry the Owner row's cross. A press
 * saves the wait without that entry at once, through the wait's own intent,
 * and the trigger is the plus after the chips. A cross that leaves nothing
 * still open releases the task (ruling 59), so that one asks first, as the
 * Owner row's cross does.
 */
describe("ruling 309: the Blocked by row's chips carry the remove cross", () => {
  const entry = (ref: string, state: "open" | "done" | "failed") => ({ ref, label: ref, state, taskKey: ref });
  /** The row itself, outside any popover. */
  const row = (container: HTMLElement) => container.querySelector<HTMLElement>('.kv-row[data-prop="deps"]')!;

  it("saves the wait without an entry at once, and ignores the other crosses until that save answers", async () => {
    // CANARY: drop the one-save-at-a-time guard and the second press posts a
    // list that still holds JC-6, the entry the first press took out.
    const view = renderCapturing({ blockedBy: [entry("JC-3", "done"), entry("JC-6", "failed"), entry("JC-7", "open")] }, true);
    const r = within(row(view.container));
    expect(r.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Remove JC-3",
      "Remove JC-6",
      "Remove JC-7",
      "Add dependency",
    ]);
    // The plus after the chips is still the row's trigger, named by its label.
    expect(trigger(view, "Blocked by").textContent).toBe("Add dependency");
    fireEvent.click(r.getByRole("button", { name: "Remove JC-6" }));
    expect(r.getByRole("button", { name: "Remove JC-6" }).getAttribute("aria-busy")).toBe("true");
    fireEvent.click(r.getByRole("button", { name: "Remove JC-7" }));
    await waitFor(() => expect(view.posted).toHaveLength(1));
    expect(view.posted[0]).toMatchObject({ intent: "set-task-dependencies", blockedBy: "JC-3, JC-7" });
    await waitFor(() => expect(r.getByRole("button", { name: "Remove JC-6" }).getAttribute("aria-busy")).toBeNull());
    expect(view.posted).toHaveLength(1);
  });

  it.each([
    ["the last entry", [entry("JC-7", "open")], "", "JC-7 is the last task VIB-151 waits on."],
    ["the last one still open", [entry("JC-3", "done"), entry("JC-7", "open")], "JC-3", "Everything else VIB-151 waits on is done."],
  ])("asks before a cross takes out %s, and Keep the wait posts nothing", async (_, blockedBy, posted, lead) => {
    // CANARY: confirm only an emptied list and the second row releases VIB-151
    // (the engine's next sweep) without a word.
    const view = renderCapturing({ blockedBy }, true);
    const cross = within(row(view.container)).getByRole("button", { name: "Remove JC-7" });
    fireEvent.click(cross);
    const dialog = view.getByRole("alertdialog", { name: "Release VIB-151?" });
    expect(dialog.textContent).toContain(
      `${lead} Taking JC-7 off releases VIB-151: it can move again, and Viberr hands it to the operator.`,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep the wait" }));
    await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull());
    expect(view.posted).toHaveLength(0);
    fireEvent.click(cross);
    fireEvent.click(within(view.getByRole("alertdialog")).getByRole("button", { name: "Release VIB-151" }));
    await waitFor(() => expect(view.posted).toHaveLength(1));
    expect(view.posted[0]).toMatchObject({ intent: "set-task-dependencies", blockedBy: posted });
  });

  it("hands the focus to the trigger once the wait comes back without the chip", async () => {
    // CANARY: drop the hand-off and the focus falls to the page when the
    // cross that held it leaves with its chip.
    let blockedBy = [entry("JC-7", "open"), entry("JC-9", "open")];
    const Stub = createRoutesStub([
      {
        path: "/",
        loader: () => ({ blockedBy }),
        Component: function Panel() {
          const data = useLoaderData<{ blockedBy: typeof blockedBy }>();
          return (
            <ToastProvider>
              <TaskDetailsPanel task={detail({ blockedBy: data.blockedBy })} canEdit />
            </ToastProvider>
          );
        },
        action: async ({ request }) => {
          const kept = String((await request.formData()).get("blockedBy")).split(", ");
          blockedBy = blockedBy.filter((e) => kept.includes(e.ref));
          return { ok: true };
        },
      },
    ]);
    const view = render(<Stub initialEntries={["/"]} />);
    const cross = await view.findByRole("button", { name: "Remove JC-7" });
    cross.focus();
    fireEvent.click(cross);
    await waitFor(() => expect(view.queryByRole("button", { name: "Remove JC-7" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger(view, "Blocked by")));
  });
});

/**
 * Ruling 309: the Details panel draws its properties the way Linear's and
 * GitHub's issue sidebars do. Each value is its own control, which edits that
 * one property in a popover and posts only its own field; the "Edit details"
 * and "Edit what it waits on" buttons, and the three-field form, are gone.
 */
describe("ruling 309: each Details property is its own control", () => {
  it("gives a viewer text, and an editor one trigger per property, with the empty ones as invitations", () => {
    // CANARY: render the triggers for a viewer, or bring back the footer buttons.
    const viewer = renderCapturing({}, false);
    expect(viewer.container.querySelectorAll("button")).toHaveLength(0);
    cleanup();
    const editor = renderCapturing({}, true);
    for (const [label, value] of [
      ["Priority", "Normal"],
      ["Labels", "Add labels"],
      ["Due date", "Set due date"],
      ["Blocked by", "Add dependency"],
    ] as const) {
      const btn = trigger(editor, label);
      expect(btn.getAttribute("aria-expanded"), label).toBe("false");
      expect(kv(editor.container, label), label).toBe(value);
    }
    expect(editor.container.querySelectorAll("button")).toHaveLength(4);
    expect(editor.queryByText(/Edit details|Edit what it waits on/)).toBeNull();
  });

  it("sets the priority from a menu, posting that field alone", async () => {
    // CANARY: post the whole metadata triple again, and `labels` rides along.
    const view = renderCapturing({ labels: ["qa"] }, true);
    fireEvent.click(trigger(view, "Priority"));
    const menu = view.getByRole("menu");
    const items = within(menu).getAllByRole("menuitemradio");
    // Most urgent first; the current one checked, and focused as it opens.
    expect(items.map((i) => i.textContent)).toEqual(["Urgent", "High", "Normal", "Low"]);
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false"]);
    expect(document.activeElement).toBe(items[2]);
    // Arrow keys rove the menu.
    fireEvent.keyDown(items[2]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[1]);
    // Picking the current priority closes it and posts nothing.
    fireEvent.click(items[2]!);
    expect(view.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger(view, "Priority"));
    fireEvent.click(within(view.getByRole("menu")).getByRole("menuitemradio", { name: "High" }));
    expect(view.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(view.posted).toHaveLength(1));
    expect(view.posted[0]).toMatchObject({ intent: "set-task-metadata", priority: "high" });
    expect(Object.keys(view.posted[0]!).sort()).toEqual(["_csrf", "intent", "priority"]);
  });

  it("closes on Escape and hands focus back to the trigger", () => {
    const view = renderCapturing({}, true);
    const btn = trigger(view, "Priority");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(view.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it("edits the labels in their own popover, posting the labels alone, and a Save with no change posts nothing", async () => {
    // CANARY: drop the unchanged check and the first Save posts a no-op.
    const view = renderCapturing({ labels: ["qa"], priority: "high" }, true);
    fireEvent.click(trigger(view, "Labels"));
    const dialog = view.getByRole("dialog", { name: "Labels" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(view.queryByRole("dialog")).toBeNull();
    expect(view.posted).toHaveLength(0);
    fireEvent.click(trigger(view, "Labels"));
    const field = within(view.getByRole("dialog", { name: "Labels" })).getByLabelText(/Add a label/);
    fireEvent.change(field, { target: { value: "codex" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.click(within(view.getByRole("dialog", { name: "Labels" })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(view.posted).toHaveLength(1));
    expect(view.posted[0]).toMatchObject({ intent: "set-task-metadata", labels: "qa,codex" });
    expect(view.posted[0]!.priority).toBeUndefined();
    expect(view.posted[0]!.dueDate).toBeUndefined();
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  it("picks the due date on a calendar and clears it from there, posting the date alone", async () => {
    const view = renderCapturing({}, true);
    fireEvent.click(trigger(view, "Due date"));
    const dialog = view.getByRole("dialog", { name: "Due date" });
    const now = new Date();
    const iso = toISODate(new Date(now.getFullYear(), now.getMonth(), 15));
    fireEvent.click(dialog.querySelector<HTMLButtonElement>(`button[data-iso="${iso}"]`)!);
    expect(view.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(view.posted).toHaveLength(1));
    expect(Object.keys(view.posted[0]!).sort()).toEqual(["_csrf", "dueDate", "intent"]);
    expect(view.posted[0]!.dueDate).toBe(iso);
    cleanup();
    const dated = renderCapturing({ dueDate: iso }, true);
    fireEvent.click(trigger(dated, "Due date"));
    fireEvent.click(within(dated.getByRole("dialog", { name: "Due date" })).getByRole("button", { name: /Clear due date/ }));
    await waitFor(() => expect(dated.posted).toHaveLength(1));
    expect(dated.posted[0]).toMatchObject({ intent: "set-task-metadata", dueDate: "" });
  });

  it("an archived task's values are text, with the reason under them", () => {
    const { container, getByText } = renderCapturing({ archived: true, priority: "urgent" }, true);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(getByText("Archived. Restore this task to edit its details.")).toBeTruthy();
    expect(kv(container, "Priority")).toContain("urgent");
  });
});

/** Ruling 63: the rail says a goal edit is owed on a decided edit_goal packet. */
describe("ruling 63: Waiting on · a decided edit_goal packet", () => {
  it("reads 'a goal edit' instead of 'a human'", () => {
    // Canary: remove the `awaiting === "goal_edit"` branch.
    const { container } = renderPanel({
      waiting: "human",
      packet: {
        type: "blocked",
        kind: "Blocked decision",
        from: "Operator",
        title: "Scope needed",
        body: "",
        observations: [],
        options: [{ kind: "edit_goal", t: "Specify the goal", d: "", rec: true }],
        awaiting: "goal_edit",
        decided: { optionIndex: 0, at: "2026-09-04T10:00:00.000Z", byUserId: "u-arda" },
      },
    });
    expect(kv(container, "Waiting on")).toBe("a goal edit");
  });
});

/**
 * Ruling 166: the rail's "Agent queued" says why the run waits from its row. A
 * run that resumes a session still being compacted is parked with the step
 * ruling 175 writes, whatever the cap says: it waits for a summary, not a slot.
 * Which sentence the rows give is the loader's (task-detail-route suite); this
 * is the rail printing it.
 */
describe("ruling 166: Waiting on · a queued run says what it waits for", () => {
  it("titles the queued fact with the loader's reason, never a cap it assumed", () => {
    // CANARY: put the one cap sentence back on the row and a run held for its
    // session's summary reads "Behind the instance's concurrent-run cap".
    const held = "Queued, waiting for the summary of its last run; then it starts when a slot frees.";
    const { container } = renderPanel({ waiting: "agent", liveRun: "queued", liveRunWait: held });
    const fact = container.querySelector(".kv.props .v > .prop-fact")!;
    expect({ words: fact.textContent, title: fact.getAttribute("title") }).toEqual({
      words: "Agent queued",
      title: held,
    });
  });
});

/**
 * Ruling 309(a) — Current state draws the rows the Details panel draws (ruling
 * 309): the labels in one column, every value on one left edge, each led by
 * its mark, and an empty one said quietly. The owner's screenshot had five
 * values set five ways and right-aligned.
 */
describe("ruling 309(a): Current state is a property grid", () => {
  /** What `Icon` draws for a glyph: one mark is told from another by its paths. */
  function glyph(name: IconName): string {
    const { container, unmount } = render(<Icon name={name} />);
    const paths = container.querySelector("svg")!.innerHTML;
    unmount();
    return paths;
  }

  /** A row of the property grid, by its label. */
  function prop(container: HTMLElement, label: string): Element {
    const row = [...container.querySelectorAll(".kv.props .kv-row")].find(
      (r) => r.querySelector(".k")?.textContent === label,
    );
    if (!row) throw new Error(`no "${label}" row on the property grid`);
    return row;
  }

  const WAITS: [string, Partial<TaskDetail>, string, IconName | "pulse"][] = [
    ["a human owes the next move", { waiting: "human" }, "a human", "hand"],
    ["a schedule picks it back up", { waiting: "schedule", resumesAt: null }, "a schedule", "clock"],
    ["its run is queued", { waiting: "agent", liveRun: "queued" }, "Agent queued", "ring"],
    ["an agent is at work", { waiting: "agent", liveRun: "running" }, "Agent work", "pulse"],
    [
      "other work holds it",
      { waiting: "none", blockedBy: [{ ref: "JC-2", label: "JC-2", state: "open", taskKey: "JC-2" }] },
      "Other work: JC-2",
      "ban",
    ],
  ];

  it.each(WAITS)("when %s, Waiting on leads with the board card's mark", (_, patch, words, mark) => {
    // CANARY: draw a queued run with the pulse, or drop a mark, and the card
    // stops speaking the board card's vocabulary (ruling 306).
    const { container } = renderPanel(patch);
    const fact = prop(container, "Waiting on").querySelector(".v > .prop-fact")!;
    expect(fact.textContent).toBe(words);
    const lead = fact.firstElementChild!;
    if (mark === "pulse") expect(lead.className).toBe("working");
    else expect(lead.innerHTML).toBe(glyph(mark));
  });

  it("keeps each held entry's key on one line, the words between them free to wrap", () => {
    // CANARY: print the sentence as one string and Chromium breaks "VIB-151"
    // after its hyphen in the value column.
    const { container } = renderPanel({
      waiting: "none",
      blockedBy: [
        { ref: "JC-2", label: "JC-2", state: "open", taskKey: "JC-2" },
        { ref: "JC-3", label: "JC-3", state: "done", taskKey: "JC-3" },
      ],
    });
    const fact = prop(container, "Waiting on").querySelector(".v > .prop-fact")!;
    expect(fact.textContent).toBe("Other work: JC-2 and JC-3 (done)");
    expect([...fact.querySelectorAll(".hold-ref")].map((r) => r.textContent)).toEqual(["JC-2", "JC-3"]);
  });

  it("says an empty value quietly, and offers Assign me as the invitation Details makes", () => {
    // CANARY: print "Nothing" as the bare value and it takes the row's full
    // ink, the loudest word in the card for the least news.
    const { container } = renderPanel({ waiting: "none", lastActivityAt: null, owner: null });
    for (const [label, words] of [
      ["Waiting on", "Nothing"],
      ["Last activity", "Nothing on the timeline yet"],
      ["Owner", "Unowned"],
    ]) {
      expect(prop(container, label).querySelector(".v > .prop-empty")?.textContent, label).toBe(words);
    }
    cleanup();
    // A contributor may take the seat: a ghost trigger holding the
    // invitation, not a boxed button in a column of text.
    const view = renderAsContributor({ owner: null });
    const assign = view.getByRole("button", { name: "Assign me" });
    expect(assign.className).toBe("prop-btn");
    expect(assign.querySelector(".prop-empty")).not.toBeNull();
  });

  it("leads the repository with the GitHub mark, in the code face", () => {
    // CANARY: put `mono` back on the value itself and `.kv-row .v`'s display
    // face wins: the repository in bold Inter, as the screenshot had it.
    const { container } = renderPanel();
    const fact = prop(container, "Repo").querySelector(".v > .prop-fact")!;
    expect(fact.firstElementChild!.innerHTML).toBe(glyph("github"));
    expect(fact.querySelector(".mono")?.textContent).toBe("akin-ozer/viberr");
  });
});
