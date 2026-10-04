import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pollUntil, settle } from "../../../test-support/polling";
import type { LogLine } from "~/features/runtime/runtime-types";
import type { RuntimeAdapter } from "~/server/runtimes/adapter.server";
import type { ControllerTurnInput } from "./controller-run.server";
import type { FakeRun } from "../../../test-support/fake-runtime";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";

/**
 * Ruling 99 — conversation ownership and turn admission.
 *
 * A conversation belongs to its user: that user and org admins read it,
 * NOBODY else (a member of the same project included), and only the owner may
 * speak in it. With no Claude credential (the hermetic default), a turn is
 * refused honestly IN the transcript rather than silently dropped.
 */

let app: AppTestContext;

let ownerId: string;
let otherMemberId: string;
let orgAdminId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ownerId = userIds.selin;
  otherMemberId = userIds.murat;
  orgAdminId = userIds.arda;
  // Ruling 127: a controller turn runs on the ASKER's own Claude account, so
  // the conversation owner has to have connected Claude for any turn in this
  // file to start. The refusal case disconnects him deliberately.
  const { connectFakeBackend } = await import(
    "../../../test-support/backend-credentials"
  );
  await connectFakeBackend(app.db, ownerId, "claude");
});
afterAll(() => app.cleanup());

describe("conversation access", () => {
  it("only the owner speaks in a conversation: an org admin's attempt is refused and appends nothing", async () => {
    const { createConversation, appendMessage, listMessages } = await import(
      "./controller-conversations.server"
    );
    const conversation = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: "viberr-core",
    });
    appendMessage(app.db, {
      conversationId: conversation.id,
      author: "user",
      userId: ownerId,
      text: "How many tasks are open?",
    });

    const { runControllerTurn } = await import("./controller-run.server");
    await expect(
      runControllerTurn(app.db, {
        conversationId: conversation.id,
        text: "Trying to speak in someone else's conversation.",
        user: {
          id: orgAdminId,
          email: "arda@viberr.dev",
          name: "Arda Kaya",
          orgRole: "admin",
        },
        dataRoot: app.dataRoot,
      }),
    ).rejects.toThrow(/owner/i);
    // The refused attempt appended nothing.
    expect(listMessages(app.db, conversation.id)).toHaveLength(1);
  });

  /**
   * The refusal is raised straight inside two route LOADERS, and the root
   * boundary only understands a thrown Response — an AppError reaches it as an
   * unhandled throw, so the deliberate 404 rendered as the generic
   * "Something went wrong" page at HTTP 500 instead of "Conversation not
   * found."
   */
  it("an unreadable conversation refuses with a 404 RESPONSE, not a bare error", async () => {
    const { createConversation } = await import(
      "./controller-conversations.server"
    );
    const { getControllerSurface } = await import(
      "~/features/controller/controller-query.server"
    );
    const conversation = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: null,
    });

    let thrown: { init?: { status?: number } } | null = null;
    try {
      getControllerSurface(
        app.db,
        { id: otherMemberId },
        {
          projectSlug: null,
          conversationId: conversation.id,
          all: false,
          dataRoot: app.dataRoot,
        },
      );
    } catch (error) {
      // SAFETY: the only throw on this path is React Router's `data()`, whose
      // value carries the response init this assertion reads.
      thrown = error as { init?: { status?: number } };
    }
    expect(thrown).not.toBeNull();

    // React Router's `data()` throw specifically — the shape every other
    // loader refusal produces and the only one the root boundary can read. An
    // `AppError` also carries a `status`, so asserting on that alone would let
    // the very regression this pins slip straight through.
    expect(thrown!.init?.status).toBe(404);
  });

  it("a turn refuses honestly IN the transcript when the ASKER has no Claude connected", async () => {
    // Ruling 127: the controller runs on the asker's OWN Claude account, so the
    // refusal is about them — not about the deployment — and another member who
    // HAS connected Claude can still converse (asserted below).
    const { createConversation, listMessages } = await import(
      "./controller-conversations.server"
    );
    const { runControllerTurn } = await import("./controller-run.server");
    const { disconnectFakeBackend } = await import(
      "../../../test-support/backend-credentials"
    );
    await disconnectFakeBackend(app.db, ownerId, "claude");
    try {
      const conversation = createConversation(app.db, {
        userId: ownerId,
        userLabel: "selin@viberr.dev",
        projectSlug: null,
      });
      const result = await runControllerTurn(app.db, {
        conversationId: conversation.id,
        text: "Anyone there?",
        user: {
          id: ownerId,
          email: "selin@viberr.dev",
          name: "Selin Aksoy",
          orgRole: "member",
        },
        dataRoot: app.dataRoot,
      });
      expect(result.state).toBe("refused");
      const messages = listMessages(app.db, conversation.id);
      expect(messages).toHaveLength(2);
      expect(messages[0]!.author).toBe("user");
      expect(messages[1]!.author).toBe("controller");
      // Ruling 465: the refusal names the message it refused.
      expect(messages[1]!.replyTo).toBe(messages[0]!.id);
      // Addressed to the person, naming where THEY fix it.
      expect(messages[1]!.text).toContain("your own Claude account");
      expect(messages[1]!.text).toContain("Profile → Agent accounts");
      // The first user message titled the conversation.
      const { getConversation } = await import(
        "./controller-conversations.server"
      );
      expect(getConversation(app.db, conversation.id)!.title).toBe(
        "Anyone there?",
      );
    } finally {
      const { connectFakeBackend } = await import(
        "../../../test-support/backend-credentials"
      );
      await connectFakeBackend(app.db, ownerId, "claude");
    }
  });

  it("a sign-in whose credential FILE is gone gets the store's own sentence", async () => {
    // Ruling 127, the wiped-runtime-volume case. This person HAS a connection
    // row — they signed in through the vendor's own binary — so "Claude isn't
    // connected for you yet" is both false and unactionable: what went missing
    // is the sign-in file that lived on the volume. The refusal note carries
    // the store's specific detail for exactly this case, and the branch that
    // does so used to be unreachable (it keyed off `verification`, which is
    // "none" on EVERY unavailable health).
    const { createConversation, listMessages } = await import(
      "./controller-conversations.server"
    );
    const { runControllerTurn } = await import("./controller-run.server");
    const { recordBackendLogin, loginTargetFor } = await import(
      "~/server/runtimes/backend-credentials.server"
    );
    const { connectFakeBackend, disconnectFakeBackend } = await import(
      "../../../test-support/backend-credentials"
    );
    await disconnectFakeBackend(app.db, ownerId, "claude");
    // A `login` row with no credential file under this data root: the exact
    // state a wiped runtime volume leaves behind.
    recordBackendLogin(
      app.db,
      { userId: ownerId, label: "selin@viberr.dev" },
      "claude",
      "claudeai",
      { authMethod: "claudeai" },
      loginTargetFor(app.db, ownerId, "claude"),
    );
    try {
      const conversation = createConversation(app.db, {
        userId: ownerId,
        userLabel: "selin@viberr.dev",
        projectSlug: null,
      });
      const result = await runControllerTurn(app.db, {
        conversationId: conversation.id,
        text: "Anyone there?",
        user: {
          id: ownerId,
          email: "selin@viberr.dev",
          name: "Selin Aksoy",
          orgRole: "member",
        },
        dataRoot: app.dataRoot,
      });
      expect(result.state).toBe("refused");
      const note = listMessages(app.db, conversation.id)[1]!.text;
      expect(note).toContain("sign-in file is missing from this server");
      expect(note).toContain("your own Claude account");
      // …and NOT the generic copy, which would send them to connect something
      // they already connected.
      expect(note).not.toContain("isn't connected for you yet");
    } finally {
      await disconnectFakeBackend(app.db, ownerId, "claude");
      await connectFakeBackend(app.db, ownerId, "claude");
    }
  });

  it("another member WITH Claude connected still gets a turn (ruling 127)", async () => {
    // The half that makes the refusal above person-shaped rather than a
    // deployment outage: one member's missing connection never silences
    // anybody else's controller. Canary: read availability from an instance
    // probe again and this turn is refused alongside the one above.
    const { createConversation, listMessages } = await import(
      "./controller-conversations.server"
    );
    const { runControllerTurn } = await import("./controller-run.server");
    const { connectFakeBackend, disconnectFakeBackend } = await import(
      "../../../test-support/backend-credentials"
    );
    const { getRun } = await import("~/server/runtimes/run-store.server");
    await disconnectFakeBackend(app.db, ownerId, "claude");
    await connectFakeBackend(app.db, orgAdminId, "claude");
    const conversation = createConversation(app.db, {
      userId: orgAdminId,
      userLabel: "arda@viberr.dev",
      projectSlug: null,
    });
    try {
      const result = await runControllerTurn(app.db, {
        conversationId: conversation.id,
        text: "Anyone there?",
        user: {
          id: orgAdminId,
          email: "arda@viberr.dev",
          name: "Arda Yilmaz",
          orgRole: "admin",
        },
        dataRoot: app.dataRoot,
      });
      // SAFETY: the conversation is fresh, so no lease is held and the turn
      // takes the `started` arm — the only one carrying a runId.
      if (result.state !== "started") throw new Error(`turn ${result.state}`);
      const runId = result.runId;
      // The turn bills the asker, and the run row says so permanently.
      expect(getRun(app.db, runId)?.credential_user_id).toBe(orgAdminId);
      // No refusal was written into the transcript: the only messages are the
      // question and whatever the (fake) controller answered.
      const messages = listMessages(app.db, conversation.id);
      expect(messages[0]!.author).toBe("user");
      expect(
        messages.some((m) => m.text.includes("Profile → Agent accounts")),
      ).toBe(false);
      // Let the fake run finish so nothing writes after the suite closes the DB.
      for (let i = 0; i < 200; i += 1) {
        const state = getRun(app.db, runId)?.state;
        if (state && state !== "running" && state !== "queued") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      await connectFakeBackend(app.db, ownerId, "claude");
    }
  });

  /**
   * A turn that lands while the controller is busy is queued, but the queue is
   * bounded. The overflow message is still WRITTEN to the transcript before
   * the bound is checked (the record is not a scheduling decision), so without
   * a reply beside it the thread reads back as a question the controller
   * ignored. Every other refusal path says so in the transcript; this one must
   * too.
   */
  it("a message refused for a full queue says so in the transcript", async () => {
    const { createConversation, listMessages } = await import(
      "./controller-conversations.server"
    );
    const { runControllerTurn } = await import("./controller-run.server");
    const conversation = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: null,
    });

    // Occupy the conversation's lease with a full queue. The lease lives in a
    // process registry under a documented symbol; seeding it is how a busy
    // controller is reproduced without a live model run.
    const leaseKey = Symbol.for("viberr.controllerLease");
    // SAFETY: the module creates this Map on first use and only ever stores
    // lease entries in it; the test seeds one entry and deletes it after.
    const host = globalThis as {
      [leaseKey]?: Map<
        string,
        { runId: string | null; queue: unknown[]; steering: unknown[]; steerable: boolean }
      >;
    };
    const map = host[leaseKey] ?? new Map();
    host[leaseKey] = map;
    // Ruling 527: steering counts against the same bound.
    map.set(conversation.id, {
      runId: "run_busy",
      queue: Array.from({ length: 6 }, (_, i) => ({
        messageId: `m_${i}`,
        text: "queued",
      })),
      steering: Array.from({ length: 2 }, (_, i) => ({
        messageId: `s_${i}`,
        text: "steering",
      })),
      steerable: true,
    });

    try {
      const result = await runControllerTurn(app.db, {
        conversationId: conversation.id,
        text: "One more thing.",
        user: {
          id: ownerId,
          email: "selin@viberr.dev",
          name: "Selin Aksoy",
          orgRole: "member",
        },
        dataRoot: app.dataRoot,
      });
      expect(result.state).toBe("refused");
      const messages = listMessages(app.db, conversation.id);
      expect(messages).toHaveLength(2);
      expect(messages[0]!.text).toBe("One more thing.");
      expect(messages[1]!.author).toBe("controller");
      expect(messages[1]!.text).toContain("queue for this conversation is full");
      // Ruling 465: under the message it refused, not under the busy turn's.
      expect(messages[1]!.replyTo).toBe(messages[0]!.id);
    } finally {
      map.delete(conversation.id);
    }
  });
});

/**
 * O39-d. A controller turn runs one to five minutes, and its answer reached
 * only the surfaces still open on it: a person who moved to another page had
 * no signal anywhere that it had landed.
 */
describe("O39-d: a reply its owner has not seen", () => {
  it("is unseen until its owner looks, and never anybody else's", async () => {
    const { createConversation, appendMessage, markConversationSeen, listUnseenReplies } = await import(
      "./controller-conversations.server"
    );
    const ids = (userId: string) => listUnseenReplies(app.db, userId).map((r) => r.id);
    const conversation = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: "viberr-core",
    });
    appendMessage(app.db, { conversationId: conversation.id, author: "user", userId: ownerId, text: "How many tasks are open?" });
    // A person's own message is not news to them.
    expect(ids(ownerId)).not.toContain(conversation.id);
    appendMessage(app.db, { conversationId: conversation.id, author: "controller", text: "Four." });
    // CANARY: drop the `m.seq > c.seen_seq` clause and a reply stays unseen
    // after its owner has read it (or, dropping the author clause, the
    // person's own message becomes a "reply").
    expect(listUnseenReplies(app.db, ownerId)).toContainEqual({
      id: conversation.id,
      title: expect.any(String),
      projectSlug: "viberr-core",
      taskKey: null,
    });
    // Somebody else opening it (an org admin) changes nothing for the owner.
    markConversationSeen(app.db, conversation.id, orgAdminId);
    expect(ids(ownerId)).toContain(conversation.id);
    markConversationSeen(app.db, conversation.id, ownerId);
    expect(ids(ownerId)).not.toContain(conversation.id);
    // Looking again changes nothing (the loader runs on every revalidation).
    markConversationSeen(app.db, conversation.id, ownerId);
    expect(ids(ownerId)).not.toContain(conversation.id);
    // The next reply is news again.
    appendMessage(app.db, { conversationId: conversation.id, author: "controller", text: "Five now." });
    expect(ids(ownerId)).toContain(conversation.id);
    // It is never another person's news.
    expect(ids(otherMemberId)).not.toContain(conversation.id);
    expect(ids(orgAdminId)).not.toContain(conversation.id);
  });
});

/**
 * Stopping a turn from the controller page.
 *
 * `interruptControllerTurn` hands the engine the ruling-99 scope of a
 * controller run so neither page has to know it, and the engine's interrupt
 * asks `canInterruptControllerRun` instead of a project membership the run
 * has none of. A stopped turn settles like a finished one: the transcript
 * records that it was stopped, and the lease is released so the next message
 * starts a fresh turn instead of queueing behind a run that is gone.
 */
describe("stopping a turn", () => {
  async function startWorkingTurn() {
    const { createConversation } = await import("./controller-conversations.server");
    const { runControllerTurn } = await import("./controller-run.server");
    const { queueFakeRun } = await import("../../../test-support/fake-runtime");
    const conversation = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: null,
    });
    queueFakeRun({
      lines: [{ t: "1", ev: "text", tag: "assistant", text: "thinking about it" }],
      sessionId: "sess-stop",
      keepRunning: true,
    });
    const result = await runControllerTurn(app.db, {
      conversationId: conversation.id,
      text: "Do something slow.",
      user: { id: ownerId, email: "selin@viberr.dev", name: "Selin", orgRole: "member" },
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
    // The settle runs from the completion callback on a later tick.
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("the owner stops it: the run is interrupted, the transcript says so, the lease is released", async () => {
    // Canary: make interruptRun's controller branch throw for everyone and
    // this rejects; drop the branch entirely and the empty member map refuses
    // the owner the same way.
    const { interruptControllerTurn, conversationTurnState } = await import(
      "./controller-run.server"
    );
    const { listMessages } = await import("./controller-conversations.server");
    const { getRun } = await import("~/server/runtimes/run-store.server");
    const { conversationId, runId } = await startWorkingTurn();
    expect(conversationTurnState(app.db, conversationId)).toMatchObject({
      working: true,
      runId,
    });

    const result = await interruptControllerTurn(
      app.db,
      { conversationId, runId, dataRoot: app.dataRoot },
      { userId: ownerId, label: "selin@viberr.dev" },
    );
    expect(result.outcome).toBe("interrupted");
    await settled(runId);

    const run = getRun(app.db, runId)!;
    expect(run.state).toBe("interrupted");
    expect(run.interrupted_by).toBe(ownerId);
    const messages = listMessages(app.db, conversationId);
    expect(messages.at(-1)).toMatchObject({
      author: "controller",
      runId,
      text: "This turn was stopped before I could answer.",
      // Ruling 465: the settle's note names the message the turn answered.
      replyTo: messages[0]!.id,
    });
    expect(conversationTurnState(app.db, conversationId).working).toBe(false);
  });

  /**
   * Ruling 250 (pass 37, F37-79): the live turn says what it is doing.
   *
   * Both facts are on the run row and both already render in the live-run panel
   * on the controller page; the conversation row, where the person actually
   * waits, showed a static sentence for turns measured in minutes, and the dock
   * has no run panel to fall back to at all.
   */
  it("ruling 250: the turn state carries the run's phase and step, minus the generic phase", async () => {
    const { conversationTurnState } = await import("./controller-run.server");
    const { patchRun } = await import("~/server/runtimes/run-store.server");
    const { conversationId, runId } = await startWorkingTurn();

    patchRun(app.db, runId, {
      phase: "Working",
      step: 'mcp__viberr_controller__get_task · {"taskKey":"SHOP-31"}',
    });
    // CANARY: return `run.phase` unconditionally and `phase` reads "Working",
    // which the row's own sentence already says.
    expect(conversationTurnState(app.db, conversationId)).toMatchObject({
      working: true,
      runId,
      phase: null,
      step: 'mcp__viberr_controller__get_task · {"taskKey":"SHOP-31"}',
      queued: [],
    });

    // A phase that means something else survives.
    patchRun(app.db, runId, { phase: "Preparing workspace", step: null });
    expect(conversationTurnState(app.db, conversationId)).toMatchObject({
      phase: "Preparing workspace",
      step: null,
    });

    const { interruptControllerTurn } = await import("./controller-run.server");
    await interruptControllerTurn(
      app.db,
      { conversationId, runId, dataRoot: app.dataRoot },
      { userId: ownerId, label: "selin@viberr.dev" },
    );
    await settled(runId);
    // A finished turn reports nothing to show, not a stale step. (The lease is
    // released with the turn, so the run id goes with it.)
    expect(conversationTurnState(app.db, conversationId)).toEqual({
      working: false,
      runId: null,
      phase: null,
      step: null,
      answering: null,
      queued: [],
      steering: [],
    });
  });

  it("another member gets the not-found shape; an org admin may stop it", async () => {
    const { interruptControllerTurn } = await import("./controller-run.server");
    const { conversationId, runId } = await startWorkingTurn();
    await expect(
      interruptControllerTurn(
        app.db,
        { conversationId, runId, dataRoot: app.dataRoot },
        { userId: otherMemberId, label: "murat@viberr.dev" },
      ),
    ).rejects.toMatchObject({ status: 404 });
    const result = await interruptControllerTurn(
      app.db,
      { conversationId, runId, dataRoot: app.dataRoot },
      { userId: orgAdminId, label: "arda@viberr.dev" },
    );
    expect(result.outcome).toBe("interrupted");
    await settled(runId);
  });

  it("a run id from another thread is not found on this conversation", async () => {
    const { interruptControllerTurn } = await import("./controller-run.server");
    const { createConversation } = await import("./controller-conversations.server");
    const { conversationId, runId } = await startWorkingTurn();
    const other = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: null,
    });
    await expect(
      interruptControllerTurn(
        app.db,
        { conversationId: other.id, runId, dataRoot: app.dataRoot },
        { userId: ownerId, label: "selin@viberr.dev" },
      ),
    ).rejects.toMatchObject({ status: 404 });
    // Clean up the live fake run so nothing writes after the DB closes.
    await interruptControllerTurn(
      app.db,
      { conversationId, runId, dataRoot: app.dataRoot },
      { userId: ownerId, label: "selin@viberr.dev" },
    );
    await settled(runId);
  });
});

/**
 * The wiring the console depends on, end to end through the real sink: a
 * controller turn's stored lines reach the OWNER's user stream as
 * `controller.log-appended`, and its lifecycle reaches it as the
 * `controller.updated` reference. Nobody else's stream hears either.
 */
describe("a working turn streams to its owner", () => {
  it("publishes controller.log-appended per line and controller.updated for the lifecycle", async () => {
    // Canary: drop `controller` from the sink's line publish and the owner
    // receives the lifecycle references but never a line.
    const { connectSseClient } = await import("~/server/events/sse-broker.server");
    const { createConversation } = await import("./controller-conversations.server");
    const { runControllerTurn } = await import("./controller-run.server");
    const { queueFakeRun } = await import("../../../test-support/fake-runtime");
    const { getRun } = await import("~/server/runtimes/run-store.server");
    const { sseEventSchema } = await import("~/schemas/sse-event.schema");

    const conversation = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: null,
    });
    const listen = (userId: string) => {
      const writes: string[] = [];
      connectSseClient({ userId, scopes: [{ kind: "user" }], lastEventId: null, write: (c) => { writes.push(c); } });
      return () =>
        writes
          .flatMap((chunk) => chunk.split("\n"))
          .filter((line) => line.startsWith("data: "))
          .map((line) => sseEventSchema.parse(JSON.parse(line.slice("data: ".length))));
    };
    const owner = listen(ownerId);
    const other = listen(otherMemberId);

    queueFakeRun({
      lines: [
        { t: "1", ev: "text", tag: "assistant", text: "one" },
        { t: "2", ev: "text", tag: "assistant", text: "two" },
      ],
      sessionId: "sess-stream",
    });
    const result = await runControllerTurn(app.db, {
      conversationId: conversation.id,
      text: "Stream this.",
      user: { id: ownerId, email: "selin@viberr.dev", name: "Selin", orgRole: "member" },
      dataRoot: app.dataRoot,
    });
    if (result.state !== "started") throw new Error(`turn ${result.state}`);
    await pollUntil(() => {
      const state = getRun(app.db, result.runId)?.state;
      return !!state && state !== "running" && state !== "queued";
    }, 1_000);
    await settle();

    const lines = owner().filter((e) => e.type === "controller.log-appended");
    expect(lines.map((e) => e.data)).toEqual([
      { conversationId: conversation.id, userId: ownerId, runId: result.runId, threadId: expect.any(String), seq: 0 },
      { conversationId: conversation.id, userId: ownerId, runId: result.runId, threadId: expect.any(String), seq: 1 },
    ]);
    const updated = owner().filter((e) => e.type === "controller.updated");
    expect(updated.length).toBeGreaterThan(0);
    expect(updated.every((e) => e.data.conversationId === conversation.id)).toBe(true);
    // Another member's user stream heard nothing of this conversation.
    expect(other().filter((e) => e.type !== "stream.open")).toEqual([]);
  });
});

/**
 * A queued-start failure kills the lease and the whole FIFO with it. Those
 * messages are ALREADY in the transcript and no other scheduler will ever reach
 * them, so without a note they read back as questions the controller ignored —
 * and boot recovery cannot see them either, since the newest message is now the
 * controller's own note rather than a user's.
 */
describe("a failed queued start accounts for the messages behind it", () => {
  it("names how many follow-ups were dropped, under the message it tried, and notes each dropped one", async () => {
    const { createConversation, listMessages } = await import("./controller-conversations.server");
    const { runControllerTurn, interruptControllerTurn } = await import("./controller-run.server");
    const { installFakeRuntime, installRunAdapters } = await import("../../../test-support/fake-runtime");
    // The first turn runs until it is stopped, and every start after it FAILS:
    // the queued start is the path under test. A start that throws stands in
    // for the real causes (an MCP mount that fails pre-flight, a full data
    // volume). One adapter for the whole case, since installing another drops
    // the first turn's live handle.
    let starts = 0;
    const heldThenRefusing = (backend: "claude" | "codex"): RuntimeAdapter => ({
      backend,
      start(spec, callbacks) {
        starts += 1;
        if (starts > 1) throw new Error("the queued turn could not start");
        return {
          runId: spec.runId,
          // A real turn reports its provider session, and the queued turn
          // resumes it; that is the road a queued start takes to its adapter.
          interrupt: () =>
            callbacks.onExit({ outcome: "interrupted", effectiveBackend: backend, sessionId: "sess-held" }),
        };
      },
    });
    installRunAdapters({ claude: heldThenRefusing("claude"), codex: heldThenRefusing("codex") });
    try {
      const conversation = createConversation(app.db, {
        userId: ownerId,
        userLabel: "selin@viberr.dev",
        projectSlug: null,
      });
      const user = { id: ownerId, email: "selin@viberr.dev", name: "Selin Aksoy", orgRole: "member" as const };
      const send = (text: string, mode?: "queue") =>
        runControllerTurn(app.db, { conversationId: conversation.id, text, user, mode, dataRoot: app.dataRoot });
      const queued = async (text: string) => {
        const turn = await send(text, "queue");
        if (turn.state !== "queued") throw new Error(`${text} was ${turn.state}, not queued`);
        return turn.messageId;
      };
      const a = await send("A");
      if (a.state !== "started") throw new Error(`turn ${a.state}`);
      const b = await queued("B");
      const c = await queued("C");
      const d = await queued("D");

      // Stopping A settles it, and the settle takes B off the queue.
      await interruptControllerTurn(
        app.db,
        { conversationId: conversation.id, runId: a.runId, dataRoot: app.dataRoot },
        { userId: ownerId, label: "selin@viberr.dev" },
      );
      const notes = () =>
        listMessages(app.db, conversation.id)
          .filter((m) => m.author === "controller")
          .map((m) => [m.text, m.replyTo]);
      await pollUntil(() => notes().length >= 4, 2_000);
      // B was attempted; C and D are the ones abandoned. Ruling 465: every
      // dropped message has its own note under it, so none reads back as a
      // question nobody answered (and boot recovery, which notes every
      // unanswered message, does not call them a restart).
      // CANARY: drop the per-message notes and C and D have none.
      const dropped = "I dropped this message: the queued turn before it could not start. Say it again to retry.";
      expect(notes()).toEqual([
        ["This turn was stopped before I could answer.", a.messageId],
        ["I could not start the queued turn, and I dropped the 2 messages you sent after it. Say them again to retry.", b],
        [dropped, c],
        [dropped, d],
      ]);
    } finally {
      installFakeRuntime(); // restore the shared adapters for later cases
    }
  });
});

/**
 * Ruling 99(d): a turn a restart orphans gets an honest "interrupted" note.
 *
 * Message ORDER cannot see the common case. A turn taken off the FIFO always
 * has the PREVIOUS turn's reply sitting after its own user message, because
 * `settleTurn` appends that reply BEFORE it shifts the queue — so "the newest
 * message is the user's" misses every queued turn a restart killed, and the
 * message sat unanswered forever with no note anywhere.
 */
describe("boot recovery", () => {
  // One row per TURN, so each needs its own thread id: `agent_runs` is unique
  // on (project_slug, task_key, thread_id).
  const controllerRun = (
    id: string,
    conversationId: string,
    state: "finished" | "error",
  ) => ({
    id,
    projectSlug: "",
    taskKey: conversationId,
    threadId: `controller-${id}`,
    role: "Controller",
    kind: "controller" as const,
    backend: "claude" as const,
    model: "claude-sonnet",
    sdk: "Claude Agent SDK",
    agentProfileId: "controller",
    state,
  });

  it("a queued turn whose run died after an earlier reply landed still gets a restart note", async () => {
    const { createConversation, appendMessage, listMessages } = await import(
      "./controller-conversations.server"
    );
    const { upsertRun } = await import("~/server/runtimes/run-store.server");
    const { recoverControllerConversations } = await import("./controller-run.server");

    const conversation = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: null,
    });
    // The FIFO transcript: two questions, then the FIRST turn's reply.
    const first = appendMessage(app.db, {
      conversationId: conversation.id,
      author: "user",
      userId: ownerId,
      text: "First question.",
    });
    const second = appendMessage(app.db, {
      conversationId: conversation.id,
      author: "user",
      userId: ownerId,
      text: "Second question, sent while you were busy.",
    });
    upsertRun(app.db, controllerRun("run_ctrl_a", conversation.id, "finished"));
    appendMessage(app.db, {
      conversationId: conversation.id,
      author: "controller",
      runId: "run_ctrl_a",
      text: "Answer to the first.",
      replyTo: first.id,
    });
    // The queued turn's run, as boot's orphan finalizer leaves it.
    upsertRun(app.db, controllerRun("run_ctrl_b", conversation.id, "error"));
    // Ruling 465: a third message was still in the lost in-memory queue. The
    // old order-based arms never reached it (the dead turn's note made the
    // newest message a controller one).
    const third = appendMessage(app.db, {
      conversationId: conversation.id,
      author: "user",
      userId: ownerId,
      text: "Third question, queued behind the second.",
    });

    // Other threads in this shared store may be noted too; this one's two are
    // what the assertions below pin.
    expect(recoverControllerConversations(app.db)).toBeGreaterThanOrEqual(2);

    const messages = listMessages(app.db, conversation.id);
    const notes = messages.filter((m) => m.text.includes("interrupted by a server restart"));
    // The dead run settles the OLDEST waiting message; the lost one gets its own.
    // CANARY: drop the unanswered-message arm and the third has no note.
    expect(notes.map((m) => [m.replyTo, m.runId])).toEqual([
      [second.id, "run_ctrl_b"],
      [third.id, null],
    ]);
    // The note settles that run, so a second boot does not write another.
    const before = messages.length;
    recoverControllerConversations(app.db);
    expect(listMessages(app.db, conversation.id)).toHaveLength(before);
  });

  it("ruling 527: a message that steered a turn is part of it, so only the turn's own message is noted", async () => {
    const { createConversation, appendMessage, listMessages, markSteered } = await import(
      "./controller-conversations.server"
    );
    const { upsertRun } = await import("~/server/runtimes/run-store.server");
    const { recoverControllerConversations } = await import("./controller-run.server");
    const conversation = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: null,
    });
    const asked = appendMessage(app.db, {
      conversationId: conversation.id,
      author: "user",
      userId: ownerId,
      text: "Tidy the agents.",
    });
    const steered = appendMessage(app.db, {
      conversationId: conversation.id,
      author: "user",
      userId: ownerId,
      text: "I deleted the calculator one already.",
    });
    markSteered(app.db, conversation, [steered.id], asked.id);
    // The server stopped mid-turn; boot's orphan finalizer left its run so.
    upsertRun(app.db, controllerRun("run_ctrl_steered", conversation.id, "error"));

    recoverControllerConversations(app.db);
    const notes = listMessages(app.db, conversation.id).filter((m) => m.author === "controller");
    // CANARY: drop `steered_into IS NULL` from the unanswered arm and the
    // steering message gets a restart note of its own.
    expect(notes.map((m) => [m.replyTo, m.runId])).toEqual([[asked.id, "run_ctrl_steered"]]);
  });
});

// ------------------------------------------------------------ ruling 121

describe("conversation scope (ruling 121)", () => {
  it("refuses a task binding without a project, in the store and in the CHECK", async () => {
    const { createConversation } = await import("./controller-conversations.server");
    expect(() =>
      createConversation(app.db, {
        userId: ownerId,
        userLabel: "selin@viberr.dev",
        projectSlug: null,
        taskKey: "VIB-142",
      }),
    ).toThrow(/must name the task's project/);
    expect(() =>
      app.db
        .prepare(
          `INSERT INTO controller_conversations
             (id, user_id, user_label, project_slug, task_key, title, created_at, updated_at)
           VALUES ('cnv_bad', ?, 'x', NULL, 'VIB-142', '', '2026-01-01', '2026-01-01')`,
        )
        .run(ownerId),
    ).toThrow(/CHECK/);
  });

  it("lists one scope at a time: board threads exclude task threads, and a task lists its own", async () => {
    const { createConversation, listConversations } = await import(
      "./controller-conversations.server"
    );
    const board = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: "viberr-core",
    });
    const task = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
    });
    expect(task.taskKey).toBe("VIB-142");
    expect(board.taskKey).toBeNull();
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    // The board's own threads only.
    expect(
      ids(listConversations(app.db, { userId: ownerId, projectSlug: "viberr-core", taskKey: null })),
    ).toContain(board.id);
    expect(
      ids(listConversations(app.db, { userId: ownerId, projectSlug: "viberr-core", taskKey: null })),
    ).not.toContain(task.id);
    // That task's threads only.
    const taskList = ids(
      listConversations(app.db, { userId: ownerId, projectSlug: "viberr-core", taskKey: "VIB-142" }),
    );
    expect(taskList).toContain(task.id);
    expect(taskList).not.toContain(board.id);
    // The project page: both.
    const projectList = ids(listConversations(app.db, { userId: ownerId, projectSlug: "viberr-core" }));
    expect(projectList).toEqual(expect.arrayContaining([board.id, task.id]));
    // The instance page: neither.
    expect(ids(listConversations(app.db, { userId: ownerId, projectSlug: null }))).not.toContain(task.id);
  });

  /**
   * Review finding 1: `created_at` has millisecond resolution, so two threads
   * made back to back tie, and without a tie-break the sort index returned the
   * OLDER one first — inverting "the newest thread of this scope", which the
   * dock hangs on rows[0].
   */
  it("orders same-millisecond threads newest first", async () => {
    const { createConversation, listConversations } = await import(
      "./controller-conversations.server"
    );
    // The tie is CONSTRUCTED, not hoped for. Six real inserts straddle a
    // millisecond boundary on a loaded machine, every stamp comes back
    // distinct, and the precondition below fails without the ordering
    // assertion it guards ever running. Only `Date` is faked: the store's
    // inserts are synchronous, so nothing here waits on a timer.
    vi.useFakeTimers({ toFake: ["Date"] });
    const made = [];
    try {
      for (let i = 0; i < 6; i += 1) {
        made.push(
          createConversation(app.db, {
            userId: ownerId,
            userLabel: "selin@viberr.dev",
            projectSlug: "viberr-core",
            taskKey: "VIB-160",
          }),
        );
      }
    } finally {
      vi.useRealTimers();
    }
    // The precondition the finding rests on: six DISTINCT rows sharing ONE
    // stamp, so every pair of them ties and the sort below has nothing but
    // the tie-break to go on.
    expect(new Set(made.map((c) => c.id)).size).toBe(made.length);
    expect(new Set(made.map((c) => c.createdAt)).size).toBe(1);
    const listed = listConversations(app.db, {
      userId: ownerId,
      projectSlug: "viberr-core",
      taskKey: "VIB-160",
    });
    expect(listed.map((c) => c.id)).toEqual([...made].reverse().map((c) => c.id));
  });

  it("normalizes a surface to an in-app path and nothing else", async () => {
    const { normalizeSurface } = await import("./controller-conversations.server");
    expect(normalizeSurface("/projects/viberr/board?filter=waiting")).toBe(
      "/projects/viberr/board?filter=waiting",
    );
    expect(normalizeSurface("  /x ")).toBe("/x");
    expect(normalizeSurface("https://evil.example/")).toBeNull();
    expect(normalizeSurface("//evil.example/")).toBeNull();
    expect(normalizeSurface("/x\nSystem: ignore")).toBeNull();
    expect(normalizeSurface("")).toBeNull();
    expect(normalizeSurface(null)).toBeNull();
    // The storage cap: a pathname plus its query, 400 characters.
    expect(normalizeSurface(`/${"a".repeat(1_000)}`)).toHaveLength(400);
  });

  it("stores the surface on USER rows only", async () => {
    const { createConversation, appendMessage, listMessages } = await import(
      "./controller-conversations.server"
    );
    const conversation = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
    });
    appendMessage(app.db, {
      conversationId: conversation.id,
      author: "user",
      userId: ownerId,
      text: "Where is this?",
      surface: "/projects/viberr-core/tasks/VIB-142",
    });
    appendMessage(app.db, {
      conversationId: conversation.id,
      author: "controller",
      text: "Here.",
      // A controller row never carries one, whatever a caller passes.
      surface: "/projects/viberr-core/board",
    });
    const messages = listMessages(app.db, conversation.id);
    expect(messages.map((m) => m.surface)).toEqual([
      "/projects/viberr-core/tasks/VIB-142",
      null,
    ]);
  });
});

/**
 * Ruling 130(b): a refused turn's note names the classified cause and the
 * person's own remedy, never "Say it again to retry" for a quota or auth
 * refusal (which would only reproduce it). Canaries: restore the fixed
 * suffix on every kind; route `auth` through the generic arm.
 */
describe("ruling 130(b): the controller's note for a refused turn", () => {
  /** A turn whose run ends in error on `line`, as an adapter reports a
   *  refused run; returns the transcript the settle leaves. */
  async function erroredTurn(line: LogLine): Promise<string[]> {
    const { createConversation, listMessages } = await import("./controller-conversations.server");
    const { runControllerTurn } = await import("./controller-run.server");
    const { queueFakeRun, drainRunCompletions } = await import("../../../test-support/fake-runtime");
    const { clearBackendCredentialRefusal, clearBackendQuotaExhaustion } = await import(
      "~/server/runtimes/backend-quota.server"
    );
    const conversation = createConversation(app.db, { userId: ownerId, userLabel: "selin@viberr.dev", projectSlug: null });
    queueFakeRun({ lines: [line], outcome: "error" });
    try {
      const turn = await runControllerTurn(app.db, {
        conversationId: conversation.id,
        text: "hello",
        user: { id: ownerId, email: "selin@viberr.dev", name: "Selin Aksoy", orgRole: "member" },
        dataRoot: app.dataRoot,
      });
      if (turn.state !== "started") throw new Error(`turn ${turn.state}`);
      await drainRunCompletions();
      return listMessages(app.db, conversation.id).map((m) => m.text);
    } finally {
      // The sink records a quota or an auth refusal against the backend off
      // these lines (D5, F32-4); every case starts without one.
      clearBackendQuotaExhaustion(app.db, "claude");
      clearBackendCredentialRefusal(app.db, "claude");
    }
  }

  it("a quota-refused turn names the reset and the account switch, never 'Say it again to retry'", async () => {
    const texts = await erroredTurn({
      t: "1", ev: "err", tag: "run·error·quota", text: "The Claude account is over its usage quota.",
      failure: { kind: "quota", resetsAt: "2026-09-06T19:50:00.000Z", window: "five_hour", windowRejected: true, apiError: null, apiErrorStatus: 429, terminalReason: "api_error", origin: null },
    });
    const note = texts.find((t) => t.startsWith("I could not finish this turn"))!;
    expect(note).toContain("five hour window is spent");
    expect(note).toContain("reopens at 2026-09-06 19:50 UTC");
    expect(note).toContain("Profile → Agent accounts");
    expect(note).not.toContain("Say it again to retry");
  });

  it("an auth-refused turn names the org restriction; an `unknown` failure keeps the retry sentence", async () => {
    const auth = await erroredTurn({
      t: "1", ev: "err", tag: "run·error·auth", text: "refused",
      failure: { kind: "auth", resetsAt: null, window: null, windowRejected: false, apiError: "oauth_org_not_allowed", apiErrorStatus: 403, terminalReason: "api_error", origin: null },
    });
    const authNote = auth.find((t) => t.startsWith("I could not finish this turn"))!;
    expect(authNote).toContain("oauth_org_not_allowed");
    expect(authNote).toContain("does not allow it here");
    expect(authNote).toContain("Profile → Agent accounts");
    expect(authNote).not.toContain("Say it again to retry");

    const unknown = await erroredTurn({ t: "1", ev: "err", tag: "run·error·unknown", text: "The agent run did not complete." });
    const unknownNote = unknown.find((t) => t.startsWith("I could not finish this turn"))!;
    expect(unknownNote).toContain("Say it again to retry");
  });

  it("a provider-overloaded turn (Agent SDK 0.3.261 upgrade) says so, clears the account, and asks for a retry in a few minutes", async () => {
    // Canary: route `overloaded` through the generic arm and the note reads
    // "the run did not complete … Say it again to retry" — true, but it hides
    // that nothing the person can change was involved.
    const texts = await erroredTurn({
      t: "1", ev: "err", tag: "run·error·overloaded", text: "Claude could not serve this run: the provider was overloaded (HTTP 529).",
      failure: { kind: "overloaded", resetsAt: null, window: null, windowRejected: false, apiError: null, apiErrorStatus: 529, terminalReason: "api_error", origin: "provider" },
    });
    const note = texts.find((t) => t.startsWith("I could not finish this turn"))!;
    expect(note).toBe(
      "I could not finish this turn: Claude was overloaded or failed on its side (HTTP 529). Nothing about your account is wrong. Say it again in a few minutes.",
    );
    expect(note).not.toContain("Profile → Agent accounts");
  });

  it("ruling 175: a turn the spending cap stopped names the cap and the spend, and who can raise it", async () => {
    // Canary: route `max_budget` through the generic arm and the note reads
    // "the run did not complete" with no figure and nobody to ask.
    const texts = await erroredTurn({
      t: "1", ev: "err", tag: "run·error·max_budget", text: "The run reached its $0.50 spending cap after spending $0.52 and was cut off.",
      failure: { kind: "max_budget", resetsAt: null, window: null, windowRejected: false, apiError: null, apiErrorStatus: null, terminalReason: null, origin: null, spendCapUsd: 0.5, spentUsd: 0.52 },
    });
    const note = texts.find((t) => t.startsWith("I could not finish this turn"))!;
    expect(note).toBe(
      "I could not finish this turn: the instance's spending cap of $0.50 stopped it after spending $0.52. Say it again to continue, or ask an org admin to raise the cap in Instance settings (Max spend per Claude run).",
    );
  });
});

/**
 * U39-19 (pass 39): a conversation is titled by the person's first sentence,
 * not by 79 characters cut mid-word. The live rail's titles, before and after.
 */
describe("U39-19: a conversation is titled by its first sentence", () => {
  it("titles a thread by its first sentence, and clips a long one at a word", async () => {
    // CANARY: return the 79-character slice again.
    const { createConversation, appendMessage, getConversation } = await import(
      "./controller-conversations.server"
    );
    /** The title a fresh thread takes from its first user message. */
    const titled = (text: string) => {
      const c = createConversation(app.db, { userId: ownerId, userLabel: "selin@viberr.dev", projectSlug: null });
      appendMessage(app.db, { conversationId: c.id, author: "user", userId: ownerId, text });
      return getConversation(app.db, c.id)!.title;
    };
    expect(titled("Knowledge base check, please. Since the ax-clone knowledge bases were last written, AX-17 merged.")).toBe(
      "Knowledge base check, please.",
    );
    expect(titled("AX-24 merged a few minutes ago (PR #19). Please bring the rulings knowledge base up to date.")).toBe(
      "AX-24 merged a few minutes ago (PR #19).",
    );
    // A first sentence too short to name anything falls back to the clip.
    expect(titled("Good graph. AX-2 and AX-3 are both building, which is what I was after. One correction about the graph.")).toBe(
      "Good graph. AX-2 and AX-3 are both building, which is what I was after. One…",
    );
    // A version number is not a sentence end.
    expect(titled("Deployed build 0.19.0 with the new rail. Check the goals.")).toBe(
      "Deployed build 0.19.0 with the new rail.",
    );
    // No sentence end and short: the text itself.
    expect(titled("Anyone there?")).toBe("Anyone there?");
    // A first sentence longer than the rail shows is clipped at a word.
    const long =
      "Separate from the build: I need this board's access model exercised for real, not in a test, by the people who will use it.";
    const title = titled(long);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.slice(0, -1).endsWith(" ")).toBe(false);
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
  });
});

/**
 * U39-30: a long turn's answer reaches the transcript the moment it is
 * written, not after the completion compaction (ruling 376) behind it. Live on
 * ax-clone the page showed "Compacting context" for 27 seconds while the reply
 * already existed, and ruling 371 measured one compaction at 131.
 */
describe("U39-30: the answer does not wait for the compaction", () => {
  it("is in the transcript while the compaction runs, and only once after it", async () => {
    // CANARY: drop the `onAnswered` hook and the transcript is empty
    // of the reply during the compaction; drop the settle's `replyPosted`
    // check and the reply is posted twice.
    const { createConversation, listMessages } = await import("./controller-conversations.server");
    const { runControllerTurn } = await import("./controller-run.server");
    const { queueFakeRun, queueFakeCompaction } = await import("../../../test-support/fake-runtime");
    const { getRun } = await import("~/server/runtimes/run-store.server");
    const conversation = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: null,
    });
    const answer = "Three tasks are open on the board.";
    queueFakeRun({
      sessionId: "sess-u39-30",
      lines: [
        { t: "1", ev: "init", tag: "system·init", text: "session" },
        { t: "2", ev: "text", tag: "assistant", text: answer },
        { t: "3", ev: "result", tag: "result", text: "done", stats: { dur: 100, api: 90, turns: 2, cost: 1, in: 150_000, cached: 0, out: 500 } },
      ],
      extraFacts: [
        undefined,
        {
          cache: {
            messageId: "m1",
            promptTokens: 150_000,
            cacheWrite: 1_000,
            cacheRead: 149_000,
            perCall: true,
            ttl: { fiveMinute: 0, oneHour: 1_000 },
            missReason: null,
          },
        },
        undefined,
      ],
    });
    let duringCompaction: string[] | null = null;
    queueFakeCompaction("claude", { compacted: true, preTokens: 150_000, postTokens: 12_000 }, () => {
      duringCompaction = listMessages(app.db, conversation.id)
        .filter((m) => m.author === "controller")
        .map((m) => m.text);
    });
    const result = await runControllerTurn(app.db, {
      conversationId: conversation.id,
      text: "How many tasks are open?",
      user: { id: ownerId, email: "selin@viberr.dev", name: "Selin", orgRole: "member" },
      dataRoot: app.dataRoot,
    });
    if (result.state !== "started") throw new Error(`turn ${result.state}`);
    for (let i = 0; i < 400; i += 1) {
      const state = getRun(app.db, result.runId)?.state;
      const replies = listMessages(app.db, conversation.id).filter((m) => m.author === "controller");
      if (state && state !== "running" && state !== "queued" && replies.length > 0 && duringCompaction) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Let the settle that follows the compaction run.
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(duringCompaction).toEqual([answer]);
    const replies = listMessages(app.db, conversation.id).filter((m) => m.author === "controller");
    expect(replies.map((m) => [m.text, m.runId])).toEqual([[answer, result.runId]]);
    // Ruling 465: the answer posted before the compaction names its message.
    // CANARY: drop `replyTo` from `postReply`.
    expect(replies[0]!.replyTo).toBe(result.messageId);

    // The next turn in the thread takes the resume door. CANARY: drop
    // `resumeInput.onAnswered = answered`.
    const second = "Two of them are waiting on review.";
    queueFakeRun({
      sessionId: "sess-u39-30-b",
      lines: [
        { t: "1", ev: "init", tag: "system·init", text: "session" },
        { t: "2", ev: "text", tag: "assistant", text: second },
        { t: "3", ev: "result", tag: "result", text: "done", stats: { dur: 100, api: 90, turns: 2, cost: 1, in: 150_000, cached: 0, out: 500 } },
      ],
      extraFacts: [
        undefined,
        {
          cache: {
            messageId: "m2",
            promptTokens: 150_000,
            cacheWrite: 1_000,
            cacheRead: 149_000,
            perCall: true,
            ttl: { fiveMinute: 0, oneHour: 1_000 },
            missReason: null,
          },
        },
        undefined,
      ],
    });
    let duringSecond: string[] | null = null;
    queueFakeCompaction("claude", { compacted: true, preTokens: 150_000, postTokens: 12_000 }, () => {
      duringSecond = listMessages(app.db, conversation.id)
        .filter((m) => m.author === "controller")
        .map((m) => m.text);
    });
    const next = await runControllerTurn(app.db, {
      conversationId: conversation.id,
      text: "And which are waiting?",
      user: { id: ownerId, email: "selin@viberr.dev", name: "Selin", orgRole: "member" },
      dataRoot: app.dataRoot,
    });
    if (next.state !== "started") throw new Error(`turn ${next.state}`);
    for (let i = 0; i < 400; i += 1) {
      const state = getRun(app.db, next.runId)?.state;
      if (state && state !== "running" && state !== "queued" && duringSecond) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(duringSecond).toEqual([answer, second]);
  });
});

/**
 * Ruling 465 (F40-8, F40-10): a queued message is visible as queued, each
 * reply names the message it answers, and a turn's prompt stops at its own
 * message with a line for the ones behind it.
 */
describe("ruling 465: the queue is visible and every reply names its message", () => {
  it("exposes the answered and queued ids with their positions, then links each reply as the FIFO drains", async () => {
    const { createConversation, listMessages } = await import("./controller-conversations.server");
    const { runControllerTurn, conversationTurnState, interruptControllerTurn } = await import(
      "./controller-run.server"
    );
    const { getControllerSurface } = await import("~/features/controller/controller-query.server");
    const { queueFakeRun, startedRunSpecs } = await import("../../../test-support/fake-runtime");
    const { getRun } = await import("~/server/runtimes/run-store.server");
    const user = { id: ownerId, email: "selin@viberr.dev", name: "Selin", orgRole: "member" as const };
    const conversation = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: null,
    });
    const send = (text: string) =>
      runControllerTurn(app.db, {
        conversationId: conversation.id,
        text,
        user,
        mode: "queue",
        dataRoot: app.dataRoot,
      });

    queueFakeRun({
      lines: [{ t: "1", ev: "text", tag: "assistant", text: "reading part one" }],
      sessionId: "sess-465",
      keepRunning: true,
    });
    const first = await send("Dossier part 1.");
    if (first.state !== "started") throw new Error(`turn ${first.state}`);
    const second = await send("Dossier part 2.");
    const third = await send("QUEUED-THIRD: the correction.");
    if (second.state !== "queued" || third.state !== "queued") {
      throw new Error(`expected two queued sends, got ${second.state} and ${third.state}`);
    }

    // CANARY: drop `queued` from `conversationTurnState` and the transcript has
    // nothing to say about where the two waiting messages are.
    const expected = {
      answering: first.messageId,
      queued: [
        { messageId: second.messageId, ahead: 1 },
        { messageId: third.messageId, ahead: 2 },
      ],
    };
    expect(conversationTurnState(app.db, conversation.id)).toMatchObject({ working: true, ...expected });
    // The page's view carries the server's own reading.
    const view = getControllerSurface(
      app.db,
      { id: ownerId },
      { conversationId: conversation.id, dataRoot: app.dataRoot },
    );
    expect(view.turn).toMatchObject(expected);

    // Drain the FIFO: stop turn one; turns two and three answer in order.
    const specsBefore = startedRunSpecs().length;
    const answer = (text: string) => ({
      lines: [
        { t: "1", ev: "text" as const, tag: "assistant", text },
        { t: "2", ev: "result" as const, tag: "result", text: "done" },
      ],
      sessionId: "sess-465",
    });
    queueFakeRun(answer("Answer two."));
    queueFakeRun(answer("Answer three."));
    await interruptControllerTurn(
      app.db,
      { conversationId: conversation.id, runId: first.runId, dataRoot: app.dataRoot },
      { userId: ownerId, label: "selin@viberr.dev" },
    );
    for (let i = 0; i < 400; i += 1) {
      const replies = listMessages(app.db, conversation.id).filter((m) => m.author === "controller");
      if (replies.length >= 3 && !conversationTurnState(app.db, conversation.id).answering) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(getRun(app.db, first.runId)?.state).toBe("interrupted");
    const replies = listMessages(app.db, conversation.id).filter((m) => m.author === "controller");
    // CANARY: drop `replyTo` from the settle and no reply names its message.
    expect(replies.map((m) => [m.text, m.replyTo])).toEqual([
      ["This turn was stopped before I could answer.", first.messageId],
      ["Answer two.", second.messageId],
      ["Answer three.", third.messageId],
    ]);

    // Turn two's prompt stops at part 2 and counts the one behind it.
    const turnTwo = startedRunSpecs()[specsBefore]!.prompt;
    expect(turnTwo).toContain("says:\n\nDossier part 2.");
    expect(turnTwo).not.toContain("QUEUED-THIRD");
    expect(turnTwo).toContain("1 more message from selin@viberr.dev is queued behind this one");
    const turnThree = startedRunSpecs()[specsBefore + 1]!.prompt;
    expect(turnThree).toContain("says:\n\nQUEUED-THIRD: the correction.");
    expect(turnThree).not.toContain("queued behind this one");
  });

  it("a message queued while a first turn was starting gets its own note when that start fails", async () => {
    // The start awaits (the MCP pre-flight here; a stdio server's spawn or a
    // continuity reset live), and a send from another surface in that window
    // joins the lease's queue. The catch deleted the lease and noted only the
    // first message, so the second read back as a question nobody answered.
    const { createConversation, listMessages } = await import("./controller-conversations.server");
    const { runControllerTurn } = await import("./controller-run.server");
    const { configureRunServiceForTests } = await import("~/server/runtimes/run-service.server");
    const { installFakeRuntime } = await import("../../../test-support/fake-runtime");
    const throwingAdapter = (backend: "claude" | "codex") => ({
      backend,
      start(): never {
        throw new Error("the turn could not start");
      },
    });
    configureRunServiceForTests({ claude: throwingAdapter("claude"), codex: throwingAdapter("codex") });
    try {
      const conversation = createConversation(app.db, {
        userId: ownerId,
        userLabel: "selin@viberr.dev",
        projectSlug: null,
      });
      const user = { id: ownerId, email: "selin@viberr.dev", name: "Selin", orgRole: "member" as const };
      const send = (text: string, mode?: "queue") =>
        runControllerTurn(app.db, { conversationId: conversation.id, text, user, mode, dataRoot: app.dataRoot });
      // All three sends begin before the first start reaches the adapter.
      // Ruling 527: part 3 is sent to steer the turn that is starting.
      const [first, second, third] = await Promise.allSettled([
        send("Part 1."),
        send("Part 2.", "queue"),
        send("Part 3."),
      ]);
      expect(first.status).toBe("rejected");
      expect(second.status === "fulfilled" ? second.value.state : second.status).toBe("queued");
      expect(third.status === "fulfilled" ? third.value.state : third.status).toBe("steering");

      const messages = listMessages(app.db, conversation.id);
      const [one, two, three] = messages.filter((m) => m.author === "user");
      const notes = messages.filter((m) => m.author === "controller");
      // CANARY: drop the queue drain from `runControllerTurn`'s catch and part
      // 2 has no note (and the next boot calls it a restart); drop `replyTo`
      // from the start-failure note and part 1's note names no message; drop
      // the steering half of `drainWaiting` and part 3 has none.
      const dropped = "I dropped this message: the turn before it could not start. Say it again to retry.";
      expect(notes.map((m) => [m.text, m.replyTo])).toEqual([
        ["I could not start this turn: The controller turn could not start.", one!.id],
        [dropped, three!.id],
        [dropped, two!.id],
      ]);
    } finally {
      installFakeRuntime();
    }
  });
});

/**
 * Ruling 527: a message sent while a turn works steers that turn unless its
 * sender queued it. The run asks for what is waiting at each step boundary
 * (`RunSpec.steering`, which the Claude adapter's hooks call; the adapter's
 * own suite owns those); a message that misses the turn starts the next one,
 * ahead of the messages queued on purpose.
 */
describe("ruling 527: a message sent while a turn works steers it", () => {
  const user = { id: "", email: "selin@viberr.dev", name: "Selin", orgRole: "member" as const };
  const answer = (text: string, gate?: Promise<void>): FakeRun => {
    const run: FakeRun = {
      lines: [
        { t: "1", ev: "text", tag: "assistant", text },
        { t: "2", ev: "result", tag: "result", text: "done" },
      ],
      sessionId: "sess-527",
    };
    if (gate) run.gate = gate;
    return run;
  };
  /** A gate a test opens when it is done with the run behind it. */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }
  async function conversationFor() {
    const { createConversation } = await import("./controller-conversations.server");
    const { runControllerTurn } = await import("./controller-run.server");
    const conversation = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: null,
    });
    const send = async (text: string, mode?: "queue") => {
      const result = await runControllerTurn(app.db, {
        conversationId: conversation.id,
        text,
        user: { ...user, id: ownerId },
        mode,
        dataRoot: app.dataRoot,
      });
      if (result.state === "refused") throw new Error(`refused: ${result.reason}`);
      return result;
    };
    return { conversation, send };
  }

  it("goes into the running turn at its next step, and that turn's reply answers it", async () => {
    const { listMessages } = await import("./controller-conversations.server");
    const { conversationTurnState } = await import("./controller-run.server");
    const { queueFakeRun, lastRunSpec, startedRunSpecs } = await import("../../../test-support/fake-runtime");
    const { conversation, send } = await conversationFor();
    const running = gate();
    queueFakeRun(answer("Both handled: the agent and its KB are gone.", running.opened));
    const first = await send("Clean up the calculator agent.");
    if (first.state !== "started") throw new Error(`turn ${first.state}`);
    const queued = await send("QUEUED: then list what is left.", "queue");
    const steering = await send("STEER: I deleted its KB already.");
    expect([queued.state, steering.state]).toEqual(["queued", "steering"]);
    expect(conversationTurnState(app.db, conversation.id)).toMatchObject({
      answering: first.messageId,
      steering: [steering.messageId],
      queued: [{ messageId: queued.messageId, ahead: 1 }],
    });

    // The run's next step takes it. CANARY: drop `markSteered` from the
    // channel's `take` and the message reads back as never answered (and the
    // next boot notes it as a restart).
    const channel = lastRunSpec()!.steering!;
    const delivery = channel.take();
    expect(delivery).toEqual({
      count: 1,
      text:
        "selin@viberr.dev sent this while you were working on this turn. It is part of this turn: take it " +
        "into account from here, and answer it in the reply you write for this turn.\n\n" +
        "STEER: I deleted its KB already.",
    });
    expect(channel.take()).toBeNull();
    const byId = () => new Map(listMessages(app.db, conversation.id).map((m) => [m.id, m]));
    expect(byId().get(steering.messageId)!.steeredInto).toBe(first.messageId);
    expect(conversationTurnState(app.db, conversation.id).steering).toEqual([]);

    queueFakeRun(answer("Two agents are left."));
    const specsBefore = startedRunSpecs().length;
    running.open();
    const replies = () => listMessages(app.db, conversation.id).filter((m) => m.author === "controller");
    expect(
      await pollUntil(
        () => replies().length >= 2 && conversationTurnState(app.db, conversation.id).answering === null,
      ),
    ).toBe(true);
    // The steering message has no turn or reply of its own. CANARY: leave it
    // in the lease after `take` and the settle queues it for a third turn.
    expect(replies().map((m) => [m.text, m.replyTo])).toEqual([
      ["Both handled: the agent and its KB are gone.", first.messageId],
      ["Two agents are left.", queued.messageId],
    ]);
    expect(startedRunSpecs()).toHaveLength(specsBefore + 1);
    // The queued message was sent first, but the turn it steered is behind
    // it, so its turn's digest has it. CANARY: drop the `steered_into` arm of
    // `messagesUpTo` and that turn reads a reply to a message it never saw.
    expect(startedRunSpecs()[specsBefore]!.prompt).toContain("Person: STEER: I deleted its KB already.");
  });

  it("what the turn never read goes next, ahead of the queue: after its answer is written, and after it stops", async () => {
    const { listMessages } = await import("./controller-conversations.server");
    const { conversationTurnState, interruptControllerTurn } = await import("./controller-run.server");
    const { queueFakeRun, lastRunSpec } = await import("../../../test-support/fake-runtime");
    const { conversation, send } = await conversationFor();
    const turnOf = () => conversationTurnState(app.db, conversation.id);
    const firstGate = gate();
    queueFakeRun(answer("First answer.", firstGate.opened));
    const first = await send("First.");
    if (first.state !== "started") throw new Error(`turn ${first.state}`);
    const queued = await send("Queued on purpose.", "queue");
    const late = await send("Steer, too late.");
    const firstChannel = lastRunSpec()!.steering!;

    // The model wrote its final answer: the run closes steering. CANARY: drop
    // the move in the channel's `close` and the message waits on a turn that
    // will never read it.
    firstChannel.close();
    const later = await send("Steer, later still.");
    // CANARY: make `steer` ignore `steerable` and this reads "steering".
    expect(later.state).toBe("queued");
    expect(turnOf()).toMatchObject({
      steering: [],
      queued: [
        { messageId: late.messageId, ahead: 1 },
        { messageId: later.messageId, ahead: 2 },
        { messageId: queued.messageId, ahead: 3 },
      ],
    });
    expect(firstChannel.take()).toBeNull();

    // The next turn takes steering again. CANARY: drop `entry.steerable =
    // true` from `startTurnRun` and this one queues.
    const lateGate = gate();
    queueFakeRun(answer("Late answer.", lateGate.opened));
    firstGate.open();
    expect(await pollUntil(() => turnOf().answering === late.messageId)).toBe(true);
    const steersLate = await send("Steers the late turn.");
    expect(steersLate.state).toBe("steering");
    const lateChannel = lastRunSpec()!.steering!;
    expect(lateChannel).not.toBe(firstChannel);
    expect(lateChannel.take()?.count).toBe(1);

    // A turn stopped before reading a steering message leaves it next: after
    // the one that missed a turn before it, ahead of the one queued on
    // purpose. CANARY: drop the settle's move of the unread steering and it
    // is lost with the lease.
    const stopped = await send("Steers a turn that stops.");
    expect(stopped.state).toBe("steering");
    const lateRun = turnOf().runId;
    queueFakeRun({ ...answer("After the stop."), keepRunning: true });
    await interruptControllerTurn(
      app.db,
      { conversationId: conversation.id, runId: lateRun!, dataRoot: app.dataRoot },
      { userId: ownerId, label: "selin@viberr.dev" },
    );
    lateGate.open();
    expect(await pollUntil(() => turnOf().answering === later.messageId)).toBe(true);
    expect(turnOf()).toMatchObject({
      steering: [],
      queued: [
        { messageId: stopped.messageId, ahead: 1 },
        { messageId: queued.messageId, ahead: 2 },
      ],
    });
    const byId = new Map(listMessages(app.db, conversation.id).map((m) => [m.id, m]));
    expect(byId.get(steersLate.messageId)!.steeredInto).toBe(late.messageId);
    expect(byId.get(stopped.messageId)!.steeredInto).toBeNull();

    // Let the rest drain so the lease is gone when the next test starts.
    await interruptControllerTurn(
      app.db,
      { conversationId: conversation.id, runId: turnOf().runId!, dataRoot: app.dataRoot },
      { userId: ownerId, label: "selin@viberr.dev" },
    );
    expect(await pollUntil(() => turnOf().answering === null)).toBe(true);
  });

  it("Send now and Retract act on a message still waiting, and only for its owner", async () => {
    const { listMessages } = await import("./controller-conversations.server");
    const { conversationTurnState, retractWaitingMessage, sendQueuedMessageNow, interruptControllerTurn } =
      await import("./controller-run.server");
    const { queueFakeRun, lastRunSpec } = await import("../../../test-support/fake-runtime");
    const { conversation, send } = await conversationFor();
    const turnOf = () => conversationTurnState(app.db, conversation.id);
    const owner = { ...user, id: ownerId };
    const target = (messageId: string, who: ControllerTurnInput["user"] = owner) => ({
      conversationId: conversation.id,
      messageId,
      user: who,
    });
    queueFakeRun({ ...answer("Working on it."), keepRunning: true });
    const first = await send("First.");
    if (first.state !== "started") throw new Error(`turn ${first.state}`);
    const one = await send("Queued one.", "queue");
    const two = await send("Queued two.", "queue");

    // Send now: out of the queue, into the running turn.
    expect(sendQueuedMessageNow(app.db, target(two.messageId))).toBe("steering");
    expect(turnOf()).toMatchObject({
      steering: [two.messageId],
      queued: [{ messageId: one.messageId, ahead: 1 }],
    });

    // Only the owner, even an org admin is refused. CANARY: drop
    // `requireOwnConversation` from `retractWaitingMessage`.
    const admin = { id: orgAdminId, email: "arda@viberr.dev", name: "Arda", orgRole: "admin" as const };
    expect(() => retractWaitingMessage(app.db, target(one.messageId, admin))).toThrow(
      "Only the conversation's owner can talk in it.",
    );

    // Retract: the message leaves the transcript and its text comes back.
    expect(retractWaitingMessage(app.db, target(one.messageId))).toBe("Queued one.");
    expect(listMessages(app.db, conversation.id).map((m) => m.id)).not.toContain(one.messageId);
    expect(turnOf().queued).toEqual([]);

    // Once the turn has read a message it stays. CANARY: search `take`n
    // messages in `retractWaitingMessage` and a read message is deleted.
    lastRunSpec()!.steering!.take();
    expect(() => retractWaitingMessage(app.db, target(two.messageId))).toThrow(
      "That message has already been read, so it can't be taken back.",
    );
    expect(() => sendQueuedMessageNow(app.db, target(two.messageId))).toThrow(
      "That message is not waiting any more",
    );
    expect(listMessages(app.db, conversation.id).map((m) => m.id)).toContain(two.messageId);

    // Send now on a turn that has written its answer: it goes next instead.
    const three = await send("Queued three.", "queue");
    const four = await send("Queued four.", "queue");
    lastRunSpec()!.steering!.close();
    expect(sendQueuedMessageNow(app.db, target(four.messageId))).toBe("queued");
    expect(turnOf().queued).toEqual([
      { messageId: four.messageId, ahead: 1 },
      { messageId: three.messageId, ahead: 2 },
    ]);

    // Drain: retract what is left and stop the turn.
    retractWaitingMessage(app.db, target(three.messageId));
    retractWaitingMessage(app.db, target(four.messageId));
    await interruptControllerTurn(
      app.db,
      { conversationId: conversation.id, runId: turnOf().runId!, dataRoot: app.dataRoot },
      { userId: ownerId, label: "selin@viberr.dev" },
    );
    expect(await pollUntil(() => turnOf().answering === null)).toBe(true);
  });
});
