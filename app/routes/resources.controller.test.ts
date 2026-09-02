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
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  arda = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  deniz = findUserByEmail(app.db, "deniz@viberr.dev")!.id;
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
      label: z.string(),
      contextLine: z.string(),
      pageHref: z.string(),
    }),
    conversation: z.object({ id: z.string(), taskKey: z.string().nullable() }).nullable(),
    threads: z.array(z.object({ id: z.string() })),
    messages: z.array(z.object({ author: z.string(), surface: z.string().nullable() })),
  }),
});

async function get(userId: string, query: string) {
  const { loader } = await import("~/routes/resources.controller");
  const { cookie } = await app.cookieFor(userId);
  const request = app.request(`/resources/controller${query}`, { cookie });
  return loader({
    request,
    url: new URL(request.url),
    params: {},
    pattern: "/resources/controller",
    context: new RouterContextProvider(),
  });
}

async function post(userId: string, fields: Record<string, string>, csrf?: string) {
  const { action } = await import("~/routes/resources.controller");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const body = new FormData();
  body.set("_csrf", csrf ?? (await app.csrfFor(sessionId)));
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = app.request("/resources/controller", { method: "POST", body, cookie });
  return action({
    request,
    url: new URL(request.url),
    params: {},
    pattern: "/resources/controller",
    context: new RouterContextProvider(),
  });
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
    // forgets the stored id (review finding 2).
    const foreign = loaderView.parse(await get(arda, `?project=${SLUG}&task=VIB-142&c=${board.id}`));
    expect(foreign.view.staleSelection).toBe(true);
    expect(foreign.view.conversation?.id).toBe(newer.id);
    expect(loaderView.parse(await get(arda, `?project=${SLUG}&task=VIB-142`)).view.staleSelection).toBe(false);
    // The board scope lists only its own threads.
    const boardView = loaderView.parse(await get(arda, `?project=${SLUG}`));
    expect(boardView.view.threads.map((t) => t.id)).toContain(board.id);
    expect(boardView.view.threads.map((t) => t.id)).not.toContain(newer.id);
  });
});

describe("POST /resources/controller", () => {
  it("maps a CSRF failure to a toast-shaped 403, never a thrown Response", async () => {
    const reply = returnedRefusal.parse(await post(arda, { intent: "send", text: "hi" }, "stale-token"));
    expect(reply.init?.status).toBe(403);
    expect(reply.data.error).toMatch(/expired/);
  });

  it("creates a conversation bound to the exact scope, records the surface, and runs the turn", async () => {
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
    // The hermetic root has no Claude credential: the honest refusal is in the transcript.
    expect(messages.some((m) => m.author === "controller")).toBe(true);
    // The dock then reads it back as the newest thread of that scope.
    const res = loaderView.parse(await get(arda, `?project=${SLUG}&task=VIB-142`));
    expect(res.view.conversation?.id).toBe(conversation.id);
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

  it("rejects an unknown intent", async () => {
    const reply = returnedRefusal.parse(await post(arda, { intent: "delete-everything" }));
    expect(reply.init?.status).toBe(400);
  });
});
