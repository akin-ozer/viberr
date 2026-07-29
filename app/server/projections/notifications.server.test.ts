import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import type { TaskPacket } from "~/schemas/task-file.schema";
import { insertUser } from "~/server/auth/user-store.server";
import { rebuildAll } from "./rebuilder.server";
import {
  onProjectionEvent,
  type ProjectionEvent,
} from "~/server/events/projection-events.server";
import { setPref } from "~/server/prefs/user-prefs.server";
import { NOTIFS_PREF_KEY } from "~/features/profile/profile-query.server";
import type { NotificationKind } from "~/shared/mapping/notification.server";
import {
  countUnreadNotifications,
  createNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  markTaskPacketApprovalRead,
} from "./notifications.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/** Real users row (user_prefs FKs to users), so a test can store a pref. */
function mkUser(db: DatabaseSync, id: string): void {
  insertUser(db, {
    id,
    email: `${id}@viberr.test`,
    name: id,
    role: "member",
  });
}

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
    expect(list.every((n) => n.userId === "u_1")).toBe(true);
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
    mkUser(db, "u_sender");
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
    const rows = db
      .prepare(`SELECT id, read_at FROM notifications`)
      .all() as { id: string; read_at: string | null }[];
    expect(rows.find((r) => r.id === "p")?.read_at).not.toBeNull();
    expect(rows.find((r) => r.id === "ap")?.read_at).not.toBeNull();
    expect(rows.find((r) => r.id === "m")?.read_at).toBeNull();
    expect(rows.find((r) => r.id === "othertask")?.read_at).toBeNull();
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
    mkUser(db, "u_1");
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
    mkUser(db, "u_1");
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
    mkUser(db, "u_1");
    mkUser(db, "u_2");
    setPref(db, "u_1", NOTIFS_PREF_KEY, { policy: { app: false } });
    expect(createNotification(db, { userId: "u_1", kind: "policy", text: "t" })).toBeNull();
    expect(createNotification(db, { userId: "u_2", kind: "policy", text: "t" })).not.toBeNull();
  });
});

describe("waitingOnYou — live decision reconciliation (F7-NOTIF1)", () => {
  const PACKET: TaskPacket = {
    type: "input",
    kind: "Decision required",
    from: "operator",
    title: "Pick one",
    body: "",
    observations: [],
    options: [{ kind: "request_edit", t: "Send back", d: "", rec: true }],
  };

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
      packet: PACKET,
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

  it("R8-3: waitingOnYou is member-scoped — a viewer (and a non-member) never wait on a live packet", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-104", { stage: "review" }),
      packet: PACKET,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    // Same live open packet, three recipients.
    createNotification(store.db, { id: "pm", userId: store.users.murat.id, kind: "packet", text: "t", projectSlug: store.slug, taskKey: "VIB-104" });
    createNotification(store.db, { id: "pv", userId: store.users.elif.id, kind: "packet", text: "t", projectSlug: store.slug, taskKey: "VIB-104" });
    createNotification(store.db, { id: "pn", userId: store.users.deniz.id, kind: "packet", text: "t", projectSlug: store.slug, taskKey: "VIB-104" });
    // maintainer → waits; viewer (elif) + non-member (deniz) → never.
    expect(listNotifications(store.db, store.users.murat.id)[0]?.waitingOnYou).toBe(true);
    expect(listNotifications(store.db, store.users.elif.id)[0]?.waitingOnYou).toBe(false);
    expect(listNotifications(store.db, store.users.deniz.id)[0]?.waitingOnYou).toBe(false);
  });

  it("R8-3: a contributor who OWNS the task waits on its packet (owner allowance)", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-105", {
        stage: "review",
        ownerUserId: store.users.selin.id, // selin = contributor
      }),
      packet: PACKET,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    createNotification(store.db, { id: "po", userId: store.users.selin.id, kind: "packet", text: "t", projectSlug: store.slug, taskKey: "VIB-105" });
    expect(listNotifications(store.db, store.users.selin.id)[0]?.waitingOnYou).toBe(true);
  });

  it("a task in the terminal stage is never waiting — leftover packet/rec notwithstanding", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-103", {
        stage: "done",
        waiting: "none",
        recommendations: [REC],
      }),
      packet: PACKET,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    // Use a maintainer so the drop is caused by the TERMINAL stage, not by lack
    // of authority (member-scoping is exercised separately above).
    const uid = store.users.murat.id;
    createNotification(store.db, { id: "p", userId: uid, kind: "packet", ptype: "input", text: "t", projectSlug: store.slug, taskKey: "VIB-103" });
    createNotification(store.db, { id: "a", userId: uid, kind: "approval", text: "t", projectSlug: store.slug, taskKey: "VIB-103" });
    expect(listNotifications(store.db, uid).map((n) => n.waitingOnYou)).toEqual([
      false,
      false,
    ]);
  });

  it("unresolvable task refs and non-decision kinds are never waiting", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-104", { stage: "review" }),
      packet: PACKET,
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
    const store = setupTestStore(ctx);
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
