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

/**
 * O39-d: the page is one of the two places a transcript is read, so opening a
 * thread there makes its replies seen, and the rail marks the viewer's other
 * threads that hold a reply they have not opened.
 */
describe("getControllerSurface — replies the viewer has not seen (O39-d)", () => {
  it("opening a thread sees it, the rail flags the others, and an admin reading someone's thread sees nothing for them", async () => {
    const { createConversation, appendMessage, listUnseenReplies } = await import(
      "~/server/controller/controller-conversations.server"
    );
    const replied = (userId: string, text: string) => {
      const c = createConversation(store.db, { userId, userLabel: "x", projectSlug: null });
      appendMessage(store.db, { conversationId: c.id, author: "user", userId, text });
      appendMessage(store.db, { conversationId: c.id, author: "controller", text: `Answer to ${text}` });
      return c;
    };
    const read = replied(store.users.arda.id, "first");
    const waiting = replied(store.users.arda.id, "second");
    const murats = replied(store.users.murat.id, "his");
    const view = getControllerSurface(store.db, store.users.arda, {
      projectSlug: null,
      conversationId: read.id,
      all: true,
      dataRoot: store.dataRoot,
    });
    // CANARY: drop `markConversationSeen` from the surface and the open
    // thread stays flagged while the person reads it.
    const flags = Object.fromEntries(view.conversations.map((c) => [c.id, c.unread]));
    expect(flags).toEqual({ [read.id]: false, [waiting.id]: true, [murats.id]: false });
    expect(listUnseenReplies(store.db, store.users.arda.id).map((r) => r.id)).toEqual([waiting.id]);
    // An org admin opening Murat's thread reads it for nobody.
    getControllerSurface(store.db, store.users.arda, {
      projectSlug: null,
      conversationId: murats.id,
      all: true,
      dataRoot: store.dataRoot,
    });
    expect(listUnseenReplies(store.db, store.users.murat.id).map((r) => r.id)).toEqual([murats.id]);
  });
});

describe("getControllerSurface — the tasks a transcript names (U39-29)", () => {
  it("resolves the keys the open conversation names on this board", async () => {
    // CANARY: return `taskLinks: {}` from getControllerSurface.
    const [{ createConversation, appendMessage }, { writeTask, baseTaskFrontmatter }, { rebuildAll }] = await Promise.all([
      import("~/server/controller/controller-conversations.server"),
      import("../../../test-support/test-store"),
      import("~/server/projections/rebuilder.server"),
    ]);
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-100") });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const conversation = createConversation(store.db, {
      userId: store.users.arda.id,
      userLabel: store.users.arda.email,
      projectSlug: store.slug,
    });
    appendMessage(store.db, { conversationId: conversation.id, author: "controller", text: "I created VIB-100; VIB-5 is gone." });
    const view = getControllerSurface(store.db, store.users.arda, {
      projectSlug: store.slug,
      conversationId: conversation.id,
      all: false,
      dataRoot: store.dataRoot,
    });
    expect(view.taskLinks).toEqual({ "VIB-100": "/projects/viberr-core/tasks/VIB-100" });
  });
});

/**
 * Ruling 419(h): the page the task's chain chip sends a person to carries each
 * chain's history, which the projection never held (`listGoals` returns it
 * empty). A pause, a skip, a cancel and its reason are recorded there and
 * nowhere a person could read them.
 */
describe("getControllerSurface — a chain carries its history (ruling 419(h))", () => {
  it("reads each chain's history from its file, newest first", async () => {
    // CANARY: return `listGoals` unchanged and `history` is empty.
    const { createGoal, updateGoal } = await import("~/server/tasks/goal-actions.server");
    const actor = { userId: store.users.arda.id, label: store.users.arda.email };
    const ctxFiles = { dataRoot: store.dataRoot };
    const made = await createGoal(
      store.db,
      { projectSlug: store.slug, title: "Chain with a past", links: [{ title: "Only link", goal: "Do it." }] },
      actor,
      ctxFiles,
    );
    await updateGoal(
      store.db,
      { projectSlug: store.slug, goalId: made.goalId, action: { op: "pause" } },
      actor,
      ctxFiles,
    );
    const view = getControllerSurface(store.db, store.users.arda, {
      projectSlug: store.slug,
      conversationId: null,
      all: false,
      dataRoot: store.dataRoot,
    });
    const chain = view.goals?.find((g) => g.id === made.goalId);
    expect(chain?.history.length).toBeGreaterThan(0);
    expect(chain?.history[0]!.text).toContain("Paused by");
  });
});

/**
 * Ruling 483 (F40-59): the project surface carries the open knowledge-base
 * proposals its tasks filed, so the owner sees what waits on them; the link to
 * the document is an org admin's, the only person who can open that page.
 */
describe("getControllerSurface — the project's open knowledge-base proposals", () => {
  it("lists them on the project surface only, with the document link for an org admin", async () => {
    const [{ saveKnowledgeBase, resolveStoreTarget }, { writeStoreDoc }, { parseKbProposals }, { withLegacyProposals }] =
      await Promise.all([
        import("~/server/org/resources.server"),
        import("~/server/org/store-files.server"),
        import("~/server/org/kb-proposals.server"),
        import("../../../test-support/kb-legacy-proposals"),
      ]);
    const { baseTaskFrontmatter, writeTask } = await import("../../../test-support/test-store");
    const { rebuildAll } = await import("~/server/projections/rebuilder.server");
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const admin = { userId: store.users.arda.id, label: "arda" };
    const { kb } = await saveKnowledgeBase(store.db, { name: "query-dossier", refresh: "on change" }, admin, {
      dataRoot: store.dataRoot,
    });
    const target = resolveStoreTarget(store.db, "kb", kb.id, { dataRoot: store.dataRoot })!;
    // Filed before ruling 498, and still standing in its document.
    const body = withLegacyProposals("# Facts\n\n- A fact.\n", [
      { taskKey: "VIB-1", filedBy: "Operator", line: "A fact.", correction: "A truer fact.", evidence: "measured" },
    ]);
    writeStoreDoc(store.db, target, [], "facts.md", body, admin);
    const filed = { proposal: parseKbProposals(kb.dir, "facts.md", body)[0]! };
    const on = (user: { id: string; email: string }, projectSlug: string | null) =>
      getControllerSurface(store.db, user, { projectSlug, conversationId: null, dataRoot: store.dataRoot });
    // CANARY: return `null` for `proposals` and the page has nothing to list.
    expect(on(store.users.arda, store.slug).proposals).toEqual([
      expect.objectContaining({
        id: filed.proposal.id,
        kb: kb.dir,
        doc: "facts.md",
        rulings: false,
        taskKey: "VIB-1",
        line: "A fact.",
        docHref: `/org/settings?tab=resources&kb=${kb.dir}&doc=facts.md`,
      }),
    ]);
    expect(on(store.users.murat, store.slug).proposals?.[0]?.docHref).toBeNull();
    expect(on(store.users.arda, null).proposals).toBeNull();
  });
});

/**
 * Ruling 498: the project surface lists what agents on its tasks wrote into a
 * knowledge base, newest first, each with whether a person undid it: the
 * record the owner reads instead of approving each correction first.
 */
describe("getControllerSurface — the project's knowledge-base corrections (ruling 498)", () => {
  it("lists them newest first on the project surface only, clipped for the page, with the document link for an org admin", async () => {
    const [{ saveKnowledgeBase, resolveStoreTarget }, { writeStoreDoc }, { mergeKbCorrection }] = await Promise.all([
      import("~/server/org/resources.server"),
      import("~/server/org/store-files.server"),
      import("~/server/org/kb-corrections.server"),
    ]);
    const admin = { userId: store.users.arda.id, label: "arda" };
    const { kb } = await saveKnowledgeBase(store.db, { name: "query-runbook", refresh: "on change" }, admin, {
      dataRoot: store.dataRoot,
    });
    const target = resolveStoreTarget(store.db, "kb", kb.id, { dataRoot: store.dataRoot })!;
    writeStoreDoc(store.db, target, [], "runbook.md", "# Runbook\n\n- Step one.\n", admin);
    const merge = async (replaces: string | null, text: string, evidence: string) => {
      const r = await mergeKbCorrection(
        store.db,
        {
          kb: kb.dir,
          doc: "runbook.md",
          replaces,
          text,
          evidence,
          projectSlug: store.slug,
          taskKey: "VIB-1",
          filedBy: "Platform Engineer",
          actorRef: "operator",
          rulings: false,
          actor: { userId: null, label: "operator" },
        },
        { dataRoot: store.dataRoot },
      );
      if (!r.ok) throw new Error(r.message);
      return r.correction;
    };
    const first = await merge("- Step one.", "- Step one, measured.", "ran it");
    const second = await merge(null, "- Step two.", "e".repeat(700));
    const on = (user: { id: string; email: string }, projectSlug: string | null) =>
      getControllerSurface(store.db, user, { projectSlug, conversationId: null, dataRoot: store.dataRoot }).corrections;
    const view = on(store.users.arda, store.slug)!;
    // CANARY: return `null` for `corrections` and the page lists nothing.
    expect(view.total).toBe(2);
    expect(view.shown.map((c) => c.id)).toEqual([second.id, first.id]);
    expect(view.shown[1]).toMatchObject({
      replaced: "- Step one.",
      text: "- Step one, measured.",
      taskKey: "VIB-1",
      filedBy: "Platform Engineer",
      undone: null,
      docHref: `/org/settings?tab=resources&kb=${kb.dir}&doc=runbook.md`,
    });
    expect(view.shown[0]!.replaced).toBeNull();
    // The evidence is clipped for the page; the record keeps it whole.
    expect(view.shown[0]!.evidence).toBe(`${"e".repeat(600)}…`);
    expect(on(store.users.murat, store.slug)!.shown[0]!.docHref).toBeNull();
    expect(on(store.users.arda, null)).toBeNull();
  });
});
