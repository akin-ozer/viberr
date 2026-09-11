import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { fakeGithubFetch , unreachableFetch } from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readTaskFile } from "~/server/files/task-writer.server";
import { findOpenScopeViolation } from "~/server/projections/policy-violations.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { createGithubClient } from "./github-client.server";
import {
  deriveSyncState,
  ensureTaskBranch, ensureTaskBranchBestEffort,
  getBranchCompare,
  taskBranchName,
  taskCommits,
} from "./branch-sync.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const REPO_PATH = "/repos/akin-ozer/viberr";
const ACTOR = { userId: "u_test", label: "arda@viberr.test" };

function setupWithCredential(taskKey = "VIB-201", branch: string | null = null) {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(taskKey, {
      title: "Attach execution workspace to task runtime",
      branch,
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_branchsync0001" },
    ACTOR,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);
  return store;
}

function compareRoute(ahead: { sha: string; message: string }[], behindBy = 0) {
  return {
    body: {
      ahead_by: ahead.length,
      behind_by: behindBy,
      status: behindBy > 0 ? "diverged" : ahead.length ? "ahead" : "identical",
      commits: ahead.map((c) => ({ sha: c.sha, commit: { message: c.message } })),
    },
  };
}

describe("taskBranchName", () => {
  it("is the lowercased task key — one task, one predictable branch (2026-07-17 ruling)", () => {
    expect(taskBranchName("VIB-142")).toBe("vib-142");
    expect(taskBranchName("VIB-7")).toBe("vib-7");
  });
});

describe("deriveSyncState (ruling 12: merged > behind > synced)", () => {
  it("maps the matrix", () => {
    expect(deriveSyncState({ prMerged: true, behindBy: 3 })).toBe("merged");
    expect(deriveSyncState({ prMerged: false, behindBy: 2 })).toBe("behind_main");
    expect(deriveSyncState({ prMerged: false, behindBy: 0 })).toBe("synced");
  });
});

describe("taskCommits ([VIB-n] prefix convention)", () => {
  it("keeps only task-key-prefixed commits (case-insensitive)", () => {
    const commits = [
      { sha: "a91f7c2", msg: "[VIB-142] add repo attach policy gate" },
      { sha: "4ce0b18", msg: "[vib-142] branch reconciler + task projection" },
      { sha: "12dd9af", msg: "chore: unrelated housekeeping" },
      { sha: "77aa001", msg: "[VIB-151] wrong task" },
    ];
    expect(taskCommits(commits, "VIB-142").map((c) => c.sha)).toEqual([
      "a91f7c2",
      "4ce0b18",
    ]);
  });
});

describe("getBranchCompare commit tolerance (F21-8)", () => {
  const REPO = "akin-ozer/viberr";

  /** A compare answer as these cases send it — GitHub's counters, plus the
   *  commit list whose entries each case drifts. */
  interface ComparePayload {
    ahead_by?: number;
    behind_by?: number;
    status?: string;
    commits?: unknown[];
  }

  function compareClient(body: ComparePayload) {
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/compare/main...vib-201`]: { body },
    });
    return createGithubClient({ token: "ghp_x", fetchImpl: gh.fetchImpl });
  }

  it("keeps the entries that decode and counts the ones that do not", async () => {
    // One entry without a sha names no commit. Voiding the array for it emptied
    // the WHOLE list while `ahead_by: 3` survived — a branch reading "3 commits
    // ahead" with nothing to show, and a delivery footprint reduced to nothing.
    const result = await getBranchCompare(
      compareClient({
        ahead_by: 3,
        behind_by: 0,
        status: "ahead",
        commits: [
          { sha: "a91f7c2ffff", commit: { message: "[VIB-201] first\n\nbody" } },
          { commit: { message: "[VIB-201] no sha" } },
          { sha: "4ce0b18ffff", commit: { message: "[VIB-201] third" } },
        ],
      }),
      REPO,
      "main",
      "vib-201",
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.compare.commits).toEqual([
      { sha: "a91f7c2", fullSha: "a91f7c2ffff", msg: "[VIB-201] first", parents: [] },
      { sha: "4ce0b18", fullSha: "4ce0b18ffff", msg: "[VIB-201] third", parents: [] },
    ]);
    expect(result.compare.droppedCommits).toBe(1);
    // The counters GitHub sent are untouched by the drop.
    expect(result.compare.aheadBy).toBe(3);
  });

  it("ruling 132: the reader carries the full sha and the parents, and `taskCommits` projects `{sha, msg}` only", async () => {
    // Canary: remove `parents` from the reader; leave the projection out of
    // `taskCommits` (the file would gain `fullSha` and `parents`).
    const result = await getBranchCompare(
      compareClient({
        ahead_by: 2,
        behind_by: 0,
        status: "ahead",
        commits: [
          { sha: "a91f7c2ffff", commit: { message: "[VIB-201] first" }, parents: [{ sha: "0000000aaaa" }] },
          { sha: "4ce0b18ffff", commit: { message: "[VIB-201] merge" }, parents: [{ sha: "a91f7c2ffff" }, { sha: "1111111bbbb" }] },
        ],
      }),
      REPO,
      "main",
      "vib-201",
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.compare.commits[1]).toEqual({
      sha: "4ce0b18",
      fullSha: "4ce0b18ffff",
      msg: "[VIB-201] merge",
      parents: ["a91f7c2ffff", "1111111bbbb"],
    });
    expect(taskCommits(result.compare.commits, "VIB-201")).toEqual([
      { sha: "a91f7c2", msg: "[VIB-201] first" },
      { sha: "4ce0b18", msg: "[VIB-201] merge" },
    ]);
  });

  it("a complete list reports nothing dropped", async () => {
    const result = await getBranchCompare(
      compareClient({
        ahead_by: 1,
        behind_by: 0,
        status: "ahead",
        commits: [{ sha: "a91f7c2ffff", commit: { message: "[VIB-201] only" } }],
      }),
      REPO,
      "main",
      "vib-201",
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.compare.commits).toHaveLength(1);
    expect(result.compare.droppedCommits).toBe(0);
  });
});

describe("ensureTaskBranch", () => {
  it("creates the branch from the default branch and writes it into task.md", async () => {
    const store = setupWithCredential();
    const branch = "vib-201";
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/${branch}`]: {
        status: 404,
        body: { message: "Not Found" },
      },
      [`GET ${REPO_PATH}/git/ref/heads/main`]: {
        body: { object: { sha: "basesha00" } },
      },
      // Ruling 122: the allocator asks whether any pull request ever used the
      // name before it takes it. Nothing has.
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/git/refs`]: {
        status: 201,
        body: { object: { sha: "basesha00" } },
      },
      [`GET ${REPO_PATH}/compare/main...${branch}`]: compareRoute([]),
    });
    const result = await ensureTaskBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toMatchObject({ status: "synced", branch, created: true });
    // Branch name persisted into the canonical file + reprojected.
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-201",
      dataRoot: store.dataRoot,
    });
    expect(file?.parsed.frontmatter.branch).toBe(branch);
    // SAFETY: the SELECT list is the single `task_projections.branch` column, and
    // the `result`/`file` assertions above already failed the test unless the
    // reprojected row for VIB-201 exists carrying that branch.
    const row = store.db
      .prepare(
        `SELECT branch FROM task_projections WHERE project_slug = ? AND task_key = 'VIB-201'`,
      )
      .get(store.slug) as { branch: string };
    expect(row.branch).toBe(branch);
    expect(gh.callsTo(`POST ${REPO_PATH}/git/refs`)[0]!.body).toEqual({
      ref: `refs/heads/${branch}`,
      sha: "basesha00",
    });
    const created = listAuditEvents(store.db, { action: "github.branch.created" });
    expect(created).toHaveLength(1);
    // U36-6: the canonical name records itself as such, and a name that was
    // free gets no allocation note — the note is for the suffixed case only.
    expect(created[0]!.details).toMatchObject({ canonical: branch, branch, suffixed: false });
    expect(file!.parsed.timeline.some((e) => e.text.includes("allocated:"))).toBe(false);
  });

  it("ruling 122: takes a suffixed name when a past pull request used the canonical one", async () => {
    const store = setupWithCredential("VIB-210");
    const gh = fakeGithubFetch({
      // No ref anywhere: the canonical name is free as a REF and still taken.
      [`GET ${REPO_PATH}/git/ref/heads/main`]: {
        body: { object: { sha: "basesha10" } },
      },
      [`GET ${REPO_PATH}/pulls`]: (call) =>
        call.url.searchParams.get("head") === "akin-ozer:vib-210"
          ? { body: [{ number: 265 }] }
          : { body: [] },
      [`POST ${REPO_PATH}/git/refs`]: {
        status: 201,
        body: { object: { sha: "basesha10" } },
      },
      [`GET ${REPO_PATH}/compare/main...vib-210`]: compareRoute([]),
    });
    const result = await ensureTaskBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-210" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result.status).toBe("synced");
    const allocated = result.status === "synced" ? result.branch : "";
    // The merged stranger PR on `vib-210` never blocks delivery again: the task
    // simply takes a name nobody has used.
    expect(allocated).not.toBe("vib-210");
    expect(allocated).toMatch(/^vib-210-[0-9a-f]{4}$/);
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-210",
      dataRoot: store.dataRoot,
    });
    expect(file?.parsed.frontmatter.branch).toBe(allocated);
    expect(gh.callsTo(`POST ${REPO_PATH}/git/refs`)[0]!.body).toEqual({
      ref: `refs/heads/${allocated}`,
      sha: "basesha10",
    });
    // U36-6 (pass 36): the suffix is DISCLOSED. Live, `hlc-10` was held by a
    // stranger's branch + PR, Viberr allocated `hlc-10-0c88`, and neither the
    // audit row (`{repo, from}`) nor the timeline named the taken name or the
    // suffixing — a person reading the page could not tell why the branch
    // was not the key. Canary: drop `canonical`/`suffixed` from the audit
    // details, or the `allocated.suffixed` note, and this fails.
    const audit = listAuditEvents(store.db, { action: "github.branch.created" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({
      canonical: "vib-210",
      branch: allocated,
      suffixed: true,
    });
    const note = file!.parsed.timeline.find((e) => e.text.includes("allocated:"));
    expect(note).toBeDefined();
    expect(note!.type).toBe("note");
    expect(note!.actor).toEqual({ kind: "system", systemId: "policy-engine" });
    expect(note!.text).toBe(
      `Branch \`${allocated}\` allocated: \`vib-210\` is already spoken for on GitHub (a ref or a past pull request), ruling 122.`,
    );
  });

  it("ruling 122: takes a suffixed name when the canonical ref already exists", async () => {
    const store = setupWithCredential("VIB-211");
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/vib-211`]: {
        body: { object: { sha: "strangersha" } },
      },
      [`GET ${REPO_PATH}/git/ref/heads/main`]: {
        body: { object: { sha: "basesha11" } },
      },
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/git/refs`]: {
        status: 201,
        body: { object: { sha: "basesha11" } },
      },
    });
    const result = await ensureTaskBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-211" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result.status).toBe("synced");
    const allocated = result.status === "synced" ? result.branch : "";
    expect(allocated).toMatch(/^vib-211-[0-9a-f]{4}$/);
  });

  it("ruling 122: a 403 listing pull requests opens a repo scope violation", async () => {
    const store = setupWithCredential("VIB-212");
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const result = await ensureTaskBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-212" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toMatchObject({ status: "scope_violation", scope: "repo" });
    expect(
      findOpenScopeViolation(store.db, store.slug, "repo", "VIB-212"),
    ).not.toBeNull();
  });

  it("is idempotent: an existing branch is success without a create call", async () => {
    const store = setupWithCredential("VIB-202", "vib-202-existing");
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/vib-202-existing`]: {
        body: { object: { sha: "headsha" } },
      },
      [`GET ${REPO_PATH}/compare/main...vib-202-existing`]: compareRoute(
        [{ sha: "a91f7c2aaaa", message: "[VIB-202] work" }],
        2,
      ),
    });
    const result = await ensureTaskBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-202" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toMatchObject({ status: "synced", created: false });
    if (result.status === "synced") {
      expect(result.compare).toMatchObject({ aheadBy: 1, behindBy: 2 });
      expect(result.compare?.commits[0]).toMatchObject({
        sha: "a91f7c2",
        msg: "[VIB-202] work",
      });
    }
    expect(gh.callsTo(`POST ${REPO_PATH}/git/refs`)).toHaveLength(0);
    expect(listAuditEvents(store.db, { action: "github.branch.created" })).toHaveLength(0);
  });

  it("treats a 422 'Reference already exists' race as success", async () => {
    const store = setupWithCredential("VIB-203", "vib-203-race");
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/vib-203-race`]: {
        status: 404,
        body: { message: "Not Found" },
      },
      [`GET ${REPO_PATH}/git/ref/heads/main`]: {
        body: { object: { sha: "basesha00" } },
      },
      [`POST ${REPO_PATH}/git/refs`]: {
        status: 422,
        body: { message: "Reference already exists" },
      },
      [`GET ${REPO_PATH}/compare/main...vib-203-race`]: compareRoute([]),
    });
    const result = await ensureTaskBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-203" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toMatchObject({ status: "synced", created: false });
  });

  it("403 creating the ref opens a `repo` scope violation carried by the task", async () => {
    const store = setupWithCredential("VIB-204", "vib-204-forbidden");
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/vib-204-forbidden`]: {
        status: 404,
        body: { message: "Not Found" },
      },
      [`GET ${REPO_PATH}/git/ref/heads/main`]: {
        body: { object: { sha: "basesha00" } },
      },
      [`POST ${REPO_PATH}/git/refs`]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const result = await ensureTaskBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-204" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result.status).toBe("scope_violation");
    const violation = findOpenScopeViolation(store.db, store.slug, "repo", "VIB-204");
    expect(violation).not.toBeNull();
    // Typed policy event written into the task file.
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-204",
      dataRoot: store.dataRoot,
    });
    expect(file?.parsed.timeline[0]).toMatchObject({
      type: "policy",
      text: expect.stringContaining("**Policy violation:** active PAT is missing `repo`."),
    });
  });

  it("degrades typed without a PAT / repo / default branch", async () => {
    // No PAT bound.
    const bare = setupTestStore(ctx);
    writeTask(bare.dataRoot, bare.slug, {
      frontmatter: baseTaskFrontmatter("VIB-205"),
    });
    rebuildAll(bare.db, { dataRoot: bare.dataRoot });
    expect(
      await ensureTaskBranch(
        bare.db,
        { projectSlug: bare.slug, taskKey: "VIB-205" },
        ACTOR,
        { dataRoot: bare.dataRoot, fetchImpl: fakeGithubFetch({}).fetchImpl },
      ),
    ).toEqual({ status: "no_pat_configured", repo: "akin-ozer/viberr" });

    // Ruling 128: the default branch missing on the remote is BOOTSTRAPPED,
    // then the task branch is cut from it. (This case used to assert a typed
    // `default_branch_missing` that no caller consumed.) The base cannot be
    // created at all → `bootstrap_failed`.
    const store = setupWithCredential("VIB-206", "vib-206-x");
    const failing = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/vib-206-x`]: { status: 404, body: { message: "Not Found" } },
      [`GET ${REPO_PATH}/git/ref/heads/main`]: { status: 404, body: { message: "Not Found" } },
      [`GET ${REPO_PATH}/branches`]: { body: [] },
      [`PUT ${REPO_PATH}/contents/README.md`]: { status: 500, body: { message: "boom" } },
    });
    expect(
      await ensureTaskBranch(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-206" },
        ACTOR,
        { dataRoot: store.dataRoot, fetchImpl: failing.fetchImpl },
      ),
    ).toMatchObject({ status: "bootstrap_failed", defaultBranch: "main" });

    // Unknown task.
    expect(
      await ensureTaskBranch(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-999" },
        ACTOR,
        { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch({}).fetchImpl },
      ),
    ).toEqual({ status: "task_not_found" });
  });
});

/**
 * Ruling 128 (pass 34, F34-4): on an EMPTY repository `ensureTaskBranch`
 * bootstraps `main` (an initial commit through the Contents API) and then cuts
 * the task branch from it, recording the bootstrap on the timeline and in the
 * audit log. Canary: restore the old 404 arm (return `bootstrap_failed`
 * without calling `ensureDefaultBranch`) and the PUT never runs.
 */
describe("ruling 128: ensureTaskBranch bootstraps an empty repository", () => {
  it("creates `main` with an initial commit, then the task branch from it", async () => {
    const store = setupWithCredential("VIB-207", "vib-207");
    const ROOT = "d2e0fb0".padEnd(40, "0");
    let bootstrapped = false;
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/vib-207`]: { status: 404, body: { message: "Not Found" } },
      [`GET ${REPO_PATH}/git/ref/heads/main`]: () =>
        bootstrapped
          ? { body: { object: { sha: ROOT } } }
          : { status: 409, body: { message: "Git Repository is empty." } },
      [`GET ${REPO_PATH}/branches`]: { body: [] },
      [`PUT ${REPO_PATH}/contents/README.md`]: () => {
        bootstrapped = true;
        return { status: 201, body: { commit: { sha: ROOT } } };
      },
      [`POST ${REPO_PATH}/git/refs`]: { status: 201, body: { ref: "refs/heads/vib-207" } },
      [`GET ${REPO_PATH}/compare/main...vib-207`]: compareRoute([]),
    });
    const result = await ensureTaskBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-207" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toMatchObject({ status: "synced", branch: "vib-207", created: true });
    expect(gh.callsTo(`PUT ${REPO_PATH}/contents/README.md`)).toHaveLength(1);
    expect(gh.callsTo(`POST ${REPO_PATH}/git/refs`)[0]!.body).toEqual({ ref: "refs/heads/vib-207", sha: ROOT });
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-207", dataRoot: store.dataRoot })!;
    expect(file.parsed.timeline.some((e) => e.type === "github" && e.text.includes("Bootstrapped the repository"))).toBe(true);
    expect(listAuditEvents(store.db).some((e) => e.action === "github.repo.bootstrapped")).toBe(true);
  });
});

describe("ref paths (B11)", () => {
  it("addresses `heads/<branch>` with the separator intact", async () => {
    // The fixtures above used to register `git/ref/heads%2F<branch>`, because
    // the code sent `encodeURIComponent("heads/" + branch)`. GitHub does not
    // resolve that ref, so the existence probe could never succeed and every
    // call fell through to the create path — where a 422 reads as idempotent
    // success, which is why nothing ever looked broken. The separator has to
    // stay literal; only the segments are escaped.
    const store = setupWithCredential("VIB-900", "vib-900");
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/git/ref/heads/vib-900`]: {
        body: { ref: "refs/heads/vib-900", object: { sha: "a".repeat(40) } },
      },
    });
    const result = await ensureTaskBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-900" },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result.status).toBe("synced"); // the ref already existed
    // The probe HIT, so no create was attempted — the observable proof that the
    // ref resolved rather than 404ing into the idempotent create path.
    expect(gh.callsTo(`GET ${REPO_PATH}/git/ref/heads/vib-900`)).toHaveLength(1);
    expect(gh.callsTo(`POST ${REPO_PATH}/git/refs`)).toHaveLength(0);
  });
});

/** A 2xx whose headers throw on read: the one shape that still reaches
 *  `ensureTaskBranch` as a THROW (`rateLimitFrom(response.headers)` sits
 *  outside both try blocks), so the hook's own catch is exercised. */
function unreadableResponse(): Response {
  const response = new Response("{}", { status: 200 });
  Object.defineProperty(response, "headers", {
    get(): never {
      throw new TypeError("terminated");
    },
  });
  return response;
}

/**
 * F34-3 (pass 34): the pre-dispatch branch hook returns its typed result and
 * discloses the failures a person can act on, once, on the timeline and in the
 * audit log. Canaries: restore the void `try { … } catch {}` body; keep the
 * catch but drop the disclosure; disclose every non-synced status (the
 * no-credential case writes a line); remove the dedupe (a repeat writes twice).
 */
describe("F34-3: ensureTaskBranchBestEffort discloses prepare failures", () => {
  const prepare = (store: ReturnType<typeof setupWithCredential>, fetchImpl: typeof fetch, taskKey = "VIB-201") =>
    ensureTaskBranchBestEffort(
      store.db,
      { projectSlug: store.slug, taskKey },
      ACTOR,
      { dataRoot: store.dataRoot, fetchImpl },
    );
  const events = (store: ReturnType<typeof setupWithCredential>, taskKey = "VIB-201") =>
    readTaskFile({ projectSlug: store.slug, taskKey, dataRoot: store.dataRoot })!.parsed.timeline.filter((e) => e.type === "github");

  it("a network failure is disclosed on the timeline and audited, with the typed result returned", async () => {
    const store = setupWithCredential();
    const result = await prepare(store, unreachableFetch());
    expect(result.status).toBe("network_unavailable");
    const lines = events(store);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain("No task branch could be allocated on GitHub before dispatch: GitHub was unreachable");
    expect(lines[0]!.actor).toEqual({ kind: "system", systemId: "delivery" });
    const audit = listAuditEvents(store.db, { action: "github.branch.prepare_failed" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ status: "network_unavailable", branch: null });
  });

  it("a THROWN error is disclosed too, and a recorded branch changes the sentence", async () => {
    const store = setupWithCredential("VIB-201", "vib-201-x");
    const exploding: typeof fetch = async () => unreadableResponse();
    const result = await prepare(store, exploding);
    expect(result.status).toBe("threw");
    const lines = events(store);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain("Branch `vib-201-x` could not be confirmed on GitHub before dispatch: the branch preparation failed unexpectedly");
    expect(listAuditEvents(store.db, { action: "github.branch.prepare_failed" })[0]!.details).toMatchObject({ status: "threw", branch: "vib-201-x" });
  });

  it("a project with no credential writes nothing: a standing state is not a failure line", async () => {
    const bare = setupTestStore(ctx);
    writeTask(bare.dataRoot, bare.slug, { frontmatter: baseTaskFrontmatter("VIB-205") });
    rebuildAll(bare.db, { dataRoot: bare.dataRoot });
    const result = await ensureTaskBranchBestEffort(
      bare.db,
      { projectSlug: bare.slug, taskKey: "VIB-205" },
      ACTOR,
      { dataRoot: bare.dataRoot, fetchImpl: fakeGithubFetch({}).fetchImpl },
    );
    expect(result.status).toBe("no_pat_configured");
    expect(readTaskFile({ projectSlug: bare.slug, taskKey: "VIB-205", dataRoot: bare.dataRoot })!.parsed.timeline).toEqual([]);
    expect(listAuditEvents(bare.db, { action: "github.branch.prepare_failed" })).toHaveLength(0);
  });

  it("a REPEAT of the same failure writes one line and one audit row, not three", async () => {
    const store = setupWithCredential();
    await prepare(store, unreachableFetch());
    await prepare(store, unreachableFetch());
    await prepare(store, unreachableFetch());
    expect(events(store)).toHaveLength(1);
    expect(listAuditEvents(store.db, { action: "github.branch.prepare_failed" })).toHaveLength(1);
    // A DIFFERENT status is a new fact and lands.
    const exploding: typeof fetch = async () => unreadableResponse();
    await prepare(store, exploding);
    expect(events(store)).toHaveLength(2);
  });
});
