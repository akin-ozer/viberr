import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupProjectedStore } from "../../../test-support/projected-store";
import { fakeGithubFetch, unreachableFetch } from "../../../test-support/fake-github";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { checkRepoAccess } from "./repo-access-check.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/** setupTestStore seeds the project with repo `akin-ozer/viberr`, so every
 *  repo request lands on this path (query is ignored for route matching). */
const REPO_PATH = "/repos/akin-ozer/viberr";
const ACTOR = { userId: "u_test", label: "arda@viberr.test" };

/** A store whose `projects` projection is built and whose project carries a
 *  usable PAT, so `checkRepoAccess` reaches the GitHub `request` every time. */
function setupWithCredential() {
  const store = setupProjectedStore(ctx);
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_repoaccess0001" },
    ACTOR,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);
  return store;
}

describe("checkRepoAccess", () => {
  /**
   * Ruling 468 (F40-12): an existing repository with no commit reads as
   * connected AND empty, so the GitHub page and `get_github_state` can say
   * Viberr will make the first commit. `size: 0` is the cue, the commits
   * read's 409 the proof; a repository with a size never pays that read.
   */
  it("ruling 468: an empty repository is connected and empty; size 0 with commits is not; a size skips the read", async () => {
    const store = setupWithCredential();
    const empty = fakeGithubFetch({
      [`GET ${REPO_PATH}`]: { body: { full_name: "akin-ozer/viberr", default_branch: "main", size: 0 } },
      [`GET ${REPO_PATH}/commits`]: { status: 409, body: { message: "Git Repository is empty." } },
    });
    // CANARY: drop the `repositoryIsEmpty` call and `empty` is never set.
    expect(await checkRepoAccess(store.db, store.slug, { fetchImpl: empty.fetchImpl })).toEqual({
      status: "connected",
      repo: "akin-ozer/viberr",
      remoteDefaultBranch: "main",
      private: false,
      empty: true,
    });
    // `size: 0` alone is not proof: GitHub computes it lazily.
    const lazy = fakeGithubFetch({
      [`GET ${REPO_PATH}`]: { body: { default_branch: "main", size: 0 } },
      [`GET ${REPO_PATH}/commits`]: { body: [{ sha: "abc" }] },
    });
    expect(await checkRepoAccess(store.db, store.slug, { fetchImpl: lazy.fetchImpl })).not.toHaveProperty("empty");
    const sized = fakeGithubFetch({ [`GET ${REPO_PATH}`]: { body: { default_branch: "main", size: 12 } } });
    await checkRepoAccess(store.db, store.slug, { fetchImpl: sized.fetchImpl });
    expect(sized.callsTo(`GET ${REPO_PATH}/commits`)).toHaveLength(0);
  });

  /**
   * R-repo-2 (ruling 468's dated note): the page and `get_github_state` said
   * Viberr would make an empty repository's first commit whatever the token
   * could do. GitHub's permissions block is the proof a token cannot push.
   */
  it("R-repo-2: a token GitHub says cannot push is recorded read-only; one that can, or no block, is not", async () => {
    const store = setupWithCredential();
    const readOnly = fakeGithubFetch({
      [`GET ${REPO_PATH}`]: {
        body: { default_branch: "main", size: 0, permissions: { pull: true, push: false } },
      },
      [`GET ${REPO_PATH}/commits`]: { status: 409, body: { message: "Git Repository is empty." } },
    });
    // CANARY: drop the permissions read and `readOnly` is never set.
    expect(await checkRepoAccess(store.db, store.slug, { fetchImpl: readOnly.fetchImpl })).toMatchObject({
      status: "connected",
      empty: true,
      readOnly: true,
    });
    const writable = fakeGithubFetch({
      [`GET ${REPO_PATH}`]: { body: { default_branch: "main", permissions: { push: true } } },
    });
    expect(await checkRepoAccess(store.db, store.slug, { fetchImpl: writable.fetchImpl })).not.toHaveProperty(
      "readOnly",
    );
    const unknown = fakeGithubFetch({ [`GET ${REPO_PATH}`]: { body: { default_branch: "main" } } });
    expect(await checkRepoAccess(store.db, store.slug, { fetchImpl: unknown.fetchImpl })).not.toHaveProperty(
      "readOnly",
    );
  });

  it("connected: a 200 repo body maps to the remote default branch and privacy", async () => {
    const store = setupWithCredential();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}`]: {
        body: {
          full_name: "akin-ozer/viberr",
          private: true,
          default_branch: "develop",
        },
      },
    });
    const result = await checkRepoAccess(store.db, store.slug, {
      fetchImpl: gh.fetchImpl,
    });
    expect(result).toEqual({
      status: "connected",
      repo: "akin-ozer/viberr",
      remoteDefaultBranch: "develop",
      private: true,
    });
  });

  it("connected: a body missing every field degrades to the configured repo, no branch, public", async () => {
    const store = setupWithCredential();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}`]: { body: {} },
    });
    const result = await checkRepoAccess(store.db, store.slug, {
      fetchImpl: gh.fetchImpl,
    });
    expect(result).toEqual({
      status: "connected",
      repo: "akin-ozer/viberr",
      remoteDefaultBranch: null,
      private: false,
    });
  });

  it("auth_failed/expired: a 401 whose message says the token expired classifies as expired", async () => {
    const store = setupWithCredential();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}`]: {
        status: 401,
        body: { message: "Your token has expired. Please generate a new token." },
      },
    });
    const result = await checkRepoAccess(store.db, store.slug, {
      fetchImpl: gh.fetchImpl,
    });
    expect(result).toEqual({
      status: "auth_failed",
      repo: "akin-ozer/viberr",
      reason: "expired",
    });
  });

  it("auth_failed/revoked: a 401 'Bad credentials' (no 'expired') classifies as revoked", async () => {
    const store = setupWithCredential();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}`]: {
        status: 401,
        body: { message: "Bad credentials" },
      },
    });
    const result = await checkRepoAccess(store.db, store.slug, {
      fetchImpl: gh.fetchImpl,
    });
    expect(result).toEqual({
      status: "auth_failed",
      repo: "akin-ozer/viberr",
      reason: "revoked",
    });
  });

  it("org_approval_missing: a 403 SSO/approval message routes to the org-approval arm", async () => {
    const store = setupWithCredential();
    const message =
      "Although you appear to have the correct authorization credentials, access to this repository requires the organization to grant SSO approval, which is still pending.";
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}`]: { status: 403, body: { message } },
    });
    const result = await checkRepoAccess(store.db, store.slug, {
      fetchImpl: gh.fetchImpl,
    });
    expect(result).toEqual({
      status: "org_approval_missing",
      repo: "akin-ozer/viberr",
      message,
    });
  });

  it("forbidden: a plain 403 with no org/approval/policy keyword stays a bare forbidden", async () => {
    const store = setupWithCredential();
    const message = "Resource not accessible by personal access token";
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}`]: { status: 403, body: { message } },
    });
    const result = await checkRepoAccess(store.db, store.slug, {
      fetchImpl: gh.fetchImpl,
    });
    expect(result).toEqual({
      status: "forbidden",
      repo: "akin-ozer/viberr",
      message,
    });
  });

  it("repo_not_found: a 404 maps to the not-found arm", async () => {
    const store = setupWithCredential();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}`]: { status: 404, body: { message: "Not Found" } },
    });
    const result = await checkRepoAccess(store.db, store.slug, {
      fetchImpl: gh.fetchImpl,
    });
    expect(result).toEqual({
      status: "repo_not_found",
      repo: "akin-ozer/viberr",
    });
  });

  it("network_unavailable: a transport failure (never an HTTP status) hits the network arm", async () => {
    const store = setupWithCredential();
    const result = await checkRepoAccess(store.db, store.slug, {
      fetchImpl: unreachableFetch(),
    });
    expect(result).toEqual({
      status: "network_unavailable",
      repo: "akin-ozer/viberr",
    });
  });

  it("no_pat_configured: the context failure passes straight through before any request", async () => {
    const store = setupProjectedStore(ctx);
    // No PAT bound to the project, so the context resolver degrades first.
    const gh = fakeGithubFetch({});
    const result = await checkRepoAccess(store.db, store.slug, {
      fetchImpl: gh.fetchImpl,
    });
    expect(result).toEqual({
      status: "no_pat_configured",
      repo: "akin-ozer/viberr",
    });
    // Nothing ever reached GitHub.
    expect(gh.calls).toHaveLength(0);
  });
});
