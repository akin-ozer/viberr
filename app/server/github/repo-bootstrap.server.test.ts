import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { fakeGithubFetch, type FakeGithub } from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { findOpenScopeViolation } from "~/server/projections/policy-violations.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, getPatMetadata, setProjectCredential } from "~/server/secrets/pat-store.server";
import { getProjectGithubContext } from "./github-context.server";
import { ensureDefaultBranch, isTaskBranch } from "./repo-bootstrap.server";

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

/** GitHub's answers on an EMPTY repository (ruling 227; recorded in the module
 *  comment — the live step V2 re-verifies them). */
const EMPTY_REF = { status: 409, body: { message: "Git Repository is empty." } };

describe("ensureDefaultBranch (ruling 227)", () => {
  it("an empty repository gets an initial commit and its default branch, recorded on the timeline and audited", async () => {
    // Canary: return `bootstrap_failed` from the empty-array arm instead of
    // issuing the PUT — the status, the PUT call and the timeline line all fail.
    // The first ref read is GitHub's 409 for an empty repository, a missing ref:
    // drop the 409 clause from `isMissingRefAnswer` and no PUT is sent either.
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
    // Ruling 220 (F40-43): the commit this token just made proves `repo` on this
    // repository. Canary: drop the bootstrap's `markWriteScopeProven`.
    const proof = getPatMetadata(store.db, contextFor(store, gh).patId)!.repoScopes;
    expect(proof).toEqual([
      {
        repo: "akin-ozer/viberr",
        scopes: [
          expect.objectContaining({ id: "repo", ok: true, source: "probe", note: "the initial commit Viberr made here" }),
        ],
      },
    ]);
  });

  /**
   * Ruling 227: two paths now bootstrap (the branch preparation and the
   * operator's first checkout). A PUT that loses the race is refused by
   * GitHub; the branch the winner made is the outcome both wanted.
   */
  it("ruling 227: a create refused because another call already made the branch answers `exists` and writes nothing", async () => {
    const store = setup();
    let reads = 0;
    const gh = fakeGithubFetch({
      // Empty on the first read; the winner's branch on the one after the PUT.
      [`GET ${REPO_PATH}/git/ref/heads/main`]: () => {
        reads += 1;
        return reads === 1 ? EMPTY_REF : { body: { object: { sha: ROOT } } };
      },
      [`GET ${REPO_PATH}/branches`]: { body: [] },
      [`PUT ${REPO_PATH}/contents/README.md`]: {
        status: 422,
        body: { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' },
      },
    });
    const result = await ensureDefaultBranch(
      store.db,
      contextFor(store, gh),
      { projectSlug: store.slug, taskKey: "JC-1" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    // CANARY: drop the re-read after a refused PUT and this is `bootstrap_failed`,
    // which refuses the push of a task whose base exists.
    expect(result).toEqual({ status: "exists", defaultBranch: "main" });
    expect(listAuditEvents(store.db).some((e) => e.action === "github.repo.bootstrapped")).toBe(false);
    const timeline = readTaskFile({ projectSlug: store.slug, taskKey: "JC-1", dataRoot: store.dataRoot })!
      .parsed.timeline;
    expect(timeline.some((e) => e.text.includes("Bootstrapped the repository"))).toBe(false);
  });

  /** An empty repository whose first commit lands on the first PUT, which
   *  GitHub answers 502; a second PUT meets the file and is refused. */
  function landedThenBadGateway(headCommit: (putMessage: string) => { message: string; parents: unknown[] }) {
    let landed = false;
    let putMessage = "";
    return fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/main`]: () =>
        landed ? { body: { object: { sha: ROOT } } } : EMPTY_REF,
      [`GET ${REPO_PATH}/branches`]: { body: [] },
      [`PUT ${REPO_PATH}/contents/README.md`]: (call) => {
        if (landed) return { status: 422, body: { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' } };
        landed = true;
        putMessage = z.object({ message: z.string() }).parse(call.body).message;
        return { status: 502, body: { message: "Server Error" } };
      },
      [`GET ${REPO_PATH}/git/commits/${ROOT}`]: () => ({ body: { sha: ROOT, ...headCommit(putMessage) } }),
    });
  }

  it("R-repo-1: a first commit that landed but answered 502 is sent once and recorded as the bootstrap", async () => {
    // CANARY: let the client retry the PUT and its 422 sends the race arm to
    // `exists`: Viberr's own first commit gets no audit row and no timeline
    // line. Skip the head-commit read and it is `exists` too.
    const store = setup();
    const gh = landedThenBadGateway((message) => ({ message, parents: [] }));
    const result = await ensureDefaultBranch(
      store.db,
      contextFor(store, gh),
      { projectSlug: store.slug, taskKey: "JC-1" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(gh.callsTo(`PUT ${REPO_PATH}/contents/README.md`)).toHaveLength(1);
    expect(result).toEqual({ status: "bootstrapped", defaultBranch: "main", how: "initial_commit", sha: ROOT });
    expect(listAuditEvents(store.db).filter((e) => e.action === "github.repo.bootstrapped")).toHaveLength(1);
    const timeline = readTaskFile({ projectSlug: store.slug, taskKey: "JC-1", dataRoot: store.dataRoot })!
      .parsed.timeline;
    expect(timeline.some((e) => e.text.includes("Bootstrapped the repository"))).toBe(true);
  });

  it("R-repo-1: after a 502, a branch whose head is not this write's first commit answers `exists` and writes nothing", async () => {
    const store = setup();
    const gh = landedThenBadGateway(() => ({ message: "Add a readme by hand", parents: [{ sha: NEWER }] }));
    const result = await ensureDefaultBranch(
      store.db,
      contextFor(store, gh),
      { projectSlug: store.slug, taskKey: "JC-1" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(result).toEqual({ status: "exists", defaultBranch: "main" });
    expect(listAuditEvents(store.db).some((e) => e.action === "github.repo.bootstrapped")).toBe(false);
  });

  it("a repository whose only branch is a pushed task branch gets `main` at that branch's first commit and the default restored", async () => {
    // Canary: post the ref with the NEWEST sha (the first page entry) and the
    // sha assertions fail. Ruling 227: stop reading a task's key as its
    // branch and `jc-1` is taken as the project's default instead.
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
    const { unreachableFetch } = await import("../../../test-support/fake-github");
    const offline = getProjectGithubContext(store.db, store.slug, { fetchImpl: unreachableFetch() });
    if (offline.status !== "ok") throw new Error("context");
    expect(
      (await ensureDefaultBranch(store.db, offline, { projectSlug: store.slug }, ACTOR, { dataRoot: store.dataRoot })).status,
    ).toBe("network_unavailable");
  });
});

/**
 * Ruling 227: the repair is for a repository whose default on GitHub is a
 * task branch. A default branch that is not one is the repository's own.
 * The repair used to run there too: a project written with `main` while
 * GitHub was unreachable, or left on `master` after a rename on GitHub, had
 * that name created at the first commit of the real default branch and made
 * the repository's default.
 */
describe("ensureDefaultBranch and a repository with a default branch of its own (ruling 227)", () => {
  /** GitHub's answers for a repository whose default is `branch`, with the
   *  writes the repair would make answering as they do when it runs. */
  const routes = (branch: string) => ({
    [`GET ${REPO_PATH}/git/ref/heads/main`]: { status: 404, body: { message: "Not Found" } },
    [`GET ${REPO_PATH}/branches`]: { body: [{ name: branch }] },
    [`GET ${REPO_PATH}`]: { body: { default_branch: branch } },
    [`GET ${REPO_PATH}/commits`]: { body: [{ sha: NEWER }, { sha: ROOT }] },
    [`POST ${REPO_PATH}/git/refs`]: { status: 201, body: { ref: "refs/heads/main" } },
    [`PATCH ${REPO_PATH}`]: { body: { default_branch: "main" } },
  });

  it("the project takes it when it names a branch the repository does not have, and nothing is created on GitHub", async () => {
    // CANARY: drop the task-branch question and `main` is created at the
    // first commit of somebody's `master` and made the repository's default;
    // skip the reprojection and every later reader still gets `main`.
    const store = setup();
    const gh = fakeGithubFetch(routes("master"));
    const result = await ensureDefaultBranch(
      store.db,
      contextFor(store, gh),
      { projectSlug: store.slug, taskKey: "JC-1" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(result).toEqual({ status: "adopted", defaultBranch: "master", was: "main" });
    expect(gh.callsTo(`POST ${REPO_PATH}/git/refs`)).toHaveLength(0);
    expect(gh.callsTo(`PATCH ${REPO_PATH}`)).toHaveLength(0);
    expect(
      readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter.defaultBranch,
    ).toBe("master");
    // The projection is what every later reader of the base goes through.
    expect(contextFor(store, gh).defaultBranch).toBe("master");
    expect(
      readTaskFile({ projectSlug: store.slug, taskKey: "JC-1", dataRoot: store.dataRoot })!.parsed.timeline[0]!.text,
    ).toBe(
      "`akin-ozer/viberr` has no **main**: its default branch on GitHub is **master**, which Viberr did not make. Nothing was created there. This project now uses **master** as its default branch.",
    );
    const audits = listAuditEvents(store.db);
    expect(audits.find((e) => e.action === "project.default_branch.adopted")).toMatchObject({
      taskKey: "JC-1",
      details: { repo: "akin-ozer/viberr", from: "main", to: "master" },
    });
    expect(audits.some((e) => e.action === "github.repo.bootstrapped")).toBe(false);
  });

  it("a branch a task recorded is not a task's by that alone: a task that records the repository's default leaves it the repository's", async () => {
    // A finished run's checkout is recorded as its task's branch unless it
    // stood on the project's default, so a project naming the wrong default
    // has tasks recording the real one. CANARY: read `branch:` as well as the
    // name and the repair runs on a person's `master`.
    const store = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("JC-1", { title: "Bootstrap the repo", branch: "master" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const gh = fakeGithubFetch(routes("master"));
    const result = await ensureDefaultBranch(
      store.db,
      contextFor(store, gh),
      { projectSlug: store.slug, taskKey: "JC-1" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(result).toMatchObject({ status: "adopted", defaultBranch: "master" });
    expect(gh.callsTo(`POST ${REPO_PATH}/git/refs`)).toHaveLength(0);
    expect(gh.callsTo(`PATCH ${REPO_PATH}`)).toHaveLength(0);
  });

  it("a branch is a task's when it is a task's key or that with a suffix, in any case, and nothing else", () => {
    // The refresh asks this of an unborn checkout's branch too. CANARY:
    // compare the key by case and `JC-1` is nobody's: a checkout unborn on it
    // is moved off its own task's branch.
    const store = setup();
    const rows: [string, boolean][] = [
      ["jc-1", true],
      ["JC-1", true],
      ["jc-1-0c88", true],
      ["JC-1-rework", true],
      ["jc-10", false],
      ["jc-", false],
      ["xjc-1", false],
      ["master", false],
      ["", false],
    ];
    for (const [branch, tasks] of rows) {
      expect(isTaskBranch(store.db, store.slug, branch), branch).toBe(tasks);
    }
    expect(isTaskBranch(store.db, "another-project", "jc-1")).toBe(false);
  });

  it("a task's key with a suffix is a task's branch, an archived task's too: the repair runs and the project keeps its own", async () => {
    // Ruling 228 allocates `<key>-<4 hex>` when the key is taken. CANARY: ask
    // only whether the name IS a task's key, or leave archived tasks out, and
    // `jc-1-0c88` becomes the project's default branch.
    const store = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("JC-1", { title: "Bootstrap the repo", archived: true }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const gh = fakeGithubFetch(routes("jc-1-0c88"));
    const result = await ensureDefaultBranch(
      store.db,
      contextFor(store, gh),
      { projectSlug: store.slug, taskKey: "JC-1" },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(result).toMatchObject({ status: "bootstrapped", how: "ref_from_branch_root", from: "jc-1-0c88" });
    expect(
      readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter.defaultBranch,
    ).toBe("main");
  });
});

/**
 * Pass 34 review (ruling 227's own split): the gate divides by EVIDENCE, not by
 * failure. A read that did not answer proves nothing about the repository, so
 * it must never tell a person their `main` is missing; a create that failed is
 * positive evidence the base could not be made.
 */
describe("ensureDefaultBranch degrades an unread probe and refuses a failed create", () => {
  it("a 5xx on the ref READ degrades instead of claiming the base is missing", async () => {
    // Canary: send every non-network, non-401 read failure to
    // `bootstrap_failed` again — delivery refuses a healthy `main`.
    const store = setup();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/main`]: { status: 500, body: { message: "boom" } },
    });
    const result = await ensureDefaultBranch(
      store.db,
      contextFor(store, gh),
      { projectSlug: store.slug },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(result.status).toBe("network_unavailable");
  });

  it("a 5xx on the initial-commit CREATE still refuses the push", async () => {
    const store = setup();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/main`]: { status: 404, body: { message: "Not Found" } },
      [`GET ${REPO_PATH}/branches`]: { body: [] },
      [`PUT ${REPO_PATH}/contents/README.md`]: { status: 500, body: { message: "boom" } },
    });
    const result = await ensureDefaultBranch(
      store.db,
      contextFor(store, gh),
      { projectSlug: store.slug },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(result).toMatchObject({ status: "bootstrap_failed", defaultBranch: "main" });
  });

  it("a 409 `Git Repository is empty` on the BRANCH listing is zero branches, not a failure", async () => {
    // Canary: drop the `isMissingRefAnswer(branches)` arm — the empty
    // repository this module exists to bootstrap is refused instead.
    const store = setup();
    let refCreated = false;
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/main`]: () =>
        refCreated ? { body: { object: { sha: ROOT } } } : EMPTY_REF,
      // The empty repository answers the BRANCH listing the same way.
      [`GET ${REPO_PATH}/branches`]: EMPTY_REF,
      [`PUT ${REPO_PATH}/contents/README.md`]: () => {
        refCreated = true;
        return { status: 201, body: { commit: { sha: ROOT } } };
      },
    });
    const result = await ensureDefaultBranch(
      store.db,
      contextFor(store, gh),
      { projectSlug: store.slug },
      ACTOR,
      { dataRoot: store.dataRoot },
    );
    expect(result).toMatchObject({ status: "bootstrapped", how: "initial_commit" });
  });
});
