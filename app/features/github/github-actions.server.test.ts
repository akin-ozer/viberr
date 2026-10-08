import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupProjectedStore } from "../../../test-support/projected-store";
import type { TestStore } from "../../../test-support/test-store";
import { fakeGithubFetch, unreachableFetch } from "../../../test-support/fake-github";
import {
  createConnection,
  getConnection,
  getDefaultConnection,
} from "~/server/org/connections.server";
import {
  getProjectCredential,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";
import {
  runClearCredential,
  runGrantScope,
  runReconcile,
  runSetCredential,
} from "./github-actions.server";
import { readRepoHealth, recordRepoAccess } from "~/server/github/repo-health.server";
import { latestProjectReconcileAt } from "~/server/provenance/provenance-query.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const REPO = "akin-ozer/viberr";
const FINE = "github_pat_11ATTACH0123456789_attachattach";

/** The org-level connection add of akin-ozer's fine-grained token: no repo
 *  context exists there. */
async function addFineConnection(store: TestStore, actor: { userId: string; label: string }) {
  const addTime = fakeGithubFetch({
    "GET /user": { body: { login: "akin-ozer" } },
    "GET /user/orgs": { body: [] },
    "GET /users/akin-ozer": { body: { public_repos: 3 } },
  });
  return createConnection(
    store.db,
    { owner: "akin-ozer", token: FINE, userId: store.users.arda.id },
    actor,
    { fetchImpl: addTime.fetchImpl },
  );
}

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
    const store = setupProjectedStore(ctx); // projects table (repo column)
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };

    // 1. Org-level connection add — no repo context exists here.
    const created = await addFineConnection(store, actor);
    expect(created.status).toBe("saved");

    // 2. Attach to the project — the revalidation now runs WITH the repo.
    const attachTime = fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" } },
      "GET /user/orgs": { body: [] },
      [`GET /repos/${REPO}`]: {
        // A8 (pass 16): repository write is proven from the `permissions`
        // block GitHub returns for the authenticated token, replacing the
        // probe that PUT a file into the user's repo. Real GitHub always
        // sends it, so the fixture has to as well.
        body: { full_name: REPO, permissions: { push: true } },
      },
      [`GET /repos/${REPO}/pulls`]: { body: [] },
    });
    const outcome = await runSetCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: attachTime.fetchImpl,
    });
    expect(outcome.result).toBe("attached");
    // One read proves the scopes; the other is the board's new reading of the
    // repository (ruling 540).
    expect(attachTime.callsTo(`GET /repos/${REPO}`)).toHaveLength(2);

    // 3. The SHARED cache (what the org card renders too) is upgraded.
    const credential = getProjectCredential(store.db, store.slug);
    expect(credential?.validation?.repo).toBe(REPO);
    const repoScope = credential?.validation?.scopes.find((s) => s.id === "repo");
    expect(repoScope).toMatchObject({ ok: true, source: "probe" });
  });

  it("an unreachable GitHub degrades the refresh but never fails the attach", async () => {
    const store = setupProjectedStore(ctx);
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    await addFineConnection(store, actor);

    // Attach while GitHub is down: bind still lands, cache stays org-level.
    const outcome = await runSetCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: unreachableFetch(),
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
    const store = setupProjectedStore(ctx);
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    await addFineConnection(store, actor);
    const attachTime = fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" } },
      "GET /user/orgs": { body: [] },
      [`GET /repos/${REPO}`]: {
        // A8 (pass 16): repository write is proven from the `permissions`
        // block GitHub returns for the authenticated token, replacing the
        // probe that PUT a file into the user's repo. Real GitHub always
        // sends it, so the fixture has to as well.
        body: { full_name: REPO, permissions: { push: true } },
      },
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
    expect(outcome.toast).toContain("No task has a delivery branch");
    expect(latestProjectReconcileAt(store.db, store.slug)).not.toBeNull();
  });

  it("F21-9: an UNEXPECTED failure answers with a toast instead of 500ing the button", async () => {
    const store = setupProjectedStore(ctx);
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    // Fault injection: a handle whose every read throws — the class of failure
    // no reader anticipates, which used to escape as a raw 500 and leave the
    // maintainer with a dead Reconcile button and no explanation.
    // SAFETY: the proxy target is never read through; the trap answers every
    // property access on this handle, so no member of the asserted type is
    // reachable without throwing first.
    const brokenDb = new Proxy({} as DatabaseSync, {
      get() {
        throw new Error("database disk image is malformed");
      },
    });
    const outcome = await runReconcile(brokenDb, store.slug, actor, {
      dataRoot: store.dataRoot,
    });
    expect(outcome.result).toBe("error");
    expect(outcome.toast).toContain("nothing was changed");
    expect(outcome.toast).toContain("database disk image is malformed");
  });
});

/**
 * B-GH3: project creation binds the connection matching the repo OWNER, but
 * Attach/Rotate bound `getDefaultConnection` unconditionally. In a
 * multi-connection org that silently swapped a project onto another owner's
 * PAT — and the damage only surfaced later, as a repo-access miss blamed on
 * the token.
 *
 * S4-1: the owner match is a PREFERENCE, not a gate. `connection.owner` is the
 * account a PAT was added under, not the set of repos it reaches, so requiring
 * one stranded every org-repo / collaborator-repo project on a permanent
 * refusal. GitHub answers the access question, and only its "no" refuses.
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
    const store = setupProjectedStore(ctx);
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
      [`GET /repos/${REPO}`]: {
        // A8 (pass 16): repository write is proven from the `permissions`
        // block GitHub returns for the authenticated token, replacing the
        // probe that PUT a file into the user's repo. Real GitHub always
        // sends it, so the fixture has to as well.
        body: { full_name: REPO, permissions: { push: true } },
      },
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

  it("borrows another owner's connection when GitHub says that token reaches the repo", async () => {
    const store = setupProjectedStore(ctx);
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    // The one PAT in the org is labelled "hepapi" — but it is a collaborator on
    // akin-ozer/viberr, which is the whole point of this shape.
    await createConnection(
      store.db,
      { owner: "hepapi", token: "ghp_hepapi_token_4444", userId: actor.userId },
      actor,
      { fetchImpl: CLASSIC("hepapi").fetchImpl },
    );

    const attach = fakeGithubFetch({
      "GET /user": { body: { login: "hepapi" }, headers: { "x-oauth-scopes": "repo" } },
      [`GET /repos/${REPO}`]: {
        // A8 (pass 16): repository write is proven from the `permissions`
        // block GitHub returns for the authenticated token, replacing the
        // probe that PUT a file into the user's repo. Real GitHub always
        // sends it, so the fixture has to as well.
        body: { full_name: REPO, permissions: { push: true } },
      },
      [`GET /repos/${REPO}/pulls`]: { body: [] },
    });
    const outcome = await runSetCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: attach.fetchImpl,
    });
    // Fails on the B-GH3 shape: result was "no_owner_connection" and nothing
    // was ever bound — a working setup refused forever.
    expect(outcome.result).toBe("attached");
    expect(getProjectCredential(store.db, store.slug)!.id).toBe(
      getConnection(store.db, "hepapi")!.patId,
    );
    // The toast is honest about WHY it used a differently-labelled connection.
    expect(outcome.toast).toContain("No akin-ozer PAT");
    expect(outcome.toast).toContain(REPO);
  });

  it("refuses — naming the probe result — when the fallback token cannot reach the repo", async () => {
    const store = setupProjectedStore(ctx);
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    await createConnection(
      store.db,
      { owner: "hepapi", token: "ghp_hepapi_token_3333", userId: actor.userId },
      actor,
      { fetchImpl: CLASSIC("hepapi").fetchImpl },
    );

    // Every route 404s — GitHub's own answer is "this token cannot see it".
    const outcome = await runSetCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: fakeGithubFetch({}).fetchImpl,
    });
    // Fails on main: it happily bound hepapi's PAT to an unreachable repo.
    expect(outcome.result).toBe("no_repo_access");
    expect(outcome.toast).toContain(REPO);
    expect(outcome.toast).toContain("404");
    expect(getProjectCredential(store.db, store.slug)).toBeNull();
  });
});

/**
 * Ruling 480 (F40-45): "Rotate credential" rotated nothing. On a one-connection
 * instance it bound the same PAT again and toasted "Credential rotated to
 * akin-ozer's connection. Sync uses it now", while the token that ran was byte
 * for byte the one before. The toast now says which happened.
 */
describe("ruling 480: re-attaching says what it did, never 'rotated'", () => {
  const CLASSIC = (owner: string) =>
    fakeGithubFetch({
      "GET /user": { body: { login: owner }, headers: { "x-oauth-scopes": "repo" } },
      [`GET /users/${owner}`]: { body: { public_repos: 2 } },
      [`GET /repos/${REPO}`]: { body: { full_name: REPO, permissions: { push: true } } },
    });

  // Canary: restore the `wasBound` toast ("Credential rotated to …") and the
  // first case reads "rotated"; compare nothing and the second reads
  // "reattached".
  it("the same connection bound again: re-attached, the token unchanged, and where a token IS replaced", async () => {
    const store = setupProjectedStore(ctx);
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    await createConnection(
      store.db,
      { owner: "akin-ozer", token: "ghp_akinozer_token_k3ui", userId: actor.userId },
      actor,
      { fetchImpl: CLASSIC("akin-ozer").fetchImpl },
    );
    const opts = { dataRoot: store.dataRoot, fetchImpl: CLASSIC("akin-ozer").fetchImpl };
    expect((await runSetCredential(store.db, store.slug, actor, opts)).result).toBe("attached");
    const before = getProjectCredential(store.db, store.slug)!.id;

    const again = await runSetCredential(store.db, store.slug, actor, opts);
    expect(again.result).toBe("reattached");
    expect(again.toast).toBe(
      "Re-attached akin-ozer's connection and re-checked it. The token is unchanged: replace it with Update token in Instance settings, under GitHub connections",
    );
    expect(again.toast).not.toMatch(/rotat/i);
    expect(getProjectCredential(store.db, store.slug)!.id).toBe(before);
  });

  it("another connection's token bound: switched", async () => {
    const store = setupProjectedStore(ctx);
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    await createConnection(
      store.db,
      { owner: "hepapi", token: "ghp_hepapi_token_1111", userId: actor.userId },
      actor,
      { fetchImpl: CLASSIC("hepapi").fetchImpl },
    );
    await createConnection(
      store.db,
      { owner: "akin-ozer", token: "ghp_akinozer_token_2222", userId: actor.userId },
      actor,
      { fetchImpl: CLASSIC("akin-ozer").fetchImpl },
    );
    // Bound to hepapi's token before the repository's owner had a connection.
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: getConnection(store.db, "hepapi")!.patId },
      actor,
    );
    const outcome = await runSetCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: CLASSIC("akin-ozer").fetchImpl,
    });
    expect(outcome.result).toBe("switched");
    expect(outcome.toast).toBe("Switched to akin-ozer's connection. Sync uses its token now");
    expect(getProjectCredential(store.db, store.slug)!.id).toBe(
      getConnection(store.db, "akin-ozer")!.patId,
    );
  });
});

/**
 * Ruling 540: the board's Repository strip and the home card read the check
 * remembered per project (U33-2). Attaching, re-checking and removing the
 * credential change what that check describes, so each takes a new reading.
 * Before, each cleared only the 30-second memo in front of it, and the strip
 * went on showing its verdict about the credential that was there before.
 */
describe("ruling 540: a credential change takes a new reading for the board", () => {
  it("attach, Re-check scopes and remove each leave the check describing the credential as it now stands", async () => {
    const store = setupProjectedStore(ctx);
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    await createConnection(
      store.db,
      { owner: "akin-ozer", token: FINE, userId: store.users.arda.id },
      actor,
      {
        fetchImpl: fakeGithubFetch({
          "GET /user": { body: { login: "akin-ozer" } },
          "GET /user/orgs": { body: [] },
          "GET /users/akin-ozer": { body: {} },
        }).fetchImpl,
      },
    );
    // What the board said about the credential attached before this one.
    recordRepoAccess(store.db, store.slug, { status: "auth_failed", repo: REPO, reason: "revoked" });
    const board = () => readRepoHealth(store.db, store.slug)?.result;

    const working = fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" } },
      "GET /user/orgs": { body: [] },
      [`GET /repos/${REPO}`]: {
        body: { full_name: REPO, default_branch: "main", private: true, permissions: { push: true } },
      },
      [`GET /repos/${REPO}/pulls`]: { body: [] },
    });
    await runSetCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: working.fetchImpl,
    });
    // CANARY: let the attach only drop the memo again and the strip keeps
    // saying "token revoked" about a credential that is gone.
    expect(board()).toEqual({ status: "connected", repo: REPO, remoteDefaultBranch: "main", private: true });

    const refused = { status: 401, body: { message: "Bad credentials" } };
    await runGrantScope(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: fakeGithubFetch({ "GET /user": refused, [`GET /repos/${REPO}`]: refused }).fetchImpl,
    });
    expect(board()).toEqual({ status: "auth_failed", repo: REPO, reason: "revoked" });

    await runClearCredential(store.db, store.slug, actor);
    expect(board()).toEqual({ status: "no_pat_configured", repo: REPO });
  });
});
