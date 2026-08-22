import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { fakeGithubFetch, unreachableFetch } from "../../../test-support/fake-github";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { checkRepoAccess } from "./repo-access-check.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/** setupTestStore seeds the project with repo `akin-ozer/viberr`, so every
 *  repo request lands on this path (query is ignored for route matching). */
const REPO_PATH = "/repos/akin-ozer/viberr";
const ACTOR = { userId: "u_test", label: "arda@viberr.test" };

/** A store whose `projects` projection is built and whose project carries a
 *  usable PAT, so `checkRepoAccess` reaches the GitHub `request` every time. */
function setupWithCredential() {
  const store = setupTestStore(ctx);
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_repoaccess0001" },
    ACTOR,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);
  return store;
}

describe("checkRepoAccess", () => {
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
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
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
