// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRoutesStub, replace, useLocation, type ActionFunction } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { ControllerPage, surfaceLabel } from "./controller-page";
import { readableStep } from "~/features/runtime/readable-step";
import type { ControllerSurfaceView } from "./controller-query.server";
import type { RunView } from "~/features/runtime/runtime-types";
import { NO_RUN_CACHE } from "~/features/runtime/runtime-types";

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

// jsdom's Element has no `scrollIntoView`; the ruling 419(b) case spies on it
// to prove the page never calls it.
Element.prototype.scrollIntoView = () => {};

afterEach(cleanup);

function view(over: Partial<ControllerSurfaceView> = {}): ControllerSurfaceView {
  return {
    available: true,
    controllerName: "Controller",
    projectName: "Viberr Core",
    conversations: [
      { id: "cnv_b", title: "Board thread", ownerLabel: "arda@viberr.dev", own: true, lastMessageAt: "2026-09-01T10:00:00.000Z", projectSlug: "viberr-core", taskKey: null, unread: false, readable: true, canDelete: true, working: false },
      { id: "cnv_t", title: "Task thread", ownerLabel: "arda@viberr.dev", own: true, lastMessageAt: "2026-09-01T11:00:00.000Z", projectSlug: "viberr-core", taskKey: "VIB-142", unread: false, readable: true, canDelete: true, working: false },
    ],
    conversation: null,
    messages: [],
    taskLinks: {},
    turn: { working: false, runId: null, phase: null, step: null, answering: null, queued: [], steering: [] },
    runtime: [],
    canInterruptTurn: false,
    proposals: [],
    corrections: { shown: [], total: 0 },
    viewerOwnsActive: false,
    showingAll: false,
    showAllAs: "org admin",
    viewerIsOrgAdmin: true,
    ...over,
  };
}

/**
 * O39-d: the rail and the phone's picker mark a thread holding a controller
 * reply the viewer has not opened.
 */
describe("the page marks a reply the viewer has not seen (O39-d)", () => {
  it("marks the unread thread on the rail and in the picker, and no other", async () => {
    const v = view();
    v.conversations = v.conversations.map((c) => (c.id === "cnv_t" ? { ...c, unread: true } : c));
    renderPage(v);
    // CANARY: drop the rail's unread mark and the thread that answered looks
    // like every other.
    const unread = await screen.findByRole("link", { name: /Task thread, new reply/ });
    expect(unread.className).toContain("unread");
    expect(screen.getByRole("link", { name: /^Board thread/ }).className).not.toContain("unread");
    const options = Array.from(screen.getByRole("combobox", { name: "Conversation" }).querySelectorAll("option"));
    expect(options.map((o) => o.textContent)).toEqual(
      expect.arrayContaining(["New reply · VIB-142 · Task thread", "Board thread"]),
    );
  });
});

function renderPage(v: ControllerSurfaceView, search = "", action?: ActionFunction) {
  const page: Parameters<typeof createRoutesStub>[0][number] = {
    path: "projects/:slug/controller",
    Component: () => (
      <ToastProvider>
        <ControllerPage view={v} projectSlug="viberr-core" />
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
          <ControllerPage view={v} projectSlug={null} />
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

/** The transcript's "is working…" row. Ruling 476(d) made it visual only, so
 *  it is found by its class, not as a status region. */
function findWorkingRow(): Promise<HTMLElement> {
  return waitFor(() => {
    const row = document.querySelector<HTMLElement>(".ctl-working");
    if (!row) throw new Error("no working row yet");
    return row;
  });
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
    expect(
      screen.getByText("Board thread", { selector: ".ctl-conv-title" }).closest("a")?.querySelector(".ctl-conv-task"),
    ).toBeNull();
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
          { id: "m1", conversationId: "cnv_t", seq: 1, author: "user", userId: "u1", text: "Status?", runId: null, surface: "/projects/viberr-core/board?filter=waiting", replyTo: null, steeredInto: null, createdAt: "2026-09-01T10:00:00.000Z" },
          { id: "m2", conversationId: "cnv_t", seq: 2, author: "controller", userId: null, text: "In review.", runId: "run_1", surface: null, replyTo: null, steeredInto: null, createdAt: "2026-09-01T10:00:05.000Z" },
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
    // Ruling 419(a): New lives in the page head now, one control for the page.
    const link = await screen.findByRole("link", { name: "New conversation" });
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
    await screen.findByText("Board thread", { selector: ".ctl-conv-title" });
    const marked = [...container.querySelectorAll("a.ctl-conv.on")];
    expect(marked.map((a) => a.textContent)).toEqual([
      expect.stringContaining("Board thread"),
    ]);
    // Interface review 2026-09-24 (acce-9): the open thread is exposed as the
    // current page, and only that row.
    const current = [...container.querySelectorAll('a.ctl-conv[aria-current="page"]')];
    expect(current).toEqual(marked);
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
      view({ available: false, projectName: null, conversations: [] }),
    );
    await screen.findByText("Managing this instance with your own permissions.");
    const box = composer(container);
    expect(box.disabled).toBe(true);
    // U39-10: the sentence is a visible note beside the box, with the place it
    // names linked; the disabled box itself says only what it cannot do.
    // CANARY: drop <NotConnectedNote /> from the composer.
    const note = container.querySelector(".ctl-composer [data-not-connected]");
    expect(note?.textContent).toContain("your own Claude account");
    expect(note?.querySelector('a[href="/profile"]')?.textContent).toBe("Profile → Agent accounts");
    expect(box.placeholder).toBe("Connect Claude to send a message.");
    // The pill states the same fact in the header, and neither of them blames
    // the deployment: since ruling 127 it holds no credential to blame.
    expect(container.textContent).toContain("Claude not connected");
    expect(container.textContent).not.toContain("backend unavailable");
    // The blame, not the words: ruling 419(g) puts ruling 314's instance
    // examples on this page, and one of them asks about the agent profiles
    // "on this instance", which blames nothing.
    expect(container.textContent).not.toMatch(/unavailable[^.]*on this instance/i);
  });

  it("says nothing of the sort to a viewer who HAS connected Claude", async () => {
    const { container } = renderInstancePage(
      view({ available: true, projectName: null, conversations: [] }),
    );
    await screen.findByText("Managing this instance with your own permissions.");
    const box = composer(container);
    expect(box.disabled).toBe(false);
    expect(box.placeholder).toContain("Ask the controller");
    expect(container.textContent).not.toContain("Claude not connected");
    expect(container.querySelector("[data-not-connected]")).toBeNull();
  });

  it("keeps the read-only refusal distinct from the not-connected one", async () => {
    // Someone else's conversation: the composer is off for a reason that has
    // nothing to do with credentials, and must not borrow the other sentence.
    const { container } = renderInstancePage(
      view({
        available: true,
        projectName: null,
        conversations: [],
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
});

/**
 * Ruling 259 (pass 37, F37-90): the composer keeps the words until the server
 * takes them. It used to clear the box as it submitted, so a send refused
 * before the engine ran (an expired CSRF token, a scope that is not open, a
 * transport failure) lost the message; four of the five longest messages on
 * the live board are 1,800 to 2,200 characters.
 *
 * And the clear, for a message that ends in whitespace. The composer sends the
 * TRIMMED text, and the success handler used to compare that against the raw
 * box, so "hello " or a message ending in a newline stayed in the box after
 * the controller had taken it.
 */
describe("ruling 259: the box is compared with what went out, trimmed", () => {
  const typed = "hello \n";

  /** An action the test settles by hand, so the send stays in flight. */
  function held(result: { ok: boolean; error?: string }) {
    const posted: Record<string, string>[] = [];
    let settle!: () => void;
    const gate = new Promise<void>((r) => (settle = r));
    const action: ActionFunction = async ({ request }) => {
      const form = await request.formData();
      posted.push(Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])));
      await gate;
      return result;
    };
    return { action, posted, settle };
  }

  async function sendTyped(action: ActionFunction) {
    const { container } = renderInstancePage(
      view({ available: true, projectName: null, conversations: [] }),
      action,
    );
    await screen.findByText("Managing this instance with your own permissions.");
    const box = composer(container);
    fireEvent.change(box, { target: { value: typed } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Sending…" });
    return box;
  }

  /** Lets the held action return and waits for the fetcher to settle. */
  async function land(settle: () => void) {
    await act(async () => settle());
    await screen.findByRole("button", { name: "Send" });
    // The result handler runs in the settle commit's passive effects.
    await act(async () => {});
  }

  it("clears a message sent with a trailing space and newline", async () => {
    const { action, posted, settle } = held({ ok: true });
    const box = await sendTyped(action);
    await land(settle);
    expect(posted.map((p) => p.text)).toEqual(["hello"]);
    // U39-24: the zone this page prints times in goes with the message, so
    // the controller quotes times in it. CANARY: drop it from `sendForm`.
    expect(posted[0]!.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // CANARY: compare the raw box (`cur === sent`) and this stays "hello \n".
    expect(box.value).toBe("");
  });

  it("keeps what was typed while the send was in flight", async () => {
    const { action, settle } = held({ ok: true });
    const box = await sendTyped(action);
    fireEvent.change(box, { target: { value: `${typed}and the next thing` } });
    await land(settle);
    // CANARY: clear on every success and the next message is lost.
    expect(box.value).toBe(`${typed}and the next thing`);
  });

  it("keeps the message when the send fails", async () => {
    const { action, settle } = held({ ok: false, error: "That request expired. Reload the page and try again." });
    const box = await sendTyped(action);
    await land(settle);
    // CANARY: move `setText("")` back beside `send.submit(...)`, or drop the
    // `data.ok` guard, and the failed message is gone.
    expect(box.value).toBe(typed);
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
    cache: NO_RUN_CACHE,
    lines: [{ t: "10:00:01", ev: "text", tag: "assistant", text: "Reading the board." }],
    raw: ['{"type":"assistant"}'],
    lineCount: 1,
    logWindow: { totalLines: 1, hasMore: false, runIds: ["run_ctl"], oldest: null, headSeq: 0 },
  };
  const working = (over: Partial<ControllerSurfaceView> = {}) =>
    view({
      conversation,
      viewerOwnsActive: true,
      turn: { working: true, runId: "run_ctl", phase: null, step: null, answering: null, queued: [], steering: [] },
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
          answering: null,
          queued: [],
          steering: [],
        },
      }),
      "?c=cnv_b",
    );
    // CANARY: drop <TurnStep> from the ctl-working row and this is gone, while
    // the run panel below keeps showing it — the live shape.
    const row = await findWorkingRow();
    expect(row.textContent).toContain("is working");
    // U39-9: in words, with the stored text kept on the title.
    expect(row.textContent).toContain("get task · SHOP-31");
    expect(row.querySelector(".ctl-working-step")?.getAttribute("title")).toBe(
      'mcp__viberr_controller__get_task · {"taskKey":"SHOP-31"}',
    );
  });

  it("U39-9: a step reads as words: no server prefix, no underscores, a flat input as its values", () => {
    // CANARY: render `detail` instead of `readableStep(detail)`.
    expect(readableStep("composing · mcp__viberr_controller__read_default_branch_file · internal/client/client.go answered")).toBe(
      "composing · read default branch file · internal/client/client.go answered",
    );
    expect(readableStep('mcp__viberr_ops__read_run_log · {"runId":"run_x","tail":40}')).toBe("read run log · run_x, 40");
    // A payload the 120-character cap cut short is not JSON, so it stays as stored.
    expect(readableStep('mcp__viberr_controller__update_epic · {"epicId":"epic-6","addTasks…')).toBe(
      'update epic · {"epicId":"epic-6","addTasks…',
    );
    // Built-in tools and their inputs are already words.
    expect(readableStep("Bash · npm test")).toBe("Bash · npm test");
  });

  it("U39-28: the run loading its tools says so, with their names", () => {
    // Live on ax-clone, the first step of a controller turn. CANARY: drop the
    // two ToolSearch replacements.
    expect(
      readableStep(
        "composing · ToolSearch · query: select:mcp__viberr_controller__get_task,mcp__viberr_controller__list_decisions… answered",
      ),
    ).toBe("composing · loading tools · get task, list decisions… answered");
    expect(readableStep("ToolSearch · query: slack send")).toBe("looking up tools · slack send");
    // Live after the deploy: the cap cut the second id before its tool name.
    // CANARY: drop the truncated-id replacement.
    expect(
      readableStep(
        "composing · ToolSearch · query: select:mcp__viberr_controller__read_knowledge_base_doc,mcp__viberr_controller_… answered",
      ),
    ).toBe("composing · loading tools · read knowledge base doc, … answered");
  });

  it("U39-29: the tasks a reply names open from the transcript", async () => {
    // Live on ax-clone, "I created two urgent core tasks … AX-33 and AX-34"
    // named five tasks as plain text. CANARY: drop `taskLinks={view.taskLinks}`
    // from the transcript's Markdown.
    renderPage(
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
          lastMessageAt: "2026-09-01T10:00:05.000Z",
        },
        messages: [
          { id: "m2", conversationId: "cnv_b", seq: 2, author: "controller", userId: null, text: "I created VIB-142. VIB-7 is not on this board.", runId: "run_1", surface: null, replyTo: null, steeredInto: null, createdAt: "2026-09-01T10:00:05.000Z" },
        ],
        taskLinks: { "VIB-142": "/projects/viberr-core/tasks/VIB-142" },
        viewerOwnsActive: true,
      }),
      "?c=cnv_b",
    );
    const link = await screen.findByRole("link", { name: "VIB-142" });
    expect(link.getAttribute("href")).toBe("/projects/viberr-core/tasks/VIB-142");
    expect(link.hasAttribute("target")).toBe(false);
    expect(screen.queryByRole("link", { name: "VIB-7" })).toBeNull();
  });

  it("ruling 250: a phase that only repeats the sentence is not printed twice", async () => {
    // The server sends `phase: null` while it is the generic "Working" — the
    // row already says that in prose. CANARY: render `turn.phase ?? "Working"`
    // and the row reads "Controller is working… Working · npm test".
    renderPage(
      working({
        turn: { working: true, runId: "run_ctl", phase: null, step: "Bash · npm test", answering: null, queued: [], steering: [] },
      }),
      "?c=cnv_b",
    );
    const row = await findWorkingRow();
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
          answering: null,
          queued: [],
          steering: [],
        },
      }),
      "?c=cnv_b",
    );
    const row2 = await findWorkingRow();
    expect(row2.querySelector(".ctl-working-step")?.textContent).toBe(
      "Preparing workspace · Cloning acme/widgets",
    );
  });

  it("renders the strip (phase, step, Interrupt) and discloses the console on it", async () => {
    // Canary: render only the transcript's "is working" row again and every
    // assertion below fails.
    const { container } = renderPage(working(), "?c=cnv_b");
    await screen.findByText("Live run");
    expect(screen.getByText("1 agent running")).toBeTruthy();
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText("viberr_controller · list_tasks")).toBeTruthy();
    // The strip's cells (Elapsed, Turns, Tokens, Runtime) are LiveRunPanel's
    // own, pinned in runs-panels.test.tsx.
    expect(screen.getByRole("button", { name: "Interrupt" })).toBeTruthy();

    // F39 (owner decision): while the turn streams, its console is DISCLOSED
    // on this card — open by default, because it was always on the page
    // before, just a full viewport below with the conversation in between.
    const trigger = screen.getByRole("button", { name: "Hide console" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // The console, with the turn's line and the transcript-shaped footer.
    expect(screen.getByText("Agent logs")).toBeTruthy();
    expect(screen.getByText("Reading the board.")).toBeTruthy();
    expect(container.textContent).toContain("never in the transcript");
    // CANARY: restore the scroll-to-anchor `onViewLogs` and the console goes
    // back below the composer — this query null.
    expect(
      container.querySelector(".runbar .runbar-console")?.textContent,
    ).toContain("Agent logs");
    // Ruling 524(a): the run is a pane of the layout's own, between the
    // conversation and the rail, where the sheet gives it the band's middle
    // column (under the composer when the page is one column). `data-console`
    // is what the sheet reads to size it. CANARY: render the card inside
    // `.ctl-main` again, above the transcript, and both orders fail.
    const layout = container.querySelector(".ctl-layout")!;
    expect([...layout.children].map((el) => el.className.split(" ")[0])).toEqual([
      "ctl-main",
      "ctl-run",
      "ctl-side",
    ]);
    const main = container.querySelector(".ctl-main")!;
    expect([...main.children].map((el) => el.className.split(" ")[0])).toEqual([
      "panel",
      "ctl-composer",
    ]);
    const pane = container.querySelector(".ctl-run")!;
    expect(pane.getAttribute("data-console")).toBe("open");

    // And it collapses, which is the whole point of a disclosure. Hidden, the
    // pane is the strip alone, which the sheet puts back under the composer.
    fireEvent.click(trigger);
    expect(screen.queryByText("Agent logs")).toBeNull();
    expect(pane.getAttribute("data-console")).toBe("closed");
    const closed = screen.getByRole("button", { name: "Show console" });
    expect(closed.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(closed);
    expect(screen.getByText("Agent logs")).toBeTruthy();
    expect(pane.getAttribute("data-console")).toBe("open");
  });

  it("ruling 524(a): a finished turn's console stays in the run pane as its archive", async () => {
    // Ruling 380 keeps the settled turn's console on the page. It takes the
    // pane the live card had, so the conversation keeps its column while the
    // log is read. CANARY: render the archive inside `.ctl-main` again and the
    // pane is gone.
    const { container } = renderPage(
      view({
        conversation,
        viewerOwnsActive: true,
        runtime: [{ ...run, state: "done", lifecycle: "finished", finished: "10:03:20" }],
        canInterruptTurn: true,
      }),
      "?c=cnv_b",
    );
    await screen.findByText("Agent logs");
    expect(container.querySelector(".runbar")).toBeNull();
    const pane = container.querySelector(".ctl-run")!;
    expect(pane.getAttribute("data-console")).toBe("archive");
    expect(pane.textContent).toContain("Reading the board.");
  });

  it("hides Interrupt from a viewer who may not stop the turn", async () => {
    renderPage(working({ canInterruptTurn: false, viewerOwnsActive: false }), "?c=cnv_b");
    await screen.findByText("Live run");
    expect(screen.queryByRole("button", { name: "Interrupt" })).toBeNull();
    expect(screen.getByRole("button", { name: "Hide console" })).toBeTruthy();
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
    await screen.findByText("Board thread", { selector: ".ctl-conv-title" });
    expect(container.querySelector(".runbar")).toBeNull();
    expect(screen.queryByText("Agent logs")).toBeNull();
    // Ruling 524(a): and no empty pane, so the band keeps two columns.
    // CANARY: render the `.ctl-run` wrapper unconditionally.
    expect(container.querySelector(".ctl-run")).toBeNull();
  });
});

/**
 * Ruling 419: the controller page for the person using it.
 *
 * Measured live on ax-clone (six goal chains, three conversations): the list of
 * conversations and its New button began 4,419px down the page on a desktop
 * and 5,576px down on a phone, under every chain; the main column went blank
 * for ~3,000px beside a rail that scrolled with the page; a phone landed at the
 * bottom of a 12,625px transcript; one unconfirmed click cancelled a whole
 * chain for good; and a completed chain took 479px to say it was done.
 */
describe("ruling 419(a): the page's navigation is at its top", () => {
  it("puts the conversations first in the rail, ahead of the knowledge base", async () => {
    // CANARY: render <KnowledgePanel> before <ConversationList> in the aside.
    const { container } = renderPage(view());
    await screen.findByText("Board thread", { selector: ".ctl-conv-title" });
    const rail = container.querySelector("aside.ctl-side")!;
    // Ruling 483 put the board's knowledge-base panel under the list. The goal
    // chains that followed it left the rail with ruling 503: an epic has its
    // own pages.
    expect([...rail.children].map((c) => c.className)).toEqual([
      "panel ctl-convs",
      "panel ctl-proposals",
    ]);
  });

  it("offers New conversation in the page head, and nowhere else", async () => {
    // CANARY: put a `New` link back in the Conversations panel's head.
    const { container } = renderPage(view());
    const link = await screen.findByRole("link", { name: "New conversation" });
    expect(link.closest("header.ctl-head")).not.toBeNull();
    expect(within(container.querySelector<HTMLElement>(".ctl-convs")!).queryAllByRole("link", { name: /^New/ })).toEqual([]);
  });

  it("a phone's thread switcher names the open thread and opens the one picked", async () => {
    // CANARY: drop the picker's `navigate(...)`, and the URL never moves.
    let search = "";
    function Probe() {
      search = useLocation().search;
      return null;
    }
    const open = {
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
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        loader: () => ({ csrf: "tok", theme: "system" }),
        children: [
          {
            path: "projects/:slug/controller",
            Component: () => (
              <ToastProvider>
                <ControllerPage
                  view={view({ conversation: open, viewerOwnsActive: true })}
                  projectSlug="viberr-core"
                 
                />
                <Probe />
              </ToastProvider>
            ),
          },
        ],
      },
    ]);
    render(<Stub initialEntries={["/projects/viberr-core/controller?c=cnv_b"]} />);
    const picker = await screen.findByRole("combobox", { name: "Conversation" });
    if (!(picker instanceof HTMLSelectElement)) throw new Error("the switcher must be a native select");
    expect(picker.value).toBe("cnv_b");
    expect([...picker.options].map((o) => o.textContent)).toEqual([
      "Board thread",
      "VIB-142 · Task thread",
    ]);
    fireEvent.change(picker, { target: { value: "cnv_t" } });
    await waitFor(() => expect(search).toBe("?c=cnv_t"));
  });

  it("on the blank composer the switcher says so instead of naming a thread", async () => {
    renderPage(view({ conversation: null }), "?c=new");
    const picker = await screen.findByRole("combobox", { name: "Conversation" });
    if (!(picker instanceof HTMLSelectElement)) throw new Error("the switcher must be a native select");
    expect(picker.value).toBe("");
    expect(picker.options[0]!.textContent).toBe("New conversation");
  });
});

describe("ruling 419(b): the transcript scrolls itself, never the page", () => {
  it("moves only the transcript's own box to the newest message", async () => {
    // CANARY: restore `endRef.current?.scrollIntoView?.({ block: "end" })`.
    const intoView = vi.spyOn(Element.prototype, "scrollIntoView");
    const height = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("ctl-transcript") ? 4321 : 0;
      });
    try {
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
          messages: [
            { id: "m1", conversationId: "cnv_b", seq: 1, author: "user", userId: "u1", text: "Status?", runId: null, surface: null, replyTo: null, steeredInto: null, createdAt: "2026-09-01T10:00:00.000Z" },
          ],
          viewerOwnsActive: true,
        }),
        "?c=cnv_b",
      );
      await screen.findByText("Status?");
      const box = container.querySelector<HTMLElement>("section.ctl-transcript")!;
      await waitFor(() => expect(box.scrollTop).toBe(4321));
      expect(intoView).not.toHaveBeenCalled();
    } finally {
      intoView.mockRestore();
      height.mockRestore();
    }
  });
});

describe("ruling 419(d): the send hint names the key this keyboard has", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says Ctrl on a keyboard with no ⌘, and prints no ⌘ anywhere in the footer", async () => {
    // CANARY: restore the literal "⌘↵ sends".
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    const { container } = renderPage(view());
    await screen.findByText(/Acts with your permissions/);
    const foot = container.querySelector(".ctl-composer-foot")!;
    await waitFor(() => expect(foot.textContent).toContain("Ctrl ↵ sends"));
    expect(foot.textContent).not.toContain("⌘");
    // The hint is its own element, which a touch screen drops (app.css).
    expect(foot.querySelector(".kbd-hint")!.textContent).toBe(" · Ctrl ↵ sends");
  });
});

describe("ruling 419(g): the page's blank transcript offers ruling 314's examples", () => {
  it("lists the board examples and SENDS the one clicked, as the dock does", async () => {
    // CANARY: drop the `ctl-examples` list from the blank transcript.
    const posted: Record<string, string>[] = [];
    renderPage(view({ conversation: null }), "?c=new", async ({ request }) => {
      const form = await request.formData();
      posted.push(Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])));
      return { ok: true, conversationId: "cnv_new" };
    });
    const example = await screen.findByRole("button", {
      name: "What's waiting on me, and what's waiting on an agent?",
    });
    expect(screen.getAllByRole("button").filter((b) => b.className === "ctl-example")).toHaveLength(3);
    await act(async () => {
      fireEvent.click(example);
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({
      _csrf: "tok",
      intent: "send",
      text: "What's waiting on me, and what's waiting on an agent?",
    });
    expect(posted[0]!.conversationId).toBeUndefined();
  });

  it("holds the examples while the viewer's Claude is not connected", async () => {
    renderPage(view({ conversation: null, available: false }), "?c=new");
    const example = await screen.findByRole("button", { name: "Which tasks have been open longest, and why?" });
    expect(example).toHaveProperty("disabled", true);
  });
});

/**
 * Ruling 451 (motion from transitions.dev, owner 2026-09-23): the page's
 * conversation moves as the dock's does. A reply that lands while the
 * transcript is up rises in, and the working row's step arrives as a new line
 * under a sentence that carries its own words for the shimmer band.
 */
describe("ruling 451: the page's conversation motion", () => {
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
  const message = (id: string, text: string, author: "user" | "controller") => ({
    id,
    conversationId: "cnv_b",
    seq: Number(id.slice(1)),
    author,
    userId: author === "user" ? "u1" : null,
    text,
    runId: null,
    surface: null,
    replyTo: null,
    steeredInto: null,
    createdAt: "2026-09-01T10:00:00.000Z",
  });

  /** The real page, handed a new view the way a revalidation hands it one. */
  function renderLive(initial: ControllerSurfaceView) {
    let setView: (v: ControllerSurfaceView) => void = () => {};
    function Live() {
      const [v, set] = useState(initial);
      setView = set;
      return (
        <ToastProvider>
          <ControllerPage view={v} projectSlug="viberr-core" />
        </ToastProvider>
      );
    }
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        loader: () => ({ csrf: "tok", theme: "system" }),
        children: [{ path: "projects/:slug/controller", Component: Live }],
      },
    ]);
    const utils = render(<Stub initialEntries={["/projects/viberr-core/controller?c=cnv_b"]} />);
    return { ...utils, update: (v: ControllerSurfaceView) => act(() => setView(v)) };
  }

  it("(d) a reply that lands while the transcript is up wears data-fresh; history never does", async () => {
    // CANARY: drop `data-fresh` from the page's <article> and the reply that
    // ends a minutes-long wait appears in one frame, as it did before.
    const first = message("m1", "Status?", "user");
    const reply = message("m2", "Two tasks are waiting on you.", "controller");
    const { update } = renderLive(view({ conversation, messages: [first], viewerOwnsActive: true }));
    await screen.findByText("Status?");
    expect(document.querySelector(".ctl-msg[data-fresh]")).toBeNull();
    update(view({ conversation, messages: [first, reply], viewerOwnsActive: true }));
    await screen.findByText("Two tasks are waiting on you.");
    const fresh = [...document.querySelectorAll(".ctl-msg[data-fresh]")].map((el) => el.textContent ?? "");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toContain("Two tasks are waiting on you.");
  });

  it("(a) the working sentence carries its own words, and a new step is a new line", async () => {
    const turn = (step: string) => ({ working: true, runId: "run_ctl", phase: null, step, answering: null, queued: [], steering: [] });
    const { update } = renderLive(
      view({ conversation, messages: [message("m1", "Go", "user")], viewerOwnsActive: true, turn: turn("Bash · npm test") }),
    );
    const row = await findWorkingRow();
    // CANARY: let `data-text` drift from the words and the band sweeps a
    // different sentence than the one on screen.
    const sentence = row.querySelector(".ctl-working-text")!;
    expect(sentence.textContent).toBe("Controller is working…");
    expect(sentence.getAttribute("data-text")).toBe(sentence.textContent);
    const step = row.querySelector(".ctl-working-step")!;
    // CANARY: drop TurnStep's `key` and the step's words change in place.
    update(view({ conversation, messages: [message("m1", "Go", "user")], viewerOwnsActive: true, turn: turn("Bash · npm test") }));
    expect(row.querySelector(".ctl-working-step")).toBe(step);
    update(view({ conversation, messages: [message("m1", "Go", "user")], viewerOwnsActive: true, turn: turn("Read · app/app.css") }));
    expect(row.querySelector(".ctl-working-step")).not.toBe(step);
    expect(row.querySelector(".ctl-working-step")!.textContent).toBe("Read · app/app.css");
  });

  it("ruling 459: the step on screen when the page opens stands still; the next one is marked to rise", async () => {
    // CANARY: set TurnStep's `data-fresh` unconditionally and the step a
    // person finds on opening the page mid-turn rises as if it had just changed.
    const turn = (step: string) => ({ working: true, runId: "run_ctl", phase: null, step, answering: null, queued: [], steering: [] });
    const at = (step: string) =>
      view({ conversation, messages: [message("m1", "Go", "user")], viewerOwnsActive: true, turn: turn(step) });
    const { update } = renderLive(at("Bash · npm test"));
    const row = await findWorkingRow();
    expect(row.querySelector(".ctl-working-step")!.hasAttribute("data-fresh")).toBe(false);
    update(at("Read · app/app.css"));
    expect(row.querySelector(".ctl-working-step")!.getAttribute("data-fresh")).toBe("true");
    // A latch: the first words coming back are a new step too.
    update(at("Bash · npm test"));
    expect(row.querySelector(".ctl-working-step")!.getAttribute("data-fresh")).toBe("true");
  });
});

/**
 * Ruling 368: a controller request shows itself on the button that sent it.
 * Send named its work but went to the .45 refused step with no busy mark. (The
 * goal controls this ruling also named left with the chains, ruling 503.)
 * Canary: render Send's resting label while `busy` in controller-page.tsx.
 */
describe("ruling 368: the controller's requests in flight", () => {
  // Never answers: each test reads the wait itself.
  const never = () => new Promise<never>(() => {});

  it("Send reads Sending…, busy, the loader spinning", async () => {
    const { container } = renderInstancePage(
      view({ available: true, projectName: null, conversations: [] }),
      never,
    );
    await screen.findByText("Managing this instance with your own permissions.");
    fireEvent.change(composer(container), { target: { value: "short ask" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const sending = await screen.findByRole("button", { name: "Sending…" });
    expect(sending.getAttribute("aria-busy")).toBe("true");
    expect(sending.querySelector("svg.ico.spin")).not.toBeNull();
  });
});

/**
 * Ruling 465 (F40-8): each reply sits under the message it answers, and an
 * unanswered message says where it stands. Live, three dossier parts were
 * queued while a turn worked; the transcript put "Controller is working…"
 * under part 2 while the turn was still on part 1, and once the replies landed
 * it read part 1, part 2, part 3, reply, correction, reply, reply.
 */
describe("ruling 465: the transcript is in reply order and names the queue", () => {
  const conversation: NonNullable<ControllerSurfaceView["conversation"]> = {
    id: "cnv_b",
    userId: "u1",
    userLabel: "Akin",
    projectSlug: "viberr-core",
    taskKey: null,
    title: "Dossier",
    createdAt: "2026-09-24T20:00:00.000Z",
    updatedAt: "2026-09-24T20:00:00.000Z",
    lastMessageAt: "2026-09-24T20:00:00.000Z",
  };
  const msg = (
    id: string,
    seq: number,
    author: "user" | "controller",
    text: string,
    replyTo: string | null = null,
  ): ControllerSurfaceView["messages"][number] => ({
    id,
    conversationId: "cnv_b",
    seq,
    author,
    userId: author === "user" ? "u1" : null,
    text,
    runId: author === "user" ? null : `run_${id}`,
    surface: null,
    replyTo,
    steeredInto: null,
    createdAt: "2026-09-24T20:00:00.000Z",
  });

  it("puts each reply under its message, 'answering now' and the working row on the answered one, and 'queued · N ahead' on the rest", async () => {
    renderPage(
      view({
        conversation,
        viewerOwnsActive: true,
        // seq order: three parts queued, then part 1's reply.
        messages: [
          msg("p1", 1, "user", "Part one."),
          msg("p2", 2, "user", "Part two."),
          msg("p3", 3, "user", "Part three."),
          msg("r1", 4, "controller", "Filed part one.", "p1"),
        ],
        turn: {
          working: true,
          runId: "run_live",
          phase: null,
          step: null,
          answering: "p2",
          queued: [{ messageId: "p3", ahead: 1 }],
          steering: [],
        },
      }),
      "?c=cnv_b",
    );
    await screen.findByText("Part three.");
    const order = [...document.querySelectorAll(".ctl-msgs > .ctl-msg, .ctl-msgs > .ctl-working")].map((el) =>
      el.classList.contains("ctl-working") ? "WORKING" : (el.querySelector(".md-body")?.textContent ?? "").trim(),
    );
    // CANARY: render `view.messages` in seq order again and the reply sits
    // under part three with the working row under it.
    expect(order).toEqual(["Part one.", "Filed part one.", "Part two.", "WORKING", "Part three."]);
    const articles = [...document.querySelectorAll(".ctl-msgs > .ctl-msg")];
    // CANARY: drop <MessageState> from the page's header and neither label shows.
    expect(articles[2]!.querySelector("[data-msg-state]")?.textContent).toBe("answering now");
    expect(articles[3]!.querySelector("[data-msg-state]")?.textContent).toBe("queued · 1 ahead");
    // A message with a reply says nothing about the queue.
    expect(articles[0]!.querySelector("[data-msg-state]")).toBeNull();
  });

  it("an unlinked older transcript keeps its seq order and says nothing it does not know", async () => {
    renderPage(
      view({
        conversation,
        viewerOwnsActive: true,
        messages: [msg("u1", 1, "user", "Old question."), msg("c1", 2, "controller", "Old answer.")],
      }),
      "?c=cnv_b",
    );
    await screen.findByText("Old answer.");
    const texts = [...document.querySelectorAll(".ctl-msgs > .ctl-msg .md-body")].map((el) => el.textContent?.trim());
    expect(texts).toEqual(["Old question.", "Old answer."]);
    expect(document.querySelector("[data-msg-state]")).toBeNull();
  });

  /**
   * Ruling 527: a message sent while a turn works steers it unless it was
   * queued. It sits in the turn it steers, says whether it is still waiting
   * for the turn's next step or was read, and a message still waiting offers
   * its sender Send now (queued) and Retract.
   */
  describe("ruling 527: steering", () => {
    const steer = (id: string, seq: number, text: string, into: string | null) => ({
      ...msg(id, seq, "user", text),
      steeredInto: into,
    });
    const rows = () =>
      [...document.querySelectorAll(".ctl-msgs > .ctl-msg, .ctl-msgs > .ctl-working")].map((el) => {
        if (el.classList.contains("ctl-working")) return "WORKING";
        const text = (el.querySelector(".md-body")?.textContent ?? "").trim();
        const state = el.querySelector("[data-msg-state]")?.textContent;
        const acts = [...el.querySelectorAll(".ctl-msg-acts button")].map((b) => b.textContent);
        return [text, state ?? null, ...acts].join(" | ");
      });
    const live = {
      working: true,
      runId: "run_live",
      phase: null,
      step: null,
      answering: "p1",
      queued: [{ messageId: "q", ahead: 1 }],
      steering: ["s"],
    };

    it("puts a steering message in the turn it steers, above the working row, and keeps it there once read", async () => {
      renderPage(
        view({
          conversation,
          viewerOwnsActive: true,
          messages: [
            msg("p1", 1, "user", "Tidy the agents."),
            msg("q", 2, "user", "Then list them."),
            steer("s", 3, "The KB is gone too.", null),
          ],
          turn: live,
        }),
        "?c=cnv_b",
      );
      await screen.findByText("The KB is gone too.");
      // CANARY: drop `view.turn` from the page's `inReplyOrder` and the
      // steering message sits under the queued one, below the working row.
      expect(rows()).toEqual([
        "Tidy the agents. | answering now",
        "The KB is gone too. | steering · next step | Retract",
        "WORKING",
        "Then list them. | queued · 1 ahead | Send now | Retract",
      ]);

      // The turn read it and replied; the queued message's turn is working.
      cleanup();
      renderPage(
        view({
          conversation,
          viewerOwnsActive: true,
          messages: [
            msg("p1", 1, "user", "Tidy the agents."),
            msg("q", 2, "user", "Then list them."),
            steer("s", 3, "The KB is gone too.", "p1"),
            msg("r1", 4, "controller", "Done, and the KB was already gone.", "p1"),
          ],
          turn: { ...live, answering: "q", queued: [], steering: [] },
        }),
        "?c=cnv_b",
      );
      await screen.findByText("Done, and the KB was already gone.");
      // CANARY: drop `steered` from the page's <MessageState> and the steered
      // message (no reply of its own) says nothing of where its answer is.
      expect(rows()).toEqual([
        "Tidy the agents. | ",
        "The KB is gone too. | steered",
        "Done, and the KB was already gone. | ",
        "Then list them. | answering now",
        "WORKING",
      ]);
    });

    it("hides Send now and Retract from a viewer who does not own the conversation", async () => {
      renderPage(
        view({
          conversation,
          viewerOwnsActive: false,
          messages: [msg("p1", 1, "user", "Tidy the agents."), msg("q", 2, "user", "Then list them.")],
          turn: { ...live, steering: [] },
        }),
        "?c=cnv_b",
      );
      await screen.findByText("Then list them.");
      expect(document.querySelector(".ctl-msg-acts")).toBeNull();
    });

    it("Retract puts the message back under what is typed; Send now asks the server; the composer steers or queues", async () => {
      const posted: Record<string, string>[] = [];
      const { container } = renderPage(
        view({
          conversation,
          viewerOwnsActive: true,
          messages: [msg("p1", 1, "user", "Tidy the agents."), msg("q", 2, "user", "Then list them.")],
          turn: { ...live, steering: [] },
        }),
        "?c=cnv_b",
        async ({ request }) => {
          const form = Object.fromEntries([...(await request.formData()).entries()].map(([k, v]) => [k, String(v)]));
          posted.push(form);
          if (form.intent === "retract") return { ok: true, retracted: "Then list them.", toast: "Taken back into your composer." };
          if (form.intent === "send-now") return { ok: true, toast: "It goes into the running turn at its next step." };
          return { ok: true, conversationId: "cnv_b" };
        },
      );
      await screen.findByText("Then list them.");
      const box = composer(container);
      fireEvent.change(box, { target: { value: "And the scheduler." } });

      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retract" })));
      await screen.findByText("Taken back into your composer.");
      // CANARY: replace the box instead of `withRetracted` and what was typed is lost.
      expect(box.value).toBe("And the scheduler.\n\nThen list them.");

      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send now" })));
      await screen.findByText("It goes into the running turn at its next step.");
      expect(posted).toEqual([
        { _csrf: "tok", intent: "retract", conversationId: "cnv_b", messageId: "q" },
        { _csrf: "tok", intent: "send-now", conversationId: "cnv_b", messageId: "q" },
      ]);

      // A working turn: Steer is the primary send, Queue waits for a turn of its own.
      expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Queue" })));
      await waitFor(() => expect(posted).toHaveLength(3));
      fireEvent.change(box, { target: { value: "One more." } });
      // CANARY: drop the shift check and ⌘⇧↵ steers.
      await act(async () => fireEvent.keyDown(box, { key: "Enter", metaKey: true, shiftKey: true }));
      await waitFor(() => expect(posted).toHaveLength(4));
      fireEvent.change(box, { target: { value: "Last one." } });
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Steer" })));
      await waitFor(() => expect(posted).toHaveLength(5));
      expect(posted.slice(2).map((p) => [p.intent, p.mode, p.text])).toEqual([
        ["send", "queue", "And the scheduler.\n\nThen list them."],
        ["send", "queue", "One more."],
        ["send", "steer", "Last one."],
      ]);
    });
  });
});

/**
 * Ruling 476 (pass 40, the controller page, dock and goals rail). Measured
 * live on the owner's akinozer.com instance: a thread whose source URLs ran
 * past the transcript, replies opened at their tail, replies no screen reader
 * heard, and a 97px thread switcher. Its findings on the goals rail (a link's
 * number, the head's count, a link's status word, the planning conversation)
 * moved with the chains to the epic pages (ruling 503), whose tests carry
 * (g) and (h).
 */
describe("ruling 476: the controller page", () => {
  const conversation: NonNullable<ControllerSurfaceView["conversation"]> = {
    id: "cnv_b",
    userId: "u1",
    userLabel: "arda@viberr.dev",
    projectSlug: "viberr-core",
    taskKey: null,
    title: "Board thread",
    createdAt: "2026-09-24T20:00:00.000Z",
    updatedAt: "2026-09-24T20:00:00.000Z",
    lastMessageAt: "2026-09-24T20:00:00.000Z",
  };
  const msg = (id: string, seq: number, author: "user" | "controller", text: string, replyTo: string | null = null) => ({
    id,
    conversationId: "cnv_b",
    seq,
    author,
    userId: author === "user" ? "u1" : null,
    text,
    runId: author === "user" ? null : `run_${id}`,
    surface: null,
    replyTo,
    steeredInto: null,
    createdAt: "2026-09-24T20:00:00.000Z",
  });
  const idle: ControllerSurfaceView["turn"] = { working: false, runId: null, phase: null, step: null, answering: null, queued: [], steering: [] };
  const busy = (answering: string): ControllerSurfaceView["turn"] => ({ ...idle, working: true, runId: "run_live", answering });
  const at = (messages: ReturnType<typeof msg>[], turn: ControllerSurfaceView["turn"] = idle) =>
    view({ conversation, messages, turn, viewerOwnsActive: true });

  /** The real page, handed a new view the way a revalidation hands it one. */
  function renderLive(initial: ControllerSurfaceView) {
    let setView: (v: ControllerSurfaceView) => void = () => {};
    function Live() {
      const [v, set] = useState(initial);
      setView = set;
      return (
        <ToastProvider>
          <ControllerPage view={v} projectSlug="viberr-core" />
        </ToastProvider>
      );
    }
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        loader: () => ({ csrf: "tok", theme: "system" }),
        children: [{ path: "projects/:slug/controller", Component: Live }],
      },
    ]);
    const utils = render(<Stub initialEntries={["/projects/viberr-core/controller?c=cnv_b"]} />);
    return { ...utils, update: (v: ControllerSurfaceView) => act(() => setView(v)) };
  }

  /**
   * Layout jsdom does not do: the transcript is a 400px box over 5,000px of
   * content, and each message named in `tops` starts that far down it.
   */
  function stubTranscript(tops: Record<string, number>): () => void {
    const box = () => document.querySelector<HTMLElement>("section.ctl-transcript");
    const spies = [
      vi
        .spyOn(HTMLElement.prototype, "scrollHeight", "get")
        .mockImplementation(function (this: HTMLElement) {
          return this.classList.contains("ctl-transcript") ? 5000 : 0;
        }),
      vi
        .spyOn(HTMLElement.prototype, "clientHeight", "get")
        .mockImplementation(function (this: HTMLElement) {
          return this.classList.contains("ctl-transcript") ? 400 : 0;
        }),
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const top = tops[this.dataset.messageId ?? ""];
        return DOMRect.fromRect({ x: 0, y: top === undefined ? 0 : top - (box()?.scrollTop ?? 0), width: 300, height: 100 });
      }),
    ];
    return () => {
      for (const spy of spies) spy.mockRestore();
    };
  }

  const transcript = () => document.querySelector<HTMLElement>("section.ctl-transcript")!;

  describe("(c) F40-23: a reply is shown from its first line", () => {
    it("a reply that lands above queued messages puts its first line at the top of the box", async () => {
      // Live: the reply to the 23:39 message sat above three queued messages,
      // and the scroll went ~13,000px past it to the last one.
      // CANARY: restore `box.scrollTop = box.scrollHeight` on every change.
      const restore = stubTranscript({ p1: 0, r1: 1200, p2: 4600 });
      try {
        const { update } = renderLive(at([msg("p1", 1, "user", "First."), msg("p2", 2, "user", "Queued.")], busy("p1")));
        await screen.findByText("Queued.");
        // Opened on the person's own unanswered message: the end.
        await waitFor(() => expect(transcript().scrollTop).toBe(5000));
        update(
          at(
            [msg("p1", 1, "user", "First."), msg("p2", 2, "user", "Queued."), msg("r1", 3, "controller", "Done with the first.", "p1")],
            busy("p2"),
          ),
        );
        await screen.findByText("Done with the first.");
        expect(transcript().scrollTop).toBe(1192);
      } finally {
        restore();
      }
    });

    it("opens a thread on its newest reply's first line, not its last", async () => {
      // CANARY: place an opened transcript at its end whatever it ends with.
      const restore = stubTranscript({ p1: 0, r1: 900 });
      try {
        renderLive(at([msg("p1", 1, "user", "Status?"), msg("r1", 2, "controller", "A long answer.", "p1")]));
        await screen.findByText("A long answer.");
        await waitFor(() => expect(transcript().scrollTop).toBe(892));
      } finally {
        restore();
      }
    });

    it("leaves a reader who scrolled up to history where they are, and follows one reading the newest reply", async () => {
      // CANARY: drop the `following` check and the reader is pulled away.
      const restore = stubTranscript({ p1: 0, r1: 1200, p2: 2400, r2: 3000, p3: 4000, r3: 4400 });
      const three = [msg("p1", 1, "user", "One."), msg("r1", 2, "controller", "Answer one.", "p1"), msg("p2", 3, "user", "Two.")];
      const answered = [...three, msg("r2", 4, "controller", "Answer two.", "p2")];
      try {
        const { update } = renderLive(at(three, busy("p2")));
        await screen.findByText("Two.");
        await waitFor(() => expect(transcript().scrollTop).toBe(5000));
        transcript().scrollTop = 100; // reading the top of the thread
        update(at(answered));
        await screen.findByText("Answer two.");
        expect(transcript().scrollTop).toBe(100);
        // The person's own message goes to the end, wherever they were.
        update(at([...answered, msg("p3", 5, "user", "Three.")], busy("p3")));
        await screen.findByText("Three.");
        expect(transcript().scrollTop).toBe(5000);
        // Reading the newest reply (its first line is in view): the next reply is shown.
        transcript().scrollTop = 2800;
        update(at([...answered, msg("p3", 5, "user", "Three."), msg("r3", 6, "controller", "Answer three.", "p3")]));
        await screen.findByText("Answer three.");
        expect(transcript().scrollTop).toBe(4392);
      } finally {
        restore();
      }
    });
  });

  describe("(d) F40-24: a screen reader hears that a turn started and that it replied", () => {
    it("keeps one status region mounted, empty at rest, and changes only its text", async () => {
      // CANARY: drop <TurnAnnouncer> and put `role="status"` back on the
      // working row: no region at rest, and nothing says the reply landed.
      const { update } = renderLive(at([msg("p1", 1, "user", "What changed?")]));
      await screen.findByText("What changed?");
      const region = screen.getByRole("status");
      expect(region.textContent).toBe("");
      update(at([msg("p1", 1, "user", "What changed?")], busy("p1")));
      await findWorkingRow();
      expect(screen.getByRole("status")).toBe(region);
      expect(region.textContent).toBe("Controller is working");
      // The working row is what a sighted person watches; it is no region.
      expect(document.querySelector(".ctl-working")!.hasAttribute("role")).toBe(false);
      update(
        at([
          msg("p1", 1, "user", "What changed?"),
          msg("r1", 2, "controller", "I've removed the sentence from **WEB-1**'s goal. Then a [source](https://example.com/a).", "p1"),
        ]),
      );
      await screen.findByText(/removed the sentence/, { selector: ".md-body p" });
      expect(screen.getByRole("status")).toBe(region);
      expect(region.textContent).toBe("Controller replied: I've removed the sentence from WEB-1's goal.");
    });
  });

  /**
   * Ruling 572, on (c)'s box: the way back for a reader who has scrolled away.
   * (c) leaves a reader in history where they are when a reply lands, and
   * nothing on screen said that one had.
   */
  describe("ruling 572: the jump back to the newest message", () => {
    /** The reader moves the box; the jump is measured on the next frame. */
    async function scrollTo(top: number) {
      transcript().scrollTop = top;
      fireEvent.scroll(transcript());
      await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
    }
    const jump = () => within(transcript()).queryByRole("button", { name: /New reply|Latest/ });

    it("offers Latest to a reader above the newest reply, never to one reading it, and goes where an open goes", async () => {
      // CANARY: measure the jump against the box's end instead of the newest
      // reply's first line, and the thread opens with the jump already up.
      const restore = stubTranscript({ p1: 0, r1: 1200 });
      try {
        renderLive(at([msg("p1", 1, "user", "Status?"), msg("r1", 2, "controller", "A long answer.", "p1")]));
        await screen.findByText("A long answer.");
        await waitFor(() => expect(transcript().scrollTop).toBe(1192));
        expect(jump()).toBeNull();
        // CANARY: drop the box's scroll listener, and the jump never comes.
        await scrollTo(0);
        fireEvent.click(await within(transcript()).findByRole("button", { name: "Latest" }));
        expect(transcript().scrollTop).toBe(1192);
        expect(jump()).toBeNull();
      } finally {
        restore();
      }
    });

    it("says New reply when one lands on a reader in history, and takes them and the focus to its first line", async () => {
      const restore = stubTranscript({ p1: 0, r1: 1200, p2: 2400, r2: 3000 });
      const three = [msg("p1", 1, "user", "One."), msg("r1", 2, "controller", "Answer one.", "p1"), msg("p2", 3, "user", "Two.")];
      try {
        const { update } = renderLive(at(three, busy("p2")));
        await screen.findByText("Two.");
        await waitFor(() => expect(transcript().scrollTop).toBe(5000));
        await scrollTo(100);
        expect(jump()?.textContent).toBe("Latest");
        update(at([...three, msg("r2", 4, "controller", "Answer two.", "p2")]));
        await screen.findByText("Answer two.");
        // Ruling 476(c): the reader stays where they are, and is told.
        // CANARY: forget the reply (c) left below the reader, and this reads Latest.
        expect(transcript().scrollTop).toBe(100);
        const button = within(transcript()).getByRole("button", { name: "New reply" });
        expect(button.className).toContain("primary");
        button.focus();
        fireEvent.click(button);
        expect(transcript().scrollTop).toBe(2992);
        expect(jump()).toBeNull();
        // CANARY: drop the focus move, and the focus goes to nothing with the jump.
        expect(document.activeElement).toBe(transcript().querySelector('[data-message-id="r2"]'));
      } finally {
        restore();
      }
    });

    it("stops saying New reply once the reader has scrolled to it", async () => {
      // CANARY: keep the held reply until the jump is pressed, and a reader who
      // scrolled down to it is still told it is new.
      const restore = stubTranscript({ p1: 0, r1: 1200, p2: 2400, r2: 3000 });
      const three = [msg("p1", 1, "user", "One."), msg("r1", 2, "controller", "Answer one.", "p1"), msg("p2", 3, "user", "Two.")];
      try {
        const { update } = renderLive(at(three, busy("p2")));
        await screen.findByText("Two.");
        await scrollTo(100);
        update(at([...three, msg("r2", 4, "controller", "Answer two.", "p2")]));
        await within(transcript()).findByRole("button", { name: "New reply" });
        await scrollTo(2800); // r2's first line is in view
        expect(jump()).toBeNull();
        await scrollTo(100);
        expect(jump()?.textContent).toBe("Latest");
      } finally {
        restore();
      }
    });
  });
});


/**
 * Ruling 483 (F40-59): the project's open knowledge-base proposals are listed
 * where the owner looks, with a count, and Promote and Dismiss ask the
 * controller to carry the decision out. Live on WEB-1 two operator proposals
 * existed only as timeline events that looked like failed reviews, and nothing
 * brought them back. Since ruling 498 nothing files one, and the ones that
 * documents still hold are listed under the corrections, with Promote all.
 */
describe("the project's open knowledge-base proposals (ruling 483)", () => {
  const proposal = {
    id: "kp-0123456789",
    kb: "akin-rulings",
    doc: "gates.md",
    rulings: true,
    taskKey: "WEB-1",
    filedOn: "2026-09-24",
    filedBy: "Operator",
    line: "Gate commands: not yet settled",
    correction: "The gate set is npm run lint, npm run typecheck and npm test.",
    evidence: "All three exited 0 on WEB-1.",
    docHref: "/org/settings?tab=resources&kb=akin-rulings&doc=gates.md",
  };

  it("lists each with its count, document, line and task, and Promote sends the request to the controller", async () => {
    const posted: Record<string, string>[] = [];
    renderPage(view({ proposals: [proposal] }), "", async ({ request }) => {
      const form = await request.formData();
      posted.push(Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])));
      return { ok: true, conversationId: "cnv_b" };
    });
    // CANARY: drop the proposals from the panel and nothing on the page says
    // one waits.
    const panel = await screen.findByRole("region", { name: "Knowledge base" });
    expect(within(panel).getByText("Open proposals (1)")).toBeTruthy();
    expect(within(panel).getByText("akin-rulings/gates.md")).toBeTruthy();
    expect(within(panel).getByText("Gate commands: not yet settled")).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "WEB-1" }).getAttribute("href")).toBe(
      "/projects/viberr-core/tasks/WEB-1",
    );
    expect(within(panel).getByRole("link", { name: "Open document" }).getAttribute("href")).toBe(
      proposal.docHref,
    );
    // One proposal needs no Promote all.
    expect(within(panel).queryByRole("button", { name: "Promote all" })).toBeNull();
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Promote" }));
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ intent: "send" });
    expect(posted[0]!.text).toContain("Promote knowledge-base proposal kp-0123456789 in akin-rulings/gates.md");
    expect(posted[0]!.text).toContain("resolve_kb_proposal");
  });

  it("Promote all asks once for every open proposal", async () => {
    const posted: string[] = [];
    renderPage(view({ proposals: [proposal, { ...proposal, id: "kp-9876543210", doc: "layout.md" }] }), "", async ({ request }) => {
      posted.push(String((await request.formData()).get("text")));
      return { ok: true, conversationId: "cnv_b" };
    });
    const panel = await screen.findByRole("region", { name: "Knowledge base" });
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Promote all" }));
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toContain("Promote all 2 open knowledge-base proposals on this board");
    expect(posted[0]).toContain("resolve_kb_proposal");
  });

  it("Dismiss confirms first, then asks; a member who is not an org admin is told who decides", async () => {
    const posted: string[] = [];
    renderPage(view({ proposals: [proposal] }), "", async ({ request }) => {
      posted.push(String((await request.formData()).get("text")));
      return { ok: true, conversationId: "cnv_b" };
    });
    const panel = await screen.findByRole("region", { name: "Knowledge base" });
    fireEvent.click(within(panel).getByRole("button", { name: "Dismiss" }));
    expect(posted).toEqual([]);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Dismiss proposal" }));
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toContain("Dismiss knowledge-base proposal kp-0123456789");
    cleanup();

    renderPage(view({ viewerIsOrgAdmin: false, proposals: [{ ...proposal, docHref: null }] }));
    const memberPanel = await screen.findByRole("region", { name: "Knowledge base" });
    expect(within(memberPanel).queryByRole("button", { name: "Promote" })).toBeNull();
    expect(within(memberPanel).getByText("An org admin promotes or dismisses proposals.")).toBeTruthy();
    expect(within(memberPanel).queryByRole("link", { name: "Open document" })).toBeNull();
  });

  /**
   * Ruling 497: a proposal's notification opens its entry here. The router
   * arrives by `pushState`, which never updates `:target`, so the page marks
   * the entry itself. One promoted or dismissed since has left the panel, and
   * the notification still lands on the panel.
   *
   * Canaries: drop `data-targeted` from the entry and nothing marks it; drop
   * the fallback in `revealKnowledge` and the second link moves nothing.
   */
  it("ruling 497: a proposal's notification marks and focuses its entry; a closed one lands on the proposals list", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderPage(view({ proposals: [proposal] }), "#proposal-kp-0123456789");
    const panel = await screen.findByRole("region", { name: "Knowledge base" });
    const entry = panel.querySelector("#proposal-kp-0123456789")!;
    await waitFor(() => expect(entry.hasAttribute("data-targeted")).toBe(true));
    // The mark is drawn by the render, the focus by the effect after it.
    await waitFor(() => expect(document.activeElement).toBe(entry));
    cleanup();

    focus.mockClear();
    renderPage(view({ proposals: [proposal] }), "#proposal-kp-ffffffffff");
    const after = await screen.findByRole("region", { name: "Knowledge base" });
    expect(after.querySelector("[data-targeted]")).toBeNull();
    // Ruling 498: the proposals sit inside the Knowledge base panel, so a
    // closed one's link lands on their list.
    const list = after.querySelector("#kb-proposals")!;
    await waitFor(() => expect(focus.mock.contexts).toContain(list));
    focus.mockRestore();
  });
});

/**
 * Ruling 498: the owner stopped approving each knowledge-base correction ("No
 * human can approve all of these while inspecting them thoroughly"). The panel
 * lists what agents wrote, each passage before and after with its evidence,
 * and an org admin's Undo puts one back, directly, after a confirm.
 */
describe("the project's knowledge-base corrections (ruling 498)", () => {
  const correction = {
    id: "kc-0123456789",
    kb: "akinozer-deploy-runbook",
    doc: "runbook.md",
    rulings: false,
    replaced: "5. Non-production branch builds: on",
    text: "5. Non-production branch builds: off (previews_enabled: false)",
    evidence: "GET /builds/workers/e7e2… returned previews_enabled: false",
    taskKey: "WEB-3",
    filedBy: "Platform Engineer",
    at: "2026-09-25T08:20:00.000Z",
    undone: null,
    docHref: "/org/settings?tab=resources&kb=akinozer-deploy-runbook&doc=runbook.md",
  };

  it("lists each with its document, what the passage was and is now, the evidence, the task and the agent", async () => {
    renderPage(view({ corrections: { shown: [correction], total: 1 } }));
    const panel = await screen.findByRole("region", { name: "Knowledge base" });
    // CANARY: drop the list and the owner has nothing to read afterwards.
    expect(within(panel).getByText("1 corrected")).toBeTruthy();
    expect(within(panel).getByText("akinozer-deploy-runbook/runbook.md")).toBeTruthy();
    expect(within(panel).getByText("5. Non-production branch builds: on").tagName).toBe("DEL");
    expect(within(panel).getByText(/previews_enabled: false\)$/)).toBeTruthy();
    expect(within(panel).getByText(correction.evidence)).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "WEB-3" }).getAttribute("href")).toBe(
      "/projects/viberr-core/tasks/WEB-3",
    );
    expect(within(panel).getByText(/Platform Engineer/)).toBeTruthy();
    expect(within(panel).getByText("kc-0123456789")).toBeTruthy();
    expect(within(panel).queryByText(/Open proposals/)).toBeNull();
  });

  it("Undo confirms first, then posts the undo with the reason, directly", async () => {
    const posted: Record<string, string>[] = [];
    renderPage(view({ corrections: { shown: [correction], total: 1 } }), "", async ({ request }) => {
      const form = await request.formData();
      posted.push(Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])));
      return { ok: true, toast: "Undid kc-0123456789." };
    });
    const panel = await screen.findByRole("region", { name: "Knowledge base" });
    fireEvent.click(within(panel).getByRole("button", { name: "Undo" }));
    expect(posted).toEqual([]);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Previews are on." } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Undo correction" }));
    });
    await waitFor(() => expect(posted).toHaveLength(1));
    // CANARY: send it to the controller and every undo costs a turn.
    expect(posted[0]).toMatchObject({ intent: "kb-correction-undo", id: "kc-0123456789", reason: "Previews are on." });
    expect(await screen.findByText("Undid kc-0123456789.")).toBeTruthy();
  });

  it("an undone correction says who undid it and offers nothing; a member is told who can undo", async () => {
    renderPage(
      view({
        corrections: {
          shown: [{ ...correction, undone: { at: "2026-09-25T09:00:00.000Z", by: "Akin", reason: "Previews are on." } }],
          total: 1,
        },
      }),
    );
    const panel = await screen.findByRole("region", { name: "Knowledge base" });
    expect(within(panel).getByText("Undone")).toBeTruthy();
    expect(within(panel).getByText(/Undone by Akin/).textContent).toContain(": Previews are on.");
    expect(within(panel).queryByRole("button", { name: "Undo" })).toBeNull();
    cleanup();

    renderPage(view({ viewerIsOrgAdmin: false, corrections: { shown: [{ ...correction, docHref: null }], total: 1 } }));
    const memberPanel = await screen.findByRole("region", { name: "Knowledge base" });
    expect(within(memberPanel).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(within(memberPanel).getByText("An org admin can undo a correction.")).toBeTruthy();
    expect(within(memberPanel).queryByRole("link", { name: "Open document" })).toBeNull();
  });

  it("a correction's link marks and focuses its entry; one no longer listed lands on the panel", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderPage(view({ corrections: { shown: [correction], total: 1 } }), "#correction-kc-0123456789");
    const panel = await screen.findByRole("region", { name: "Knowledge base" });
    const entry = panel.querySelector("#correction-kc-0123456789")!;
    // CANARY: drop `data-targeted` from the entry and nothing marks it.
    await waitFor(() => expect(entry.hasAttribute("data-targeted")).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(entry));
    cleanup();

    focus.mockClear();
    renderPage(view({ corrections: { shown: [correction], total: 25 } }), "#correction-kc-ffffffffff");
    const after = await screen.findByRole("region", { name: "Knowledge base" });
    expect(after.querySelector("[data-targeted]")).toBeNull();
    await waitFor(() => expect(focus.mock.contexts).toContain(after));
    focus.mockRestore();
  });

  it("says what fills it when nothing has been corrected, and how many it leaves out", async () => {
    renderPage(view());
    const panel = await screen.findByRole("region", { name: "Knowledge base" });
    expect(within(panel).getByText("0 corrected")).toBeTruthy();
    expect(within(panel).getByText(/No corrections yet/)).toBeTruthy();
    cleanup();
    renderPage(view({ corrections: { shown: [correction], total: 21 } }));
    const more = await screen.findByRole("region", { name: "Knowledge base" });
    expect(within(more).getByText("The newest 1 of 21. The audit log keeps the rest for 90 days.")).toBeTruthy();
  });
});

/**
 * Ruling 525: a conversation is deleted from the rail. Each row the viewer may
 * delete carries a Delete that asks first; the confirm says what goes, and for
 * whom when it is somebody else's. A thread the viewer may delete but not read
 * is listed without its words and opens nothing.
 */
describe("ruling 525: deleting a conversation from the rail", () => {
  const open: NonNullable<ControllerSurfaceView["conversation"]> = {
    id: "cnv_t",
    userId: "u1",
    userLabel: "arda@viberr.dev",
    projectSlug: "viberr-core",
    taskKey: "VIB-142",
    title: "Task thread",
    createdAt: "2026-09-01T11:00:00.000Z",
    updatedAt: "2026-09-01T11:00:00.000Z",
    lastMessageAt: "2026-09-01T11:00:00.000Z",
  };
  const sealed: ControllerSurfaceView["conversations"][number] = {
    id: "cnv_s",
    title: "Selin Aksoy's conversation",
    ownerLabel: "Selin Aksoy",
    own: false,
    lastMessageAt: "2026-09-01T09:00:00.000Z",
    projectSlug: "viberr-core",
    taskKey: "VIB-150",
    unread: false,
    readable: false,
    canDelete: true,
    working: true,
  };

  function recorded() {
    const posted: Record<string, string>[] = [];
    const record = async (request: Request) => {
      const form = await request.formData();
      posted.push(Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])));
    };
    return { posted, record };
  }

  it("offers Delete on the rows the viewer may delete, and asks before it posts", async () => {
    // CANARY: submit from the row's button directly and a post lands before
    // the dialog is answered.
    const { posted, record } = recorded();
    const v = view({ conversation: open, viewerOwnsActive: true });
    v.conversations = v.conversations.map((c) => (c.id === "cnv_t" ? { ...c, canDelete: false } : c));
    renderPage(v, "?c=cnv_t", async ({ request }) => {
      await record(request);
      return { ok: true, toast: "Conversation deleted." };
    });
    await screen.findByText("Board thread", { selector: ".ctl-conv-title" });
    expect(screen.getAllByRole("button", { name: /^Delete / }).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Delete Board thread",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Delete Board thread" }));
    expect(posted).toEqual([]);
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this conversation?" });
    expect(dialog.getAttribute("data-screen-label")).toBe("Delete conversation dialog");
    expect(dialog.textContent).toContain(
      "“Board thread” goes for good: its messages and the logs of its turns. This cannot be undone.",
    );
    const commit = within(dialog).getByRole("button", { name: "Delete conversation" });
    expect(commit.className).toBe("btn danger");
    await act(async () => {
      fireEvent.click(commit);
    });
    await screen.findByText("Conversation deleted.");
    // The page says which thread it has open, so the server can move it off
    // one it deletes; this one stays.
    expect(posted).toEqual([
      { _csrf: "tok", intent: "delete-conversation", conversationId: "cnv_b", open: "cnv_t" },
    ]);
  });

  it("says the open thread is deleted once the redirect off it lands, after any earlier result", async () => {
    // The redirect carries no result and the fetcher keeps the one it had.
    // CANARY: toast the redirect only while the fetcher holds no data, and the
    // second delete below lands silently.
    const { posted, record } = recorded();
    let search = "?c=cnv_t";
    function Probe() {
      search = useLocation().search;
      return null;
    }
    const v = view({ conversation: open, viewerOwnsActive: true });
    const Stub = createRoutesStub([
      {
        id: "root",
        path: "/",
        loader: () => ({ csrf: "tok", theme: "system" }),
        children: [
          {
            path: "projects/:slug/controller",
            Component: () => (
              <ToastProvider>
                <ControllerPage view={v} projectSlug="viberr-core" />
                <Probe />
              </ToastProvider>
            ),
            action: async ({ request }) => {
              await record(request);
              const last = posted.at(-1)!;
              return last.conversationId === last.open
                ? replace("/projects/viberr-core/controller")
                : { ok: true, toast: "The other one is deleted." };
            },
          },
        ],
      },
    ]);
    render(<Stub initialEntries={["/projects/viberr-core/controller?c=cnv_t"]} />);
    const remove = async (name: string) => {
      fireEvent.click(await screen.findByRole("button", { name }));
      const dialog = await screen.findByRole("alertdialog");
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Delete conversation" }));
      });
    };
    await remove("Delete Board thread");
    await screen.findByText("The other one is deleted.");
    await remove("Delete Task thread");
    await screen.findByText("Conversation deleted.");
    expect(search).toBe("");
    expect(posted.map((p) => [p.conversationId, p.open])).toEqual([
      ["cnv_b", "cnv_t"],
      ["cnv_t", "cnv_t"],
    ]);
  });

  it("lists a thread the viewer may delete but not read without its words, and opens nothing", async () => {
    // CANARY: render every row as a link and this one opens a transcript its
    // viewer may not read.
    const v = view({ showingAll: true, showAllAs: "project admin", viewerIsOrgAdmin: false });
    v.conversations = [...v.conversations, sealed];
    const { container } = renderPage(v, "?all=1");
    await screen.findByText("Selin Aksoy's conversation", { selector: ".ctl-conv-title" });
    expect(screen.queryByRole("link", { name: /Selin Aksoy/ })).toBeNull();
    expect(container.querySelector(".ctl-conv-sealed")?.textContent).toContain("Selin Aksoy's conversation");
    expect(screen.getByRole("link", { name: "Show mine only" })).toBeTruthy();
    const options = Array.from(screen.getByRole("combobox", { name: "Conversation" }).querySelectorAll("option"));
    expect(options.map((o) => o.textContent).join(" | ")).not.toContain("Selin");

    fireEvent.click(screen.getByRole("button", { name: "Delete Selin Aksoy's conversation" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete Selin Aksoy's conversation?" });
    expect(dialog.textContent).toMatch(
      /^Delete Selin Aksoy's conversation\?This conversation about VIB-150, last active .+, goes for good, for Selin Aksoy too: its messages and the logs of its turns\. The turn it is working on stops first\. This cannot be undone\./,
    );
  });

  it("names who the viewer lists everyone's as", async () => {
    renderPage(view({ showAllAs: "project admin", viewerIsOrgAdmin: false }));
    expect(await screen.findByRole("link", { name: "Show everyone's (project admin)" })).toBeTruthy();
  });
});

/**
 * Ruling 573: a person's files, on the page. A pasted screenshot joins the
 * composer's tray and goes out with the message; a message's files show under
 * its words, a picture as itself and any other file as the tray's chip, each
 * linking to the conversation's own serving route.
 */
describe("ruling 573: files on the controller page", () => {
  const conversation: NonNullable<ControllerSurfaceView["conversation"]> = {
    id: "cnv_f",
    userId: "u1",
    userLabel: "Akin",
    projectSlug: "viberr-core",
    taskKey: null,
    title: "Inventory",
    createdAt: "2026-09-28T20:00:00.000Z",
    updatedAt: "2026-09-28T20:00:00.000Z",
    lastMessageAt: "2026-09-28T20:00:00.000Z",
  };

  it("shows a message's files under it, each opening from the conversation's route", async () => {
    // CANARY: drop `<MessageFiles>` from the transcript and neither file shows.
    renderPage(
      view({
        conversation,
        viewerOwnsActive: true,
        messages: [
          {
            id: "m1",
            conversationId: "cnv_f",
            seq: 1,
            author: "user",
            userId: "u1",
            text: "",
            runId: null,
            surface: null,
            replyTo: null,
            steeredInto: null,
            createdAt: "2026-09-28T20:00:00.000Z",
            files: [
              { id: "cfile_a", name: "portal.png", bytes: 2048 },
              { id: "cfile_b", name: "inventory.csv", bytes: 16 },
            ],
          },
        ],
      }),
    );
    const sent = await screen.findByRole("list", { name: "2 files sent" });
    const links = within(sent).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/resources/controller-file/cfile_a",
      "/resources/controller-file/cfile_b",
    ]);
    expect(links[0]!.getAttribute("aria-label")).toBe("Open portal.png (2.0 KB)");
    expect(links[1]!.textContent).toContain("inventory.csv");
  });

  it("puts a pasted screenshot in the tray, and a tray alone may be sent", async () => {
    // CANARY: drop the composer's `onPaste` and the screenshot never joins;
    // keep Send's old `!text.trim()` and files alone cannot go. (The dock's
    // tests send a tray through the request itself.)
    const { container } = renderInstancePage(view({ available: true, projectName: null, conversations: [] }));
    await screen.findByText("Managing this instance with your own permissions.");
    const box = composer(container);
    const shot = new File(["png"], "image.png", { type: "image/png" });
    fireEvent.paste(box, { clipboardData: { files: [shot], types: ["Files"] } });
    expect(screen.getByRole("list", { name: "1 of 10 files attached" }).textContent).toContain("screenshot.png");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
  });
});
