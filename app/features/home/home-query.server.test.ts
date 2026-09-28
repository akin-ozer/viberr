import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { createPat } from "~/server/secrets/pat-store.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { seedInitialAdmin } from "~/server/auth/seed-admin.server";
import { createUser } from "~/server/auth/user-admin.server";
import { findUserByEmail } from "~/server/auth/user-store.server";
import {
  createConnection,
  recheckConnection,
} from "~/server/org/connections.server";
import {
  loginTargetFor,
  recordBackendLogin,
} from "~/server/runtimes/backend-credentials.server";
import { setupProjectedStore } from "../../../test-support/projected-store";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import {
  getHomeOrgSummary,
  getHomeSetup,
  listHomeProjectsForUser,
} from "./home-query.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("getHomeOrgSummary — connection picker", () => {
  it("lists real GitHub connections even before any project references the repo", () => {
    const store = setupTestStore(ctx);
    // A connection exists but NO project uses that owner's repo yet.
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "connection · acme", token: "ghp_testtesttesttesttesttesttest0000" },
      { userId: store.users.arda.id, label: "arda" },
    );
    const now = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO github_connections (id, owner, pat_id, is_default, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run("acme", "acme", pat.id, now, now);

    const summary = getHomeOrgSummary(store.db, { dataRoot: store.dataRoot });
    // Before the fix this derived owners from project repos and returned [].
    expect(summary.connectionOwners).toContain("acme");
  });
});

describe("listHomeProjectsForUser — membership scoping (D10/Q6)", () => {
  it("a non-member org member sees no projects they don't belong to", () => {
    const store = setupProjectedStore(ctx);
    // deniz is an org MEMBER and NOT a member of the seeded project.
    const forDeniz = listHomeProjectsForUser(store.db, {
      id: store.users.deniz.id,
      role: "member",
    });
    expect(forDeniz).toHaveLength(0);
    // selin IS a project member → sees it.
    const forSelin = listHomeProjectsForUser(store.db, {
      id: store.users.selin.id,
      role: "member",
    });
    expect(forSelin.length).toBeGreaterThan(0);
  });

  it("an ORG admin sees every project, member or not", () => {
    const store = setupProjectedStore(ctx);
    const all = listHomeProjectsForUser(store.db, {
      id: store.users.deniz.id, // non-member...
      role: "admin", // ...but org admin
    });
    expect(all.length).toBeGreaterThan(0);
  });

  it("B-FD5: the card's `waiting on you` counts an acceptance-ready task with no packet", () => {
    const store = setupTestStore(ctx);
    const revision = {
      id: "rev_1",
      headSha: "b".repeat(40),
      treeSha: "u".repeat(40),
      branch: "vib-400-work",
      createdAt: "2026-07-04T00:00:00.000Z",
      sourceProfileId: "developer",
    };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-400", {
        stage: "review",
        waiting: "human",
        branch: revision.branch,
        pr: { number: 400, state: "review", title: "Approved work" },
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
    // murat = maintainer → holds the acceptance. Home used to read 0 here while
    // the board chip and the review queue both showed the task (UI-48 union was
    // applied only in the board loader).
    const [card] = listHomeProjectsForUser(store.db, {
      id: store.users.murat.id,
      role: "member",
    });
    expect(card!.waiting).toBe(1);
    // elif = viewer → no acceptance authority, so still nothing waits on her.
    const [viewerCard] = listHomeProjectsForUser(store.db, {
      id: store.users.elif.id,
      role: "member",
    });
    expect(viewerCard!.waiting).toBe(0);
  });
});

/**
 * UI-02 — "updated just now" on projects that did not change.
 *
 * `updatedAt` used to fall back to `projects.parsed_at`, which is `nowIso()` at
 * (re)projection time, so "Rebuild projections" made every TASK-LESS project
 * card read "updated just now" although nothing had changed.
 */
describe("UI-02: a task-less project has no recency signal", () => {
  it("returns null updatedAt instead of the projection timestamp", () => {
    const store = setupProjectedStore(ctx);
    const card = listHomeProjectsForUser(store.db, { id: store.users.arda.id, role: "admin" })
      .find((p) => p.slug === store.slug)!;
    expect(card.total).toBe(0);
    expect(card.updatedAt).toBeNull();
  });

  it("still reports the newest task updated_at when tasks exist", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-903", {
        updatedAt: "2026-07-20T10:00:00.000Z",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const card = listHomeProjectsForUser(store.db, { id: store.users.arda.id, role: "admin" })
      .find((p) => p.slug === store.slug)!;
    expect(card.updatedAt).toBe("2026-07-20T10:00:00.000Z");
  });
});

/**
 * Ruling 532: Home's setup checklist. An org admin gets the instance's steps
 * (GitHub, an account other than the bootstrap admin); every person gets the
 * two that are their own (a Claude or Codex account, which their runs bill,
 * and a first project); the checklist is null once every step is done. Each
 * gap is closed here through the writer that closes it in the product.
 */
describe("getHomeSetup — the setup checklist (ruling 532)", () => {
  /** GitHub accepting a classic token with the scopes a connection needs. */
  const github = () =>
    fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" }, headers: { "x-oauth-scopes": "repo" } },
      "GET /users/akin-ozer": { body: { public_repos: 1 } },
      "GET /user/repos": { body: [] },
    }).fetchImpl;

  async function freshInstance() {
    const db = ctx.makeDb();
    await seedInitialAdmin(db, { email: "admin@viberr.test", password: "bootstrap-pass-2828" });
    const admin = findUserByEmail(db, "admin@viberr.test")!;
    return { db, admin, actor: { userId: admin.id, label: admin.email } };
  }

  it("walks the bootstrap admin of a fresh instance through its four steps", async () => {
    const { db, admin, actor } = await freshInstance();
    const viewer = { id: admin.id, role: "admin" as const };
    // CANARY: count the bootstrap admin as an account of someone's own and
    // "account" starts done.
    expect(getHomeSetup(db, viewer, 0)).toEqual([
      { id: "github", state: "todo" },
      { id: "account", state: "todo" },
      { id: "agents", state: "todo" },
      { id: "project", state: "blocked" },
    ]);

    await createUser(
      db,
      { email: "akin@viberr.test", name: "Akin Ozer", role: "admin", tempPassword: "temporary-pass-1" },
      actor,
    );
    await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_setup_checklist_0001", userId: admin.id },
      actor,
      { fetchImpl: github() },
    );
    await connectFakeBackend(db, admin.id, "claude");
    expect(getHomeSetup(db, viewer, 0)).toEqual([
      { id: "github", state: "done", owner: "akin-ozer", more: 0 },
      { id: "account", state: "done" },
      { id: "agents", state: "done", backends: ["claude"] },
      { id: "project", state: "todo" },
    ]);
    expect(getHomeSetup(db, viewer, 1)).toBeNull();
  });

  it("asks every person for a Claude or Codex account of their own, and a member for nothing of the instance's", async () => {
    const { db, admin, actor } = await freshInstance();
    await connectFakeBackend(db, admin.id, "claude");
    const member = await createUser(
      db,
      { email: "selin@viberr.test", name: "Selin", role: "member", tempPassword: "temporary-pass-2" },
      actor,
    );
    const viewer = { id: member.id, role: "member" as const };
    // CANARY: count anyone's connected account (connectedUserIds) and the
    // admin's Claude closes the member's step.
    expect(getHomeSetup(db, viewer, 2)).toEqual([{ id: "agents", state: "todo" }, { id: "project", state: "done" }]);

    // A Codex sign-in whose file is gone from the server (a wiped runtime
    // volume) is connected but cannot bill a run.
    const personal = { userId: member.id, label: member.email };
    recordBackendLogin(db, personal, "codex", "device", {}, loginTargetFor(db, member.id, "codex"));
    expect(getHomeSetup(db, viewer, 2)?.[0]).toEqual({ id: "agents", state: "stale", backend: "codex" });

    await connectFakeBackend(db, member.id, "claude");
    expect(getHomeSetup(db, viewer, 2)).toBeNull();
  });

  it("sends an admin to the token GitHub refused when no connection still works", async () => {
    const { db, admin, actor } = await freshInstance();
    await createConnection(
      db,
      { owner: "akin-ozer", token: "ghp_setup_checklist_0002", userId: admin.id },
      actor,
      { fetchImpl: github() },
    );
    await recheckConnection(db, "akin-ozer", actor, {
      fetchImpl: fakeGithubFetch({ "GET /user": { status: 401, body: { message: "Bad credentials" } } })
        .fetchImpl,
    });
    const steps = getHomeSetup(db, { id: admin.id, role: "admin" }, 0);
    expect(steps?.[0]).toEqual({ id: "github", state: "failed", owner: "akin-ozer", connectionId: "akin-ozer" });
    // A project can still be made from a refused connection; it cannot push.
    expect(steps?.[3]).toEqual({ id: "project", state: "todo" });
  });
});
