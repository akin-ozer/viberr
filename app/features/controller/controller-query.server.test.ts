import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import { setupTestStore, type TestStore } from "../../../test-support/test-store";
import { setBackendApiKey } from "~/server/runtimes/backend-credentials.server";
import { getControllerSurface } from "./controller-query.server";

/**
 * Ruling 127 — `available` on the controller surface is a fact about the PERSON
 * looking at it.
 *
 * A controller turn runs on the ASKER's own Claude account (the run row records
 * them as its credential principal), so the surface cannot go on answering one
 * deployment-wide boolean: on the same instance, at the same second, a member
 * who has connected Claude converses and one who has not is refused. The old
 * shape could not express that, and the page it fed said "the Claude backend is
 * unavailable" to everybody or to nobody.
 *
 * These pin the per-viewer answer and the rule that the surface carries no
 * credential material of any kind (it is loader data, i.e. a public payload).
 */

const CLAUDE_KEY = "sk-ant-api03-viberr-controller-surface-test";

/** A provider that accepts the pasted key, so a person can be connected with no
 *  network (`npm test` never opens a socket). */
const acceptingProvider: typeof fetch = () =>
  Promise.resolve(new Response("{}", { status: 200 }));

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
});
afterEach(() => ctx.cleanup());

async function connectClaude(userId: string, label: string): Promise<void> {
  await setBackendApiKey(store.db, { userId, label }, "claude", "api_key", CLAUDE_KEY, {
    fetchImpl: acceptingProvider,
    dataRoot: store.dataRoot,
  });
}

function surfaceFor(user: { id: string; email: string }) {
  return getControllerSurface(store.db, user, {
    projectSlug: null,
    conversationId: null,
    all: false,
    dataRoot: store.dataRoot,
  });
}

describe("getControllerSurface — availability is the viewer's own Claude (ruling 127)", () => {
  it("is false for a viewer who has connected nothing", () => {
    const view = surfaceFor(store.users.murat);
    expect(view.available).toBe(false);
  });

  it("is true once THAT person connects Claude, and stays false for everyone else", async () => {
    await connectClaude(store.users.murat.id, store.users.murat.email);
    expect(surfaceFor(store.users.murat).available).toBe(true);
    // The canary for a regression back to an instance-level probe: one member's
    // connection must never answer for another's.
    expect(surfaceFor(store.users.selin).available).toBe(false);
  });

  it("carries no key, no sealed box and no home path in the loader payload", async () => {
    await connectClaude(store.users.murat.id, store.users.murat.email);
    const wire = JSON.stringify(surfaceFor(store.users.murat));
    expect(wire).not.toContain(CLAUDE_KEY);
    expect(wire).not.toContain("secret_box");
    expect(wire).not.toContain(store.dataRoot);
  });
});

/**
 * The open conversation's runtime rides the surface: the Live-run strip and
 * the Agent-logs console on the controller page are the task page's panels fed
 * from the same projection, asked for the ruling-99 scope a controller run is
 * stored under (`project_slug = ''`, `task_key = <conversation id>`).
 */
describe("getControllerSurface — the open conversation's runtime", () => {
  async function conversationWithRun(ownerId: string, ownerLabel: string) {
    const [{ createConversation }, { upsertRun, insertRunLine }] = await Promise.all([
      import("~/server/controller/controller-conversations.server"),
      import("~/server/runtimes/run-store.server"),
    ]);
    const conversation = createConversation(store.db, {
      userId: ownerId,
      userLabel: ownerLabel,
      projectSlug: null,
    });
    upsertRun(store.db, {
      id: `run_${conversation.id}`,
      projectSlug: "",
      taskKey: conversation.id,
      threadId: "controller",
      role: "Controller",
      kind: "controller",
      agentProfileId: "controller",
      agentName: "Controller",
      backend: "claude",
      model: "claude-opus-4-8",
      sdk: "claude-agent-sdk",
      state: "running",
      startedAt: "2026-09-05T08:00:00.000Z",
    });
    insertRunLine(store.db, {
      runId: `run_${conversation.id}`,
      seq: 0,
      occurredAt: "2026-09-05T08:00:01.000Z",
      raw: JSON.stringify({ type: "assistant" }),
      display: { t: "08:00:01", ev: "text", tag: "assistant", text: "Reading the board." },
    });
    return conversation;
  }

  it("projects the conversation's controller run as one console entry, with its lines", async () => {
    // Canary: return `[]` for `runtime` and the strip and console have nothing
    // to render.
    const conversation = await conversationWithRun(store.users.murat.id, store.users.murat.email);
    const view = getControllerSurface(store.db, store.users.murat, {
      projectSlug: null,
      conversationId: conversation.id,
      all: false,
      dataRoot: store.dataRoot,
    });
    expect(view.runtime).toHaveLength(1);
    const run = view.runtime[0]!;
    expect(run.kind).toBe("controller");
    expect(run.serverRunId).toBe(`run_${conversation.id}`);
    expect(run.state).toBe("running");
    expect(run.who.name).toBe("Controller");
    expect(run.lines.map((l) => l.text)).toEqual(["Reading the board."]);
    expect(run.logWindow.headSeq).toBe(0);
  });

  it("is empty with no conversation open", () => {
    expect(surfaceFor(store.users.murat).runtime).toEqual([]);
    expect(surfaceFor(store.users.murat).canInterruptTurn).toBe(false);
  });

  it("offers the interrupt to the owner and to an org admin, not to another member", async () => {
    // Canary: derive `canInterruptTurn` from `viewerOwnsActive` alone and the
    // admin loses the control the engine would honour.
    const conversation = await conversationWithRun(store.users.murat.id, store.users.murat.email);
    const open = (viewer: { id: string; email: string }, all = false) =>
      getControllerSurface(store.db, viewer, {
        projectSlug: null,
        conversationId: conversation.id,
        all,
        dataRoot: store.dataRoot,
      });
    expect(open(store.users.murat).canInterruptTurn).toBe(true);
    expect(open(store.users.arda, true).canInterruptTurn).toBe(true);
    // Selin cannot even open it (404); the surface never reaches the flag.
    expect(() => open(store.users.selin)).toThrow();
  });
});

/**
 * Ruling 419(f): a person is named on the controller page the way the rest of
 * the app names them. A conversation stores its owner's email when it is
 * created, and the transcript and the rail printed "arda@viberr.dev" beside
 * every message the task timeline attributes to "Arda".
 */
describe("getControllerSurface — people are named by display name (ruling 419(f))", () => {
  it("names the open thread's owner and every listed thread's owner, not their address", async () => {
    // CANARY: return `c.userLabel` / the stored conversation unchanged.
    const { createConversation } = await import("~/server/controller/controller-conversations.server");
    const own = createConversation(store.db, {
      userId: store.users.arda.id,
      userLabel: store.users.arda.email,
      projectSlug: null,
    });
    createConversation(store.db, {
      userId: store.users.murat.id,
      userLabel: store.users.murat.email,
      projectSlug: null,
    });
    const view = getControllerSurface(store.db, store.users.arda, {
      projectSlug: null,
      conversationId: own.id,
      all: true,
      dataRoot: store.dataRoot,
    });
    expect(view.conversation?.userLabel).toBe(store.users.arda.name);
    expect(view.conversations.map((c) => c.ownerLabel).sort()).toEqual(
      [store.users.arda.name, store.users.murat.name].sort(),
    );
    expect(JSON.stringify(view.conversations)).not.toContain("@");
  });

  it("keeps the stored label for an owner who no longer has a row", async () => {
    const { createConversation } = await import("~/server/controller/controller-conversations.server");
    createConversation(store.db, { userId: "u_gone", userLabel: "gone@viberr.dev", projectSlug: null });
    const view = getControllerSurface(store.db, store.users.arda, {
      projectSlug: null,
      conversationId: null,
      all: true,
      dataRoot: store.dataRoot,
    });
    expect(view.conversations.find((c) => c.ownerLabel === "gone@viberr.dev")).toBeDefined();
  });
});
