import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  createConnection,
  getConnection,
  getDefaultConnection,
} from "~/server/org/connections.server";
import { getProjectCredential } from "~/server/secrets/pat-store.server";
import { runReconcile, runSetCredential } from "./github-actions.server";
import { latestProjectReconcileAt } from "~/server/provenance/provenance-query.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const REPO = "akin-ozer/viberr";
const FINE = "github_pat_11ATTACH0123456789_attachattach";

/**
 * The add-connection → attach story behind the "eternal ~ chips" complaint:
 * the connection modal necessarily validates with `repo: null`, which pins a
 * fine-grained token at all-"assumed" scope chips — and the ORG card renders
 * that same per-PAT cache forever. Attaching to a project is the first moment
 * a real repo exists, so `runSetCredential` now refreshes the shared cache
 * with project context and the chips upgrade to probe-backed verdicts.
 */
describe("runSetCredential refreshes the PAT cache with project context", () => {
  it("upgrades a fine-grained token's repo scope from 'assumed' to 'probe' on attach", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot }); // projects table (repo column)
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };

    // 1. Org-level connection add — no repo context exists here.
    const addTime = fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" } },
      "GET /user/orgs": { body: [] },
      "GET /users/akin-ozer": { body: { public_repos: 3 } },
    });
    const created = await createConnection(
      store.db,
      { owner: "akin-ozer", token: FINE, userId: store.users.arda.id },
      actor,
      { fetchImpl: addTime.fetchImpl },
    );
    expect(created.status).toBe("saved");

    // 2. Attach to the project — the revalidation now runs WITH the repo.
    const attachTime = fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" } },
      "GET /user/orgs": { body: [] },
      [`GET /repos/${REPO}`]: { body: { full_name: REPO } },
      [`GET /repos/${REPO}/pulls`]: { body: [] },
    });
    const outcome = await runSetCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: attachTime.fetchImpl,
    });
    expect(outcome.result).toBe("attached");
    expect(attachTime.callsTo(`GET /repos/${REPO}`)).toHaveLength(1);

    // 3. The SHARED cache (what the org card renders too) is upgraded.
    const credential = getProjectCredential(store.db, store.slug);
    expect(credential?.validation?.repo).toBe(REPO);
    const repoScope = credential?.validation?.scopes.find((s) => s.id === "repo");
    expect(repoScope).toMatchObject({ ok: true, source: "probe" });
  });

  it("an unreachable GitHub degrades the refresh but never fails the attach", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };

    const addTime = fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" } },
      "GET /user/orgs": { body: [] },
      "GET /users/akin-ozer": { body: { public_repos: 3 } },
    });
    await createConnection(
      store.db,
      { owner: "akin-ozer", token: FINE, userId: store.users.arda.id },
      actor,
      { fetchImpl: addTime.fetchImpl },
    );

    // Attach while GitHub is down: bind still lands, cache stays org-level.
    const down = fakeGithubFetch({}); // every route 404s; validator reports it
    const outcome = await runSetCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: down.fetchImpl,
    });
    expect(outcome.result).toBe("attached");
    expect(getProjectCredential(store.db, store.slug)).not.toBeNull();
  });
});

/**
 * F15-02 (live repro): a young project with a credential but no branched task
 * hit "Update status" → 14ms POST, success-flavored toast, and the "Not yet
 * synced" badge never flipped (reconcileProject scanned zero tasks and wrote
 * no provenance). The pass over nothing must SAY it checked nothing, and it
 * must still count as an observation.
 */
describe("runReconcile on a project with no branched tasks", () => {
  it("names the nothing-to-sync case and records a freshness heartbeat", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };

    const addTime = fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" } },
      "GET /user/orgs": { body: [] },
      "GET /users/akin-ozer": { body: { public_repos: 3 } },
    });
    await createConnection(
      store.db,
      { owner: "akin-ozer", token: FINE, userId: store.users.arda.id },
      actor,
      { fetchImpl: addTime.fetchImpl },
    );
    const attachTime = fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" } },
      "GET /user/orgs": { body: [] },
      [`GET /repos/${REPO}`]: { body: { full_name: REPO } },
      [`GET /repos/${REPO}/pulls`]: { body: [] },
    });
    await runSetCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: attachTime.fetchImpl,
    });

    const reconcileTime = fakeGithubFetch({});
    const outcome = await runReconcile(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: reconcileTime.fetchImpl,
    });
    // Fails on wave-1/main: result was "ok" with the generic reconciled toast,
    // and latestProjectReconcileAt stayed null forever.
    expect(outcome.result).toBe("no_branched_tasks");
    expect(outcome.toast).toContain("no task has a delivery branch");
    expect(latestProjectReconcileAt(store.db, store.slug)).not.toBeNull();
  });
});

/**
 * B-GH3: project creation binds the connection matching the repo OWNER, but
 * Attach/Rotate bound `getDefaultConnection` unconditionally. In a
 * multi-connection org that silently swapped a project onto another owner's
 * PAT — and the damage only surfaced later, as a repo-access miss blamed on
 * the token.
 */
describe("runSetCredential binds by repo owner, not by org default", () => {
  const CLASSIC = (owner: string) =>
    fakeGithubFetch({
      "GET /user": {
        body: { login: owner },
        headers: { "x-oauth-scopes": "repo" },
      },
      [`GET /users/${owner}`]: { body: { public_repos: 2 } },
    });

  it("picks the connection that owns the project's repo", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };

    // "hepapi" is created FIRST, so it is the org default…
    await createConnection(
      store.db,
      { owner: "hepapi", token: "ghp_hepapi_token_1111", userId: actor.userId },
      actor,
      { fetchImpl: CLASSIC("hepapi").fetchImpl },
    );
    // …while the project's repo (akin-ozer/viberr) lives under this one.
    await createConnection(
      store.db,
      { owner: "akin-ozer", token: "ghp_akinozer_token_2222", userId: actor.userId },
      actor,
      { fetchImpl: CLASSIC("akin-ozer").fetchImpl },
    );
    expect(getDefaultConnection(store.db)!.id).toBe("hepapi");

    const attach = fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" }, headers: { "x-oauth-scopes": "repo" } },
      [`GET /repos/${REPO}`]: { body: { full_name: REPO } },
    });
    const outcome = await runSetCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: attach.fetchImpl,
    });
    expect(outcome.result).toBe("attached");
    // Fails on main: the bound PAT was hepapi's (the default).
    expect(getProjectCredential(store.db, store.slug)!.id).toBe(
      getConnection(store.db, "akin-ozer")!.patId,
    );
    expect(outcome.toast).toContain("akin-ozer");
  });

  it("refuses — with the owner named — when no connection covers the repo owner", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    await createConnection(
      store.db,
      { owner: "hepapi", token: "ghp_hepapi_token_3333", userId: actor.userId },
      actor,
      { fetchImpl: CLASSIC("hepapi").fetchImpl },
    );

    const outcome = await runSetCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: fakeGithubFetch({}).fetchImpl,
    });
    // Fails on main: it happily bound hepapi's PAT to an akin-ozer repo.
    expect(outcome.result).toBe("no_owner_connection");
    expect(outcome.toast).toContain("akin-ozer");
    expect(getProjectCredential(store.db, store.slug)).toBeNull();
  });
});
