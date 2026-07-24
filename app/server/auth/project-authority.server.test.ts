import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertProjectAction,
  canRunAgents,
  requireProjectAuthority,
  requireRunAgents,
  type AuthorityProject,
} from "./project-authority.server";
import type { DatabaseSync } from "node:sqlite";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import { setupTestStore } from "../../../test-support/test-store";
import { insertUser } from "./user-store.server";

describe("run-agents authority — archived read-only gate (F17)", () => {
  let ctx: TestDbContext;
  let db: DatabaseSync;
  const actor = { userId: "u_admin", label: "admin@viberr.dev" };
  const project = (archived: boolean): AuthorityProject => ({
    slug: "proj",
    memberRoles: new Map([["u_admin", "admin"]]),
    archived,
  });

  beforeEach(() => {
    ctx = createTestDbContext();
    db = ctx.makeDb();
  });
  afterEach(() => {
    ctx.cleanup();
  });

  it("requireRunAgents throws for an archived project even for an admin", () => {
    expect(() =>
      requireRunAgents(db, project(true), actor, "run the operator"),
    ).toThrowError(/archived/i);
  });

  it("requireRunAgents allows an admin on a live project", () => {
    expect(
      requireRunAgents(db, project(false), actor, "run the operator").role,
    ).toBe("admin");
  });

  it("canRunAgents is false on an archived project (silent @mention skip)", () => {
    expect(canRunAgents(db, project(true), actor, "run by @mention")).toBe(
      false,
    );
    expect(canRunAgents(db, project(false), actor, "run by @mention")).toBe(
      true,
    );
  });
});

/**
 * P13-D-8: NFR10 requires unauthorized action ATTEMPTS to be audited. Before
 * this, the deny branch returned bare and every throwing guard above it was
 * silent, so a session probing above its role produced a clean audit log.
 */
describe("denied authority is audited (P13-D-8)", () => {
  let ctx: TestDbContext;
  let db: DatabaseSync;

  const viewer = { userId: "u_viewer", label: "viewer@viberr.test" };
  const stranger = { userId: "u_stranger", label: "stranger@viberr.test" };
  const project: AuthorityProject = {
    slug: "proj",
    memberRoles: new Map([["u_viewer", "viewer"]]),
    archived: false,
  };

  beforeEach(() => {
    ctx = createTestDbContext();
    db = ctx.makeDb();
    for (const u of [viewer, stranger]) {
      insertUser(db, {
        id: u.userId,
        email: u.label,
        name: u.label,
        role: "member",
      });
    }
  });
  afterEach(() => {
    ctx.cleanup();
  });

  it("records the attempted action and the caller's role on a member denial", () => {
    expect(() =>
      requireProjectAuthority(db, project, viewer, ["admin"], {
        action: "edit-policy",
        what: "change the policy",
      }),
    ).toThrowError(/cannot change the policy/);

    const rows = listAuditEvents(db, { action: "project.authority.denied" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: "u_viewer",
      projectSlug: "proj",
      subjectKind: "project",
      subjectId: "proj",
    });
    expect(rows[0]!.details).toMatchObject({
      action: "edit-policy",
      what: "change the policy",
      memberRole: "viewer",
    });
  });

  it("records a non-member denial with memberRole null", () => {
    expect(() =>
      requireProjectAuthority(db, project, stranger, "any-member", {
        action: "any-member",
        what: "view this project's settings",
      }),
    ).toThrowError(/Only project members/);

    const rows = listAuditEvents(db, { action: "project.authority.denied" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({
      action: "any-member",
      memberRole: null,
    });
  });

  it("writes NO row for the @mention probe — a normal UI-gated state", () => {
    expect(canRunAgents(db, project, viewer, "run by @mention")).toBe(false);
    expect(listAuditEvents(db, { action: "project.authority.denied" })).toEqual(
      [],
    );
  });

  it("collapses repeated identical denials so a polled 403 cannot flood", () => {
    for (let i = 0; i < 5; i += 1) {
      expect(() =>
        requireProjectAuthority(db, project, viewer, ["admin"], {
          action: "edit-policy",
          what: "change the policy",
        }),
      ).toThrow();
    }
    expect(
      listAuditEvents(db, { action: "project.authority.denied" }),
    ).toHaveLength(1);

    // A DIFFERENT attempted action is its own fact and still lands.
    expect(() =>
      requireProjectAuthority(db, project, viewer, ["admin"], {
        action: "manage-members",
        what: "manage members",
      }),
    ).toThrow();
    expect(
      listAuditEvents(db, { action: "project.authority.denied" }),
    ).toHaveLength(2);
  });

  it("audits the slug-only config-surface guard too (assertProjectAction)", () => {
    const store = setupTestStore(ctx);
    expect(() =>
      assertProjectAction(
        store.db,
        "edit-policy",
        store.slug,
        { userId: store.users.elif.id, label: store.users.elif.email },
        "change the policy",
        { dataRoot: store.dataRoot },
      ),
    ).toThrowError(/Only project/);

    const rows = listAuditEvents(store.db, {
      action: "project.authority.denied",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({
      action: "edit-policy",
      memberRole: "viewer",
    });
  });
});
