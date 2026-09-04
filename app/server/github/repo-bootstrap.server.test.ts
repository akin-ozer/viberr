import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { fakeGithubFetch, type FakeGithub } from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readTaskFile } from "~/server/files/task-writer.server";
import { findOpenScopeViolation } from "~/server/projections/policy-violations.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { getProjectGithubContext } from "./github-context.server";
import { ensureDefaultBranch } from "./repo-bootstrap.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const REPO_PATH = "/repos/akin-ozer/viberr";
const ACTOR = { userId: "u_test", label: "arda@viberr.test" };
const ROOT = "d2e0fb0".padEnd(40, "0");
const NEWER = "9e9e9e9".padEnd(40, "0");

function setup(taskKey = "JC-1") {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(taskKey, { title: "Bootstrap the repo" }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_bootstrap0001" },
    ACTOR,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);
  return store;
}

function contextFor(store: ReturnType<typeof setup>, gh: FakeGithub) {
  const result = getProjectGithubContext(store.db, store.slug, { fetchImpl: gh.fetchImpl });
  if (result.status !== "ok") throw new Error(`context ${result.status}`);
  return result;
}

/** GitHub's answers on an EMPTY repository (ruling 128; recorded in the module
 *  comment — the live step V2 re-verifies them). */
const EMPTY_REF = { status: 409, body: { message: "Git Repository is empty." } };

describe("ensureDefaultBranch (ruling 128)", () => {
  it("an empty repository gets an initial commit and its default branch, recorded on the timeline and audited", async () => {
    // Canary: return `bootstrap_failed` from the empty-array arm instead of
    // issuing the PUT — the status, the PUT call and the timeline line all fail.
    const store = setup();
    let refCreated = false;
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/main`]: () =>
        refCreated ? { body: { object: { sha: ROOT } } } : EMPTY_REF,
      [`GET ${REPO_PATH}/branches`]: { body: [] },
      [`PUT ${REPO_PATH}/contents/README.md`]: () => {
        refCreated = true;
        return { status: 201, body: { commit: { sha: ROOT } } };
      },
    });
    const result = await ensureDefaultBranch(
      store.db,
      contextFor(store, gh),
      { projectSlug: store.slug, taskKey: "JC-1" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(result).toEqual({
      status: "bootstrapped",
      defaultBranch: "main",
      how: "initial_commit",
      sha: ROOT,
    });
    const put = gh.callsTo(`PUT ${REPO_PATH}/contents/README.md`);
    expect(put).toHaveLength(1);
    expect(put[0]!.body).toMatchObject({ branch: "main" });
    // SAFETY: the fake records the JSON body the bootstrap sent, whose `message` is a string.
    expect(String((put[0]!.body as { message: string }).message)).toContain("Initialize");
    const timeline = readTaskFile({ projectSlug: store.slug, taskKey: "JC-1", dataRoot: store.dataRoot })!
      .parsed.timeline;
    expect(timeline[0]!.type).toBe("github");
    expect(timeline[0]!.text).toContain("Bootstrapped the repository");
    expect(timeline[0]!.text).toContain("**main**");
    expect(timeline[0]!.text).toContain("`d2e0fb0`");
    const audit = listAuditEvents(store.db).find((e) => e.action === "github.repo.bootstrapped");
    expect(audit?.details).toMatchObject({ how: "initial_commit", sha: ROOT, defaultBranch: "main" });
  });

  it("a 409 `Git Repository is empty.` on the ref read is a missing ref, not a network failure", async () => {
    // Canary: drop the 409 clause from `isMissingRefAnswer` and this reads
    // `bootstrap_failed` (the 409 falls into the generic failure arm).
    const store = setup();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/main`]: EMPTY_REF,
      [`GET ${REPO_PATH}/branches`]: { body: [] },
      [`PUT ${REPO_PATH}/contents/README.md`]: { status: 201, body: { commit: { sha: ROOT } } },
    });
    // The re-probe after the PUT still answers 409 here (the fake is static),
    // which is a bootstrap that did not take — but the FIRST read must have
    // been treated as "missing", which the PUT proves happened.
    const result = await ensureDefaultBranch(
      store.db,
      contextFor(store, gh),
      { projectSlug: store.slug, taskKey: "JC-1" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(gh.callsTo(`PUT ${REPO_PATH}/contents/README.md`)).toHaveLength(1);
    expect(result.status).not.toBe("network_unavailable");
  });

  it("a repository whose only branch is a pushed task branch gets `main` at that branch's first commit and the default restored", async () => {
    // Canary: post the ref with the NEWEST sha (the first page entry) and the
    // sha assertions fail.
    const store = setup();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/main`]: { status: 404, body: { message: "Not Found" } },
      [`GET ${REPO_PATH}/branches`]: { body: [{ name: "jc-1" }] },
      [`GET ${REPO_PATH}`]: { body: { default_branch: "jc-1" } },
      // Newest first, as GitHub lists them: the ROOT is the last entry.
      [`GET ${REPO_PATH}/commits`]: { body: [{ sha: NEWER }, { sha: ROOT }] },
      [`POST ${REPO_PATH}/git/refs`]: { status: 201, body: { ref: "refs/heads/main" } },
      [`PATCH ${REPO_PATH}`]: { body: { default_branch: "main" } },
    });
    const result = await ensureDefaultBranch(
      store.db,
      contextFor(store, gh),
      { projectSlug: store.slug, taskKey: "JC-1" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(result).toEqual({
      status: "bootstrapped",
      defaultBranch: "main",
      how: "ref_from_branch_root",
      sha: ROOT,
      from: "jc-1",
      defaultRestored: true,
    });
    expect(gh.callsTo(`POST ${REPO_PATH}/git/refs`)[0]!.body).toEqual({
      ref: "refs/heads/main",
      sha: ROOT,
    });
    expect(gh.callsTo(`PATCH ${REPO_PATH}`)[0]!.body).toEqual({ default_branch: "main" });
    const text = readTaskFile({ projectSlug: store.slug, taskKey: "JC-1", dataRoot: store.dataRoot })!
      .parsed.timeline[0]!.text;
    expect(text).toContain("`jc-1`");
    expect(text).toContain("restored it as the repository default");
    expect(listAuditEvents(store.db).find((e) => e.action === "github.repo.bootstrapped")?.details)
      .toMatchObject({ how: "ref_from_branch_root", from: "jc-1", defaultRestored: true });
  });

  it("a 403 on the initial commit opens a `repo` scope violation", async () => {
    // Canary: return `network_unavailable` from the 403 arm without calling
    // `flagScopeViolation`.
    const store = setup();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/main`]: EMPTY_REF,
      [`GET ${REPO_PATH}/branches`]: { body: [] },
      [`PUT ${REPO_PATH}/contents/README.md`]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const result = await ensureDefaultBranch(
      store.db,
      contextFor(store, gh),
      { projectSlug: store.slug, taskKey: "JC-1" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(result.status).toBe("scope_violation");
    expect(findOpenScopeViolation(store.db, store.slug, "repo", "JC-1")).toBeTruthy();
  });

  it("an existing default branch writes nothing", async () => {
    // Canary: issue the PUT unconditionally and the call count fails.
    const store = setup();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/main`]: { body: { object: { sha: ROOT } } },
      [`PUT ${REPO_PATH}/contents/README.md`]: { status: 201, body: { commit: { sha: NEWER } } },
    });
    const result = await ensureDefaultBranch(
      store.db,
      contextFor(store, gh),
      { projectSlug: store.slug, taskKey: "JC-1" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(result).toEqual({ status: "exists", defaultBranch: "main" });
    expect(gh.callsTo(`PUT ${REPO_PATH}/contents/README.md`)).toHaveLength(0);
    expect(gh.calls).toHaveLength(1);
    expect(listAuditEvents(store.db).some((e) => e.action === "github.repo.bootstrapped")).toBe(false);
  });

  it("a probe that could not be READ is not a missing base: network → network_unavailable, 401 → auth_failed", async () => {
    const store = setup();
    const unauthorized = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/main`]: { status: 401, body: { message: "Bad credentials" } },
    });
    expect(
      (await ensureDefaultBranch(store.db, contextFor(store, unauthorized), { projectSlug: store.slug }, ACTOR, { dataRoot: store.dataRoot })).status,
    ).toBe("auth_failed");
    const gh = contextFor(store, fakeGithubFetch({}));
    const { unreachableFetch } = await import("../../../test-support/fake-github");
    const offline = getProjectGithubContext(store.db, store.slug, { fetchImpl: unreachableFetch() });
    if (offline.status !== "ok") throw new Error("context");
    expect(
      (await ensureDefaultBranch(store.db, offline, { projectSlug: store.slug }, ACTOR, { dataRoot: store.dataRoot })).status,
    ).toBe("network_unavailable");
    void gh;
  });
});
