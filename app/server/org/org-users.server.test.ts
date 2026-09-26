import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import { resolveGithubHandle } from "~/server/github/pr-human-approval.server";
import { verifyPassword } from "~/server/auth/password.server";
import { credentialPasswordHash } from "~/server/auth/identity.server";
import {
  findUserByEmail,
  insertUser,
  recordUserLogin,
  updateUserFields,
} from "~/server/auth/user-store.server";
import {
  addDomain,
  createLocalAccount,
  deleteOrgUser,
  findDomainAllowlistRole,
  listDomains,
  listOrgUsers,
  normalizeDomain,
  removeDomain,
  resetLocalPassword,
  setOrgUserRole,
  updateOrgUser,
  whitelistGithubUser,
  whitelistGoogleAccount,
} from "./org-users.server";

/**
 * Users & access server layer: whitelist rows via the phase-2 model,
 * status derivation, guards (self handled at route level; last-admin
 * here), domain allowlist normalization + dedupe.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const ACTOR = { userId: "u_admin", label: "admin@test" };

function makeDb() {
  const db = ctx.makeDb();
  insertUser(db, {
    id: "u_admin",
    email: "admin@test.dev",
    name: "Admin Test",
    role: "admin",
  });
  return db;
}

describe("whitelisting", () => {
  it("github handle → placeholder identity row, status whitelisted", () => {
    const db = makeDb();
    const { user, toast } = whitelistGithubUser(
      db,
      { handle: "@octocat", role: "member" },
      ACTOR,
    );
    expect(user).toMatchObject({
      name: "@octocat",
      email: "github.com/octocat",
      idp: "github",
      status: "whitelisted",
      role: "member",
      tone: "teal",
    });
    expect(toast).toBe("@octocat whitelisted — allowed at first GitHub sign-in");
    // Dedupe.
    expect(() =>
      whitelistGithubUser(db, { handle: "octocat", role: "member" }, ACTOR),
    ).toThrowError(/already whitelisted/);
  });

  it("google account → passwordless row (the row IS the whitelist)", async () => {
    const db = makeDb();
    const { user } = await whitelistGoogleAccount(
      db,
      { email: "Deniz@Company.dev", role: "member" },
      ACTOR,
    );
    expect(user).toMatchObject({
      name: "deniz",
      email: "deniz@company.dev",
      idp: "google",
      status: "whitelisted",
    });
    const record = findUserByEmail(db, "deniz@company.dev");
    expect(record!.hasPassword).toBe(false);
  });

  it("local account → temp password surfaced once, status invited; first login flips to active", async () => {
    const db = makeDb();
    const { user, tempPassword } = await createLocalAccount(
      db,
      { name: "Yeni Kişi", email: "yeni@test.dev", role: "member" },
      ACTOR,
    );
    expect(user.status).toBe("invited");
    expect(user.pwreset).toBe(false); // invited absorbs the pending flag
    expect(tempPassword.length).toBeGreaterThanOrEqual(8);
    const record = findUserByEmail(db, "yeni@test.dev")!;
    await expect(
      verifyPassword(tempPassword, credentialPasswordHash(db, record.id)),
    ).resolves.toBe(true);
    expect(record.pwresetRequired).toBe(true);

    recordUserLogin(db, record.id);
    const view = listOrgUsers(db).find((u) => u.id === record.id)!;
    expect(view.status).toBe("active");
  });

  it("F20-12: a passwordless LOCAL account reads setup-pending, never 'active'", () => {
    const db = makeDb();
    // Replicates the old project-invite mint / the live probe.nobody specimen: a
    // local row with NO credential and pwreset not required. It can never sign in
    // (no password, and OAuth is a different idp), so it must not render as a
    // healthy account. Before the fix `statusOf` returned "active" here.
    insertUser(db, {
      id: "u_ghost",
      email: "probe.nobody@viberr.dev",
      name: "Probe Nobody",
      role: "member",
      idp: "local",
    });
    const record = findUserByEmail(db, "probe.nobody@viberr.dev")!;
    expect(record.hasPassword).toBe(false);
    expect(record.pwresetRequired).toBe(false);
    const view = listOrgUsers(db).find((u) => u.id === "u_ghost")!;
    expect(view.status).toBe("invited");
  });
});

describe("edit / role / reset / remove", () => {
  it("updates a local user's name + email with dedupe", async () => {
    const db = makeDb();
    const { user } = await createLocalAccount(
      db,
      { name: "Yeni Kişi", email: "yeni@test.dev", role: "member" },
      ACTOR,
    );
    const updated = updateOrgUser(
      db,
      { userId: user.id, name: "Yeni İsim", email: "yepyeni@test.dev", role: "member" },
      ACTOR,
    );
    expect(updated.name).toBe("Yeni İsim");
    expect(updated.email).toBe("yepyeni@test.dev");
    expect(() =>
      updateOrgUser(
        db,
        { userId: user.id, name: "X Y", email: "admin@test.dev", role: "member" },
        ACTOR,
      ),
    ).toThrowError(/already exists/);
  });

  it("last-admin demotion is refused (phase-2 guard)", () => {
    const db = makeDb();
    expect(() =>
      setOrgUserRole(db, { userId: "u_admin", role: "member" }, ACTOR),
    ).toThrowError(/last active admin/);
  });

  it("reset is local-only, kills the flag into a pending pill", async () => {
    const db = makeDb();
    const gh = whitelistGithubUser(db, { handle: "octocat", role: "member" }, ACTOR);
    await expect(
      resetLocalPassword(db, gh.user.id, ACTOR),
    ).rejects.toThrowError(/signs in with GitHub/);

    const local = await createLocalAccount(
      db,
      { name: "Selin Test", email: "selin@test.dev", role: "member" },
      ACTOR,
    );
    recordUserLogin(db, local.user.id); // now an active account
    const { user, tempPassword } = await resetLocalPassword(
      db,
      local.user.id,
      ACTOR,
    );
    expect(user.pwreset).toBe(true);
    expect(user.status).toBe("active");
    expect(tempPassword.length).toBeGreaterThanOrEqual(8);
  });

  it("removes a user row but never the last active admin", async () => {
    const db = makeDb();
    const { user } = await createLocalAccount(
      db,
      { name: "Gidici", email: "gidici@test.dev", role: "member" },
      ACTOR,
    );
    const removed = await deleteOrgUser(db, user.id, ACTOR);
    expect(removed.toast).toBe("Gidici removed");
    expect(findUserByEmail(db, "gidici@test.dev")).toBeNull();

    await expect(deleteOrgUser(db, "u_admin", ACTOR)).rejects.toThrowError(
      /last active admin/,
    );
  });

  // WI-3: delete must remove the better-auth identity too, so re-creating the
  // same email later doesn't hit the UNIQUE constraint on "user".email.
  it("delete removes the better-auth identity so the email can be reused", async () => {
    const db = makeDb();
    const { user } = await createLocalAccount(
      db,
      { name: "Reuse", email: "reuse@test.dev", role: "member" },
      ACTOR,
    );
    expect(
      db.prepare(`SELECT id FROM "user" WHERE id=?`).get(user.id),
    ).toBeTruthy();

    await deleteOrgUser(db, user.id, ACTOR);
    expect(db.prepare(`SELECT id FROM "user" WHERE id=?`).get(user.id)).toBeUndefined();

    // Re-creating the same email succeeds (no orphaned identity constraint).
    const again = await createLocalAccount(
      db,
      { name: "Reuse Two", email: "reuse@test.dev", role: "member" },
      ACTOR,
    );
    expect(again.user.email).toBe("reuse@test.dev");
  });

  /**
   * Ruling 127: the credential ROWS cascade with the account, but the vendor's
   * own sign-in file lives on the filesystem, where no foreign key reaches. Left
   * behind it is a live Claude.ai / ChatGPT credential on this server that no
   * row accounts for, that the person can never again reach a disconnect to
   * revoke, and that every backup of the runtime volume carries forward.
   * Ruling 507: EVERY account goes, the ones not in use included — an inactive
   * account's sign-in is as live a credential as the active one's.
   */
  it("delete retires the person's agent accounts, sign-in files included", async () => {
    const { recordBackendLogin, getBackendCredential, loginTargetFor, listBackendAccounts } =
      await import("~/server/runtimes/backend-credentials.server");
    const { backendAccountHome, claudeLoginCredentialPath } = await import(
      "~/server/runtimes/user-homes.server"
    );
    const { writeFakeVendorBinaries } = await import(
      "../../../test-support/fake-vendor-binary"
    );
    const { mkdirSync, existsSync, writeFileSync } = await import("node:fs");

    const db = makeDb();
    const dataRoot = ctx.makeTempDir();
    const { user } = await createLocalAccount(
      db,
      { name: "Leaver", email: "leaver@test.dev", role: "member" },
      ACTOR,
    );
    // The state two hosted sign-ins leave: a `login` row per account carrying
    // no secret, and the vendor client's own credential file inside each
    // account's own home (ruling 507). The second one is the account in use.
    const credentialFiles: string[] = [];
    for (const email of ["work@example.com", "personal@example.com"]) {
      const target = loginTargetFor(db, user.id, "claude");
      recordBackendLogin(
        db,
        { userId: user.id, label: user.email },
        "claude",
        "claudeai",
        { authMethod: "claudeai", email },
        target,
      );
      const home = backendAccountHome(user.id, "claude", target, dataRoot);
      mkdirSync(home, { recursive: true });
      const credentialFile = claudeLoginCredentialPath(home);
      writeFileSync(credentialFile, JSON.stringify({ fake: true }));
      credentialFiles.push(credentialFile);
    }
    expect(listBackendAccounts(db, user.id, "claude")).toHaveLength(2);

    // Fake binaries: removing an account must never spawn the REAL
    // `claude auth logout` from a test.
    const fake = writeFakeVendorBinaries();
    try {
      await deleteOrgUser(db, user.id, ACTOR, {
        dataRoot,
        binaries: fake.binaries,
      });
    } finally {
      fake.cleanup();
    }

    for (const credentialFile of credentialFiles) {
      expect(existsSync(credentialFile)).toBe(false);
    }
    expect(getBackendCredential(db, user.id, "claude")).toBeNull();
    expect(listBackendAccounts(db, user.id, "claude")).toEqual([]);
    // The revocation is auditable, not silent.
    const removal = listAuditEvents(db, { action: "org.user.removed" }).find(
      (e) => e.subjectId === user.id,
    );
    expect(removal!.details).toMatchObject({
      backendsRetired: ["claude"],
    });
  });

  // rbac #5: deleting the identity cascades better-auth `session` rows via the
  // FK (ON DELETE CASCADE), so deleteOrgUser needs no explicit session revoke.
  it("delete cascades the user's better-auth sessions", async () => {
    const db = makeDb();
    const { user } = await createLocalAccount(
      db,
      { name: "Session", email: "session@test.dev", role: "member" },
      ACTOR,
    );
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO "session"
         (id, expiresAt, token, createdAt, updatedAt, userId)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("sess_del", now, "tok_del", now, now, user.id);
    expect(
      db.prepare(`SELECT id FROM "session" WHERE userId = ?`).get(user.id),
    ).toBeTruthy();

    await deleteOrgUser(db, user.id, ACTOR);

    expect(
      db.prepare(`SELECT id FROM "session" WHERE userId = ?`).get(user.id),
    ).toBeUndefined();
  });

  it("names the GitHub connections and project bindings the delete takes with it", async () => {
    // users → github_pats → github_connections AND project_github_credentials,
    // all ON DELETE CASCADE. So removing one person can disconnect the org's
    // DEFAULT connection and unbind projects they never touched — the very
    // thing `removeConnection` refuses ("Set another connection as default
    // first"). The delete still proceeds (offboarding must not be blockable by
    // whose PAT happened to be bound), but it no longer does it silently.
    // Canary: drop connectionsLost/projectsUnbound from the audit + toast and
    // both assertions below fail.
    const db = makeDb();
    const { user } = await createLocalAccount(
      db,
      { name: "Leaver", email: "leaver@test.dev", role: "member" },
      ACTOR,
    );
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO github_pats
         (id, user_id, label, encrypted_token, token_suffix, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("pat_1", user.id, "work", "box", "abcd", now);
    db.prepare(
      `INSERT INTO github_connections
         (id, owner, pat_id, is_default, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run("acme", "acme", "pat_1", now, now);
    db.prepare(
      `INSERT INTO project_github_credentials
         (project_slug, pat_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run("viberr-core", "pat_1", now, now);

    const result = await deleteOrgUser(db, user.id, ACTOR);

    // The cascade really did fire — this is not a hypothetical.
    expect(
      db.prepare(`SELECT id FROM github_connections WHERE id = ?`).get("acme"),
    ).toBeUndefined();

    // …and the operator is told, by name, including that it was the default.
    expect(result.toast).toContain("acme");
    expect(result.toast).toContain("DEFAULT");
    const [row] = listAuditEvents(db, { action: "org.user.removed" });
    const details = row!.details!;
    expect(details.connectionsLost).toEqual(["acme"]);
    expect(details.defaultConnectionLost).toBe("acme");
    expect(details.projectsUnbound).toEqual(["viberr-core"]);
  });
});

/**
 * Ruling 154 (pass 35, G35-3): `users.github_handle` had one writer, GitHub
 * OAuth sign-in, so on a deployment without GitHub sign-in a member's PR
 * approval could only ever land as `unlinked_handle` and ruling 68 was
 * unreachable. The Edit-user save is now the org admin's door to the column,
 * and the verdict resolver must see what it wrote.
 */
describe("ruling 154: an org admin links a GitHub handle", () => {
  async function localUser(db: ReturnType<typeof makeDb>, name: string, email: string) {
    const { user } = await createLocalAccount(
      db,
      { name, email, role: "member" },
      ACTOR,
    );
    return user;
  }

  it("a handle set on a local account resolves for the verdict path, normalized and audited", async () => {
    const db = makeDb();
    const user = await localUser(db, "Maya Lin", "maya@test.dev");
    const updated = updateOrgUser(
      db,
      {
        userId: user.id,
        name: user.name,
        email: user.email,
        role: "member",
        githubHandle: " @OctoCat ",
      },
      ACTOR,
    );
    expect(updated.githubHandle).toBe("octocat");
    expect(resolveGithubHandle(db, "OctoCat")).toEqual({
      kind: "found",
      userId: user.id,
      name: "Maya Lin",
    });
    const [row] = listAuditEvents(db, { action: "org.user.github_handle.set" });
    expect(row).toMatchObject({
      subjectKind: "user",
      subjectId: user.id,
      details: { handle: "octocat", previous: null },
    });
  });

  it("refuses a handle another enabled account already carries, naming them", async () => {
    const db = makeDb();
    const maya = await localUser(db, "Maya Lin", "maya@test.dev");
    const omar = await localUser(db, "Omar Reyes", "omar@test.dev");
    updateOrgUser(
      db,
      { userId: maya.id, name: maya.name, email: maya.email, role: "member", githubHandle: "octocat" },
      ACTOR,
    );
    expect(() =>
      updateOrgUser(
        db,
        { userId: omar.id, name: omar.name, email: omar.email, role: "member", githubHandle: "OCTOCAT" },
        ACTOR,
      ),
    ).toThrowError("@octocat is already linked to Maya Lin.");
    // Nothing was written for the refused edit: the resolver still finds one.
    expect(resolveGithubHandle(db, "octocat")).toMatchObject({ kind: "found", userId: maya.id });
  });

  it("refuses a handle on a GitHub-signed-in account; a blank leaves its synced handle alone", () => {
    const db = makeDb();
    const { user } = whitelistGithubUser(db, { handle: "hubber", role: "member" }, ACTOR);
    expect(() =>
      updateOrgUser(
        db,
        { userId: user.id, name: user.name, email: user.email, role: "member", githubHandle: "other" },
        ACTOR,
      ),
    ).toThrowError(/signs in with GitHub; its handle syncs at each sign-in/);
    // The modal for a GitHub account sends no handle; the route still passes
    // the empty field, which must not clear what OAuth recorded.
    updateUserFields(db, user.id, { githubHandle: "hubber" });
    updateOrgUser(
      db,
      { userId: user.id, name: user.name, email: user.email, role: "member", githubHandle: "" },
      ACTOR,
    );
    expect(resolveGithubHandle(db, "hubber")).toMatchObject({ kind: "found", userId: user.id });
  });

  it("a blank clears the link with its own audit row; an omitted field changes nothing", async () => {
    const db = makeDb();
    const user = await localUser(db, "Maya Lin", "maya@test.dev");
    const edit = (githubHandle?: string | null) =>
      updateOrgUser(
        db,
        { userId: user.id, name: user.name, email: user.email, role: "member", githubHandle },
        ACTOR,
      );
    edit("octocat");
    expect(edit().githubHandle).toBe("octocat");
    expect(edit("").githubHandle).toBeNull();
    expect(resolveGithubHandle(db, "octocat")).toEqual({ kind: "none" });
    const [row] = listAuditEvents(db, { action: "org.user.github_handle.cleared" });
    expect(row).toMatchObject({
      subjectId: user.id,
      details: { handle: null, previous: "octocat" },
    });
    expect(() => edit("not a handle!")).toThrowError("Enter a GitHub username.");
  });
});

describe("google domain allowlist", () => {
  it("normalizes, dedupes and removes", () => {
    const db = makeDb();
    expect(normalizeDomain("someone@Company.DEV")).toBe("@company.dev");
    expect(normalizeDomain("@company.dev")).toBe("@company.dev");
    expect(normalizeDomain("nonsense")).toBeNull();

    const added = addDomain(db, { domain: "elif@viberr.dev", role: "member" }, ACTOR);
    expect(added.status).toBe("added");
    if (added.status === "added") {
      expect(added.domain.domain).toBe("@viberr.dev");
      expect(added.toast).toBe(
        "Anyone with @viberr.dev can now sign in with Google — joins as member",
      );
    }

    const dup = addDomain(db, { domain: "@viberr.dev", role: "admin" }, ACTOR);
    expect(dup.status).toBe("duplicate");
    if (dup.status === "duplicate") {
      expect(dup.message).toBe("@viberr.dev is already whitelisted");
    }

    expect(findDomainAllowlistRole(db, "anyone@viberr.dev")).toBe("member");
    expect(findDomainAllowlistRole(db, "anyone@other.dev")).toBeNull();

    const [domain] = listDomains(db);
    const removed = removeDomain(db, domain!.id, ACTOR);
    expect(removed.toast).toBe("@viberr.dev removed from the allowlist");
    expect(listDomains(db)).toHaveLength(0);
  });
});
