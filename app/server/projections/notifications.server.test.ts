import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
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
