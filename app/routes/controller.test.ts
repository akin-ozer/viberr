import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * The `interrupt` intent on both controller pages.
 *
 * The Live-run strip's Interrupt (confirmed on the page) posts the open
 * conversation and the working run's id; the route hands them to
 * `interruptControllerTurn`, which carries the ruling-99 scope to the engine.
 * The engine's authority (owner or org admin) answers a stranger with the
 * not-found shape, which `appErrorResponse` turns into a toast-shaped result
 * rather than a thrown response.
 */

let app: AppTestContext;
let selin: string; // conversation owner (contributor on viberr-core)
let murat: string; // another member of viberr-core
const SLUG = "viberr-core";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  selin = userIds.selin;
  murat = userIds.murat;
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
    return action({
      request,
      url: new URL(request.url),
      params: {},
      pattern: "/controller",
      context: new RouterContextProvider(),
    });
  }
  const { action } = await import("~/routes/project.controller");
  const request = app.request(`/projects/${SLUG}/controller`, { method: "POST", body, cookie });
  return action({
    request,
    url: new URL(request.url),
    params: { slug: SLUG },
    pattern: "/projects/:slug/controller",
    context: new RouterContextProvider(),
  });
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

async function settled(runId: string): Promise<void> {
  const { getRun } = await import("~/server/runtimes/run-store.server");
  for (let i = 0; i < 200; i += 1) {
    const state = getRun(app.db, runId)?.state;
    if (state && state !== "running" && state !== "queued") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * U35-4 (pass 35): a refused turn (no Claude connected for the asker, ruling
 * 127) used to answer `{ ok: true }` on both pages, so the HTTP door said yes
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
    // Canary: drop the `interrupt` branch from the route and this answers the
    // "Unknown action." refusal.
    const { getRun } = await import("~/server/runtimes/run-store.server");
    const { conversationId, runId } = await workingTurn(surface);
    const reply = okResult.parse(
      await post(surface, selin, { intent: "interrupt", conversationId, runId }),
    );
    expect(reply.toast).toBe("Turn interrupted. The transcript records that it was stopped.");
    await settled(runId);
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
    await settled(runId);
  });
});
