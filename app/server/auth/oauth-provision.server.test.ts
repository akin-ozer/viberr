import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import { whitelistGithubUser } from "../org/org-users.server";
import {
  applyOAuthUser,
  isOAuthWhitelisted,
  linkOAuth,
} from "./oauth-provision.server";
import { findUserByEmail, insertUser } from "./user-store.server";

/**
 * The OAuth whitelist/provisioning hooks better-auth's social flow calls: only
 * domain-allowlisted or GitHub-placeholder or already-known emails may create a
 * NEW social user, and provisioning materializes the canonical `users` row.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const ACTOR = { userId: "u_admin", label: "admin@viberr.test" };

function allowDomain(db: Database.Database, domain: string, role = "member") {
  db.prepare(
    `INSERT INTO google_domain_allowlist (id, domain, role, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(`dom_${domain}`, domain, role, new Date().toISOString());
}

describe("isOAuthWhitelisted", () => {
  it("allows domain-allowlisted, placeholder and existing emails; rejects the rest", () => {
    const db = ctx.makeDb();
    allowDomain(db, "@viberr.dev", "admin");
    whitelistGithubUser(db, { handle: "octocat", role: "member" }, ACTOR);
    insertUser(db, {
      id: "u_known",
      email: "known@else.dev",
      name: "Known",
      role: "member",
    });

    expect(
      isOAuthWhitelisted(db, { id: "x", email: "new@viberr.dev", name: "N" }),
    ).toBe(true); // domain allowlist
    expect(
      isOAuthWhitelisted(db, {
        id: "x",
        email: "octocat@personal.dev",
        name: "O",
        githubHandle: "octocat",
      }),
    ).toBe(true); // placeholder by handle
    expect(
      isOAuthWhitelisted(db, { id: "x", email: "known@else.dev", name: "K" }),
    ).toBe(true); // existing row
    expect(
      isOAuthWhitelisted(db, { id: "x", email: "stranger@nope.dev", name: "S" }),
    ).toBe(false);
  });

  it("rejects a disabled existing user and a disabled placeholder", () => {
    const db = ctx.makeDb();
    insertUser(db, {
      id: "u_off",
      email: "off@else.dev",
      name: "Off",
      role: "member",
    });
    db.prepare(`UPDATE users SET disabled = 1 WHERE id = 'u_off'`).run();
    whitelistGithubUser(db, { handle: "ghost", role: "member" }, ACTOR);
    const ph = findUserByEmail(db, "github.com/ghost")!;
    db.prepare(`UPDATE users SET disabled = 1 WHERE id = ?`).run(ph.id);

    expect(
      isOAuthWhitelisted(db, { id: "x", email: "off@else.dev", name: "O" }),
    ).toBe(false);
    expect(
      isOAuthWhitelisted(db, {
        id: "x",
        email: "ghost@personal.dev",
        name: "G",
        githubHandle: "ghost",
      }),
    ).toBe(false);
  });
});

describe("applyOAuthUser", () => {
  it("provisions a domain-allowlisted Google user with the mapped role", () => {
    const db = ctx.makeDb();
    allowDomain(db, "@viberr.dev", "admin");
    // better-auth already created user `ba_1`; materialize the legacy row.
    applyOAuthUser(db, { id: "ba_1", email: "New@Viberr.Dev", name: "New Hire" });
    const user = findUserByEmail(db, "new@viberr.dev");
    expect(user).toMatchObject({
      id: "ba_1",
      email: "new@viberr.dev",
      role: "admin",
      idp: "google",
      passwordHash: null,
    });
    const member = db
      .prepare(`SELECT role FROM member WHERE userId = 'ba_1'`)
      .get() as { role: string };
    expect(member.role).toBe("admin");
  });

  it("claims a GitHub-handle placeholder by replacement (role carries over)", () => {
    const db = ctx.makeDb();
    whitelistGithubUser(db, { handle: "octocat", role: "admin" }, ACTOR);
    const placeholder = findUserByEmail(db, "github.com/octocat")!;

    applyOAuthUser(db, {
      id: "ba_gh",
      email: "octocat@real.dev",
      name: "The Octocat",
      githubHandle: "octocat",
    });

    // Placeholder is gone; the claimed identity has the placeholder's role.
    expect(findUserByEmail(db, "github.com/octocat")).toBeNull();
    const claimed = findUserByEmail(db, "octocat@real.dev");
    expect(claimed).toMatchObject({
      id: "ba_gh",
      role: "admin",
      idp: "github",
      githubHandle: "octocat",
    });
    expect(claimed!.id).not.toBe(placeholder.id);
    expect(
      listAuditEvents(db, { action: "auth.oauth.placeholder_claimed" }),
    ).toHaveLength(1);
  });
});

describe("linkOAuth", () => {
  it("stamps the last provider onto the legacy row", () => {
    const db = ctx.makeDb();
    const user = insertUser(db, {
      id: "u_link",
      email: "link@viberr.dev",
      name: "Link",
      role: "member",
    });
    linkOAuth(db, user.id, "github");
    expect(findUserByEmail(db, "link@viberr.dev")?.idp).toBe("github");
    expect(listAuditEvents(db, { action: "auth.oauth.login" })).toHaveLength(1);
  });
});
