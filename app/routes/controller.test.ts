import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { untilRunSettled } from "../../test-support/fake-runtime";
import { routeArgs, setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * The `interrupt` intent on both controller pages.
 *
 * The Live-run strip's Interrupt (confirmed on the page) posts the open
 * conversation and the working run's id; the route hands them to
 * `interruptControllerTurn`, which carries the ruling-251 scope to the engine.
 * The engine's authority (owner or org admin) answers a stranger with the
 * not-found shape, which `appErrorResponse` turns into a toast-shaped result
 * rather than a thrown response.
 */

let app: AppTestContext;
let selin: string; // conversation owner (contributor on viberr-core)
let murat: string; // another member of viberr-core
let arda: string; // org admin
let elif: string; // project admin on viberr-core, no org admin
let deniz: string; // org member, member of nothing
const SLUG = "viberr-core";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  selin = userIds.selin;
  murat = userIds.murat;
  arda = userIds.arda;
  elif = userIds.elif;
  deniz = userIds.deniz;
  const { connectFakeBackend } = await import("../../test-support/backend-credentials");
  await connectFakeBackend(app.db, selin, "claude");
});
afterAll(() => app.cleanup());

const okResult = z.object({ ok: z.literal(true), toast: z.string() });
/** A returned `data({ ok:false, error }, { status })`. */
const refusal = z.object({
  data: z.object({ ok: z.literal(false), error: z.string() }),
  init: z.object({ status: z.number() }).nullable(),
});

type Surface = "instance" | "project";

async function post(surface: Surface, userId: string, fields: Record<string, string>) {
  const { cookie, sessionId } = await app.cookieFor(userId);
  const body = new FormData();
  body.set("_csrf", await app.csrfFor(sessionId));
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  if (surface === "instance") {
    const { action } = await import("~/routes/controller");
    const request = app.request("/controller", { method: "POST", body, cookie });
    return action(routeArgs(request, {}, "/controller"));
  }
  const { action } = await import("~/routes/project.controller");
  const request = app.request(`/projects/${SLUG}/controller`, { method: "POST", body, cookie });
  return action(routeArgs(request, { slug: SLUG }, "/projects/:slug/controller"));
}

/** A conversation of selin's on the given surface, with a turn still working. */
async function workingTurn(surface: Surface) {
  const { createConversation } = await import(
    "~/server/controller/controller-conversations.server"
  );
  const { runControllerTurn } = await import("~/server/controller/controller-run.server");
  const { queueFakeRun } = await import("../../test-support/fake-runtime");
  const conversation = createConversation(app.db, {
    userId: selin,
    userLabel: "selin@viberr.dev",
    projectSlug: surface === "project" ? SLUG : null,
  });
  queueFakeRun({
    lines: [{ t: "1", ev: "text", tag: "assistant", text: "working" }],
    sessionId: "sess-route-stop",
    keepRunning: true,
  });
  const result = await runControllerTurn(app.db, {
    conversationId: conversation.id,
    text: "Take your time.",
    user: { id: selin, email: "selin@viberr.dev", name: "Selin", orgRole: "member" },
    dataRoot: app.dataRoot,
  });
  if (result.state !== "started") throw new Error(`turn ${result.state}`);
  return { conversationId: conversation.id, runId: result.runId };
}

/**
 * U35-4 (pass 35): a refused turn (no Claude connected for the asker, ruling
 * 137) used to answer `{ ok: true }` on both pages, so the HTTP door said yes
 * where the composer said no. The refusal stays in the transcript; the door
 * answers 409 with it. Murat has no fake credential here. Canary: restore
 * `{ ok: true }` in the `refused` branch.
 */
describe.each<Surface>(["instance", "project"])("POST intent=send on the %s surface", (surface) => {
  it("answers a refused turn with 409 and the refusal sentence", async () => {
    const reply = refusal.parse(
      await post(surface, murat, { intent: "send", text: "hello?" }),
    );
    expect(reply.init?.status).toBe(409);
    expect(reply.data.error).toContain("Claude isn't connected for you yet");
  });
});

describe.each<Surface>(["instance", "project"])("POST intent=interrupt on the %s surface", (surface) => {
  it("the owner stops the working turn and is told so", async () => {
    // Canary: drop the `interrupt` branch from `controllerPageAction` and this
    // answers the "Unknown action." refusal.
    const { getRun } = await import("~/server/runtimes/run-store.server");
    const { conversationId, runId } = await workingTurn(surface);
    const reply = okResult.parse(
      await post(surface, selin, { intent: "interrupt", conversationId, runId }),
    );
    expect(reply.toast).toBe("Turn interrupted. The transcript records that it was stopped.");
    await untilRunSettled(app.db, runId);
    expect(getRun(app.db, runId)?.state).toBe("interrupted");
    // A second press finds the turn already over, and says that instead.
    const again = okResult.parse(
      await post(surface, selin, { intent: "interrupt", conversationId, runId }),
    );
    expect(again.toast).toBe("That turn had already ended.");
  });

  it("another member gets a toast-shaped not-found, and the turn keeps working", async () => {
    const { getRun } = await import("~/server/runtimes/run-store.server");
    const { conversationId, runId } = await workingTurn(surface);
    const reply = refusal.parse(
      await post(surface, murat, { intent: "interrupt", conversationId, runId }),
    );
    expect(reply.init?.status).toBe(404);
    expect(getRun(app.db, runId)?.state).toBe("running");
    // Clean up: the owner stops it so nothing writes after the DB closes.
    await post(surface, selin, { intent: "interrupt", conversationId, runId });
    await untilRunSettled(app.db, runId);
  });
});

/**
 * Ruling 251 on both pages: a send while a turn works steers it unless its
 * form says `mode=queue`, and the owner's Send now and Retract act on a
 * message still waiting. Canary: drop `mode: sendModeOf(formData)` from the
 * send, or the `waitingMessageAction` branch, and the replies below differ.
 */
describe.each<Surface>(["instance", "project"])("ruling 251: steering and the queue on the %s surface", (surface) => {
  it("queues or steers as the form says; the owner may Send now and Retract, a stranger may not", async () => {
    const { conversationTurnState } = await import("~/server/controller/controller-run.server");
    const { conversationId, runId } = await workingTurn(surface);
    const send = (text: string, extra: Record<string, string> = {}) =>
      post(surface, selin, { intent: "send", text, conversationId, ...extra });
    await send("Queued on purpose.", { mode: "queue" });
    await send("Steering it.");
    const turn = conversationTurnState(app.db, conversationId);
    expect(turn.queued).toHaveLength(1);
    expect(turn.steering).toHaveLength(1);
    const queued = turn.queued[0]!.messageId;
    const steering = turn.steering[0]!;

    const now = okResult.parse(await post(surface, selin, { intent: "send-now", conversationId, messageId: queued }));
    expect(now.toast).toBe("It goes into the running turn at its next step.");
    expect(conversationTurnState(app.db, conversationId).steering).toEqual([steering, queued]);
    const back = z
      .object({ ok: z.literal(true), retracted: z.string(), toast: z.string() })
      .parse(await post(surface, selin, { intent: "retract", conversationId, messageId: steering }));
    expect(back.retracted).toBe("Steering it.");
    // Only the owner: another member gets the not-found shape.
    const stranger = refusal.parse(await post(surface, murat, { intent: "retract", conversationId, messageId: queued }));
    expect(stranger.init?.status).toBe(404);
    // One not waiting any more (this one is gone) is a 409 sentence, not a throw.
    const gone = refusal.parse(await post(surface, selin, { intent: "retract", conversationId, messageId: steering }));
    expect(gone.init?.status).toBe(409);
    expect(gone.data.error).toBe("That message has already been read, so it can't be taken back.");

    // Clean up: stop the turn; the message still waiting runs its own and settles.
    await post(surface, selin, { intent: "interrupt", conversationId, runId });
    await untilRunSettled(app.db, runId);
    for (let i = 0; i < 400 && conversationTurnState(app.db, conversationId).answering; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
});

/**
 * Ruling 250: the rail's Delete posts `delete-conversation` with the thread the
 * page has open. Deleting another thread answers a toast; deleting the open one
 * answers a redirect to where a bare visit lands, replacing the history entry
 * that named it, since its URL now answers 404. Canary: drop the `open` branch
 * and the page is left on a thread that is gone.
 */
describe.each<Surface>(["instance", "project"])("POST intent=delete-conversation on the %s surface", (surface) => {
  const page = surface === "instance" ? "/controller" : `/projects/${SLUG}/controller`;

  async function selinsThread(): Promise<string> {
    const { createConversation } = await import(
      "~/server/controller/controller-conversations.server"
    );
    return createConversation(app.db, {
      userId: selin,
      userLabel: "selin@viberr.dev",
      projectSlug: surface === "project" ? SLUG : null,
    }).id;
  }

  async function gone(conversationId: string): Promise<boolean> {
    const { getConversation } = await import(
      "~/server/controller/controller-conversations.server"
    );
    return getConversation(app.db, conversationId) === null;
  }

  it("deletes a thread the page is not showing, and says so", async () => {
    const other = await selinsThread();
    const open = await selinsThread();
    const reply = okResult.parse(
      await post(surface, selin, { intent: "delete-conversation", conversationId: other, open }),
    );
    expect(reply.toast).toBe("Conversation deleted.");
    expect(await gone(other)).toBe(true);
    expect(await gone(open)).toBe(false);
  });

  it("moves the page off the thread it deletes, in place of the entry that named it", async () => {
    for (const all of [false, true]) {
      const open = await selinsThread();
      const fields = { intent: "delete-conversation", conversationId: open, open };
      const reply = await post(surface, selin, all ? { ...fields, all: "1" } : fields);
      if (!(reply instanceof Response)) throw new Error("expected a redirect");
      expect(reply.status).toBe(302);
      expect(reply.headers.get("Location")).toBe(all ? `${page}?all=1` : page);
      expect(reply.headers.get("X-Remix-Replace")).toBe("true");
      expect(await gone(open)).toBe(true);
    }
  });

  it("refuses a member who may not, and the thread stays", async () => {
    const thread = await selinsThread();
    const reply = refusal.parse(
      await post(surface, murat, { intent: "delete-conversation", conversationId: thread }),
    );
    // On the project page a maintainer is told who may; on the instance page,
    // which no project role reaches, the thread is not found, as for reading.
    expect(reply.init?.status).toBe(surface === "project" ? 403 : 404);
    expect(await gone(thread)).toBe(false);
    if (surface === "project") {
      const done = okResult.parse(
        await post(surface, elif, { intent: "delete-conversation", conversationId: thread }),
      );
      expect(done.toast).toBe("Conversation deleted.");
      expect(await gone(thread)).toBe(true);
    }
  });
});

/**
 * Ruling 321: the Knowledge base panel's Undo posts `kb-correction-undo`, and
 * the route undoes the correction itself, no controller turn, for an org admin
 * only: the undo edits an org knowledge base. Canary: drop the org-admin check
 * and a member rewrites what every run reads.
 */
describe("POST intent=kb-correction-undo on the project surface (ruling 321)", () => {
  it("an org admin undoes a correction; a member is refused and nothing changes", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { saveKnowledgeBase, resolveStoreTarget } = await import("~/server/org/resources.server");
    const { writeStoreDoc } = await import("~/server/org/store-files.server");
    const { mergeKbCorrection } = await import("~/server/org/kb-corrections.server");
    const admin = { userId: arda, label: "arda" };
    const { kb } = await saveKnowledgeBase(app.db, { name: "route-runbook", refresh: "on change" }, admin, {
      dataRoot: app.dataRoot,
    });
    const target = resolveStoreTarget(app.db, "kb", kb.id, { dataRoot: app.dataRoot })!;
    writeStoreDoc(app.db, target, [], "runbook.md", "# Step 1\n\n- Preview builds: on\n", admin);
    const merged = await mergeKbCorrection(
      app.db,
      {
        kb: kb.dir,
        doc: "runbook.md",
        replaces: "- Preview builds: on",
        text: "- Preview builds: off",
        evidence: "previews_enabled: false",
        projectSlug: SLUG,
        taskKey: "VIB-142",
        filedBy: "Platform Engineer",
        actorRef: "operator",
        rulings: false,
        actor: { userId: null, label: "operator" },
      },
      { dataRoot: app.dataRoot },
    );
    if (!merged.ok) throw new Error(merged.message);
    const id = merged.correction.id;
    const doc = () => readFileSync(path.join(app.dataRoot, "kb", kb.dir, "runbook.md"), "utf8");

    const refused = refusal.parse(await post("project", murat, { intent: "kb-correction-undo", id }));
    expect(refused.init?.status).toBe(403);
    expect(refused.data.error).toContain("Only an org admin can undo a knowledge-base correction");
    expect(doc()).toBe("# Step 1\n\n- Preview builds: off\n");

    const done = okResult.parse(
      await post("project", arda, { intent: "kb-correction-undo", id, reason: "Previews are on." }),
    );
    expect(done.toast).toContain(`Undid ${id}`);
    expect(doc()).toBe("# Step 1\n\n- Preview builds: on\n");
  });
});

/**
 * U33-8 — the two controller PAGE loaders open the same thread the dock would.
 *
 * Ruling 256 gave the dock a continuity rule ("the newest thread of the scope
 * you are standing in"); the page answered a blank composer, so one person on
 * one scope got two different answers from the two entry points. These pin the
 * page half of that rule: a bare URL opens the scope's newest thread, `?c=new`
 * is the blank composer the New link asks for, an explicit id still wins, and
 * the default is drawn from threads the viewer can actually talk in.
 */
describe("the controller page's opening thread (U33-8)", () => {
  const pageView = z.object({
    view: z.object({
      conversation: z.object({ id: z.string() }).nullable(),
      conversations: z.array(z.object({ id: z.string() })),
    }),
  });

  async function instancePage(userId: string, query: string) {
    const { loader } = await import("~/routes/controller");
    const { cookie } = await app.cookieFor(userId);
    const request = app.request(`/controller${query}`, { cookie });
    return pageView.parse(
      await loader(routeArgs(request, {}, "/controller")),
    );
  }

  async function projectPage(userId: string, query: string) {
    const { loader } = await import("~/routes/project.controller");
    const { cookie } = await app.cookieFor(userId);
    const request = app.request(`/projects/${SLUG}/controller${query}`, { cookie });
    return pageView.parse(
      await loader(routeArgs(request, { slug: SLUG }, "/projects/:slug/controller")),
    );
  }

  async function start(input: {
    userId: string;
    label: string;
    projectSlug?: string | null;
    taskKey?: string | null;
  }) {
    const { createConversation } = await import(
      "~/server/controller/controller-conversations.server"
    );
    return createConversation(app.db, {
      userId: input.userId,
      userLabel: input.label,
      projectSlug: input.projectSlug ?? null,
      taskKey: input.taskKey ?? null,
    });
  }

  it("opens the instance scope's newest thread when nothing is selected", async () => {
    const older = await start({ userId: arda, label: "arda@viberr.dev" });
    const newest = await start({ userId: arda, label: "arda@viberr.dev" });
    expect((await instancePage(arda, "")).view.conversation?.id).toBe(newest.id);
    // "New" still starts a fresh thread, and an explicit id still wins.
    expect((await instancePage(arda, "?c=new")).view.conversation).toBeNull();
    expect((await instancePage(arda, `?c=${older.id}`)).view.conversation?.id).toBe(
      older.id,
    );
  });

  it("opens the project scope's newest thread, task-anchored ones included", async () => {
    const board = await start({
      userId: arda,
      label: "arda@viberr.dev",
      projectSlug: SLUG,
    });
    const task = await start({
      userId: arda,
      label: "arda@viberr.dev",
      projectSlug: SLUG,
      taskKey: "VIB-142",
    });
    // The rail lists both, so the default may be either — here, the task one.
    const opened = await projectPage(arda, "");
    expect(opened.view.conversation?.id).toBe(task.id);
    expect(opened.view.conversations.map((c) => c.id)).toContain(board.id);
    expect((await projectPage(arda, "?c=new")).view.conversation).toBeNull();
    expect((await projectPage(arda, `?c=${board.id}`)).view.conversation?.id).toBe(
      board.id,
    );
    // The instance page keeps its own scope: neither of these is its default.
    const elsewhere = (await instancePage(arda, "")).view.conversation?.id;
    expect([board.id, task.id]).not.toContain(elsewhere);
  });

  it("defaults to the viewer's own newest thread, never someone else's", async () => {
    // A scope with nothing in it still opens the blank composer.
    expect((await instancePage(deniz, "")).view.conversation).toBeNull();
    const mine = await start({ userId: arda, label: "arda@viberr.dev" });
    const theirs = await start({ userId: deniz, label: "deniz@viberr.dev" });
    // An org admin reading everyone's (?all=1) sees Deniz's newer thread in the
    // rail but opens their own: the default has to land somewhere they can talk.
    const all = await instancePage(arda, "?all=1");
    expect(all.view.conversations.map((c) => c.id)).toContain(theirs.id);
    expect(all.view.conversation?.id).toBe(mine.id);
    expect((await instancePage(arda, "")).view.conversation?.id).toBe(mine.id);
  });
});
