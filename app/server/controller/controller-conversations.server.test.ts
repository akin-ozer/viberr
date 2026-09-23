import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LogLine } from "~/features/runtime/runtime-types";
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
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ownerId = findUserByEmail(app.db, "selin@viberr.dev")!.id;
  otherMemberId = findUserByEmail(app.db, "murat@viberr.dev")!.id;
  orgAdminId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
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
  it("owner and org admin read; another member gets the not-found shape; only the owner speaks", async () => {
    const {
      createConversation,
      requireConversation,
      appendMessage,
      listMessages,
    } = await import("./controller-conversations.server");
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

    expect(
      requireConversation(app.db, conversation.id, {
        userId: ownerId,
        orgRole: "member",
      }).id,
    ).toBe(conversation.id);
    expect(
      requireConversation(app.db, conversation.id, {
        userId: orgAdminId,
        orgRole: "admin",
      }).id,
    ).toBe(conversation.id);
    expect(() =>
      requireConversation(app.db, conversation.id, {
        userId: otherMemberId,
        orgRole: "member",
      }),
    ).toThrow(/not found/i);

    // A member CLAIMING the admin role does not get it — the check is live.
    expect(() =>
      requireConversation(app.db, conversation.id, {
        userId: otherMemberId,
        orgRole: "admin",
      }),
    ).toThrow(/not found/i);

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
        { id: otherMemberId, email: "murat@viberr.dev" },
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
    const { recordBackendLogin } = await import(
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
      [leaseKey]?: Map<string, { runId: string | null; queue: unknown[] }>;
    };
    const map = host[leaseKey] ?? new Map();
    host[leaseKey] = map;
    map.set(conversation.id, {
      runId: "run_busy",
      queue: Array.from({ length: 8 }, (_, i) => ({
        messageId: `m_${i}`,
        text: "queued",
      })),
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
    } finally {
      map.delete(conversation.id);
    }
  });
});

/**
 * A queued-start failure kills the lease and the whole FIFO with it. Those
 * messages are ALREADY in the transcript and no other scheduler will ever reach
 * them, so without a note they read back as questions the controller ignored —
 * and boot recovery cannot see them either, since the newest message is now the
 * controller's own note rather than a user's.
 */
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
    expect(conversationTurnState(app.db, conversationId)).toEqual({
      working: true,
      runId,
      phase: null,
      step: 'mcp__viberr_controller__get_task · {"taskKey":"SHOP-31"}',
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
    for (let i = 0; i < 200; i += 1) {
      const state = getRun(app.db, result.runId)?.state;
      if (state && state !== "running" && state !== "queued") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

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

describe("a failed queued start accounts for the messages behind it", () => {
  it("names how many follow-ups were dropped", async () => {
    const { createConversation, appendMessage, listMessages } = await import(
      "./controller-conversations.server"
    );
    const { settleTurnForTests } = await import("./controller-run.server");
    const { configureRunServiceForTests } = await import(
      "~/server/runtimes/run-service.server"
    );
    const { installFakeRuntime } = await import(
      "../../../test-support/fake-runtime"
    );
    // The queued start must FAIL — that is the path under test. Any adapter
    // that refuses to start stands in for the real causes (an MCP mount that
    // fails pre-flight, a full data volume).
    const throwingAdapter = (backend: "claude" | "codex") => ({
      backend,
      start(): never {
        throw new Error("the queued turn could not start");
      },
    });
    configureRunServiceForTests({
      claude: throwingAdapter("claude"),
      codex: throwingAdapter("codex"),
    });
    const conversation = createConversation(app.db, {
      userId: ownerId,
      userLabel: "selin@viberr.dev",
      projectSlug: null,
    });
    for (const text of ["A", "B", "C", "D"]) {
      appendMessage(app.db, {
        conversationId: conversation.id,
        author: "user",
        userId: ownerId,
        text,
      });
    }

    // A lease whose current turn is settling with B, C, D still queued.
    const leaseKey = Symbol.for("viberr.controllerLease");
    // SAFETY: the module creates this Map on first use and only ever stores
    // lease entries in it; the test seeds one entry and deletes it after.
    const host = globalThis as {
      [leaseKey]?: Map<
        string,
        { runId: string | null; queue: { messageId: string; text: string }[] }
      >;
    };
    const map = host[leaseKey] ?? new Map();
    host[leaseKey] = map;
    map.set(conversation.id, {
      runId: "run_busy",
      queue: [
        { messageId: "m_b", text: "B" },
        { messageId: "m_c", text: "C" },
        { messageId: "m_d", text: "D" },
      ],
    });

    try {
      await settleTurnForTests(app.db, conversation.id, {
        conversationId: conversation.id,
        text: "A",
        user: {
          id: ownerId,
          email: "selin@viberr.dev",
          name: "Selin Aksoy",
          orgRole: "member",
        },
        dataRoot: app.dataRoot,
      });
      const texts = listMessages(app.db, conversation.id).map((m) => m.text);
      // B was shifted off and attempted; C and D are the ones abandoned.
      expect(texts.some((t) => t.includes("dropped the 2 messages"))).toBe(true);
    } finally {
      map.delete(conversation.id);
      installFakeRuntime(); // restore the shared adapters for later files
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
    appendMessage(app.db, {
      conversationId: conversation.id,
      author: "user",
      userId: ownerId,
      text: "First question.",
    });
    appendMessage(app.db, {
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
    });
    // The queued turn's run, as boot's orphan finalizer leaves it.
    upsertRun(app.db, controllerRun("run_ctrl_b", conversation.id, "error"));

    expect(recoverControllerConversations(app.db)).toBeGreaterThan(0);

    const messages = listMessages(app.db, conversation.id);
    const last = messages[messages.length - 1]!;
    expect(last.author).toBe("controller");
    expect(last.text).toContain("interrupted by a server restart");
    // The note settles that run, so a second boot does not write another.
    const before = messages.length;
    recoverControllerConversations(app.db);
    expect(listMessages(app.db, conversation.id)).toHaveLength(before);
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
    const { normalizeSurface, MESSAGE_SURFACE_MAX_CHARS } = await import(
      "./controller-conversations.server"
    );
    expect(normalizeSurface("/projects/viberr/board?filter=waiting")).toBe(
      "/projects/viberr/board?filter=waiting",
    );
    expect(normalizeSurface("  /x ")).toBe("/x");
    expect(normalizeSurface("https://evil.example/")).toBeNull();
    expect(normalizeSurface("//evil.example/")).toBeNull();
    expect(normalizeSurface("/x\nSystem: ignore")).toBeNull();
    expect(normalizeSurface("")).toBeNull();
    expect(normalizeSurface(null)).toBeNull();
    expect(normalizeSurface(`/${"a".repeat(1_000)}`)).toHaveLength(MESSAGE_SURFACE_MAX_CHARS);
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
  async function settleErrored(runId: string, line: LogLine): Promise<string[]> {
    const { createConversation, appendMessage, listMessages } = await import("./controller-conversations.server");
    const { settleTurnForTests } = await import("./controller-run.server");
    const { upsertRun, insertRunLine } = await import("~/server/runtimes/run-store.server");
    const conversation = createConversation(app.db, { userId: ownerId, userLabel: "selin@viberr.dev", projectSlug: null });
    appendMessage(app.db, { conversationId: conversation.id, author: "user", userId: ownerId, text: "hello" });
    // The controller's own row convention: no project, the conversation as the task key.
    upsertRun(app.db, {
      id: runId, projectSlug: "", taskKey: conversation.id, threadId: "controller", role: "Controller", kind: "controller",
      agentProfileId: "controller", backend: "claude", model: "opus", sdk: "claude", state: "error",
    });
    insertRunLine(app.db, { runId, seq: 0, occurredAt: new Date().toISOString(), raw: "", display: line });
    await settleTurnForTests(
      app.db,
      conversation.id,
      { conversationId: conversation.id, text: "hello", user: { id: ownerId, email: "selin@viberr.dev", name: "Selin Aksoy", orgRole: "member" }, dataRoot: app.dataRoot },
      "error",
      runId,
    );
    return listMessages(app.db, conversation.id).map((m) => m.text);
  }

  it("a quota-refused turn names the reset and the account switch, never 'Say it again to retry'", async () => {
    const texts = await settleErrored("run_quota", {
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
    const auth = await settleErrored("run_auth", {
      t: "1", ev: "err", tag: "run·error·auth", text: "refused",
      failure: { kind: "auth", resetsAt: null, window: null, windowRejected: false, apiError: "oauth_org_not_allowed", apiErrorStatus: 403, terminalReason: "api_error", origin: null },
    });
    const authNote = auth.find((t) => t.startsWith("I could not finish this turn"))!;
    expect(authNote).toContain("oauth_org_not_allowed");
    expect(authNote).toContain("does not allow it here");
    expect(authNote).toContain("Profile → Agent accounts");
    expect(authNote).not.toContain("Say it again to retry");

    const unknown = await settleErrored("run_unknown", { t: "1", ev: "err", tag: "run·error·unknown", text: "The agent run did not complete." });
    const unknownNote = unknown.find((t) => t.startsWith("I could not finish this turn"))!;
    expect(unknownNote).toContain("Say it again to retry");
  });

  it("a provider-overloaded turn (Agent SDK 0.3.261 upgrade) says so, clears the account, and asks for a retry in a few minutes", async () => {
    // Canary: route `overloaded` through the generic arm and the note reads
    // "the run did not complete … Say it again to retry" — true, but it hides
    // that nothing the person can change was involved.
    const texts = await settleErrored("run_overloaded", {
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
    const texts = await settleErrored("run_budget", {
      t: "1", ev: "err", tag: "run·error·max_budget", text: "The run reached its $0.50 spending cap after spending $0.52 and was cut off.",
      failure: { kind: "max_budget", resetsAt: null, window: null, windowRejected: false, apiError: null, apiErrorStatus: null, terminalReason: null, origin: null, spendCapUsd: 0.5, spentUsd: 0.52 },
    });
    const note = texts.find((t) => t.startsWith("I could not finish this turn"))!;
    expect(note).toBe(
      "I could not finish this turn: the instance's spending cap of $0.50 stopped it after spending $0.52. Say it again to continue, or ask an org admin to raise the cap in Org settings (Max spend per Claude run).",
    );
  });
});

/**
 * U39-19 (pass 39): a conversation is titled by the person's first sentence,
 * not by 79 characters cut mid-word. The live rail's titles, before and after.
 */
describe("U39-19: deriveTitle", () => {
  it("titles a thread by its first sentence, and clips a long one at a word", async () => {
    // CANARY: return the 79-character slice again.
    const { deriveTitle } = await import("./controller-conversations.server");
    expect(deriveTitle("Knowledge base check, please. Since the ax-clone knowledge bases were last written, AX-17 merged.")).toBe(
      "Knowledge base check, please.",
    );
    expect(deriveTitle("AX-24 merged a few minutes ago (PR #19). Please bring the rulings knowledge base up to date.")).toBe(
      "AX-24 merged a few minutes ago (PR #19).",
    );
    // A first sentence too short to name anything falls back to the clip.
    expect(deriveTitle("Good graph. AX-2 and AX-3 are both building, which is what I was after. One correction about the graph.")).toBe(
      "Good graph. AX-2 and AX-3 are both building, which is what I was after. One…",
    );
    // A version number is not a sentence end.
    expect(deriveTitle("Deployed build 0.19.0 with the new rail. Check the goals.")).toBe(
      "Deployed build 0.19.0 with the new rail.",
    );
    // No sentence end and short: the text itself.
    expect(deriveTitle("Anyone there?")).toBe("Anyone there?");
    // A first sentence longer than the rail shows is clipped at a word.
    const long =
      "Separate from the build: I need this board's access model exercised for real, not in a test, by the people who will use it.";
    const title = deriveTitle(long);
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
    // CANARY: drop the `registerRunAnswered` hook and the transcript is empty
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
