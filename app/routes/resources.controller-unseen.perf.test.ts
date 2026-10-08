import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { routeArgs, setupAppTest, type AppTestContext } from "../../test-support/test-app";
import { pinPerfClock } from "../../test-support/perf-clock";
import { expectWithinBudget } from "../../test-support/perf-ratchet";
import { DOCK_STATUS_URL } from "~/features/controller/controller-dock-context";

/**
 * Ruling 457, CTL-2: what the controller dock fetches every 5 s while a turn
 * works, open or closed. It used to be the whole view of the thread (every
 * message, the threads, the task links) to move one step line; it is the
 * dock's status (`DOCK_STATUS_URL`): the unseen replies and the live turns.
 * Bytes are the JSON of the loader's answer, a stable proxy for the wire.
 */

let app: AppTestContext;
let arda: string;
let conversationId: string;
let runId: string;
const SLUG = "viberr-core";

beforeAll(async () => {
  pinPerfClock();
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  arda = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  const { connectFakeBackend } = await import("../../test-support/backend-credentials");
  await connectFakeBackend(app.db, arda, "claude");
  const { createConversation, appendMessage } = await import(
    "~/server/controller/controller-conversations.server"
  );
  // The thread being worked: thirty messages, as the discovery measured.
  const thread = createConversation(app.db, { userId: arda, userLabel: "arda@viberr.dev", projectSlug: SLUG });
  for (let i = 0; i < 30; i += 1) {
    appendMessage(
      app.db,
      i % 2 === 0
        ? { conversationId: thread.id, author: "user", userId: arda, text: "Where is VIB-1? ".repeat(25) }
        : { conversationId: thread.id, author: "controller", text: "VIB-1 waits on review. ".repeat(65) },
    );
  }
  conversationId = thread.id;
  // Five more board threads holding a reply arda has not seen.
  for (let i = 0; i < 5; i += 1) {
    const other = createConversation(app.db, { userId: arda, userLabel: "arda@viberr.dev", projectSlug: SLUG });
    appendMessage(app.db, { conversationId: other.id, author: "user", userId: arda, text: `Question ${i}.` });
    appendMessage(app.db, { conversationId: other.id, author: "controller", text: `Answer ${i}.` });
  }
  // A turn that keeps working.
  const { queueFakeRun } = await import("../../test-support/fake-runtime");
  queueFakeRun({
    lines: [{ t: "1", ev: "text", tag: "assistant", text: "reading the board" }],
    sessionId: "sess-poll",
    keepRunning: true,
  });
  const { runControllerTurn } = await import("~/server/controller/controller-run.server");
  const result = await runControllerTurn(app.db, {
    conversationId,
    text: "Keep VIB-1 moving.",
    user: { id: arda, email: "arda@viberr.dev", name: "Arda", orgRole: "admin" },
    dataRoot: app.dataRoot,
  });
  if (result.state !== "started") throw new Error(`turn ${result.state}`);
  runId = result.runId;
});

afterAll(async () => {
  const { interruptControllerTurn } = await import("~/server/controller/controller-run.server");
  await interruptControllerTurn(
    app.db,
    { conversationId, runId, dataRoot: app.dataRoot },
    { userId: arda, label: "arda@viberr.dev" },
  );
  vi.useRealTimers();
  app.cleanup();
});

describe("the dock's working poll (ruling 457, CTL-2)", () => {
  it("fetches the small status, not the transcript", async () => {
    const { loader } = await import("~/routes/resources.controller-unseen");
    const { cookie } = await app.cookieFor(arda);
    const request = app.request(DOCK_STATUS_URL, { cookie });
    const status = await loader(routeArgs(request, {}, "/resources/controller-unseen"));
    // Signed in, the route answers the status itself; only a caller who is not
    // gets the 401 `data()` wraps (ruling 457).
    if (!("working" in status)) throw new Error(`expected the status, got ${JSON.stringify(status)}`);
    // The turn is in it, with its scope, so the button and the step line can
    // read it without the transcript.
    expect(status.working).toEqual([
      expect.objectContaining({ id: conversationId, projectSlug: SLUG, taskKey: null }),
    ]);
    expect(status.unseen).toHaveLength(6);
    expectWithinBudget("controller:working-poll.bytes-per-tick", JSON.stringify(status).length);
  });
});
