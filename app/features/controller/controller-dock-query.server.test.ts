import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
  type TestStoreUser,
} from "../../../test-support/test-store";
import {
  appendMessage,
  createConversation,
  type ControllerConversation,
} from "~/server/controller/controller-conversations.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  connectFakeBackend,
  disconnectFakeBackend,
} from "../../../test-support/backend-credentials";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import {
  conversationMatchesScope,
  dockTaskExists,
  getControllerDock,
  unavailableDockView,
} from "./controller-dock-query.server";
import { NEW_CONVERSATION_PARAM } from "./conversation-param";

/**
 * Ruling 121 — the controller dock's view.
 *
 * Two promises live in this module, and nothing in the suite imported it until
 * pass 33 (ruling 65: a guard that cannot go red is a ruling that gets
 * reverted in silence).
 *
 * ONE, the scope binding. A conversation belongs to exactly one place — the
 * instance, one board, or one task — and the dock shows that place's threads
 * and nothing else. `conversationMatchesScope` is the cross-scope leak guard:
 * a task thread must never surface in its own board's dock, and a board thread
 * must never surface under the task.
 *
 * TWO, nothing here throws. The dock's loader is a ROOT-owned fetcher, and
 * React Router routes a fetcher loader's thrown response to the boundary of
 * the route that OWNS the fetcher — root — so a throw would replace the whole
 * page with the root error page (the hazard ruling 121(f) named). A scope the
 * person cannot reach therefore answers a benign, empty `unavailable` view,
 * and a selection that cannot be honoured falls back to the scope's newest
 * thread and reports `staleSelection` so the client forgets the id it asked for.
 */

const SLUG = "viberr-core";
const OTHER_SLUG = "billing-service";

const ctx = createTestDbContext();
afterEach(() => {
  ctx.cleanup();
});

/**
 * The seeded store plus a SECOND project, so "another board" and "a task key
 * that belongs to a different project" are real rows rather than hypotheticals
 * — the wrong-project case is the one `dockTaskExists` exists to refuse.
 */
function storeWithTwoProjects(): TestStore {
  const store = setupTestStore(ctx);
  writeProject(store.dataRoot, {
    name: "Billing Service",
    slug: OTHER_SLUG,
    repo: "akin-ozer/billing-service",
    defaultBranch: "main",
    taskPrefix: "BIL",
    nextTaskNumber: 2,
    stages: GOVERNED_TEMPLATE.stages,
    workflow: GOVERNED_TEMPLATE.workflow,
    members: [{ userId: store.users.arda.id, role: "admin" }],
    agents: [],
    credentialPolicy: null,
    guardrails: [],
    requiredReviewers: [],
  fileLeases: [],
  });
  writeTask(store.dataRoot, SLUG, {
    frontmatter: baseTaskFrontmatter("VIB-101"),
  });
  writeTask(store.dataRoot, SLUG, {
    frontmatter: baseTaskFrontmatter("VIB-102"),
  });
  writeTask(store.dataRoot, OTHER_SLUG, {
    frontmatter: baseTaskFrontmatter("BIL-1"),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

function thread(
  store: TestStore,
  owner: TestStoreUser,
  binding: { projectSlug: string | null; taskKey: string | null },
): ControllerConversation {
  return createConversation(store.db, {
    userId: owner.id,
    userLabel: owner.email,
    projectSlug: binding.projectSlug,
    taskKey: binding.taskKey,
  });
}

function say(store: TestStore, conversation: ControllerConversation, text: string): void {
  appendMessage(store.db, {
    conversationId: conversation.id,
    author: "user",
    userId: conversation.userId,
    text,
  });
}

function dock(
  store: TestStore,
  viewer: TestStoreUser,
  input: {
    projectSlug: string | null;
    taskKey: string | null;
    conversationId: string | null;
    markSeen?: boolean;
  },
) {
  return getControllerDock(
    store.db,
    { id: viewer.id },
    { ...input, dataRoot: store.dataRoot },
  );
}

describe("conversationMatchesScope — one thread, one place", () => {
  /**
   * THE cross-scope leak guard (ruling 121). The tempting shape — "same
   * project, and the task matches when the scope names one" — reads fine and
   * leaks every task thread into its board's dock; the mirror slip leaks a
   * board thread into the task. So assert the whole matrix, both directions:
   * a thread matches its own scope and NO other, including the neighbouring
   * ones (a sibling task, the same task in another project, the board above).
   */
  it("matches a thread to its own scope and to no other, in both directions", () => {
    const store = storeWithTwoProjects();
    const places = [
      { name: "instance", binding: { projectSlug: null, taskKey: null } },
      { name: "the viberr-core board", binding: { projectSlug: SLUG, taskKey: null } },
      { name: "the billing-service board", binding: { projectSlug: OTHER_SLUG, taskKey: null } },
      { name: "task VIB-101", binding: { projectSlug: SLUG, taskKey: "VIB-101" } },
      { name: "its sibling task VIB-102", binding: { projectSlug: SLUG, taskKey: "VIB-102" } },
      { name: "task BIL-1 of the other project", binding: { projectSlug: OTHER_SLUG, taskKey: "BIL-1" } },
    ];
    // Real rows, not literals: the binding a thread carries comes back out of
    // SQLite as NULL-or-string, which is exactly what the predicate compares.
    const threads = places.map((place) => ({
      name: place.name,
      binding: place.binding,
      row: thread(store, store.users.selin, place.binding),
    }));

    const wrong = threads.flatMap((t) =>
      threads
        .filter((s) => conversationMatchesScope(t.row, s.binding) !== (t === s))
        .map((s) =>
          t === s
            ? `a ${t.name} thread does not match its OWN scope`
            : `a ${t.name} thread leaks into ${s.name}`,
        ),
    );
    expect(wrong).toEqual([]);
  });
});

describe("getControllerDock — the dock lists one place's threads", () => {
  /**
   * The predicate above is only half the guard: the LIST is built by a scope
   * query, and a dock that asked for "this project's threads" without
   * narrowing to the task would show a board's dock every task thread under it
   * — the panel would read as one merged inbox and a person would answer in
   * the wrong context. Also pins the visibility rule the store owns: threads
   * are per-USER (a project member does not see another member's transcript).
   */
  it("shows this scope's threads only, and only the viewer's own", () => {
    const store = storeWithTwoProjects();
    const selin = store.users.selin;
    const instance = thread(store, selin, { projectSlug: null, taskKey: null });
    const board = thread(store, selin, { projectSlug: SLUG, taskKey: null });
    const task101 = thread(store, selin, { projectSlug: SLUG, taskKey: "VIB-101" });
    const task102 = thread(store, selin, { projectSlug: SLUG, taskKey: "VIB-102" });
    const anotherMembers = thread(store, store.users.murat, {
      projectSlug: SLUG,
      taskKey: null,
    });

    const listed = (projectSlug: string | null, taskKey: string | null) =>
      dock(store, selin, { projectSlug, taskKey, conversationId: null }).threads.map(
        (t) => t.id,
      );

    expect(listed(null, null)).toEqual([instance.id]);
    expect(listed(SLUG, null)).toEqual([board.id]);
    expect(listed(SLUG, "VIB-101")).toEqual([task101.id]);
    expect(listed(SLUG, "VIB-102")).toEqual([task102.id]);
    // A board this person has never spoken about is simply empty.
    expect(listed(OTHER_SLUG, null)).toEqual([]);
    // …and another member's thread on the very same board is not the viewer's
    // to see, in any scope.
    expect(listed(SLUG, null)).not.toContain(anotherMembers.id);
  });

  /**
   * `c` absent means "the newest thread here"; `c=new` means "an empty
   * composer". The distinction matters twice: every open of the panel asks for
   * the newest thread (ruling 528), and `new` must NOT be reported stale —
   * `staleSelection` is what makes the client drop its selection for this
   * scope, so treating the deliberate "new" as a failed lookup would wipe the
   * person's choice on every load.
   */
  it("opens the scope's newest thread by default, and `new` opens none without calling it stale", () => {
    const store = storeWithTwoProjects();
    const selin = store.users.selin;
    const older = thread(store, selin, { projectSlug: SLUG, taskKey: null });
    const newest = thread(store, selin, { projectSlug: SLUG, taskKey: null });
    say(store, newest, "Which tasks are waiting on me?");

    const opened = dock(store, selin, {
      projectSlug: SLUG,
      taskKey: null,
      conversationId: null,
    });
    expect(opened.conversation?.id).toBe(newest.id);
    expect(opened.staleSelection).toBe(false);
    expect(opened.messages.map((m) => m.text)).toEqual(["Which tasks are waiting on me?"]);
    expect(opened.viewerOwnsActive).toBe(true);
    expect(opened.turn).toEqual({ working: false, runId: null, phase: null, step: null, answering: null, queued: [], steering: [] });
    expect(opened.threads.map((t) => t.id)).toEqual([newest.id, older.id]);
    // A thread nobody has spoken in yet still carries a label in the list —
    // an empty title would render as an unclickable-looking blank row.
    expect(opened.threads.map((t) => t.title)).toEqual([
      "Which tasks are waiting on me?",
      "New conversation",
    ]);

    const blank = dock(store, selin, {
      projectSlug: SLUG,
      taskKey: null,
      conversationId: NEW_CONVERSATION_PARAM,
    });
    expect(blank.conversation).toBeNull();
    expect(blank.messages).toEqual([]);
    expect(blank.turn).toEqual({ working: false, runId: null, phase: null, step: null, answering: null, queued: [], steering: [] });
    expect(blank.staleSelection).toBe(false);
    // The thread list is still there: "new" empties the transcript, not the panel.
    expect(blank.threads.map((t) => t.id)).toEqual([newest.id, older.id]);
  });

  /**
   * The never-throw promise, at the selection. Every one of these used to be a
   * candidate for a 404: the dock's fetcher is root-owned, so that 404 would
   * have painted the root error page over whatever the person was doing. The
   * answer is the scope's newest thread plus `staleSelection: true`, which is
   * also the signal that makes the client drop the id instead of asking for it
   * again on every load.
   */
  it("falls back to the scope's newest thread and reports staleSelection instead of throwing", () => {
    const store = storeWithTwoProjects();
    const selin = store.users.selin;
    const older = thread(store, selin, { projectSlug: SLUG, taskKey: null });
    const newest = thread(store, selin, { projectSlug: SLUG, taskKey: null });
    say(store, newest, "Newest board thread.");
    const ownTaskThread = thread(store, selin, { projectSlug: SLUG, taskKey: "VIB-101" });
    const ownInstanceThread = thread(store, selin, { projectSlug: null, taskKey: null });
    const anotherMembers = thread(store, store.users.murat, {
      projectSlug: SLUG,
      taskKey: null,
    });

    const unhonourable = [
      { why: "a thread of a narrower scope (this task's, asked on the board)", id: ownTaskThread.id },
      { why: "a thread of a looser scope (the instance's, asked on the board)", id: ownInstanceThread.id },
      { why: "another member's thread in this very scope", id: anotherMembers.id },
      { why: "an id with no row at all (a re-baselined database)", id: "cnv_gone000000" },
    ];
    for (const { why, id } of unhonourable) {
      const view = dock(store, selin, {
        projectSlug: SLUG,
        taskKey: null,
        conversationId: id,
      });
      expect([why, view.staleSelection]).toEqual([why, true]);
      expect([why, view.conversation?.id]).toEqual([why, newest.id]);
      expect([why, view.messages.map((m) => m.text)]).toEqual([why, ["Newest board thread."]]);
      // The fallback never widens the list either.
      expect([why, view.threads.map((t) => t.id)]).toEqual([why, [newest.id, older.id]]);
    }

    // And where the scope has NO thread to fall back to, the fallback is "no
    // conversation" — still a view, still not a throw.
    const empty = dock(store, selin, {
      projectSlug: SLUG,
      taskKey: "VIB-102",
      conversationId: ownTaskThread.id,
    });
    expect(empty.staleSelection).toBe(true);
    expect(empty.conversation).toBeNull();
    expect(empty.messages).toEqual([]);
    expect(empty.turn).toEqual({ working: false, runId: null, phase: null, step: null, answering: null, queued: [], steering: [] });
    expect(empty.threads).toEqual([]);
    expect(empty.viewerOwnsActive).toBe(false);
  });

  /**
   * Org admins READ every conversation (supervision, ruling 99) — so an
   * admin's selection of someone else's thread in this scope is honourable and
   * must not be discarded as stale. Speaking is another matter: only the owner
   * may, and `viewerOwnsActive` is the single flag the panel disables its
   * composer on. Getting this pair wrong in either direction is a real defect:
   * `false`/`false` hides supervision, `true`/`true` lets an admin type into a
   * transcript whose every action is evaluated against ANOTHER person's
   * authority.
   */
  it("honours an org admin's supervised selection but marks it not-owned", () => {
    const store = storeWithTwoProjects();
    const selins = thread(store, store.users.selin, { projectSlug: SLUG, taskKey: null });
    say(store, selins, "Selin's own board thread.");

    const view = dock(store, store.users.arda, {
      projectSlug: SLUG,
      taskKey: null,
      conversationId: selins.id,
    });
    expect(view.staleSelection).toBe(false);
    expect(view.conversation?.id).toBe(selins.id);
    expect(view.messages.map((m) => m.text)).toEqual(["Selin's own board thread."]);
    expect(view.viewerOwnsActive).toBe(false);
    // Supervision is a read of ONE named thread, never a browse: the admin's
    // own (empty) thread list is what the panel offers.
    expect(view.threads).toEqual([]);
  });
});

/**
 * O39-d: the open dock is the other place a transcript is read. Opening a
 * thread there makes its replies seen, and the list marks the rest.
 */
describe("getControllerDock — replies the viewer has not seen (O39-d)", () => {
  it("the thread the panel opens is seen, and the other threads here are flagged", async () => {
    const { appendMessage, listUnseenReplies } = await import("~/server/controller/controller-conversations.server");
    const store = storeWithTwoProjects();
    const selin = store.users.selin;
    const older = thread(store, selin, { projectSlug: SLUG, taskKey: null });
    const newer = thread(store, selin, { projectSlug: SLUG, taskKey: null });
    for (const c of [older, newer]) {
      appendMessage(store.db, { conversationId: c.id, author: "controller", text: "Done." });
    }
    // CANARY: drop `markConversationSeen` from the dock and the thread the
    // person is reading stays a "new reply".
    const view = dock(store, selin, {
      projectSlug: SLUG,
      taskKey: null,
      conversationId: older.id,
      markSeen: true,
    });
    expect(Object.fromEntries(view.threads.map((t) => [t.id, t.unread]))).toEqual({
      [older.id]: false,
      [newer.id]: true,
    });
    expect(listUnseenReplies(store.db, selin.id).map((r) => r.id)).toEqual([newer.id]);
  });
});

describe("unavailableDockView — the benign refusal", () => {
  /**
   * The view for a scope the route would not let this person talk in. It is
   * answered INSTEAD of a thrown 404 (which the root boundary would turn into
   * a whole-page error), so it has to be inert in both directions: no
   * composer, and nothing read out of the store. The threads assertion is the
   * load-bearing one — this shape is also served for a project that exists but
   * is not the person's, so listing anything here would be a leak.
   */
  it("answers an empty, inert view that reads no threads out of the store", () => {
    const store = storeWithTwoProjects();
    // A real thread exists in exactly this scope, for a real user.
    thread(store, store.users.selin, { projectSlug: SLUG, taskKey: null });

    const view = unavailableDockView(
      store.db,
      { id: store.users.selin.id },
      { projectSlug: SLUG, taskKey: null },
      store.dataRoot,
    );
    expect(view.unavailable).toBe(true);
    expect(view.threads).toEqual([]);
    expect(view.conversation).toBeNull();
    expect(view.messages).toEqual([]);
    expect(view.turn).toEqual({ working: false, runId: null, phase: null, step: null, answering: null, queued: [], steering: [] });
    expect(view.viewerOwnsActive).toBe(false);
    // Not a stale selection: nothing was selected, and the client must not be
    // told to forget an id it never sent.
    expect(view.staleSelection).toBe(false);
    expect(view.scope.contextLine).toBe(
      "Not available here: this project or task is not open to you.",
    );
    // The panel header still renders: same controller name as anywhere else,
    // and a place to go.
    expect(view.controllerName).toBe(
      dock(store, store.users.selin, {
        projectSlug: SLUG,
        taskKey: null,
        conversationId: null,
      }).controllerName,
    );
    expect(view.scope.pageHref).toBe(`/projects/${SLUG}/controller`);
    // F35-4 (pass 35): the refusal names nothing but what was typed. This
    // view used to spread `describeDockScope`, which reads the project's
    // display name out of the projection, so a non-member learned "Viberr
    // Core" from a slug they guessed. Canary: restore the spread.
    expect(view.scope.projectName).toBeNull();
    expect(view.scope.label).toBe("Not available here");
    expect(JSON.stringify(view)).not.toContain("Viberr Core");
    expect(view.scope.projectSlug).toBe(SLUG);
  });
});

describe("getControllerDock's scope — the pill and the one-line disclosure", () => {
  /**
   * The panel header is the person's only cue about WHICH controller context
   * they are typing into, and the context line is the ruling-121 disclosure of
   * what it can see there. Both are per-scope, and both have to name the
   * place: a board pill that showed a slug (or a task pill with no task key)
   * would leave a person answering about the wrong board with no way to tell.
   */
  it("labels the three scopes, points each at its full surface, and discloses whose authority it acts with", () => {
    const store = storeWithTwoProjects();
    const scopeOf = (binding: { projectSlug: string | null; taskKey: string | null }) =>
      dock(store, store.users.selin, { ...binding, conversationId: null }).scope;

    const instance = scopeOf({ projectSlug: null, taskKey: null });
    expect(instance).toMatchObject({
      kind: "instance",
      projectSlug: null,
      taskKey: null,
      projectName: null,
      label: "Instance",
      pageHref: "/controller",
    });
    expect(instance.contextLine).toContain("your projects and org role");

    const board = scopeOf({ projectSlug: SLUG, taskKey: null });
    expect(board).toMatchObject({
      kind: "board",
      projectSlug: SLUG,
      taskKey: null,
      // The project's DISPLAY name, read live from the projection — not the slug.
      projectName: "Viberr Core",
      label: "Viberr Core",
      pageHref: `/projects/${SLUG}/controller`,
    });
    expect(board.contextLine).toContain("Viberr Core board");

    const task = scopeOf({ projectSlug: SLUG, taskKey: "VIB-101" });
    expect(task).toMatchObject({
      kind: "task",
      projectSlug: SLUG,
      taskKey: "VIB-101",
      projectName: "Viberr Core",
      label: "VIB-101 · Viberr Core",
      pageHref: `/projects/${SLUG}/controller`,
    });
    expect(task.contextLine).toContain("VIB-101 task file");

    // The disclosure every scope owes the person: the controller runs on THEIR
    // permissions, not on a standing grant of its own (ruling 99).
    for (const scope of [instance, board, task]) {
      expect(scope.contextLine).toContain("acts with your permissions");
    }
  });

  /**
   * The never-throw promise, at the label. A project the projection does not
   * have (deleted, or a hand-typed slug) has to degrade to the slug: reaching
   * through the null row for a display name would throw out of a root-owned
   * fetcher and take the page down with it.
   */
  it("degrades to the slug when the project is not in the projection", () => {
    const store = storeWithTwoProjects();
    const { scope } = dock(store, store.users.selin, {
      projectSlug: "deleted-project",
      taskKey: "GONE-9",
      conversationId: null,
    });
    expect(scope.kind).toBe("task");
    expect(scope.projectName).toBe("deleted-project");
    expect(scope.label).toBe("GONE-9 · deleted-project");
    expect(scope.pageHref).toBe("/projects/deleted-project/controller");
  });
});

describe("dockTaskExists — asked before a thread is bound to a task", () => {
  /**
   * The refusal that matters is the middle one. Task keys are per-project, so
   * a key that is real SOMEWHERE ELSE is the shape a stale link or a hand-
   * edited query produces; binding a viberr-core thread to it would anchor
   * every turn's context read to a task this board has never had. "Gone" and
   * "never was" deliberately answer the same.
   */
  it("is true only for a task of the project it is asked about", () => {
    const store = storeWithTwoProjects();
    expect(dockTaskExists(store.db, SLUG, "VIB-101")).toBe(true);
    expect(dockTaskExists(store.db, OTHER_SLUG, "BIL-1")).toBe(true);
    expect(dockTaskExists(store.db, SLUG, "VIB-999")).toBe(false);
    expect(dockTaskExists(store.db, SLUG, "BIL-1")).toBe(false);
    expect(dockTaskExists(store.db, "no-such-project", "VIB-101")).toBe(false);
  });
});

describe("available — the dock's honesty about the backend", () => {
  /**
   * `available` is one of the three flags the panel disables its composer on.
   * A person with no Claude connected must be told so rather than have a
   * message accepted that cannot be answered — and the refusal view has to
   * report it too, or a dock that came back from `unavailable` would enable
   * the composer for somebody with nothing to run on.
   *
   * Ruling 127 makes that a fact about the VIEWER, not the deployment: a turn
   * bills the asker's own Claude account, so one member reads `available:
   * false` while another, on the same instance, reads `true`.
   */
  it("reports the VIEWER's own Claude connection in both the normal and the unavailable view", async () => {
    const store = storeWithTwoProjects();
    const scope = { projectSlug: SLUG, taskKey: null };
    const viewer = store.users.selin;

    await disconnectFakeBackend(store.db, viewer.id, "claude");
    expect(
      dock(store, viewer, { ...scope, conversationId: null }).available,
    ).toBe(false);
    expect(
      unavailableDockView(store.db, { id: viewer.id }, scope, store.dataRoot)
        .available,
    ).toBe(false);

    await connectFakeBackend(store.db, viewer.id, "claude");
    expect(
      dock(store, viewer, { ...scope, conversationId: null }).available,
    ).toBe(true);
    expect(
      unavailableDockView(store.db, { id: viewer.id }, scope, store.dataRoot)
        .available,
    ).toBe(true);

    // The same instance, a different person: still not connected, and the
    // dock says so for them alone.
    expect(
      dock(store, store.users.arda, { ...scope, conversationId: null })
        .available,
    ).toBe(false);
  });
});
