import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
} from "../../../test-support/test-store";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  createLocalOrigin,
  gitOut,
  gitOutSync,
  withLocalGithub,
} from "../../../test-support/git-origin";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { ensureOperatorRepoCheckout } from "~/server/runtimes/operator-run.server";

/**
 * Ruling 468 (F40-12): viberr initializes an empty repository instead of
 * asking a person to push a commit. Ruling 128 already bootstrapped the base
 * before a task BRANCH; the operator runs before any branch, and live its first
 * checkout of `akin-ozer/website` held an unborn `main` and it opened a packet
 * asking the owner to "push one initial commit (a README)". Its checkout is now
 * the other path that needs the base: an unborn checkout gets the first commit
 * through the same bootstrap, and moves onto it.
 */
const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const REPO = "acme/widgets";
const REPO_PATH = `/repos/${REPO}`;
const EMPTY = { status: 409, body: { message: "Git Repository is empty." } };

/** What the fake GitHub is told about the repository. */
interface FakeRepoState {
  /** The first-commit write fails, the way a GitHub outage does. */
  refuse: boolean;
  /** The branch a person pushed first, which GitHub then calls the default,
   *  and its head. */
  own: { branch: string; sha: string } | null;
}

async function emptyRepoTask() {
  const store = setupTestStore(ctx);
  const origins = ctx.makeTempDir();
  const origin = await createLocalOrigin(origins, { repo: REPO, empty: true });
  const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, { ...project.parsed.frontmatter, repo: REPO, defaultBranch: "main" });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage: "triage" }),
    goal: "Build the site.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  const actor = { userId: store.users.arda.id, label: store.users.arda.email };
  const pat = createPat(store.db, { userId: store.users.arda.id, label: "bot", token: "ghp_empty0001" }, actor);
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);

  // GitHub as it answers an EMPTY repository, until the Contents API write
  // lands a real commit in the local origin the checkout clones from. While
  // `refuse` holds, the write fails the way a GitHub outage does.
  let head: string | null = null;
  const control: FakeRepoState = { refuse: false, own: null };
  const gh = fakeGithubFetch({
    [`GET ${REPO_PATH}/git/ref/heads/main`]: () =>
      control.own
        ? { status: 404, body: { message: "Not Found" } }
        : head
          ? { body: { object: { sha: head } } }
          : EMPTY,
    [`GET ${REPO_PATH}/git/ref/heads/master`]: () =>
      control.own?.branch === "master"
        ? { body: { object: { sha: control.own.sha } } }
        : { status: 404, body: { message: "Not Found" } },
    [`GET ${REPO_PATH}/branches`]: () =>
      control.own ? { body: [{ name: control.own.branch }] } : head ? { body: [{ name: "main" }] } : EMPTY,
    [`GET ${REPO_PATH}`]: () => ({ body: { default_branch: control.own?.branch ?? "main" } }),
    [`PUT ${REPO_PATH}/contents/README.md`]: (call) => {
      if (control.refuse) return { status: 502, body: { message: "Bad Gateway" } };
      // SAFETY: the bootstrap sends the Contents API's JSON body; `content`
      // is its base64 text.
      const body = call.body as { content: string; message: string };
      writeFileSync(path.join(origin.seed, "README.md"), Buffer.from(body.content, "base64"));
      gitOutSync(origin.seed, ["add", "-A"]);
      gitOutSync(origin.seed, ["commit", "-qm", body.message]);
      gitOutSync(origin.seed, ["push", "-q", origin.bare, "HEAD:refs/heads/main"]);
      head = gitOutSync(origin.seed, ["rev-parse", "HEAD"]);
      return { status: 201, body: { commit: { sha: head } } };
    },
  });
  const checkout = (taskKey = "VIB-1") =>
    withLocalGithub(origins, () =>
      ensureOperatorRepoCheckout(
        store.db,
        { projectSlug: store.slug, taskKey, dataRoot: store.dataRoot },
        undefined,
        { fetchImpl: gh.fetchImpl },
      ),
    );
  /** A person's first push to the empty repository, on a branch of their own. */
  const pushOwn = (branch: string): string => {
    writeFileSync(path.join(origin.seed, "app.txt"), "theirs\n");
    gitOutSync(origin.seed, ["add", "-A"]);
    gitOutSync(origin.seed, ["commit", "-qm", "Their first commit"]);
    gitOutSync(origin.seed, ["push", "-q", origin.bare, `HEAD:refs/heads/${branch}`]);
    const sha = gitOutSync(origin.seed, ["rev-parse", "HEAD"]);
    control.own = { branch, sha };
    return sha;
  };
  return { store, gh, checkout, control, pushOwn, head: () => head };
}

describe("the operator's checkout of an empty repository (ruling 468)", () => {
  it("creates the first commit, moves the checkout onto it, and says so on the timeline and the audit", async () => {
    const { store, gh, checkout, head } = await emptyRepoTask();
    const view = await checkout();
    if (view.kind !== "checkout") throw new Error(`expected a checkout, got ${view.kind}`);

    // CANARY: drop `initialize()` after the clone and the checkout stays
    // unborn: no README, no commit, and the operator asks a person for one.
    expect(gh.callsTo(`PUT ${REPO_PATH}/contents/README.md`)).toHaveLength(1);
    expect(await gitOut(view.dir, ["rev-parse", "HEAD"])).toBe(head());
    expect(existsSync(path.join(view.dir, "README.md"))).toBe(true);

    const timeline = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
      .parsed.timeline;
    expect(timeline[0]).toMatchObject({ type: "github", actor: { kind: "system", systemId: "delivery" } });
    expect(timeline[0]!.text).toContain("before the operator's first checkout of it, so nobody has to push one");
    const audit = listAuditEvents(store.db, { action: "github.repo.bootstrapped" })[0];
    expect(audit).toMatchObject({ actorLabel: "system:delivery", taskKey: "VIB-1" });
    expect(audit?.details).toMatchObject({ repo: REPO, defaultBranch: "main", how: "initial_commit", sha: head() });

    // Idempotent: the next run's checkout has a commit and asks GitHub nothing.
    const before = gh.calls.length;
    await checkout();
    expect(gh.calls.length).toBe(before);
    expect(listAuditEvents(store.db, { action: "github.repo.bootstrapped" })).toHaveLength(1);
  });

  it("an unborn checkout that already exists (the live WEB-1 workspace) is initialized on the next run", async () => {
    const { checkout, control, head } = await emptyRepoTask();
    // The first clone lands while the first commit cannot be made: the
    // checkout is left unborn, as the live one was, and the run proceeds.
    control.refuse = true;
    const first = await checkout();
    if (first.kind !== "checkout") throw new Error(first.kind);
    expect(existsSync(path.join(first.dir, "README.md"))).toBe(false);
    expect(head()).toBeNull();

    // CANARY: drop `initialize()` from the existing-checkout arm and this
    // stays unborn for every later run.
    control.refuse = false;
    const again = await checkout();
    if (again.kind !== "checkout") throw new Error(again.kind);
    expect(await gitOut(again.dir, ["rev-parse", "HEAD"])).toBe(head());
    expect(existsSync(path.join(again.dir, "README.md"))).toBe(true);
  });

  it("ruling 670: a repository whose first push was a person's own branch is not given a `main`: the project takes that branch and every unborn checkout moves onto it", async () => {
    const { store, gh, checkout, control, pushOwn } = await emptyRepoTask();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "triage" }),
      goal: "Build the other half.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // Two tasks' first clones land on the empty repository while the first
    // commit cannot be made, so both checkouts are unborn. Then a person
    // pushes their code on `master`, and GitHub makes it the default branch.
    control.refuse = true;
    for (const key of ["VIB-1", "VIB-2"]) {
      const first = await checkout(key);
      if (first.kind !== "checkout") throw new Error(first.kind);
    }
    const refused = gh.callsTo(`PUT ${REPO_PATH}/contents/README.md`).length;
    const theirs = pushOwn("master");
    control.refuse = false;

    // CANARY: refresh onto the branch the checkout was made for and it stays
    // unborn, since `origin/main` does not exist; name that branch in the view
    // and the operator is told the default is `main` for one more run.
    const again = await checkout();
    if (again.kind !== "checkout") throw new Error(again.kind);
    expect(again.defaultBranch).toBe("master");
    expect(await gitOut(again.dir, ["rev-parse", "HEAD"])).toBe(theirs);
    expect(await gitOut(again.dir, ["symbolic-ref", "--short", "HEAD"])).toBe("master");
    // The second task's run finds the project already on `master`: its
    // bootstrap answers `exists`, and its checkout moves all the same.
    // CANARY: move only the checkout whose own run took the branch and this
    // one stays unborn on `main` for good.
    const other = await checkout("VIB-2");
    if (other.kind !== "checkout") throw new Error(other.kind);
    expect(await gitOut(other.dir, ["rev-parse", "HEAD"])).toBe(theirs);
    expect(listAuditEvents(store.db, { action: "project.default_branch.adopted" })).toHaveLength(1);
    // Nothing was written to their repository: the only Contents calls are
    // the refused first commits, made while it was empty.
    expect(gh.callsTo(`PUT ${REPO_PATH}/contents/README.md`)).toHaveLength(refused);
    expect(gh.callsTo(`POST ${REPO_PATH}/git/refs`)).toHaveLength(0);
    expect(gh.callsTo(`PATCH ${REPO_PATH}`)).toHaveLength(0);
    expect(
      readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter.defaultBranch,
    ).toBe("master");
    expect(listAuditEvents(store.db, { action: "project.default_branch.adopted" })[0]).toMatchObject({
      actorLabel: "system:delivery",
      taskKey: "VIB-1",
      details: { repo: REPO, from: "main", to: "master" },
    });
  });
});
