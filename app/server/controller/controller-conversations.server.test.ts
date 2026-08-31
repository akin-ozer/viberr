import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  it("a turn with no Claude credential refuses honestly IN the transcript", async () => {
    const { createConversation, listMessages } = await import(
      "./controller-conversations.server"
    );
    const { runControllerTurn } = await import("./controller-run.server");
    const { setBackendAvailability } = await import(
      "~/server/runtimes/runtime-registry.server"
    );
    setBackendAvailability("claude", false);
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
      expect(messages[1]!.text).toContain("Claude backend");
      // The first user message titled the conversation.
      const { getConversation } = await import(
        "./controller-conversations.server"
      );
      expect(getConversation(app.db, conversation.id)!.title).toBe(
        "Anyone there?",
      );
    } finally {
      setBackendAvailability("claude", true);
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
