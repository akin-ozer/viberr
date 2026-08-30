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
});
