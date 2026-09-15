// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub, type ActionFunction } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { ControllerPage, surfaceLabel } from "./controller-page";
import type { ControllerSurfaceView } from "./controller-query.server";
import type { RunView } from "~/features/runtime/runtime-types";

/**
 * Ruling 121 on the full controller page: the project is named, task-anchored
 * threads wear a task chip, and a user message says where it was sent from.
 *
 * Ruling 127 — the controller's unavailable state is about the PERSON reading
 * it, and says where they fix it.
 *
 * The page used to render "Claude backend unavailable" and "The Claude backend
 * is unavailable, so the controller cannot answer" — a deployment outage, told
 * to a person who could do nothing about it and who was, in fact, one sign-in
 * away from a working controller. A turn runs on the ASKER's own Claude
 * account, so the composer now says exactly what the refused turn would record
 * in the transcript (`controllerRefusalNote`), and points at Profile → Agent
 * accounts.
 */

// jsdom's Element carries no `scrollIntoView`; the transcript calls it on mount.
Element.prototype.scrollIntoView = () => {};

afterEach(cleanup);

function view(over: Partial<ControllerSurfaceView> = {}): ControllerSurfaceView {
  return {
    available: true,
    controllerName: "Controller",
    projectName: "Viberr Core",
    viewerId: "u_arda",
    conversations: [
      { id: "cnv_b", title: "Board thread", ownerLabel: "arda@viberr.dev", own: true, lastMessageAt: "2026-09-01T10:00:00.000Z", projectSlug: "viberr-core", taskKey: null },
      { id: "cnv_t", title: "Task thread", ownerLabel: "arda@viberr.dev", own: true, lastMessageAt: "2026-09-01T11:00:00.000Z", projectSlug: "viberr-core", taskKey: "VIB-142" },
    ],
    conversation: null,
    messages: [],
    turn: { working: false, runId: null, phase: null, step: null },
    runtime: [],
    canInterruptTurn: false,
    goals: [],
    viewerOwnsActive: false,
    showingAll: false,
    viewerIsOrgAdmin: true,
    ...over,
  };
}

describe("ruling 131(c): the Goals panel names what a link waits on", () => {
  it("renders 'waits on …' under a link with a declared wait, and nothing under one without", async () => {
    // Canary: remove the `data-link-wait` span.
    const goal: NonNullable<ControllerSurfaceView["goals"]>[number] = {
      id: "goal-2",
      title: "Dependent chain",
      status: "active",
      createdBy: "u_arda",
      createdByLabel: "Arda",
      onFailure: "pause",
      description: "",
      links: [
        { index: 1, title: "Needs base B", goal: "C.", taskKey: "JC-9", status: "active", note: null, redeclared: false, blockedBy: ["goal-1 link 2", "JC-6"] },
        { index: 2, title: "Free", goal: "D.", taskKey: null, status: "pending", note: null, redeclared: false, blockedBy: [] },
      ],
      currentIndex: 1,
      createdAt: null,
      updatedAt: null,
      history: [],
    };
    const { container } = renderPage(view({ goals: [goal] }));
    // The stub's root loader is async: the page renders after it resolves.
    await screen.findByText("waits on goal-1 link 2, JC-6");
    const waits = [...container.querySelectorAll("[data-link-wait]")].map((n) => n.textContent);
    expect(waits).toEqual(["waits on goal-1 link 2, JC-6"]);
  });

  /**
   * Ruling 260 (pass 37, F37-91): the goal-redirect gate is a DISJUNCTION.
   *
   * `requireGoalAuthority` allows the chain's CREATOR or anyone with
   * `run-agents`. The page computed one boolean from the viewer's project ROLE
   * and handed it to every card, so the creator arm was never evaluated —
   * and a contributor can create a chain (`create-task` is A/M/C) but is not
   * `run-agents` (A/M). The repo's own toolkit test proves the server answers
   * yes: a contributor creates goal-1, then pauses it, and both return [done].
   * This panel is the ONLY goal-redirect UI in the product, so the person who
   * started the chain had no Pause, Resume, Cancel, Retry or Skip anywhere.
   */
  it("ruling 260: a chain's own creator gets its controls even below the run-agents tier", async () => {
    const mine: NonNullable<ControllerSurfaceView["goals"]>[number] = {
      id: "goal-7",
      title: "My own chain",
      status: "active",
      createdBy: "u_noor",
      createdByLabel: "Noor",
      onFailure: "pause",
      description: "",
      links: [
        { index: 1, title: "First", goal: "A.", taskKey: "JC-1", status: "failed", note: null, redeclared: false, blockedBy: [] },
      ],
      currentIndex: 1,
      createdAt: null,
      updatedAt: null,
      history: [],
    };
    const theirs = { ...mine, id: "goal-8", title: "Someone else's chain", createdBy: "u_other" };

    // A viewer below the run-agents tier (canRedirectGoals=false in the stub),
    // looking at one chain they created and one they did not.
    renderPage(view({ goals: [mine, theirs], viewerId: "u_noor" }));
    await screen.findByText("My own chain");

    // CANARY: drop `|| g.createdBy === viewerId` and BOTH counts are 0 — the
    // creator is shown their own chain with no way to redirect it.
    expect(screen.getAllByRole("button", { name: /Pause/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /Cancel goal/ })).toHaveLength(1);
    // …and the chain they did not create still offers nothing, so the fix did
    // not simply open the controls to everybody.
    const cards = document.querySelectorAll("[data-goal-id]");
    expect(cards.length === 0 || cards.length === 2).toBe(true);
  });
});

function renderPage(v: ControllerSurfaceView, search = "", action?: ActionFunction) {
  const page: Parameters<typeof createRoutesStub>[0][number] = {
    path: "projects/:slug/controller",
    Component: () => (
      <ToastProvider>
        <ControllerPage view={v} projectSlug="viberr-core" canRedirectGoals={false} />
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
  return render(<Stub initialEntries={[`/projects/viberr-core/controller${search}`]} />);
}

/** The instance surface (no project bound), where the ruling-127 copy lives. */
function renderInstancePage(v: ControllerSurfaceView, action?: ActionFunction) {
  const page: Parameters<typeof createRoutesStub>[0][number]["children"] = [
    {
      path: "controller",
      Component: () => (
        <ToastProvider>
          <ControllerPage view={v} projectSlug={null} canRedirectGoals={false} />
        </ToastProvider>
      ),
    },
  ];
  if (action) page[0]!.action = action;
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      loader: () => ({ csrf: "tok", theme: "system" }),
      children: page,
    },
  ]);
  return render(<Stub initialEntries={["/controller"]} />);
}

const composer = (container: HTMLElement) =>
  container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message to the controller"]',
  )!;

describe("the project controller page (ruling 121)", () => {
  it("names the project, not the slug, and chips task-anchored threads", async () => {
    renderPage(view());
    await screen.findByText("Managing the Viberr Core board with your own permissions.");
    const chip = screen.getByText("VIB-142", { selector: ".ctl-conv-task" });
    expect(chip.closest("a")?.textContent).toContain("Task thread");
    expect(screen.getByText("Board thread").closest("a")?.querySelector(".ctl-conv-task")).toBeNull();
  });

  it("says which task an open thread is anchored to, and where a message came from", async () => {
    renderPage(
      view({
        conversation: {
          id: "cnv_t",
          userId: "u1",
          userLabel: "arda@viberr.dev",
          projectSlug: "viberr-core",
          taskKey: "VIB-142",
          title: "Task thread",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:00:00.000Z",
          lastMessageAt: "2026-09-01T10:00:00.000Z",
        },
        messages: [
          { id: "m1", conversationId: "cnv_t", seq: 1, author: "user", userId: "u1", text: "Status?", runId: null, surface: "/projects/viberr-core/board?filter=waiting", createdAt: "2026-09-01T10:00:00.000Z" },
          { id: "m2", conversationId: "cnv_t", seq: 2, author: "controller", userId: null, text: "In review.", runId: "run_1", surface: null, createdAt: "2026-09-01T10:00:05.000Z" },
        ],
        viewerOwnsActive: true,
      }),
      "?c=cnv_t",
    );
    await screen.findByText("Anchored to VIB-142 on the Viberr Core board, with your own permissions.");
    const from = screen.getByText("from Board");
    expect(from.getAttribute("title")).toBe("/projects/viberr-core/board?filter=waiting");
    // The controller's reply carries no surface chip.
    expect(screen.getAllByText(/^from /)).toHaveLength(1);
  });
});

/**
 * U33-8: the page's conversation rail follows the dock's continuity rule. A
 * bare URL means "the newest thread of this scope", which the loader resolves
 * — so the rail marks what is OPEN rather than what the URL asked for, and
 * "New" has to name the blank composer (`?c=new`) instead of dropping `c`.
 */
describe("the conversation rail (U33-8)", () => {
  it("asks for a blank composer by name, so a bare URL can mean the newest thread", async () => {
    renderPage(view());
    const link = await screen.findByRole("link", { name: "New" });
    expect(link.getAttribute("href")).toBe(
      "/projects/viberr-core/controller?c=new",
    );
  });

  it("marks the thread the transcript is showing, even with no ?c= in the URL", async () => {
    const { container } = renderPage(
      view({
        conversation: {
          id: "cnv_b",
          userId: "u1",
          userLabel: "arda@viberr.dev",
          projectSlug: "viberr-core",
          taskKey: null,
          title: "Board thread",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:00:00.000Z",
          lastMessageAt: "2026-09-01T10:00:00.000Z",
        },
        viewerOwnsActive: true,
      }),
    );
    await screen.findByText("Board thread");
    const marked = [...container.querySelectorAll("a.ctl-conv.on")];
    expect(marked.map((a) => a.textContent)).toEqual([
      expect.stringContaining("Board thread"),
    ]);
  });
});

describe("surfaceLabel", () => {
  it("reduces a surface to the view, the task key, or the top-level page", () => {
    expect(surfaceLabel("/projects/viberr/board?filter=waiting")).toBe("Board");
    expect(surfaceLabel("/projects/viberr")).toBe("Board");
    expect(surfaceLabel("/projects/viberr/review")).toBe("Review");
    expect(surfaceLabel("/projects/viberr/tasks/VIB-7")).toBe("VIB-7");
    expect(surfaceLabel("/")).toBe("Home");
    expect(surfaceLabel("/notifications")).toBe("Notifications");
    expect(surfaceLabel("/org/settings?tab=controller")).toBe("Org");
  });
});

describe("controller page: the Claude-not-connected state (ruling 127)", () => {
  it("names the viewer's own account and where they connect it", async () => {
    const { container } = renderInstancePage(
      view({ available: false, projectName: null, conversations: [], goals: null }),
    );
    await screen.findByText("Managing this instance with your own permissions.");
    const box = composer(container);
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toContain("your own Claude account");
    expect(box.placeholder).toContain("Profile → Agent accounts");
    // The pill states the same fact in the header, and neither of them blames
    // the deployment: since ruling 127 it holds no credential to blame.
    expect(container.textContent).toContain("Claude not connected");
    expect(container.textContent).not.toContain("backend unavailable");
    expect(container.textContent).not.toContain("on this instance");
  });

  it("says nothing of the sort to a viewer who HAS connected Claude", async () => {
    const { container } = renderInstancePage(
      view({ available: true, projectName: null, conversations: [], goals: null }),
    );
    await screen.findByText("Managing this instance with your own permissions.");
    const box = composer(container);
    expect(box.disabled).toBe(false);
    expect(box.placeholder).toContain("Ask the controller");
    expect(container.textContent).not.toContain("Claude not connected");
  });

  it("keeps the read-only refusal distinct from the not-connected one", async () => {
    // Someone else's conversation: the composer is off for a reason that has
    // nothing to do with credentials, and must not borrow the other sentence.
    const { container } = renderInstancePage(
      view({
        available: true,
        projectName: null,
        conversations: [],
        goals: null,
        viewerOwnsActive: false,
        conversation: {
          id: "cv_1",
          userId: "u-other",
          userLabel: "other@viberr.test",
          projectSlug: null,
          taskKey: null,
          title: "Someone else's thread",
          createdAt: "2026-09-02T09:00:00.000Z",
          updatedAt: "2026-09-02T09:00:00.000Z",
          lastMessageAt: null,
        },
      }),
    );
    await screen.findByText("Managing this instance with your own permissions.");
    const box = composer(container);
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toContain("only the conversation's owner");
    expect(box.placeholder).not.toContain("Claude");
  });

  /**
   * Ruling 259 (pass 37, F37-90): the composer keeps the words until the server
   * takes them.
   *
   * `setText("")` ran synchronously after `fetcher.submit`, optimistically, and
   * nothing anywhere held the string. An expired CSRF token is refused BEFORE
   * the engine runs, so the text reached no transcript at all; a 404 on a scope
   * that is not open, or any transport failure, did the same. The person got a
   * toast that unmounts itself after 2,600 ms, and their message was gone. Four
   * of the five longest messages on the live board are 1,800 to 2,200
   * characters, typed into a two-row textarea.
   */
  it("ruling 259: a failed send leaves the typed message in the box", async () => {
    const typed = "A long ask I do not want to retype. ".repeat(20);
    const { container } = renderInstancePage(
      view({ available: true, projectName: null, conversations: [], goals: null }),
      // The CSRF arm: refused before the controller engine is ever reached.
      () => ({ ok: false, error: "That request expired. Reload the page and try again." }),
    );
    await screen.findByText("Managing this instance with your own permissions.");
    const box = composer(container);
    fireEvent.change(box, { target: { value: typed } });
    expect(box.value).toBe(typed);

    const send = screen.getByRole("button", { name: "Send" });
    await act(async () => {
      fireEvent.click(send);
    });

    // CANARY: move `setText("")` back beside `send.submit(...)` and this is "".
    expect(box.value).toBe(typed);
  });

  it("ruling 259: a successful send clears it", async () => {
    const { container } = renderInstancePage(
      view({ available: true, projectName: null, conversations: [], goals: null }),
      () => ({ ok: true, conversationId: "cv_new" }),
    );
    await screen.findByText("Managing this instance with your own permissions.");
    const box = composer(container);
    fireEvent.change(box, { target: { value: "short ask" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    // CANARY: clear on neither path and the box keeps every message ever sent.
    expect(box.value).toBe("");
  });
});

/**
 * Ruling 99, the execution half of the page: a controller turn is a run like
 * any other, so the page shows the run the way the task page does — the
 * Live-run strip (what it is doing, for how long, how many turns and tokens,
 * on which model, and Interrupt for whoever may stop it) and the Agent-logs
 * console with the turn's own lines.
 */
describe("the open conversation's execution", () => {
  const conversation: NonNullable<ControllerSurfaceView["conversation"]> = {
    id: "cnv_b",
    userId: "u1",
    userLabel: "arda@viberr.dev",
    projectSlug: "viberr-core",
    taskKey: null,
    title: "Board thread",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    lastMessageAt: "2026-09-01T10:00:00.000Z",
  };
  const run: RunView = {
    id: "controller",
    serverRunId: "run_ctl",
    role: "Controller",
    kind: "controller",
    profileId: "controller",
    who: { kind: "agent", backend: "claude", name: "Controller", role: "Controller" },
    backend: "claude",
    sdk: "Claude Agent SDK",
    model: "claude-opus-4-8",
    sid: "sess-ctl",
    exportable: false,
    state: "running",
    lifecycle: "running",
    interruptedBy: null,
    phase: "Working",
    step: "viberr_controller · list_tasks",
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    finished: null,
    turns: 3,
    tokens: 1200,
    tokensEstimated: false,
    lines: [{ t: "10:00:01", ev: "text", tag: "assistant", text: "Reading the board." }],
    raw: ['{"type":"assistant"}'],
    lineCount: 1,
    logWindow: { totalLines: 1, hasMore: false, runIds: ["run_ctl"], oldest: null, headSeq: 0 },
  };
  const working = (over: Partial<ControllerSurfaceView> = {}) =>
    view({
      conversation,
      viewerOwnsActive: true,
      turn: { working: true, runId: "run_ctl", phase: null, step: null },
      runtime: [run],
      canInterruptTurn: true,
      ...over,
    });

  /**
   * Ruling 250 (pass 37, F37-79). A controller turn measured live ran 201s over
   * 11 turns for $4.11 and the conversation said `Controller is working…` for
   * all of it, while the SAME page rendered the phase and step in the live-run
   * panel below. The fact was on the run row and already streaming here.
   */
  it("ruling 250: the working row carries the turn's own step", async () => {
    renderPage(
      working({
        turn: {
          working: true,
          runId: "run_ctl",
          phase: null,
          step: 'mcp__viberr_controller__get_task · {"taskKey":"SHOP-31"}',
        },
      }),
      "?c=cnv_b",
    );
    // CANARY: drop <TurnStep> from the ctl-working row and this is gone, while
    // the run panel below keeps showing it — the live shape.
    const row = await screen.findByRole("status");
    expect(row.textContent).toContain("is working");
    expect(row.textContent).toContain('get_task · {"taskKey":"SHOP-31"}');
  });

  it("ruling 250: a phase that only repeats the sentence is not printed twice", async () => {
    // The server sends `phase: null` while it is the generic "Working" — the
    // row already says that in prose. CANARY: render `turn.phase ?? "Working"`
    // and the row reads "Controller is working… Working · npm test".
    renderPage(
      working({
        turn: { working: true, runId: "run_ctl", phase: null, step: "Bash · npm test" },
      }),
      "?c=cnv_b",
    );
    const row = await screen.findByRole("status");
    const step = row.querySelector(".ctl-working-step");
    expect(step?.textContent).toBe("Bash · npm test");

    // A phase that MEANS something still shows, ahead of the step.
    cleanup();
    renderPage(
      working({
        turn: {
          working: true,
          runId: "run_ctl",
          phase: "Preparing workspace",
          step: "Cloning acme/widgets",
        },
      }),
      "?c=cnv_b",
    );
    const row2 = await screen.findByRole("status");
    expect(row2.querySelector(".ctl-working-step")?.textContent).toBe(
      "Preparing workspace · Cloning acme/widgets",
    );
  });

  it("renders the strip (elapsed, turns, tokens, model, View logs, Interrupt) and the console", async () => {
    // Canary: render only the transcript's "is working" row again and every
    // assertion below fails.
    const { container } = renderPage(working(), "?c=cnv_b");
    await screen.findByText("Live run");
    expect(screen.getByText("1 agent running")).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("viberr_controller · list_tasks")).toBeTruthy();
    // Elapsed derives from the run's own startedAt (~65 s), never a counter;
    // `useElapsed` reads the clock after mount, so wait for its first tick.
    await screen.findByText(/^01:0[56]$/);
    const cells = [...container.querySelectorAll(".run-cell")].map((c) => c.textContent);
    expect(cells[0]).toMatch(/^Elapsed01:0[56]$/);
    expect(cells.slice(1)).toEqual(["Turns3", "Tokens1.2k", "Runtimeclaude-opus-4-8"]);
    expect(screen.getByRole("button", { name: "View logs" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Interrupt" })).toBeTruthy();
    // The console, with the turn's line and the transcript-shaped footer.
    expect(screen.getByText("Agent logs")).toBeTruthy();
    expect(screen.getByText("Reading the board.")).toBeTruthy();
    expect(container.textContent).toContain("never in the transcript");
    // The strip sits above the transcript; the console below the composer.
    const main = container.querySelector(".ctl-main")!;
    const order = [...main.children].map((el) => el.className.split(" ")[0]);
    expect(order).toEqual(["runbar", "panel", "ctl-composer", "panel"]);
  });

  it("hides Interrupt from a viewer who may not stop the turn", async () => {
    renderPage(working({ canInterruptTurn: false, viewerOwnsActive: false }), "?c=cnv_b");
    await screen.findByText("Live run");
    expect(screen.queryByRole("button", { name: "Interrupt" })).toBeNull();
    expect(screen.getByRole("button", { name: "View logs" })).toBeTruthy();
  });

  it("Interrupt confirms first, then posts the conversation and the run", async () => {
    // Canary: submit from the strip's button directly, or post the thread id
    // instead of the server run id, and the recorded form differs.
    const posted: Record<string, string>[] = [];
    renderPage(working(), "?c=cnv_b", async ({ request }) => {
      const form = await request.formData();
      posted.push(Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])));
      return { ok: true, toast: "Turn interrupted. The transcript records that it was stopped." };
    });
    await screen.findByText("Live run");
    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
    expect(posted).toEqual([]);
    const dialog = await screen.findByRole("alertdialog", { name: "Interrupt this turn?" });
    expect(dialog.getAttribute("data-screen-label")).toBe("Interrupt turn dialog");
    expect(dialog.textContent).toContain("the transcript records that the turn was stopped");
    const commit = screen.getByRole("button", { name: "Interrupt turn" });
    // Rulings 149 and 150: stopping a turn discards what it was about to apply,
    // so the commit keeps the confirm's shared `danger` default and the trigger
    // that opened it carries the same red (`btn ghost sm danger`, pinned in
    // `runs-panels.test.tsx`). Canary: pass `tone="primary"` and this fails.
    expect(commit.className).toBe("btn danger");
    await act(async () => {
      fireEvent.click(commit);
    });
    await screen.findByText("Turn interrupted. The transcript records that it was stopped.");
    expect(posted).toEqual([
      { _csrf: "tok", intent: "interrupt", conversationId: "cnv_b", runId: "run_ctl" },
    ]);
  });

  it("renders neither panel for a thread that has not run yet", async () => {
    const { container } = renderPage(
      view({ conversation, viewerOwnsActive: true, runtime: [], canInterruptTurn: true }),
      "?c=cnv_b",
    );
    await screen.findByText("Board thread");
    expect(container.querySelector(".runbar")).toBeNull();
    expect(screen.queryByText("Agent logs")).toBeNull();
  });
});
