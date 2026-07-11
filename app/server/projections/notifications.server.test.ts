import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createTestDbContext } from "../../../test-support/test-db";
import { insertUser } from "~/server/auth/user-store.server";
import { hashPassword } from "~/server/auth/password.server";
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
function mkUser(db: Database.Database, id: string): void {
  insertUser(db, {
    id,
    email: `${id}@viberr.test`,
    name: id,
    role: "member",
    passwordHash: hashPassword("viberr-dev-2828"),
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
