import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  insertTestUser,
  OPEN_DECISION,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { insertUser } from "~/server/auth/user-store.server";
import { rebuildAll } from "./rebuilder.server";
import { setupProjectedStore } from "../../../test-support/projected-store";
import {
  onProjectionEvent,
  type ProjectionEvent,
} from "~/server/events/projection-events.server";
import { setPref } from "~/server/prefs/user-prefs.server";
import { NOTIFS_PREF_KEY } from "~/features/profile/profile-query.server";
import { setNotifRoutingPref } from "~/features/profile/profile-actions.server";
import type { NotificationKind } from "~/shared/mapping/notification.server";
import { listHomeProjectsForUser } from "~/features/home/home-query.server";
import {
  attentionSnapshot,
  bellCounts,
  countUnreadNotifications,
  createNotification,
  type CreateNotificationInput,
  epicLink,
  isTaskViewNavigation,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  markTaskNotificationsSeen,
  markTaskPacketApprovalRead,
  projectGithubLink,
  taskDecisionLink,
  taskEventLink,
  taskRecommendationsLink,
} from "./notifications.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("notifications", () => {
  it("lists per-user rows sorted by real timestamp DESC (ruling 9)", () => {
    const db = ctx.makeDb();
    // Inserted deliberately out of order (the mock fixture is unsorted).
    createNotification(db, { id: "a", userId: "u_1", kind: "packet", ptype: "input", text: "t", occurredAt: "2026-07-04T06:41:00.000Z" });
    createNotification(db, { id: "b", userId: "u_1", kind: "approval", text: "t", occurredAt: "2026-07-04T07:12:00.000Z" });
    createNotification(db, { id: "c", userId: "u_1", kind: "mention", text: "t", occurredAt: "2026-07-03T08:20:00.000Z" });
    createNotification(db, { id: "other", userId: "u_2", kind: "policy", text: "t" });

    const list = listNotifications(db, "u_1");
    expect(list.map((n) => n.id)).toEqual(["b", "a", "c"]);
    expect(list[1]?.ptype).toBe("input");
  });

  it("soft project refs resolve display names when the project exists", () => {
    const db = ctx.makeDb();
    db.prepare(
      `INSERT INTO projects (slug, name, task_prefix, stages_json, workflow_json, source_path, content_hash, parsed_at)
       VALUES ('deploy-pipeline', 'Deploy Pipeline', 'DEP', '[]', '[]', 'projects/deploy-pipeline/project.md', 'h', '2026-07-04T00:00:00Z')`,
    ).run();
    createNotification(db, { id: "x", userId: "u_1", kind: "packet", ptype: "input", text: "t", projectSlug: "deploy-pipeline", taskKey: "DEP-31" });
    createNotification(db, { id: "y", userId: "u_1", kind: "approval", text: "t", projectSlug: "billing-service", taskKey: "BIL-9" });

    const list = listNotifications(db, "u_1");
    expect(list.find((n) => n.id === "x")?.projectName).toBe("Deploy Pipeline");
    // Unresolvable soft ref falls back to the slug — never a crash.
    expect(list.find((n) => n.id === "y")?.projectName).toBe("billing-service");
    // F18-1: `y`'s project no longer exists → it is an orphan: not navigable
    // (href nulled) and flagged so the renderer shows a "no longer exists" note.
    // `x`'s project resolves, so it stays a live, clickable row.
    const y = list.find((n) => n.id === "y")!;
    const x = list.find((n) => n.id === "x")!;
    expect(y.targetMissing).toBe(true);
    expect(y.href).toBeNull();
    expect(x.targetMissing).toBe(false);
    expect(x.href).toBe("/projects/deploy-pipeline/tasks/DEP-31");
  });

  it("F18-1: the unread badge excludes notifications whose project was deleted", () => {
    const db = ctx.makeDb();
    insertTestUser(db, "u_1");
    db.prepare(
      `INSERT INTO projects (slug, name, task_prefix, stages_json, workflow_json, source_path, content_hash, parsed_at)
       VALUES ('live-proj', 'Live', 'LIV', '[]', '[]', 'projects/live-proj/project.md', 'h', '2026-07-04T00:00:00Z')`,
    ).run();
    // One unread org-wide, one unread in a live project, one unread in a GONE project.
    createNotification(db, { id: "org", userId: "u_1", kind: "policy", text: "t" });
    createNotification(db, { id: "live", userId: "u_1", kind: "packet", ptype: "input", text: "t", projectSlug: "live-proj", taskKey: "LIV-1" });
    createNotification(db, { id: "gone", userId: "u_1", kind: "packet", ptype: "input", text: "t", projectSlug: "wiped-proj", taskKey: "WIP-9" });
    // The orphan ("gone") does not inflate the badge — only org + live count.
    expect(countUnreadNotifications(db, "u_1")).toBe(2);
    // Ruling 457 / F19-25: the bell's head counts the orphan beside the badge,
    // from the server now that pages no longer ship the list; read rows and
    // other people's rows count in neither.
    createNotification(db, { id: "gone-read", userId: "u_1", kind: "packet", text: "t", projectSlug: "wiped-proj", readAt: "2026-07-04T00:00:00Z" });
    createNotification(db, { id: "theirs", userId: "u_2", kind: "packet", text: "t", projectSlug: "wiped-proj" });
    expect(bellCounts(db, "u_1")).toEqual({ unread: 2, orphanUnread: 1 });
    expect(bellCounts(db, "u_3")).toEqual({ unread: 0, orphanUnread: 0 });
  });

  it("read-marking is idempotent and monotonic", () => {
    const db = ctx.makeDb();
    createNotification(db, { id: "a", userId: "u_1", kind: "packet", text: "t" });
    createNotification(db, { id: "b", userId: "u_1", kind: "quality", text: "t" });
    expect(countUnreadNotifications(db, "u_1")).toBe(2);

    expect(markNotificationsRead(db, "u_1", ["a"])).toBe(1);
    expect(markNotificationsRead(db, "u_1", ["a"])).toBe(0); // idempotent
    expect(markNotificationsRead(db, "u_2", ["b"])).toBe(0); // wrong user
    expect(countUnreadNotifications(db, "u_1")).toBe(1);

    expect(markAllNotificationsRead(db, "u_1")).toBe(1);
    expect(countUnreadNotifications(db, "u_1")).toBe(0);
  });

  it("`from` actors resolve against the CURRENT users table at read time (E1)", () => {
    const db = ctx.makeDb();
    insertTestUser(db, "u_sender");
    createNotification(db, {
      id: "n1",
      userId: "u_1",
      kind: "mention",
      text: "t",
      from: {
        kind: "human",
        userId: "u_sender",
        name: "u_sender",
        initials: "U",
        tone: "",
      },
    });

    db.prepare(`UPDATE users SET name = ? WHERE id = ?`).run(
      "Sender Renamed",
      "u_sender",
    );
    const renamed = listNotifications(db, "u_1")[0]!;
    expect(renamed.from).toMatchObject({
      kind: "human",
      name: "Sender Renamed",
      initials: "SR",
    });

    // Deleted sender → the baked snapshot survives.
    db.prepare(`DELETE FROM users WHERE id = ?`).run("u_sender");
    const orphan = listNotifications(db, "u_1")[0]!;
    expect(orphan.from).toMatchObject({ kind: "human", name: "u_sender" });
  });

  it("mark-read emits a user-scoped notification.read event — once, only on change (E12)", () => {
    const db = ctx.makeDb();
    createNotification(db, { id: "a", userId: "u_1", kind: "packet", text: "t" });
    createNotification(db, { id: "b", userId: "u_1", kind: "quality", text: "t" });

    const events: ProjectionEvent[] = [];
    const off = onProjectionEvent((e) => {
      if (e.type === "notification.read") events.push(e);
    });

    markNotificationsRead(db, "u_1", ["a"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "notification.read", userId: "u_1" });

    // Idempotent re-mark changes nothing → no event (no badge churn).
    markNotificationsRead(db, "u_1", ["a"]);
    expect(events).toHaveLength(1);

    markAllNotificationsRead(db, "u_1");
    expect(events).toHaveLength(2);
    markAllNotificationsRead(db, "u_1"); // nothing left unread
    expect(events).toHaveLength(2);
    off();
  });

  it("markTaskPacketApprovalRead emits notification.read per affected user (E12)", () => {
    const db = ctx.makeDb();
    createNotification(db, { id: "p1", userId: "u_1", kind: "packet", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });
    createNotification(db, { id: "p2", userId: "u_2", kind: "approval", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });
    createNotification(db, { id: "m", userId: "u_3", kind: "mention", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });

    const users: string[] = [];
    const off = onProjectionEvent((e) => {
      if (e.type === "notification.read") users.push(e.userId);
    });
    markTaskPacketApprovalRead(db, "viberr-core", "VIB-142");
    off();
    expect(users.sort()).toEqual(["u_1", "u_2"]); // u_3's mention untouched
  });

  it("markTaskPacketApprovalRead touches only packet/approval kinds — every user", () => {
    const db = ctx.makeDb();
    createNotification(db, { id: "p", userId: "u_1", kind: "packet", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });
    createNotification(db, { id: "ap", userId: "u_2", kind: "approval", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });
    createNotification(db, { id: "m", userId: "u_1", kind: "mention", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });
    createNotification(db, { id: "othertask", userId: "u_1", kind: "packet", text: "t", projectSlug: "viberr-core", taskKey: "VIB-160" });

    expect(markTaskPacketApprovalRead(db, "viberr-core", "VIB-142")).toBe(2);
    const rows = db.prepare(`SELECT id, read_at FROM notifications`).all();
    expect(rows.find((r) => r.id === "p")?.read_at).not.toBeNull();
    expect(rows.find((r) => r.id === "ap")?.read_at).not.toBeNull();
    expect(rows.find((r) => r.id === "m")?.read_at).toBeNull();
    expect(rows.find((r) => r.id === "othertask")?.read_at).toBeNull();
  });

  /**
   * Ruling 481(a): an agent's question is a packet on the task, so the packet's
   * resolution clears its `question` row too. Otherwise an answered question
   * stayed unread in every watcher's bell and tab title.
   *
   * Canary: put the default back to `["packet", "approval"]` and the question
   * row stays unread.
   */
  /**
   * Ruling 481(c) (F40-51): what a tab nobody is looking at reads. It counts
   * the viewer's UNREAD decisions (packet, agent question, approval) that lead
   * somewhere, and words the newest for a desktop notification with the
   * bell's own destination.
   *
   * Canary: drop `question` from `DECISION_NOTIFICATION_KINDS`, or the orphan
   * condition, and the count is wrong.
   */
  it("attentionSnapshot counts the unread decisions and words the newest (ruling 481)", () => {
    const db = ctx.makeDb();
    db.prepare(
      `INSERT INTO projects (slug, name, task_prefix, stages_json, workflow_json, source_path, content_hash, parsed_at)
       VALUES ('akinozer-com', 'akinozer.com', 'WEB', '[]', '[]', 'projects/akinozer-com/project.md', 'h', '2026-09-25T00:00:00Z')`,
    ).run();
    const at = (m: number) => `2026-09-25T03:${String(m).padStart(2, "0")}:00.000Z`;
    const base = { userId: "u_1", projectSlug: "akinozer-com" };
    createNotification(db, { ...base, id: "q", kind: "question", taskKey: "WEB-3", occurredAt: at(8), title: "Platform Engineer asks: Connect Workers Builds", text: "Only **the owner** can press `Connect`.", href: "/projects/akinozer-com/tasks/WEB-3#decision" });
    createNotification(db, { ...base, id: "p", kind: "packet", ptype: "input", taskKey: "WEB-2", occurredAt: at(5), title: "Decision needed: merge PR #3?", text: "Both reviewers approved." });
    createNotification(db, { ...base, id: "a", kind: "approval", taskKey: "WEB-4", occurredAt: at(4), title: "Operator recommends: Move to Review", text: "Delivered." });
    // Not counted: read, not a decision, another person's, a deleted project.
    createNotification(db, { ...base, id: "read", kind: "packet", taskKey: "WEB-5", occurredAt: at(9), text: "t", readAt: at(9) });
    createNotification(db, { ...base, id: "m", kind: "mention", taskKey: "WEB-3", occurredAt: at(9), text: "t" });
    createNotification(db, { ...base, id: "theirs", userId: "u_2", kind: "question", taskKey: "WEB-3", text: "t" });
    createNotification(db, { id: "orphan", userId: "u_1", kind: "question", projectSlug: "gone", taskKey: "GON-1", text: "t" });

    const snapshot = attentionSnapshot(db, "u_1");
    expect(snapshot.waiting).toBe(3);
    expect(snapshot.items.map((i) => i.id)).toEqual(["q", "p", "a"]);
    expect(snapshot.items[0]).toEqual({
      id: "q",
      title: "Platform Engineer asks: Connect Workers Builds",
      body: "WEB-3 · akinozer.com\nOnly the owner can press Connect.",
      // Ruling 497: a desktop notification opens where the bell's row does.
      href: "/projects/akinozer-com/tasks/WEB-3#decision",
    });
    expect(attentionSnapshot(db, "u_nobody")).toEqual({ waiting: 0, items: [] });
  });

  it("markTaskPacketApprovalRead clears an agent question with the packet (ruling 481)", () => {
    const db = ctx.makeDb();
    createNotification(db, { id: "q", userId: "u_1", kind: "question", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });
    expect(markTaskPacketApprovalRead(db, "viberr-core", "VIB-142")).toBe(1);
    const row = db.prepare(`SELECT read_at FROM notifications WHERE id = 'q'`).get();
    expect(row?.read_at).not.toBeNull();
  });
});

/**
 * R19-15: viewing a task auto-reads its notifications — for the VIEWER only.
 * The inverse scoping of `markTaskPacketApprovalRead`: every kind (a view sees
 * the mention and the policy row too, not just the decision kinds), one user
 * (nobody else's rows are proven seen by someone else's page view).
 */
describe("R19-15: markTaskNotificationsSeen — viewing a task auto-reads its rows", () => {
  /** Every kind for the viewer on the viewed task, plus the two rows that must
   *  survive: another USER's on the same task, the viewer's on ANOTHER task. */
  function seedViewRows(db: DatabaseSync): void {
    createNotification(db, { id: "s_p", userId: "u_1", kind: "packet", ptype: "input", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });
    createNotification(db, { id: "s_a", userId: "u_1", kind: "approval", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });
    createNotification(db, { id: "s_m", userId: "u_1", kind: "mention", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });
    createNotification(db, { id: "s_q", userId: "u_1", kind: "quality", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });
    createNotification(db, { id: "s_pol", userId: "u_1", kind: "policy", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });
    createNotification(db, { id: "s_other_user", userId: "u_2", kind: "packet", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });
    createNotification(db, { id: "s_other_task", userId: "u_1", kind: "mention", text: "t", projectSlug: "viberr-core", taskKey: "VIB-160" });
  }

  it("marks EVERY kind for that user+task — nobody else's rows, no other task's", () => {
    const db = ctx.makeDb();
    seedViewRows(db);
    expect(markTaskNotificationsSeen(db, "u_1", "viberr-core", "VIB-142")).toBe(5);
    const read = db
      .prepare(`SELECT id FROM notifications WHERE read_at IS NOT NULL`)
      .all()
      .map((r) => r.id)
      .sort();
    expect(read).toEqual(["s_a", "s_m", "s_p", "s_pol", "s_q"]);
  });

  it("second view marks 0 rows and emits NO event — the convergence the loader call relies on", () => {
    const db = ctx.makeDb();
    seedViewRows(db);
    const events: ProjectionEvent[] = [];
    const off = onProjectionEvent((e) => {
      if (e.type === "notification.read") events.push(e);
    });
    markTaskNotificationsSeen(db, "u_1", "viberr-core", "VIB-142");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "notification.read", userId: "u_1" });
    // The revalidation the first event triggers re-runs the loader → this
    // second pass. It must change nothing and stay silent, or the loop sustains.
    expect(markTaskNotificationsSeen(db, "u_1", "viberr-core", "VIB-142")).toBe(0);
    expect(events).toHaveLength(1);
    off();
  });
});

describe("F20-11: isTaskViewNavigation — only a genuine document load marks seen", () => {
  const req = (url: string, headers?: Record<string, string>) =>
    new Request(new URL(url, "http://localhost:5173"), { headers });

  it("TRUE for a clean top-level route path (SSR document load)", () => {
    expect(isTaskViewNavigation(req("/projects/viberr-core/tasks/VIB-142"))).toBe(true);
  });

  it("TRUE for a browser navigation (Sec-Fetch-Mode: navigate)", () => {
    expect(
      isTaskViewNavigation(
        req("/projects/viberr-core/tasks/VIB-142", {
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
        }),
      ),
    ).toBe(true);
  });

  it("FALSE for a single-fetch `.data` revalidation (the F20-11 background eat)", () => {
    // The SSE-driven revalidation and the post-POST revalidation both land here.
    expect(
      isTaskViewNavigation(
        req("/projects/viberr-core/tasks/VIB-142.data?_routes=routes/project.task", {
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
        }),
      ),
    ).toBe(false);
  });

  it("FALSE for any non-navigation fetch that reaches a clean path", () => {
    // Belt-and-suspenders: a same-origin fetch (not a top-level navigation) is
    // never a "view", even without the `.data` suffix.
    expect(
      isTaskViewNavigation(
        req("/projects/viberr-core/tasks/VIB-142", { "Sec-Fetch-Mode": "cors" }),
      ),
    ).toBe(false);
  });
});

describe("createNotification routing prefs (FIX #4)", () => {
  const ALL_KINDS: NotificationKind[] = [
    "packet",
    "approval",
    "mention",
    "policy",
    "quality",
  ];

  it("delivers every category by default (opt-out: no stored pref → all ON)", () => {
    const db = ctx.makeDb();
    for (const kind of ALL_KINDS) {
      expect(createNotification(db, { userId: "u_1", kind, text: "t" })).not.toBeNull();
    }
    expect(countUnreadNotifications(db, "u_1")).toBe(ALL_KINDS.length);
  });

  it("skips the insert (returns null) when the recipient silenced that category", () => {
    const db = ctx.makeDb();
    insertTestUser(db, "u_1");
    // u_1 silences packets; every other category stays default-ON.
    setPref(db, "u_1", NOTIFS_PREF_KEY, { packets: { app: false } });

    const packetId = createNotification(db, { userId: "u_1", kind: "packet", text: "t" });
    const approvalId = createNotification(db, { userId: "u_1", kind: "approval", text: "t" });

    expect(packetId).toBeNull(); // silenced → no row written
    expect(approvalId).not.toBeNull();
    expect(listNotifications(db, "u_1").map((n) => n.kind)).toEqual(["approval"]);
  });

  it("maps each singular kind to its plural pref category", () => {
    const db = ctx.makeDb();
    insertTestUser(db, "u_1");
    // Silence exactly the mentions + quality categories.
    setPref(db, "u_1", NOTIFS_PREF_KEY, {
      mentions: { app: false },
      quality: { app: false },
    });
    const delivered = ALL_KINDS.filter(
      (kind) => createNotification(db, { userId: "u_1", kind, text: "t" }) !== null,
    );
    expect(delivered).toEqual(["packet", "approval", "policy"]);
  });

  it("routing is per-recipient — a silenced user doesn't mute anyone else", () => {
    const db = ctx.makeDb();
    insertTestUser(db, "u_1");
    insertTestUser(db, "u_2");
    setPref(db, "u_1", NOTIFS_PREF_KEY, { policy: { app: false } });
    expect(createNotification(db, { userId: "u_1", kind: "policy", text: "t" })).toBeNull();
    expect(createNotification(db, { userId: "u_2", kind: "policy", text: "t" })).not.toBeNull();
  });

  /**
   * T16 (pass 31) — UC-32, verified live: the profile toggle for "Decision
   * packets for you" persisted, and the routing half went to this test plan.
   *
   * The three tests above hand-write the pref blob with `setPref`, so they
   * prove the READER's gate and nothing about the WRITER the product actually
   * uses. `setNotifRoutingPref` merges into the stored document rather than
   * replacing it, and a merge bug is invisible to a hand-written fixture. The
   * uncovered half is the return trip: no test anywhere writes `app: true`
   * back, so "unticking silences it" was locked and "re-ticking restores it"
   * was not — a toggle a human cannot undo is worse than one that never worked.
   */
  it("T16: the profile toggle silences ONE user's packets and re-enabling restores delivery", () => {
    // Canary: drop the `...current` spread in `setNotifRoutingPref` (so the
    // write replaces the document instead of merging) and the bystander
    // assertions still pass while `approval` for u_1 starts failing; hard-code
    // `app: false` there and the re-enable assertion fails.
    const db = ctx.makeDb();
    insertTestUser(db, "u_1");
    insertTestUser(db, "u_2");

    // Off, through the product's own writer — the profile page's action.
    setNotifRoutingPref(db, "u_1", "packets", false);
    expect(createNotification(db, { userId: "u_1", kind: "packet", text: "t" })).toBeNull();
    // Only that category, and only that user.
    expect(createNotification(db, { userId: "u_1", kind: "approval", text: "t" })).not.toBeNull();
    expect(createNotification(db, { userId: "u_2", kind: "packet", text: "t" })).not.toBeNull();

    // …and back on again.
    setNotifRoutingPref(db, "u_1", "packets", true);
    expect(createNotification(db, { userId: "u_1", kind: "packet", text: "t" })).not.toBeNull();
    // Membership, not order: the two rows land within the same millisecond,
    // so their newest-first order is a coin flip under load (full-suite flake).
    expect(
      listNotifications(db, "u_1")
        .map((n) => n.kind)
        .sort(),
    ).toEqual(["approval", "packet"]);
    // The toggle is validated, not free-form — an unknown category is refused
    // rather than silently stored as a category nothing will ever consult.
    expect(() => setNotifRoutingPref(db, "u_1", "not-a-category", false)).toThrow();
  });
});

describe("waitingOnYou — live decision reconciliation (F7-NOTIF1)", () => {
  const REC = {
    id: "rec-1",
    kind: "transition" as const,
    toStageId: "review",
    label: "Approve transition",
    detail: "",
  };

  it("packet notification: waiting while the packet is open, drops out once resolved", () => {
    const store = setupTestStore(ctx);
    // R8-3: waitingOnYou is member-scoped — the recipient must be able to act on
    // the decision. murat is a maintainer, so the packet is in his `mine` set.
    const uid = store.users.murat.id;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-101", { stage: "review" }),
      packet: OPEN_DECISION,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    createNotification(store.db, { id: "p", userId: uid, kind: "packet", ptype: "input", text: "t", projectSlug: store.slug, taskKey: "VIB-101" });
    expect(listNotifications(store.db, uid)[0]?.waitingOnYou).toBe(true);

    // Packet resolved (cleared from the file) — the notification leaves the
    // waiting bucket WITHOUT being deleted or auto-read. Resolution hands the
    // task back to an agent; a review-stage task still waiting on a HUMAN is a
    // pending acceptance and stays in the bucket by design (B-FD5).
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-101", { stage: "review", waiting: "agent" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const after = listNotifications(store.db, uid);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: "p", waitingOnYou: false, unread: true });
  });

  it("approval notification: waiting while a recommendation is pending, drops out once applied", () => {
    const store = setupTestStore(ctx);
    const uid = store.users.murat.id; // maintainer — can act on the decision
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-102", { stage: "impl", recommendations: [REC] }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    createNotification(store.db, { id: "a", userId: uid, kind: "approval", text: "t", projectSlug: store.slug, taskKey: "VIB-102" });
    expect(listNotifications(store.db, uid)[0]?.waitingOnYou).toBe(true);

    // Recommendation applied/dismissed (cleared from the file) and the task
    // handed to an agent — a review-stage task still waiting on a human is a
    // pending acceptance and would legitimately stay in the bucket (B-FD5).
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-102", { stage: "review", waiting: "agent" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(listNotifications(store.db, uid)[0]?.waitingOnYou).toBe(false);
  });

  it("unresolvable task refs and non-decision kinds are never waiting", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-104", { stage: "review" }),
      packet: OPEN_DECISION,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    // Foreign/deleted soft ref — no local task row to reconcile against.
    createNotification(store.db, { id: "x", userId: "u_1", kind: "packet", ptype: "input", text: "t", projectSlug: "other-org-project", taskKey: "OTH-1" });
    // A mention on a task with an open packet is still not a decision.
    createNotification(store.db, { id: "m", userId: "u_1", kind: "mention", text: "t", projectSlug: store.slug, taskKey: "VIB-104" });
    expect(listNotifications(store.db, "u_1").map((n) => n.waitingOnYou)).toEqual([
      false,
      false,
    ]);
  });
});

describe("notification destinations + acceptance decisions (B-FD5/B-FD6)", () => {
  it("B-FD6: rows resolve to a task, a project, or NOTHING (never a dead click)", () => {
    // F18-1: the project must exist in the PROJECTION for its rows to stay
    // clickable (a deleted project → orphan, href null). Boot always rescans, so
    // rebuild here to reflect the real "project exists" state this test asserts.
    const store = setupProjectedStore(ctx);
    const uid = store.users.murat.id;
    createNotification(store.db, { id: "n_task", userId: uid, kind: "quality", text: "t", projectSlug: store.slug, taskKey: "VIB-1", occurredAt: "2026-07-01T03:00:00.000Z" });
    createNotification(store.db, { id: "n_proj", userId: uid, kind: "policy", text: "t", projectSlug: store.slug, occurredAt: "2026-07-01T02:00:00.000Z" });
    createNotification(store.db, { id: "n_org", userId: uid, kind: "policy", text: "t", occurredAt: "2026-07-01T01:00:00.000Z" });
    expect(listNotifications(store.db, uid).map((n) => [n.id, n.href])).toEqual([
      ["n_task", `/projects/${store.slug}/tasks/VIB-1`],
      ["n_proj", `/projects/${store.slug}`],
      ["n_org", null],
    ]);
  });

  /**
   * Ruling 497: a row opens the exact thing its notifier said it is about, and
   * only inside the project the row names, so the orphan rule (F18-1) and a
   * member's removal still decide whether it opens at all.
   *
   * Canaries: resolve the stored link without `opensInside` and the foreign and
   * lookalike rows open other projects; drop the stored link and every row
   * opens its task's top, which is the dead click this ruling fixes.
   */
  it("ruling 497: a row opens the link its notifier recorded, inside its own project only", () => {
    const store = setupProjectedStore(ctx);
    const uid = store.users.murat.id;
    const slug = store.slug;
    const row = (
      id: string,
      minute: number,
      href: string | null,
      extra: Partial<CreateNotificationInput> = {},
    ) =>
      createNotification(store.db, {
        id,
        userId: uid,
        kind: "quality",
        text: "t",
        projectSlug: slug,
        taskKey: "VIB-1",
        href,
        occurredAt: `2026-07-01T03:${String(minute).padStart(2, "0")}:00.000Z`,
        ...extra,
      });
    row("event", 9, taskEventLink(slug, "VIB-1", "2026-07-01T02:59:00.123Z"));
    row("decision", 8, taskDecisionLink(slug, "VIB-1"));
    row("recs", 7, taskRecommendationsLink(slug, "VIB-1"));
    // A proposal's row from before ruling 498 (no writer files one now).
    row("proposal", 6, `/projects/${slug}/controller#proposal-kp-0123456789`);
    row("github", 5, projectGithubLink(slug), { taskKey: null });
    // Ruling 503: an epic's page, where the goal-chain anchor used to go.
    row("epic", 4, epicLink(slug, "epic-2"), { kind: "epic", taskKey: null });
    row("foreign", 3, "/projects/other/tasks/OTH-1#decision");
    row("lookalike", 2, `/projects/${slug}x/tasks/VIB-1`);
    row("offsite", 1, "https://example.com/projects/x");
    row("orphan", 0, "/projects/gone/tasks/GON-1#decision", { projectSlug: "gone", taskKey: "GON-1" });
    expect(Object.fromEntries(listNotifications(store.db, uid).map((n) => [n.id, n.href]))).toEqual({
      event: `/projects/${slug}/tasks/VIB-1#event-2026-07-01T02:59:00.123Z`,
      decision: `/projects/${slug}/tasks/VIB-1#decision`,
      recs: `/projects/${slug}/tasks/VIB-1#recommendations`,
      proposal: `/projects/${slug}/controller#proposal-kp-0123456789`,
      github: `/projects/${slug}/github`,
      epic: `/projects/${slug}/epics/epic-2`,
      // Not inside the row's project: the task it names, as before.
      foreign: `/projects/${slug}/tasks/VIB-1`,
      lookalike: `/projects/${slug}/tasks/VIB-1`,
      offsite: `/projects/${slug}/tasks/VIB-1`,
      // F18-1 still wins: a project that is gone opens nothing.
      orphan: null,
    });
  });

  it("B-FD5: an approval row on an acceptance-ready task with NO packet is waiting on the acceptor", () => {
    const store = setupTestStore(ctx);
    const revision = {
      id: "rev_1",
      headSha: "b".repeat(40),
      treeSha: "u".repeat(40),
      branch: "vib-106-work",
      createdAt: "2026-07-04T00:00:00.000Z",
      sourceProfileId: "developer",
    };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-106", {
        stage: "review",
        waiting: "human",
        branch: revision.branch,
        pr: { number: 106, state: "review", title: "Approved work" },
        workRevision: revision,
        engagements: [
          { profileId: "reviewer", backend: "claude", role: "Review", delivers: false, verdictCapable: true },
        ],
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: revision.id,
            headSha: revision.headSha,
            result: "approve",
            reason: "looks good",
            at: "2026-07-04T01:00:00.000Z",
            rounds: 1,
          },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const uid = store.users.murat.id; // maintainer → holds acceptance
    createNotification(store.db, { id: "acc", userId: uid, kind: "approval", text: "t", projectSlug: store.slug, taskKey: "VIB-106" });
    // The task carries no packet and no recommendation: before B-FD5 the shared
    // decision source could not see it, so the inbox read "not waiting" while
    // the review queue listed it under "Waiting on your acceptance".
    expect(listNotifications(store.db, uid)[0]?.waitingOnYou).toBe(true);
    // A viewer has no acceptance authority → still not waiting on them.
    const elif = store.users.elif.id;
    createNotification(store.db, { id: "acc2", userId: elif, kind: "approval", text: "t", projectSlug: store.slug, taskKey: "VIB-106" });
    expect(listNotifications(store.db, elif)[0]?.waitingOnYou).toBe(false);
  });
});

/**
 * E6: the inbox and Home's project cards are the two surfaces that answer
 * "waiting on you", and they used to make the `mine` / `overrideEligible` pick
 * independently — agreeing only by comment. These drive BOTH off one store so a
 * change to either reading fails here, and they pin the ruling: an org admin's
 * override eligibility is governance reach, never a personal inbox item.
 */
describe("E6: 'waiting on you' reads the same on the inbox and on Home", () => {
  /** One project, one open packet, plus an org admin with NO project role. */
  function storeWithOpenPacket() {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-140", { stage: "review" }),
      packet: OPEN_DECISION,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const outsideAdmin = insertUser(store.db, {
      id: "u_orgadmin_e6",
      email: "orgadmin-e6@viberr.test",
      name: "Org Admin",
      role: "admin",
    });
    return { store, outsideAdmin };
  }

  const cardFor = (
    db: DatabaseSync,
    id: string,
    role: "admin" | "member",
    slug: string,
  ) => listHomeProjectsForUser(db, { id, role }).find((p) => p.slug === slug)!;

  it("a maintainer: the inbox says waiting, the card counts it, nothing lands in the override counter", () => {
    const { store } = storeWithOpenPacket();
    const uid = store.users.murat.id;
    createNotification(store.db, { id: "e6m", userId: uid, kind: "packet", text: "t", projectSlug: store.slug, taskKey: "VIB-140" });

    expect(listNotifications(store.db, uid)[0]?.waitingOnYou).toBe(true);
    const card = cardFor(store.db, uid, "member", store.slug);
    expect(card.waiting).toBe(1);
    expect(card.overrideWaiting).toBe(0);
  });

  it("an org admin with no project role: BOTH surfaces keep it out of the personal count, and only Home reports the override reach", () => {
    const { store, outsideAdmin } = storeWithOpenPacket();
    createNotification(store.db, { id: "e6a", userId: outsideAdmin.id, kind: "packet", text: "t", projectSlug: store.slug, taskKey: "VIB-140" });

    // The ruling: override eligibility is governance, not an inbox item. The
    // inbox has no second counter to put it in, so it simply does not wait.
    expect(listNotifications(store.db, outsideAdmin.id)[0]?.waitingOnYou).toBe(
      false,
    );
    // Home does not drop it — it reports it as its own, differently-labelled
    // number. Folding it into `waiting` would tell an org admin they personally
    // owe an answer on every project in the instance.
    const card = cardFor(store.db, outsideAdmin.id, "admin", store.slug);
    expect(card.waiting).toBe(0);
    expect(card.overrideWaiting).toBe(1);
  });

  it("a viewer reaches neither bucket on either surface", () => {
    const { store } = storeWithOpenPacket();
    const uid = store.users.elif.id;
    createNotification(store.db, { id: "e6v", userId: uid, kind: "packet", text: "t", projectSlug: store.slug, taskKey: "VIB-140" });

    expect(listNotifications(store.db, uid)[0]?.waitingOnYou).toBe(false);
    const card = cardFor(store.db, uid, "member", store.slug);
    expect(card.waiting).toBe(0);
    expect(card.overrideWaiting).toBe(0);
  });
});
