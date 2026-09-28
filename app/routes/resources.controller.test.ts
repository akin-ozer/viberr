import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * Ruling 121 — the controller dock's resource route.
 *
 * GET answers the scope the person is standing in, with the members-only 404
 * (byte-identical to the layout's) for a project they cannot see and the task
 * route's own 404 for a task that does not exist. POST records the message
 * under a conversation bound to that exact scope; a CSRF failure is a
 * toast-shaped result, never a thrown Response (the dock lives in root).
 */

let app: AppTestContext;
let arda: string; // org admin + project admin on viberr-core
let deniz: string; // org member, member of nothing
const SLUG = "viberr-core";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  arda = userIds.arda;
  deniz = userIds.deniz;
});
afterAll(() => app.cleanup());

/** A returned `data({ ok:false, error }, { status })`. */
const returnedRefusal = z.object({
  data: z.object({ ok: z.literal(false), error: z.string() }),
  init: z.object({ status: z.number() }).nullable(),
});

const loaderView = z.object({
  view: z.object({
    unavailable: z.boolean(),
    staleSelection: z.boolean(),
    scope: z.object({
      kind: z.enum(["instance", "board", "task"]),
      projectName: z.string().nullable(),
      label: z.string(),
      contextLine: z.string(),
      pageHref: z.string(),
    }),
    conversation: z.object({ id: z.string(), taskKey: z.string().nullable() }).nullable(),
    threads: z.array(z.object({ id: z.string() })),
    messages: z.array(z.object({ author: z.string(), surface: z.string().nullable() })),
  }),
});

/** One GET, signed in with `cookie` or with no session at all. */
async function load(query: string, cookie?: string) {
  const { loader } = await import("~/routes/resources.controller");
  const request = app.request(`/resources/controller${query}`, cookie ? { cookie } : {});
  return loader({
    request,
    url: new URL(request.url),
    params: {},
    pattern: "/resources/controller",
    context: new RouterContextProvider(),
  });
}

async function get(userId: string, query: string) {
  return load(query, (await app.cookieFor(userId)).cookie);
}

/** Runs `body` with a forced password reset pending for `userId`. */
async function withPendingReset<T>(userId: string, body: () => Promise<T>): Promise<T> {
  const { updateUserFields } = await import("~/server/auth/user-store.server");
  updateUserFields(app.db, userId, { pwresetRequired: true });
  try {
    return await body();
  } finally {
    updateUserFields(app.db, userId, { pwresetRequired: false });
  }
}

/** One POST, signed in with `cookie` or with no session at all. */
async function submit(fields: Record<string, string>, cookie?: string, files: readonly File[] = []) {
  const { action } = await import("~/routes/resources.controller");
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  for (const file of files) body.append("files", file);
  const init: RequestInit & { cookie?: string } = { method: "POST", body };
  if (cookie) init.cookie = cookie;
  const request = app.request("/resources/controller", init);
  return action({
    request,
    url: new URL(request.url),
    params: {},
    pattern: "/resources/controller",
    context: new RouterContextProvider(),
  });
}

async function post(userId: string, fields: Record<string, string>, csrf?: string, files: readonly File[] = []) {
  const { cookie, sessionId } = await app.cookieFor(userId);
  return submit({ _csrf: csrf ?? (await app.csrfFor(sessionId)), ...fields }, cookie, files);
}

describe("GET /resources/controller", () => {
  it("answers instance scope for any signed-in user", async () => {
    const res = loaderView.parse(await get(deniz, ""));
    expect(res.view.scope.kind).toBe("instance");
    expect(res.view.scope.label).toBe("Instance");
    expect(res.view.scope.pageHref).toBe("/controller");
  });

  /**
   * Review finding 2. This loader feeds a ROOT-OWNED fetcher, so a thrown
   * response is routed to root's error boundary and replaces the whole page.
   * A scope the person cannot reach therefore answers a benign, empty view —
   * one shape for "no such project" and "not yours", so it is no more of an
   * oracle than the 404 it replaces — and the page routes keep their own 404s.
   */
  it("answers an unreachable scope with an empty view, never a thrown response", async () => {
    const nonMember = loaderView.parse(await get(deniz, `?project=${SLUG}`));
    const unknown = loaderView.parse(await get(arda, "?project=no-such-project"));
    const unknownTask = loaderView.parse(await get(arda, `?project=${SLUG}&task=VIB-999`));
    for (const res of [nonMember, unknown, unknownTask]) {
      expect(res.view.unavailable).toBe(true);
      expect(res.view.conversation).toBeNull();
      expect(res.view.threads).toEqual([]);
      expect(res.view.scope.contextLine).toBe(
        "Not available here: this project or task is not open to you.",
      );
    }
    // Identical shape for the forbidden and the missing project.
    expect(nonMember.view.unavailable).toBe(unknown.view.unavailable);
    expect(nonMember.view.scope.contextLine).toBe(unknown.view.scope.contextLine);
    // F35-4 (pass 35): the refusal leaks no display name. A non-member used
    // to read `projectName: "Viberr Core"` and a label built from it off a
    // typed slug, while every other door answers the slug alone. Canary:
    // restore the `describeDockScope` spread in `unavailableDockView`.
    expect(nonMember.view.scope.projectName).toBeNull();
    expect(nonMember.view.scope.label).toBe("Not available here");
    expect(JSON.stringify(nonMember.view)).not.toContain("Viberr Core");
  });

  /**
   * Ruling 457, test audit L14-29. The open dock loads this through a
   * root-owned fetcher, and `requireAuth` answered a missing session with a
   * login redirect whose returnTo was this route and the scope's query: a
   * stale tab's open went to /login and, once signed in, to a page of raw
   * JSON. No session, or a forced password reset pending, answers 401 with a
   * view that says so, returned (a thrown response replaces the page), built
   * from the scope the page asked about with nothing read for a caller who
   * is not signed in.
   */
  it("answers a signed-out load 401 with the signed-out view, never a login redirect", async () => {
    const query = `?project=${SLUG}&task=VIB-142&seen=1`;
    const { cookie } = await app.cookieFor(arda);
    const answers = [await load(query), await withPendingReset(arda, () => load(query, cookie))];
    for (const answer of answers) {
      // CANARY: guard with `requireAuth` again and both loads reject with its
      // 302 to /login?returnTo=%2Fresources%2Fcontroller%3Fproject%3D….
      expect(answer).toMatchObject({
        init: { status: 401 },
        data: {
          view: {
            signedOut: true,
            unavailable: true,
            available: false,
            conversation: null,
            messages: [],
            threads: [],
            scope: {
              kind: "task",
              projectSlug: SLUG,
              taskKey: "VIB-142",
              projectName: null,
              label: "Signed out",
              contextLine: "Signed out: sign in again to talk to the controller.",
              pageHref: `/projects/${SLUG}/controller`,
            },
          },
        },
      });
      // Arda's project is not named to a caller nobody signed in as.
      expect(JSON.stringify(answer)).not.toContain("Viberr Core");
    }
  });

  it("answers the task scope, newest thread first, and refuses a thread from another scope", async () => {
    const { createConversation } = await import(
      "~/server/controller/controller-conversations.server"
    );
    const older = createConversation(app.db, {
      userId: arda,
      userLabel: "arda@viberr.dev",
      projectSlug: SLUG,
      taskKey: "VIB-142",
    });
    const newer = createConversation(app.db, {
      userId: arda,
      userLabel: "arda@viberr.dev",
      projectSlug: SLUG,
      taskKey: "VIB-142",
    });
    const board = createConversation(app.db, {
      userId: arda,
      userLabel: "arda@viberr.dev",
      projectSlug: SLUG,
    });
    const res = loaderView.parse(await get(arda, `?project=${SLUG}&task=VIB-142`));
    expect(res.view.scope.kind).toBe("task");
    expect(res.view.scope.label).toBe("VIB-142 · Viberr Core");
    expect(res.view.scope.contextLine).toBe(
      "Knows the VIB-142 task file and its place in the Viberr Core workflow · acts with your permissions",
    );
    expect(res.view.conversation?.id).toBe(newer.id);
    expect(res.view.threads.map((t) => t.id)).toEqual([newer.id, older.id]);
    // `c=new` means no conversation; an explicit id must belong to this scope.
    expect(loaderView.parse(await get(arda, `?project=${SLUG}&task=VIB-142&c=new`)).view.conversation).toBeNull();
    expect(loaderView.parse(await get(arda, `?project=${SLUG}&task=VIB-142&c=${older.id}`)).view.conversation?.id).toBe(older.id);
    // A thread from another scope is not an error either: the view falls back
    // to this scope's newest thread and flags the stale selection so the dock
    // forgets the id it asked for (review finding 2).
    const foreign = loaderView.parse(await get(arda, `?project=${SLUG}&task=VIB-142&c=${board.id}`));
    expect(foreign.view.staleSelection).toBe(true);
    expect(foreign.view.conversation?.id).toBe(newer.id);
    expect(loaderView.parse(await get(arda, `?project=${SLUG}&task=VIB-142`)).view.staleSelection).toBe(false);
    // The board scope lists only its own threads.
    const boardView = loaderView.parse(await get(arda, `?project=${SLUG}`));
    expect(boardView.view.threads.map((t) => t.id)).toContain(board.id);
    expect(boardView.view.threads.map((t) => t.id)).not.toContain(newer.id);
  });

  /** O39-d: `seen=1` is the open panel reading; a closed dock's poll is not. */
  it("marks the transcript seen only when the open panel asks with seen=1", async () => {
    const { appendMessage, createConversation, listUnseenReplies } = await import(
      "~/server/controller/controller-conversations.server"
    );
    const c = createConversation(app.db, {
      userId: arda,
      userLabel: "arda@viberr.dev",
      projectSlug: SLUG,
      taskKey: "VIB-141",
    });
    appendMessage(app.db, { conversationId: c.id, author: "controller", text: "Done." });
    const unseen = () => listUnseenReplies(app.db, arda).map((r) => r.id);
    await get(arda, `?project=${SLUG}&task=VIB-141&c=${c.id}`);
    // CANARY: drop the `seen` param from the loader's `markSeen` and either
    // this stays unseen below or is marked here.
    expect(unseen()).toContain(c.id);
    await get(arda, `?project=${SLUG}&task=VIB-141&c=${c.id}&seen=1`);
    expect(unseen()).not.toContain(c.id);
  });
});

describe("POST /resources/controller", () => {
  it("maps a CSRF failure to a toast-shaped 403, never a thrown Response", async () => {
    const reply = returnedRefusal.parse(await post(arda, { intent: "send", text: "hi" }, "stale-token"));
    expect(reply.init?.status).toBe(403);
    expect(reply.data.error).toMatch(/expired/);
  });

  /**
   * Ruling 457, test audit L14-29. The dock's send is a fetcher submit, and
   * `requireAuth` answered a missing session with a login redirect naming this
   * route, so signing in again opened a page of raw JSON. No session, or a
   * forced password reset pending, answers 401 with the sentence the dock
   * toasts; the message stays in its composer (ruling 259).
   */
  it("answers a signed-out send 401 with a sentence, never a login redirect", async () => {
    const { cookie, sessionId } = await app.cookieFor(deniz);
    const fields = { _csrf: await app.csrfFor(sessionId), intent: "send", text: "Where are we?" };
    const replies = [
      await submit(fields),
      await withPendingReset(deniz, () => submit(fields, cookie)),
    ];
    for (const reply of replies) {
      // CANARY: guard with `requireAuth` again and both sends reject with its
      // 302 to /login?returnTo=%2Fresources%2Fcontroller.
      const refused = returnedRefusal.parse(reply);
      expect(refused.init?.status).toBe(401);
      expect(refused.data.error).toBe(
        "You're signed out, so this wasn't sent. Copy it, then reload the page to sign in again.",
      );
    }
  });

  /**
   * U35-4 (pass 35): the dock disables its composer for a person with no
   * Claude connected (ruling 127), and this door used to answer 200 `{ ok }`
   * anyway, creating a thread whose only reply was the refusal. The hermetic
   * root has no credential, so this is exactly arda's state here. Canary:
   * restore `{ ok: true }` for a refused turn (or drop the availability check
   * before `createConversation`).
   */
  it("refuses a send with no Claude connected: 409, the refusal sentence, and no thread created", async () => {
    const { listConversations } = await import(
      "~/server/controller/controller-conversations.server"
    );
    const before = listConversations(app.db, { userId: arda }).length;
    const refused = returnedRefusal.parse(
      await post(arda, {
        intent: "send",
        text: "What is this task about?",
        project: SLUG,
        task: "VIB-142",
        conversationId: "new",
      }),
    );
    expect(refused.init?.status).toBe(409);
    expect(refused.data.error).toContain("Claude isn't connected for you yet");
    expect(listConversations(app.db, { userId: arda }).length).toBe(before);
  });

  /**
   * Pass-35 review: "unavailable" is TWO states. A `login` credential whose
   * sign-in file is gone from this server has its own sentence, and the door
   * refuses before any transcript exists, so this 409 body is the only place
   * the person can read it. Canary: answer the flat
   * `CONTROLLER_NOT_CONNECTED_NOTE` at the door again.
   */
  it("names the wiped sign-in file at the door, not the generic isn't-connected sentence", async () => {
    const { recordBackendLogin, disconnectBackendAccount, loginTargetFor } = await import(
      "~/server/runtimes/backend-credentials.server"
    );
    const actor = { userId: arda, label: "arda@viberr.dev" };
    const target = loginTargetFor(app.db, arda, "claude");
    recordBackendLogin(app.db, actor, "claude", "claudeai", {}, target);
    try {
      const refused = returnedRefusal.parse(
        await post(arda, {
          intent: "send",
          text: "What is this task about?",
          project: SLUG,
          conversationId: "new",
        }),
      );
      expect(refused.init?.status).toBe(409);
      expect(refused.data.error).toContain("sign-in file is missing from this server");
      expect(refused.data.error).not.toContain("Claude isn't connected for you yet");
    } finally {
      await disconnectBackendAccount(app.db, actor, target.id);
    }
  });

  /**
   * Pass-35 review: the POST-turn arm is its own door. An EXISTING conversation
   * skips the availability pre-check, so a credential that stopped being
   * available between the dock's view load and the send lands here. Canary:
   * delete the `result.state === "refused"` block and this goes green on a
   * `{ ok: true }` that answers nothing.
   */
  it("answers 409 for a refused turn on an existing conversation", async () => {
    const { createConversation, listMessages } = await import(
      "~/server/controller/controller-conversations.server"
    );
    const thread = createConversation(app.db, {
      userId: arda,
      userLabel: "arda@viberr.dev",
      projectSlug: SLUG,
    });
    const refused = returnedRefusal.parse(
      await post(arda, {
        intent: "send",
        text: "Are you there?",
        project: SLUG,
        conversationId: thread.id,
      }),
    );
    expect(refused.init?.status).toBe(409);
    expect(refused.data.error).toContain("Claude isn't connected for you yet");
    // The same sentence is in the transcript the reload shows.
    const messages = listMessages(app.db, thread.id);
    expect(messages[messages.length - 1]).toMatchObject({ author: "controller" });
  });

  it("creates a conversation bound to the exact scope, records the surface, and runs the turn", async () => {
    const { connectFakeBackend, disconnectFakeBackend } = await import(
      "../../test-support/backend-credentials"
    );
    const { queueFakeRun } = await import("../../test-support/fake-runtime");
    await connectFakeBackend(app.db, arda, "claude");
    try {
      queueFakeRun({
        lines: [{ t: "1", ev: "text", tag: "assistant", text: "It is about the task." }],
        sessionId: "sess-dock-send",
      });
      const reply = z
        .object({ ok: z.literal(true), conversationId: z.string() })
        .parse(
          await post(arda, {
            intent: "send",
            text: "What is this task about?",
            project: SLUG,
            task: "VIB-142",
            surface: "/projects/viberr-core/tasks/VIB-142",
          }),
        );
      const { getConversation, listMessages } = await import(
        "~/server/controller/controller-conversations.server"
      );
      const conversation = getConversation(app.db, reply.conversationId)!;
      expect(conversation.projectSlug).toBe(SLUG);
      expect(conversation.taskKey).toBe("VIB-142");
      const messages = listMessages(app.db, conversation.id);
      expect(messages[0]).toMatchObject({ author: "user", surface: "/projects/viberr-core/tasks/VIB-142" });
      // The dock then reads it back as the newest thread of that scope.
      const res = loaderView.parse(await get(arda, `?project=${SLUG}&task=VIB-142`));
      expect(res.view.conversation?.id).toBe(conversation.id);
      // Let the fake turn settle before the store closes.
      for (let i = 0; i < 200; i += 1) {
        if (listMessages(app.db, conversation.id).some((m) => m.author === "controller")) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      await disconnectFakeBackend(app.db, arda, "claude");
    }
  });

  it("refuses to speak in a thread from another scope, and applies the members-only 404 on send", async () => {
    const { createConversation } = await import(
      "~/server/controller/controller-conversations.server"
    );
    const board = createConversation(app.db, {
      userId: arda,
      userLabel: "arda@viberr.dev",
      projectSlug: SLUG,
    });
    const foreign = returnedRefusal.parse(
      await post(arda, {
        intent: "send",
        text: "hi",
        project: SLUG,
        task: "VIB-142",
        conversationId: board.id,
      }),
    );
    expect(foreign.init?.status).toBe(404);
    expect(foreign.data.error).toBe("Conversation not found.");
    const nonMember = returnedRefusal.parse(
      await post(deniz, { intent: "send", text: "hi", project: SLUG }),
    );
    expect(nonMember.init?.status).toBe(404);
    expect(nonMember.data.error).toBe("That project or task is not open to you.");
  });

  it("ruling 527: a send queues when its form says so, and Retract answers at this door", async () => {
    // CANARY: drop `mode: sendModeOf(formData)` from this route's send and the
    // second message steers; drop its `waitingMessageAction` branch and
    // Retract is an unknown action.
    const { connectFakeBackend, disconnectFakeBackend } = await import(
      "../../test-support/backend-credentials"
    );
    const { queueFakeRun } = await import("../../test-support/fake-runtime");
    const { conversationTurnState, interruptControllerTurn } = await import(
      "~/server/controller/controller-run.server"
    );
    await connectFakeBackend(app.db, arda, "claude");
    try {
      queueFakeRun({
        lines: [{ t: "1", ev: "text", tag: "assistant", text: "working" }],
        sessionId: "sess-dock-527",
        keepRunning: true,
      });
      const sent = z.object({ ok: z.literal(true), conversationId: z.string() });
      const { conversationId } = sent.parse(
        await post(arda, { intent: "send", text: "Take your time.", project: SLUG }),
      );
      sent.parse(
        await post(arda, { intent: "send", text: "Queued.", project: SLUG, conversationId, mode: "queue" }),
      );
      const turn = conversationTurnState(app.db, conversationId);
      expect(turn.queued).toHaveLength(1);
      const messageId = turn.queued[0]!.messageId;
      const back = z
        .object({ ok: z.literal(true), retracted: z.string() })
        .parse(await post(arda, { intent: "retract", conversationId, messageId }));
      expect(back.retracted).toBe("Queued.");
      const gone = returnedRefusal.parse(await post(arda, { intent: "retract", conversationId, messageId }));
      expect(gone.init?.status).toBe(409);
      await interruptControllerTurn(
        app.db,
        { conversationId, runId: turn.runId!, dataRoot: app.dataRoot },
        { userId: arda, label: "arda@viberr.dev" },
      );
      for (let i = 0; i < 400 && conversationTurnState(app.db, conversationId).answering; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      await disconnectFakeBackend(app.db, arda, "claude");
    }
  });

  it("rejects an unknown intent", async () => {
    const reply = returnedRefusal.parse(await post(arda, { intent: "delete-everything" }));
    expect(reply.init?.status).toBe(400);
  });
});

/**
 * Ruling 565: a message carries files. They are checked before any thread is
 * made, stored with the message, named to the turn, served to the thread's
 * owner alone from `/resources/controller-file/:id`, and a retracted message
 * takes them with it.
 */
describe("ruling 565: files sent with a controller message", () => {
  async function serve(fileId: string, userId: string) {
    const { loader } = await import("~/routes/resources.controller-file");
    const request = app.request(`/resources/controller-file/${fileId}`, {
      cookie: (await app.cookieFor(userId)).cookie,
    });
    return loader({
      request,
      url: new URL(request.url),
      params: { id: fileId },
      pattern: "/resources/controller-file/:id",
      context: new RouterContextProvider(),
    });
  }

  it("refuses a file the upload rules refuse before any thread exists", async () => {
    // CANARY: drop `checkMessageFiles` from this route's send and the refusal
    // comes from the engine, after an empty thread was made.
    const { connectFakeBackend, disconnectFakeBackend } = await import(
      "../../test-support/backend-credentials"
    );
    const { listConversations } = await import("~/server/controller/controller-conversations.server");
    await connectFakeBackend(app.db, arda, "claude");
    try {
      const before = listConversations(app.db, { userId: arda }).length;
      const refused = returnedRefusal.parse(
        await post(arda, { intent: "send", text: "Look at this.", project: SLUG }, undefined, [
          new File([new Uint8Array(10 * 1024 * 1024 + 1)], "memory.dmp"),
        ]),
      );
      expect(refused.init?.status).toBe(400);
      expect(refused.data.error).toContain("memory.dmp");
      expect(listConversations(app.db, { userId: arda }).length).toBe(before);
    } finally {
      await disconnectFakeBackend(app.db, arda, "claude");
    }
  });

  it("stores the files with the message, names them to the turn, and serves them to the owner alone", async () => {
    // CANARY: drop `withFilesNote` from the turn's start and the prompt never
    // mentions `inventory.csv`; drop the access check in the serving route and
    // deniz reads arda's file.
    const { connectFakeBackend, disconnectFakeBackend } = await import(
      "../../test-support/backend-credentials"
    );
    const { queueFakeRun, lastRunSpec } = await import("../../test-support/fake-runtime");
    const { getConversation, listMessages } = await import(
      "~/server/controller/controller-conversations.server"
    );
    await connectFakeBackend(app.db, arda, "claude");
    try {
      queueFakeRun({ lines: [{ t: "1", ev: "text", tag: "assistant", text: "Read it." }], sessionId: "sess-565" });
      const { conversationId } = z
        .object({ ok: z.literal(true), conversationId: z.string() })
        .parse(
          await post(arda, { intent: "send", text: "", project: SLUG }, undefined, [
            new File(["host,cpu\nvm-1,4\n"], "inventory.csv"),
          ]),
        );
      // Files alone are a message, titled by their names.
      expect(getConversation(app.db, conversationId)?.title).toBe("inventory.csv");
      const [asked] = listMessages(app.db, conversationId);
      expect(asked).toMatchObject({ author: "user", text: "", files: [{ name: "inventory.csv", bytes: 16 }] });
      expect(lastRunSpec()?.prompt).toContain("`inventory.csv` (1 KB)");
      expect(lastRunSpec()?.prompt).toContain("read_message_file");

      const served = await serve(asked!.files![0]!.id, arda);
      expect(served.status).toBe(200);
      expect(await served.text()).toBe("host,cpu\nvm-1,4\n");
      expect(served.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await serve(asked!.files![0]!.id, deniz)).status).toBe(404);
      for (let i = 0; i < 200; i += 1) {
        if (listMessages(app.db, conversationId).some((m) => m.author === "controller")) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      await disconnectFakeBackend(app.db, arda, "claude");
    }
  });

  it("hands back a retracted message's words alone, and its files leave with it", async () => {
    // CANARY: keep the note in the waiting message's text and Retract puts
    // "A file came with this message…" into the person's composer.
    const { connectFakeBackend, disconnectFakeBackend } = await import(
      "../../test-support/backend-credentials"
    );
    const { queueFakeRun } = await import("../../test-support/fake-runtime");
    const { conversationTurnState, interruptControllerTurn } = await import(
      "~/server/controller/controller-run.server"
    );
    const { listConversationFileNames } = await import("~/server/controller/controller-conversations.server");
    await connectFakeBackend(app.db, arda, "claude");
    try {
      queueFakeRun({
        lines: [{ t: "1", ev: "text", tag: "assistant", text: "working" }],
        sessionId: "sess-565-retract",
        keepRunning: true,
      });
      const sent = z.object({ ok: z.literal(true), conversationId: z.string() });
      const { conversationId } = sent.parse(await post(arda, { intent: "send", text: "Start.", project: SLUG }));
      sent.parse(
        await post(arda, { intent: "send", text: "And this.", project: SLUG, conversationId, mode: "queue" }, undefined, [
          new File(["a"], "notes.txt"),
        ]),
      );
      expect(listConversationFileNames(app.db, conversationId)).toEqual(["notes.txt"]);
      const turn = conversationTurnState(app.db, conversationId);
      const back = z
        .object({ ok: z.literal(true), retracted: z.string() })
        .parse(await post(arda, { intent: "retract", conversationId, messageId: turn.queued[0]!.messageId }));
      expect(back.retracted).toBe("And this.");
      expect(listConversationFileNames(app.db, conversationId)).toEqual([]);
      await interruptControllerTurn(
        app.db,
        { conversationId, runId: turn.runId!, dataRoot: app.dataRoot },
        { userId: arda, label: "arda@viberr.dev" },
      );
      for (let i = 0; i < 400 && conversationTurnState(app.db, conversationId).answering; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      await disconnectFakeBackend(app.db, arda, "claude");
    }
  });
});
