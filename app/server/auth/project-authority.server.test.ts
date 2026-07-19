import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canRunAgents,
  requireRunAgents,
  type AuthorityProject,
} from "./project-authority.server";
import type Database from "better-sqlite3";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";

describe("run-agents authority — archived read-only gate (F17)", () => {
  let ctx: TestDbContext;
  let db: Database.Database;
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
