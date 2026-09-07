import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import { updateOrgUser, whitelistGithubUser } from "../org/org-users.server";
import { resolveGithubHandle } from "../github/pr-human-approval.server";
import {
  applyOAuthUser,
  isOAuthWhitelisted,
  linkOAuth,
  recordSignIn,
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

function allowDomain(db: DatabaseSync, domain: string, role = "member") {
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
      isOAuthWhitelisted(db, {
        id: "x",
        email: "new@viberr.dev",
        name: "N",
        provider: "google",
      }),
    ).toBe(true); // domain allowlist
    expect(
      isOAuthWhitelisted(db, {
        id: "x",
        email: "octocat@personal.dev",
        name: "O",
        githubHandle: "octocat",
        provider: "github",
      }),
    ).toBe(true); // placeholder by handle
    expect(
      isOAuthWhitelisted(db, {
        id: "x",
        email: "known@else.dev",
        name: "K",
        provider: "google",
      }),
    ).toBe(true); // existing row
    expect(
      isOAuthWhitelisted(db, {
        id: "x",
        email: "stranger@nope.dev",
        name: "S",
        provider: "google",
      }),
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
      isOAuthWhitelisted(db, {
        id: "x",
        email: "off@else.dev",
        name: "O",
        provider: "google",
      }),
    ).toBe(false);
    expect(
      isOAuthWhitelisted(db, {
        id: "x",
        email: "ghost@personal.dev",
        name: "G",
        githubHandle: "ghost",
        provider: "github",
      }),
    ).toBe(false);
  });

  /**
   * P13-D-22: the table is `google_domain_allowlist`, the README says "for
   * Google", the in-app label says "any Google account with this domain". The
   * gate must not be wider than the label.
   */
  describe("domain admission is Google-only (P13-D-22)", () => {
    it("refuses a GitHub sign-in whose profile email matches an allowlisted domain", () => {
      const db = ctx.makeDb();
      allowDomain(db, "@acme.com", "admin");

      expect(
        isOAuthWhitelisted(db, {
          id: "x",
          email: "impostor@acme.com",
          name: "Impostor",
          githubHandle: "impostor",
          provider: "github",
        }),
      ).toBe(false);
      // Same email, same allowlist, Google callback → admitted.
      expect(
        isOAuthWhitelisted(db, {
          id: "x",
          email: "impostor@acme.com",
          name: "Impostor",
          provider: "google",
        }),
      ).toBe(true);
    });

    it("fails closed when the provider cannot be read off the callback", () => {
      const db = ctx.makeDb();
      allowDomain(db, "@acme.com", "member");
      expect(
        isOAuthWhitelisted(db, {
          id: "x",
          email: "someone@acme.com",
          name: "S",
          provider: null,
        }),
      ).toBe(false);
    });

    it("still admits a GitHub placeholder claim whatever the email domain", () => {
      const db = ctx.makeDb();
      whitelistGithubUser(db, { handle: "octocat", role: "member" }, ACTOR);
      expect(
        isOAuthWhitelisted(db, {
          id: "x",
          email: "octocat@nowhere.dev",
          name: "O",
          githubHandle: "octocat",
          provider: "github",
        }),
      ).toBe(true);
    });
  });
});

describe("applyOAuthUser", () => {
  it("provisions a domain-allowlisted Google user with the mapped role", () => {
    const db = ctx.makeDb();
    allowDomain(db, "@viberr.dev", "admin");
    // better-auth already created user `ba_1`; materialize the legacy row.
    applyOAuthUser(db, {
      id: "ba_1",
      email: "New@Viberr.Dev",
      name: "New Hire",
      provider: "google",
    });
    const user = findUserByEmail(db, "new@viberr.dev");
    expect(user).toMatchObject({
      id: "ba_1",
      email: "new@viberr.dev",
      role: "admin",
      idp: "google",
      hasPassword: false,
    });
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
      provider: "github",
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

  // P13-D-22: the role branch used to key on "is there a githubHandle", so a
  // GitHub identity could inherit a Google domain's mapped role, and a GitHub
  // identity with no placeholder always landed as `member`.
  it("never gives a GitHub identity a Google domain's mapped role", () => {
    const db = ctx.makeDb();
    allowDomain(db, "@acme.com", "admin");

    applyOAuthUser(db, {
      id: "ba_gh2",
      email: "dev@acme.com",
      name: "Dev",
      githubHandle: "devhandle",
      provider: "github",
    });

    expect(findUserByEmail(db, "dev@acme.com")).toMatchObject({
      role: "member",
      idp: "github",
    });
  });

  it("honours the domain-mapped role for a Google sign-in that carries no handle", () => {
    const db = ctx.makeDb();
    allowDomain(db, "@acme.com", "admin");

    applyOAuthUser(db, {
      id: "ba_goog",
      email: "boss@acme.com",
      name: "Boss",
      provider: "google",
    });

    expect(findUserByEmail(db, "boss@acme.com")).toMatchObject({
      role: "admin",
      idp: "google",
    });
  });
});

/**
 * Ruling 154 (pass 35, G35-3): `users.github_handle` gained a SECOND writer, so
 * the "unique among enabled accounts" invariant has to hold at every door, not
 * just the admin one. The reader fails closed: two enabled rows with the same
 * handle make `resolveGithubHandle` answer `ambiguous` forever, and that
 * person's PR approvals stop counting as the review verdict with nothing
 * naming the collision. The provider's own login is the authoritative claim.
 *
 * Canary for both: write the handle with a bare `updateUserFields` again.
 */
describe("ruling 154: a GitHub sign-in claims a handle an admin linked elsewhere", () => {
  const linkHandle = (db: DatabaseSync, userId: string, name: string, email: string, handle: string) =>
    updateOrgUser(db, { userId, name, email, role: "member", githubHandle: handle }, ACTOR);

  it("provisioning a new GitHub user takes the handle off the admin-linked account", () => {
    const db = ctx.makeDb();
    insertUser(db, { id: "u_maya", email: "maya@viberr.dev", name: "Maya Lin", role: "member" });
    linkHandle(db, "u_maya", "Maya Lin", "maya@viberr.dev", "octocat");
    expect(resolveGithubHandle(db, "octocat")).toMatchObject({ kind: "found", userId: "u_maya" });

    applyOAuthUser(db, {
      id: "ba_octocat",
      email: "octocat@real.dev",
      name: "The Octocat",
      githubHandle: "OctoCat",
      provider: "github",
    });

    expect(resolveGithubHandle(db, "octocat")).toMatchObject({
      kind: "found",
      userId: "ba_octocat",
    });
    expect(findUserByEmail(db, "maya@viberr.dev")?.githubHandle ?? null).toBeNull();
    const [cleared] = listAuditEvents(db, { action: "org.user.github_handle.cleared" });
    expect(cleared).toMatchObject({
      subjectId: "u_maya",
      details: { previous: "octocat", reason: "claimed by a GitHub sign-in" },
    });
  });

  it("a repeat sign-in that mirrors the provider handle takes it off the other account too", () => {
    const db = ctx.makeDb();
    insertUser(db, { id: "u_selin", email: "selin@viberr.dev", name: "Selin", role: "member", idp: "local" });
    insertUser(db, { id: "u_omar", email: "omar@viberr.dev", name: "Omar Reyes", role: "member" });
    linkHandle(db, "u_omar", "Omar Reyes", "omar@viberr.dev", "selin-aksoy");
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", "githubHandle")
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    ).run("u_selin", "Selin", "selin@viberr.dev", now, now, "Selin-Aksoy");

    recordSignIn(db, "u_selin");

    expect(resolveGithubHandle(db, "selin-aksoy")).toMatchObject({
      kind: "found",
      userId: "u_selin",
    });
    expect(findUserByEmail(db, "omar@viberr.dev")?.githubHandle ?? null).toBeNull();
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

describe("recordSignIn — the per-sign-in seam that was missing", () => {
  /** better-auth's own row, as its `user.additionalFields` writes it. */
  function identity(db: DatabaseSync, id: string, handle: string | null): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", "githubHandle")
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    ).run(id, "Selin", "selin@viberr.dev", now, now, handle);
  }

  it("stamps last_login_at and audits, on a sign-in that creates no user and links no account", () => {
    // Only `user.create.after` and `account.create.after` were wired, so an
    // existing person signing in again hit NEITHER: `last_login_at` stayed
    // null (the org Users list reads it to say "whitelisted" vs "active", so
    // every OAuth member read as never-signed-in forever) and the sign-in left
    // no audit row.
    // Canary: drop the `session.create.after` hook and both go back to empty.
    const db = ctx.makeDb();
    insertUser(db, { id: "u_1", email: "selin@viberr.dev", name: "Selin", role: "member", idp: "github" });
    identity(db, "u_1", null);
    expect(findUserByEmail(db, "selin@viberr.dev")?.lastLoginAt ?? null).toBeNull();

    recordSignIn(db, "u_1");

    expect(findUserByEmail(db, "selin@viberr.dev")?.lastLoginAt).toBeTruthy();
    expect(listAuditEvents(db, { action: "auth.sign_in" })).toHaveLength(1);
  });

  it("records the github handle for an account LINKED to an existing local user", () => {
    // `mapProfileToUser` only ever reached a user better-auth CREATED, so
    // somebody who already had a local account and then signed in with GitHub
    // never got `users.github_handle` — and `pr-human-approval.server.ts`
    // matches a PR reviewer by `lower(github_handle)`, so ruling R19-B's human
    // approval silently never counted for them.
    // Canary: remove the handle mirror from recordSignIn (or
    // `updateUserInfoOnLink`, which is what puts it on the better-auth row).
    const db = ctx.makeDb();
    insertUser(db, { id: "u_2", email: "selin@viberr.dev", name: "Selin", role: "member", idp: "local" });
    // The link happened: better-auth's row now carries the provider handle.
    identity(db, "u_2", "Selin-Aksoy");
    expect(findUserByEmail(db, "selin@viberr.dev")?.githubHandle ?? null).toBeNull();

    recordSignIn(db, "u_2");

    // Normalised the same way every other handle is (lowercased, no leading @).
    expect(findUserByEmail(db, "selin@viberr.dev")?.githubHandle).toBe("selin-aksoy");
    expect(listAuditEvents(db, { action: "auth.github_handle.recorded" })).toHaveLength(1);

    // Idempotent: signing in again records the login, not the handle again.
    recordSignIn(db, "u_2");
    expect(listAuditEvents(db, { action: "auth.github_handle.recorded" })).toHaveLength(1);
    expect(listAuditEvents(db, { action: "auth.sign_in" })).toHaveLength(2);
  });
});
