import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import {
  fakeGithubFetch,
  type FakeResponder,
} from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  readTaskFile,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { updateProjectFile } from "~/server/files/project-writer.server";
import {
  countOpenPolicyViolations,
  findOpenScopeViolation,
} from "~/server/projections/policy-violations.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  createPat,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";
import {
  configureMergeFaultHooksForTests,
  mergeTaskPr,
  recoverGithubMergeIntents,
  reconcileProject,
  reconcileTask,
} from "./github-reconciler.server";
import { reviewEvidenceFingerprint } from "~/server/tasks/review-evidence.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(() => {
  configureMergeFaultHooksForTests(null);
  ctx.cleanup();
});

const REPO_PATH = "/repos/akin-ozer/viberr";
const REVIEWED_HEAD = "1".repeat(40);
const REPLACEMENT_HEAD = "2".repeat(40);
const OLDER_HEAD = "3".repeat(40);
const BASE = { ref: "main", repo: { full_name: "akin-ozer/viberr" } };

function livePull(
  headSha = REVIEWED_HEAD,
  overrides: Record<string, unknown> = {},
) {
  return {
    state: "open",
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    head: { sha: headSha },
    base: BASE,
    ...overrides,
  };
}

function setup(): {
  store: TestStore;
  actor: { userId: string; label: string };
} {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-301", {
      title: "Attach execution workspace",
      stage: "review",
      branch: "vib-301-workspace",
      ownerUserId: store.users.arda.id,
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_reconciler01" },
    actor,
  );
  setProjectCredential(
    store.db,
    { projectSlug: store.slug, patId: pat.id },
    actor,
  );
  return { store, actor };
}

function happyRoutes(): Record<string, FakeResponder> {
  return {
    [`GET ${REPO_PATH}/compare/main...vib-301-workspace`]: {
      body: {
        ahead_by: 3,
        behind_by: 0,
        status: "ahead",
        commits: [
          {
            sha: "a91f7c2ffff",
            commit: { message: "[VIB-301] add repo attach policy gate" },
          },
          {
            sha: "4ce0b18ffff",
            commit: { message: "[VIB-301] branch reconciler\n\nbody" },
          },
          { sha: "0000000ffff", commit: { message: "chore: unrelated" } },
        ],
      },
    },
    [`GET ${REPO_PATH}/pulls`]: {
      body: [
        {
          number: 318,
          title: "Attach execution workspace",
          state: "open",
          draft: false,
          merged_at: null,
          head: { sha: REVIEWED_HEAD },
          base: BASE,
        },
      ],
    },
    [`GET ${REPO_PATH}/pulls/318`]: {
      body: {
        number: 318,
        title: "Attach execution workspace",
        state: "open",
        merged: false,
        merged_at: null,
        head: { sha: REVIEWED_HEAD },
        base: BASE,
        additions: 412,
        deletions: 87,
        changed_files: 9,
      },
    },
    [`GET ${REPO_PATH}/commits/${REVIEWED_HEAD}/check-runs`]: {
      body: {
        total_count: 2,
        check_runs: [
          { status: "completed", conclusion: "success" },
          { status: "completed", conclusion: "success" },
        ],
      },
    },
  };
}

describe("reconcileTask", () => {
  it("happy path: writes the pr/github frontmatter cache, reprojects, records provenance", async () => {
    const { store, actor } = setup();
    const gh = fakeGithubFetch(happyRoutes());
    const result = await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toMatchObject({
      status: "reconciled",
      taskKey: "VIB-301",
      branch: "vib-301-workspace",
      changed: true,
      sync: "synced",
      compare: { aheadBy: 3, behindBy: 0 },
      commits: 2,
    });

    // task.md is the canonical cache (frontmatter writers, files stay truth).
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    });
    const fm = file!.parsed.frontmatter;
    expect(fm.pr).toMatchObject({
      number: 318,
      state: "review",
      title: "Attach execution workspace",
      checks: { total: 2, passing: 2, failing: 0, pending: 0 },
    });
    expect(fm.github?.commits).toEqual([
      { sha: "a91f7c2", msg: "[VIB-301] add repo attach policy gate" },
      { sha: "4ce0b18", msg: "[VIB-301] branch reconciler" },
    ]);
    expect(fm.github?.changed).toEqual({ files: 9, add: 412, del: 87 });

    // Reprojected into SQLite.
    const row = store.db
      .prepare(
        `SELECT pr_json, github_json FROM task_projections
         WHERE project_slug = ? AND task_key = 'VIB-301'`,
      )
      .get(store.slug) as { pr_json: string; github_json: string };
    expect(JSON.parse(row.pr_json)).toMatchObject({
      number: 318,
      state: "review",
    });
    expect(JSON.parse(row.github_json).commits).toHaveLength(2);

    // Provenance + audit recorded.
    const prov = store.db
      .prepare(
        `SELECT action, details_json FROM provenance WHERE action = 'github.reconcile'`,
      )
      .all() as { action: string; details_json: string }[];
    expect(prov).toHaveLength(1);
    expect(JSON.parse(prov[0]!.details_json)).toMatchObject({
      branch: "vib-301-workspace",
      changed: true,
      prNumber: 318,
    });
    expect(
      listAuditEvents(store.db, { action: "github.reconcile.task" }),
    ).toHaveLength(1);
  });

  it("is idempotent: identical GitHub facts → no file write (changed: false)", async () => {
    const { store, actor } = setup();
    const run = () =>
      reconcileTask(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-301" },
        actor,
        {
          dataRoot: store.dataRoot,
          fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl,
        },
      );
    await run();
    const before = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.content;
    const second = await run();
    expect(second).toMatchObject({ status: "reconciled", changed: false });
    const after = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.content;
    expect(after).toBe(before); // byte-stable, no updatedAt churn
  });

  it("invalidates approval when live PR head evidence changes", async () => {
    const { store, actor } = setup();
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-301",
        dataRoot: store.dataRoot,
      },
      (parsed) => {
        parsed.frontmatter.pr = {
          number: 318,
          state: "review",
          title: "Attach execution workspace",
          headSha: OLDER_HEAD,
          baseRepo: "akin-ozer/viberr",
          baseRef: "main",
        };
        parsed.frontmatter.reviewers = [
          { profileId: "reviewer", backend: "claude", role: "Reviewer" },
        ];
        parsed.frontmatter.validation = "healthy";
        parsed.frontmatter.reviewerVerdicts = [
          {
            profileId: "reviewer",
            verdict: "approve",
            summary: "Approved reviewed-head.",
            runId: "run-reviewed-head",
            reviewedAt: "2026-07-13T00:00:00.000Z",
            evidenceFingerprint: reviewEvidenceFingerprint(
              parsed,
              "akin-ozer/viberr",
            ),
          },
        ];
      },
    );

    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      {
        dataRoot: store.dataRoot,
        fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl,
      },
    );

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr?.headSha).toBe(REVIEWED_HEAD);
    expect(fm.reviewerVerdicts).toEqual([]);
    expect(fm.validation).toBe("changed");
  });

  it("preserves approval when mutable commit cache changes under the same verified head", async () => {
    const { store, actor } = setup();
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-301",
        dataRoot: store.dataRoot,
      },
      (parsed) => {
        parsed.frontmatter.pr = {
          number: 318,
          state: "review",
          title: "Attach execution workspace",
          headSha: REVIEWED_HEAD,
          baseRepo: "akin-ozer/viberr",
          baseRef: "main",
        };
        parsed.frontmatter.github = {
          commits: [
            { sha: "fffffff", msg: "unrelated cache entry" },
            { sha: "a91f7c2", msg: "[VIB-301] old cache order" },
          ],
          changed: null,
        };
        parsed.frontmatter.reviewers = [
          { profileId: "reviewer", backend: "claude", role: "Reviewer" },
        ];
        parsed.frontmatter.validation = "healthy";
        parsed.frontmatter.reviewerVerdicts = [
          {
            profileId: "reviewer",
            verdict: "approve",
            summary: "Approved the verified head.",
            runId: "run-reviewed-head",
            reviewedAt: "2026-07-13T00:00:00.000Z",
            evidenceFingerprint: reviewEvidenceFingerprint(
              parsed,
              "akin-ozer/viberr",
            ),
          },
        ];
      },
    );

    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      {
        dataRoot: store.dataRoot,
        fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl,
      },
    );

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr?.headSha).toBe(REVIEWED_HEAD);
    expect(fm.github?.commits).toEqual([
      { sha: "a91f7c2", msg: "[VIB-301] add repo attach policy gate" },
      { sha: "4ce0b18", msg: "[VIB-301] branch reconciler" },
    ]);
    expect(fm.reviewerVerdicts).toHaveLength(1);
    expect(fm.validation).toBe("healthy");
  });

  it("preserves the last verified head and approval when a degraded PR read omits head", async () => {
    const { store, actor } = setup();
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-301",
        dataRoot: store.dataRoot,
      },
      (parsed) => {
        parsed.frontmatter.pr = {
          number: 318,
          state: "review",
          title: "Attach execution workspace",
          headSha: REVIEWED_HEAD,
          baseRepo: "akin-ozer/viberr",
          baseRef: "main",
        };
        parsed.frontmatter.reviewers = [
          { profileId: "reviewer", backend: "claude", role: "Reviewer" },
        ];
        parsed.frontmatter.validation = "healthy";
        parsed.frontmatter.reviewerVerdicts = [
          {
            profileId: "reviewer",
            verdict: "approve",
            summary: "Approved the verified head.",
            runId: "run-reviewed-head",
            reviewedAt: "2026-07-13T00:00:00.000Z",
            evidenceFingerprint: reviewEvidenceFingerprint(
              parsed,
              "akin-ozer/viberr",
            ),
          },
        ];
      },
    );
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/pulls`] = {
      body: [
        {
          number: 318,
          title: "Attach execution workspace",
          state: "open",
          draft: false,
          merged_at: null,
          base: BASE,
        },
      ],
    };
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: {
        number: 318,
        title: "Attach execution workspace",
        state: "open",
        merged: false,
        merged_at: null,
        base: BASE,
        additions: 412,
        deletions: 87,
        changed_files: 9,
      },
    };

    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      {
        dataRoot: store.dataRoot,
        fetchImpl: fakeGithubFetch(routes).fetchImpl,
      },
    );

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr?.headSha).toBe(REVIEWED_HEAD);
    expect(fm.reviewerVerdicts).toHaveLength(1);
    expect(fm.validation).toBe("healthy");
  });

  it("merged PR → sync 'merged' beats behind (ruling 12 precedence)", async () => {
    const { store, actor } = setup();
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/compare/main...vib-301-workspace`] = {
      body: { ahead_by: 0, behind_by: 4, status: "behind", commits: [] },
    };
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: {
        number: 318,
        title: "Attach execution workspace",
        state: "closed",
        merged: true,
        merged_at: "2026-07-05T09:00:00Z",
        head: { sha: REVIEWED_HEAD },
        base: BASE,
        additions: 412,
        deletions: 87,
        changed_files: 9,
      },
    };
    const result = await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      {
        dataRoot: store.dataRoot,
        fetchImpl: fakeGithubFetch(routes).fetchImpl,
      },
    );
    expect(result).toMatchObject({ status: "reconciled", sync: "merged" });
  });

  it("preserves a human-set 'accepted' (merge-pending) state while the PR is still open", async () => {
    // D3/S2: a task accepted "merge pending" must NOT be downgraded to "review"
    // by a reconcile, or the "Complete merge" affordance silently disappears.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "done",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr: {
          number: 318,
          state: "accepted",
          title: "Attach execution workspace",
          headSha: REVIEWED_HEAD,
          baseRepo: "akin-ozer/viberr",
          baseRef: "main",
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_reconciler02" },
      actor,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      actor,
    );
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      {
        dataRoot: store.dataRoot,
        fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl,
      },
    );
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr?.state).toBe("accepted"); // still open on GitHub → stays accepted
  });

  it("advances 'accepted' → 'merged' once GitHub reports the PR merged", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "done",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr: {
          number: 318,
          state: "accepted",
          title: "Attach execution workspace",
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_reconciler02" },
      actor,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      actor,
    );
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: {
        number: 318,
        title: "Attach execution workspace",
        state: "closed",
        merged: true,
        merged_at: "2026-07-05T09:00:00Z",
        head: { sha: REVIEWED_HEAD },
        base: BASE,
        additions: 412,
        deletions: 87,
        changed_files: 9,
      },
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      {
        dataRoot: store.dataRoot,
        fetchImpl: fakeGithubFetch(routes).fetchImpl,
      },
    );
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr?.state).toBe("merged"); // real terminal state overrides "accepted"
  });

  it("keeps the workspace-captured commit cache when branch commits lack the [KEY] prefix (B2)", async () => {
    // A real agent committed WITHOUT the `[VIB-301]` prefix; the workspace
    // reconcile cached those commits. The server reconcile's prefix filter
    // finds nothing — it must keep the honest cache, not zero it.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "review",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        github: {
          commits: [
            { sha: "a91f7c2", msg: "VIB-301: add repo attach policy gate" },
            { sha: "4ce0b18", msg: "wire the branch reconciler" },
          ],
          changed: null,
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_reconciler03" },
      actor,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      actor,
    );

    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/compare/main...vib-301-workspace`] = {
      body: {
        ahead_by: 2,
        behind_by: 0,
        status: "ahead",
        commits: [
          // Same real work — but no `[VIB-301]` bracket prefix anywhere.
          {
            sha: "a91f7c2ffff",
            commit: { message: "VIB-301: add repo attach policy gate" },
          },
          {
            sha: "4ce0b18ffff",
            commit: { message: "wire the branch reconciler" },
          },
        ],
      },
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      {
        dataRoot: store.dataRoot,
        fetchImpl: fakeGithubFetch(routes).fetchImpl,
      },
    );
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.github?.commits).toEqual([
      { sha: "a91f7c2", msg: "VIB-301: add repo attach policy gate" },
      { sha: "4ce0b18", msg: "wire the branch reconciler" },
    ]);
  });

  it("accepted PR closed on GitHub without merging → downgrade + typed policy event explaining why (B9)", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "done",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr: {
          number: 318,
          state: "accepted",
          title: "Attach execution workspace",
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_reconciler04" },
      actor,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      actor,
    );

    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: {
        number: 318,
        title: "Attach execution workspace",
        state: "closed",
        merged: false,
        merged_at: null,
        head: { sha: REVIEWED_HEAD },
        base: BASE,
        additions: 412,
        deletions: 87,
        changed_files: 9,
      },
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      {
        dataRoot: store.dataRoot,
        fetchImpl: fakeGithubFetch(routes).fetchImpl,
      },
    );
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.frontmatter.pr?.state).toBe("closed");
    const policy = file.parsed.timeline.find((e) => e.type === "policy");
    expect(policy?.text).toContain(
      "accepted PR #318 was closed on GitHub without merging",
    );
  });

  it("degrades typed: no branch, no PAT, network down; 403 opens a repo violation", async () => {
    const { store, actor } = setup();
    // Task without a branch.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-302"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(
      await reconcileTask(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-302" },
        actor,
        { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch({}).fetchImpl },
      ),
    ).toEqual({ status: "no_branch", taskKey: "VIB-302" });

    // 403 on compare → scope violation carried by the task.
    const forbidden = await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      {
        dataRoot: store.dataRoot,
        fetchImpl: fakeGithubFetch({
          [`GET ${REPO_PATH}/compare/main...vib-301-workspace`]: {
            status: 403,
            body: {
              message: "Resource not accessible by personal access token",
            },
          },
        }).fetchImpl,
      },
    );
    expect(forbidden.status).toBe("scope_violation");
    expect(
      findOpenScopeViolation(store.db, store.slug, "repo", "VIB-301"),
    ).not.toBeNull();
  });
});

describe("reconcileProject", () => {
  it("walks every task with a branch and summarizes", async () => {
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-303", {
        branch: "vib-303-second",
      }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-304"), // branchless — skipped
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const routes = {
      ...happyRoutes(),
      [`GET ${REPO_PATH}/compare/main...vib-303-second`]: {
        body: { ahead_by: 0, behind_by: 0, status: "identical", commits: [] },
      },
    };
    const summary = await reconcileProject(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: fakeGithubFetch(routes).fetchImpl,
    });
    expect(summary.status).toBe("ok");
    expect(summary.reconciled).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.results.map((r) => r.status)).toEqual([
      "reconciled",
      "reconciled",
    ]);
    expect(
      listAuditEvents(store.db, { action: "github.reconcile.project" }),
    ).toHaveLength(1);

    // No PAT → typed short-circuit without network.
    const bare = setupTestStore(ctx);
    rebuildAll(bare.db, { dataRoot: bare.dataRoot });
    const degraded = await reconcileProject(bare.db, bare.slug, actor, {
      dataRoot: bare.dataRoot,
      fetchImpl: fakeGithubFetch({}).fetchImpl,
    });
    expect(degraded.status).toBe("no_pat_configured");
  });
});

describe("mergeTaskPr (the real merge behind accept_completion)", () => {
  function setupWithPr(): ReturnType<typeof setup> {
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-142", {
        title: "Attach execution workspace to task runtime",
        stage: "review",
        branch: "vib-142-attach-workspace",
        ownerUserId: store.users.arda.id,
        pr: {
          number: 318,
          state: "review",
          title: "Attach execution workspace",
          headSha: REVIEWED_HEAD,
          baseRepo: "akin-ozer/viberr",
          baseRef: "main",
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    return { store, actor };
  }

  function stageMergeIntent(
    store: TestStore,
    actor: { userId: string; label: string },
    id = "merge_intent_test",
  ): void {
    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!;
    store.db
      .prepare(
        `INSERT INTO github_merge_intents
           (id, project_slug, task_key, task_incarnation, repo,
            default_branch, pr_number, head_sha, actor_user_id, actor_label,
            authority_source, created_at)
         VALUES (?, ?, 'VIB-142', ?, 'akin-ozer/viberr', 'main', 318, ?, ?, ?,
                 'task_owner', '2026-07-13T09:00:00.000Z')`,
      )
      .run(
        id,
        store.slug,
        task.parsed.frontmatter.createdAt,
        REVIEWED_HEAD,
        actor.userId,
        actor.label,
      );
  }

  it("defers a cached merged intent without live credentials or fabricated merge facts", async () => {
    const { store, actor } = setupWithPr();
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-142",
        dataRoot: store.dataRoot,
      },
      (task) => {
        task.frontmatter.pr = { ...task.frontmatter.pr!, state: "merged" };
      },
    );
    stageMergeIntent(store, actor);
    store.db
      .prepare(`DELETE FROM project_github_credentials WHERE project_slug = ?`)
      .run(store.slug);

    await expect(
      recoverGithubMergeIntents(store.db, { dataRoot: store.dataRoot }),
    ).resolves.toEqual({
      completed: 0,
      cancelled: 0,
      deferred: 1,
      errors: 0,
    });
    expect(
      (
        store.db
          .prepare(`SELECT count(*) AS n FROM github_merge_intents`)
          .get() as { n: number }
      ).n,
    ).toBe(1);
    expect(
      listAuditEvents(store.db, { action: "github.pr.merged" }),
    ).toHaveLength(0);
    expect(
      store.db
        .prepare(`SELECT 1 FROM provenance WHERE action = 'github.merge'`)
        .all(),
    ).toHaveLength(0);
  });

  it("retains an archived project's merge intent without GitHub reads or canonical mutation", async () => {
    const { store, actor } = setupWithPr();
    stageMergeIntent(store, actor);
    await updateProjectFile(
      { projectSlug: store.slug, dataRoot: store.dataRoot },
      (project) => {
        project.frontmatter.archived = true;
      },
    );
    let githubCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      githubCalls += 1;
      throw new Error("archived recovery must not contact GitHub");
    };

    await expect(
      recoverGithubMergeIntents(store.db, {
        dataRoot: store.dataRoot,
        fetchImpl,
      }),
    ).resolves.toEqual({
      completed: 0,
      cancelled: 0,
      deferred: 1,
      errors: 0,
    });
    expect(githubCalls).toBe(0);
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-142",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.pr,
    ).toMatchObject({ state: "review" });
    expect(
      (
        store.db
          .prepare(`SELECT count(*) AS n FROM github_merge_intents`)
          .get() as { n: number }
      ).n,
    ).toBe(1);
    expect(
      listAuditEvents(store.db, { action: "github.pr.merged" }),
    ).toHaveLength(0);
  });

  it("recovers an exact remote merge as a detached immutable fact without corrupting a replacement target", async () => {
    const { store, actor } = setupWithPr();
    stageMergeIntent(store, actor);
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-142",
        dataRoot: store.dataRoot,
      },
      (task) => {
        task.frontmatter.repo = "other-owner/other-repo";
        task.frontmatter.pr = {
          number: 400,
          state: "review",
          title: "Replacement delivery",
          headSha: REPLACEMENT_HEAD,
          baseRepo: "other-owner/other-repo",
          baseRef: "main",
        };
      },
    );
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/318`]: {
        body: livePull(REVIEWED_HEAD, {
          state: "closed",
          merged: true,
          merged_at: "2026-07-13T09:01:00.000Z",
          merge_commit_sha: "detached-merge-sha",
        }),
      },
    });

    await expect(
      recoverGithubMergeIntents(store.db, {
        dataRoot: store.dataRoot,
        fetchImpl: gh.fetchImpl,
      }),
    ).resolves.toEqual({
      completed: 1,
      cancelled: 0,
      deferred: 0,
      errors: 0,
    });
    const current = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(current.repo).toBe("other-owner/other-repo");
    expect(current.pr).toMatchObject({ number: 400, state: "review" });
    expect(
      listAuditEvents(store.db, { action: "github.pr.merged" })[0]!.details,
    ).toMatchObject({
      repo: "akin-ozer/viberr",
      prNumber: 318,
      canonicalApplied: false,
      authoritySource: "task_owner",
    });
    expect(
      (
        store.db
          .prepare(`SELECT count(*) AS n FROM github_merge_intents`)
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it("clears a newly staged intent when exact authority is revoked before PUT", async () => {
    const { store, actor } = setupWithPr();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/318`]: { body: livePull() },
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        body: { merged: true, sha: "must-not-run" },
      },
    });
    let checks = 0;
    await expect(
      mergeTaskPr(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-142",
          expectedHeadSha: REVIEWED_HEAD,
        },
        actor,
        {
          dataRoot: store.dataRoot,
          fetchImpl: gh.fetchImpl,
          assertAuthorized: () => {
            checks += 1;
            if (checks === 2) {
              throw new DOMException("authority revoked", "AbortError");
            }
            return "task_owner";
          },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(gh.callsTo(`PUT ${REPO_PATH}/pulls/318/merge`)).toHaveLength(0);
    expect(
      (
        store.db
          .prepare(`SELECT count(*) AS n FROM github_merge_intents`)
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it("rejects a same-head PR retargeted to a different base before PUT", async () => {
    const { store, actor } = setupWithPr();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/318`]: {
        body: livePull(REVIEWED_HEAD, {
          base: { ref: "release", repo: { full_name: "akin-ozer/viberr" } },
        }),
      },
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        body: { merged: true, sha: "must-not-run" },
      },
    });
    await expect(
      mergeTaskPr(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-142",
          expectedHeadSha: REVIEWED_HEAD,
        },
        actor,
        { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
      ),
    ).resolves.toMatchObject({ status: "head_changed", prNumber: 318 });
    expect(gh.callsTo(`PUT ${REPO_PATH}/pulls/318/merge`)).toHaveLength(0);
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-142",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.pr,
    ).toMatchObject({ baseRef: "release", state: "review" });
  });

  it("merges, flips the cache, writes the github event, resolves the task's pull_request:write violation", async () => {
    const { store, actor } = setupWithPr();
    // The migration-seeded VIB-142 violation is open on this slug.
    expect(countOpenPolicyViolations(store.db, store.slug)).toBe(1);

    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/318`]: { body: livePull() },
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        body: {
          merged: true,
          sha: "mergesha01",
          message: "Pull Request successfully merged",
        },
      },
    });
    const result = await mergeTaskPr(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-142",
        expectedHeadSha: REVIEWED_HEAD,
      },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toEqual({
      status: "merged",
      prNumber: 318,
      sha: "mergesha01",
    });
    expect(gh.callsTo(`PUT ${REPO_PATH}/pulls/318/merge`)[0]?.body).toEqual({
      sha: REVIEWED_HEAD,
    });

    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.frontmatter.pr).toMatchObject({
      number: 318,
      state: "merged",
    });
    // Newest events: policy update (violation resolved) above the merge event.
    const [first, second] = file.parsed.timeline;
    expect(first).toMatchObject({
      type: "policy",
      text: expect.stringContaining(
        "**Policy update:** `pull_request:write` granted",
      ),
    });
    expect(second).toMatchObject({
      type: "github",
      text: "Merged **PR #318** into `main`.",
      actor: { kind: "human", userId: actor.userId },
    });
    // The successful write proved the scope — violation resolved.
    expect(countOpenPolicyViolations(store.db, store.slug)).toBe(0);
    expect(
      listAuditEvents(store.db, { action: "github.pr.merged" }),
    ).toHaveLength(1);
    // Provenance row for the merge observation.
    const prov = store.db
      .prepare(`SELECT action FROM provenance WHERE action = 'github.merge'`)
      .all();
    expect(prov).toHaveLength(1);
  });

  it("records merge facts independently for a recreated same-key task incarnation", async () => {
    const { store, actor } = setupWithPr();
    await expect(
      mergeTaskPr(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-142",
          expectedHeadSha: REVIEWED_HEAD,
        },
        actor,
        {
          dataRoot: store.dataRoot,
          fetchImpl: fakeGithubFetch({
            [`GET ${REPO_PATH}/pulls/318`]: { body: livePull() },
            [`PUT ${REPO_PATH}/pulls/318/merge`]: {
              body: { merged: true, sha: "merge-old-incarnation" },
            },
          }).fetchImpl,
        },
      ),
    ).resolves.toMatchObject({ status: "merged" });

    const replacementCreatedAt = "2026-07-14T10:00:00.000Z";
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-142", {
        title: "Recreated delivery",
        createdAt: replacementCreatedAt,
        updatedAt: replacementCreatedAt,
        stage: "review",
        branch: "vib-142-attach-workspace",
        ownerUserId: store.users.arda.id,
        pr: {
          number: 318,
          state: "review",
          title: "Attach execution workspace",
          headSha: REVIEWED_HEAD,
          baseRepo: "akin-ozer/viberr",
          baseRef: "main",
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const alreadyMerged = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/318`]: {
        body: livePull(REVIEWED_HEAD, {
          state: "closed",
          merged: true,
          merged_at: "2026-07-14T10:05:00.000Z",
          merge_commit_sha: "merge-new-incarnation",
        }),
      },
    });
    await expect(
      mergeTaskPr(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-142",
          expectedHeadSha: REVIEWED_HEAD,
        },
        actor,
        { dataRoot: store.dataRoot, fetchImpl: alreadyMerged.fetchImpl },
      ),
    ).resolves.toMatchObject({ status: "merged" });
    expect(
      alreadyMerged.calls.filter((call) => call.method === "PUT"),
    ).toHaveLength(0);

    const audits = listAuditEvents(store.db, { action: "github.pr.merged" });
    expect(audits).toHaveLength(2);
    expect(
      new Set(audits.map((event) => event.details?.taskIncarnation)),
    ).toEqual(new Set(["2026-07-01T09:00:00.000Z", replacementCreatedAt]));
    expect(
      store.db
        .prepare(
          `SELECT details_json FROM provenance WHERE action = 'github.merge'`,
        )
        .all()
        .map(
          (row) =>
            JSON.parse((row as { details_json: string }).details_json)
              .taskIncarnation,
        ),
    ).toEqual(
      expect.arrayContaining([
        "2026-07-01T09:00:00.000Z",
        replacementCreatedAt,
      ]),
    );
  });

  it("converges when remote merge succeeds and the process crashes before the task write", async () => {
    const { store, actor } = setupWithPr();
    configureMergeFaultHooksForTests({
      afterRemoteSuccess: () => {
        throw new Error("injected crash after remote merge");
      },
    });
    await expect(
      mergeTaskPr(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-142",
          expectedHeadSha: REVIEWED_HEAD,
        },
        actor,
        {
          dataRoot: store.dataRoot,
          fetchImpl: fakeGithubFetch({
            [`GET ${REPO_PATH}/pulls/318`]: { body: livePull() },
            [`PUT ${REPO_PATH}/pulls/318/merge`]: {
              body: { merged: true, sha: "merge-sha-crash-a" },
            },
          }).fetchImpl,
        },
      ),
    ).rejects.toThrow("injected crash after remote merge");
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-142",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.pr?.state,
    ).toBe("review");

    configureMergeFaultHooksForTests(null);
    const retryActor = {
      userId: store.users.murat.id,
      label: store.users.murat.email,
    };
    const retry = fakeGithubFetch({
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        status: 405,
        body: { message: "Pull Request is not mergeable" },
      },
      [`GET ${REPO_PATH}/pulls/318`]: {
        body: {
          state: "closed",
          merged: true,
          merged_at: "2026-07-13T09:00:00.000Z",
          merge_commit_sha: "merge-sha-crash-a",
          head: { sha: REVIEWED_HEAD },
          base: BASE,
        },
      },
    });
    await expect(
      mergeTaskPr(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-142",
          expectedHeadSha: REVIEWED_HEAD,
        },
        retryActor,
        { dataRoot: store.dataRoot, fetchImpl: retry.fetchImpl },
      ),
    ).resolves.toEqual({
      status: "merged",
      prNumber: 318,
      sha: "merge-sha-crash-a",
    });
    const mergeAudits = listAuditEvents(store.db, {
      action: "github.pr.merged",
    });
    expect(mergeAudits).toHaveLength(1);
    expect(mergeAudits[0]).toMatchObject({
      actorUserId: actor.userId,
      actorLabel: actor.label,
    });
    const mergeEvent = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.find((event) => event.type === "github");
    expect(mergeEvent?.actor).toMatchObject({
      kind: "human",
      userId: actor.userId,
    });
    expect(
      (
        store.db
          .prepare(`SELECT count(*) AS n FROM github_merge_intents`)
          .get() as { n: number }
      ).n,
    ).toBe(0);
    expect(
      store.db
        .prepare(`SELECT 1 FROM provenance WHERE action = 'github.merge'`)
        .all(),
    ).toHaveLength(1);
    expect(countOpenPolicyViolations(store.db, store.slug)).toBe(0);
  });

  it("never retargets a surviving merge intent when the task repository changes during retry", async () => {
    const { store, actor } = setupWithPr();
    const expectedTarget = {
      expectedRepo: "akin-ozer/viberr",
      expectedDefaultBranch: "main",
      expectedPrNumber: 318,
    };
    const ambiguousFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (
        (init?.method ?? "GET") === "GET" &&
        url.pathname.endsWith("/pulls/318")
      ) {
        return Response.json(livePull());
      }
      throw new TypeError("connection reset after request write");
    }) as typeof fetch;
    await expect(
      mergeTaskPr(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-142",
          expectedHeadSha: REVIEWED_HEAD,
          ...expectedTarget,
        },
        actor,
        { dataRoot: store.dataRoot, fetchImpl: ambiguousFetch },
      ),
    ).resolves.toMatchObject({ status: "network_unavailable" });
    expect(
      (
        store.db
          .prepare(`SELECT count(*) AS n FROM github_merge_intents`)
          .get() as { n: number }
      ).n,
    ).toBe(1);

    const retry = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/318`]: () => {
        const current = readTaskFile({
          projectSlug: store.slug,
          taskKey: "VIB-142",
          dataRoot: store.dataRoot,
        })!.parsed;
        writeTask(store.dataRoot, store.slug, {
          ...current,
          frontmatter: {
            ...current.frontmatter,
            repo: "other-owner/other-repo",
          },
        });
        return {
          body: {
            state: "open",
            merged: false,
            head: { sha: REVIEWED_HEAD },
            base: BASE,
          },
        };
      },
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        body: { merged: true, sha: "must-not-run" },
      },
      [`PUT /repos/other-owner/other-repo/pulls/318/merge`]: {
        body: { merged: true, sha: "must-not-run-either" },
      },
    });
    await expect(
      mergeTaskPr(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-142",
          expectedHeadSha: REVIEWED_HEAD,
          ...expectedTarget,
        },
        { userId: store.users.murat.id, label: store.users.murat.email },
        { dataRoot: store.dataRoot, fetchImpl: retry.fetchImpl },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(retry.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });

  it.each([
    "project default branch",
    "pull request base repository",
    "pull request base branch",
  ] as const)(
    "rechecks the %s under the task lock after the remote merge succeeds",
    async (retarget) => {
      const { store, actor } = setupWithPr();
      configureMergeFaultHooksForTests({
        afterTargetCheckBeforeCanonicalWrite: async () => {
          if (retarget === "project default branch") {
            await updateProjectFile(
              { projectSlug: store.slug, dataRoot: store.dataRoot },
              (project) => {
                project.frontmatter.defaultBranch = "release";
              },
            );
            return;
          }
          await updateTaskFile(
            {
              projectSlug: store.slug,
              taskKey: "VIB-142",
              dataRoot: store.dataRoot,
            },
            (task) => {
              task.frontmatter.pr = {
                ...task.frontmatter.pr!,
                ...(retarget === "pull request base repository"
                  ? { baseRepo: "other-owner/other-repo" }
                  : { baseRef: "release" }),
              };
            },
          );
        },
      });
      const gh = fakeGithubFetch({
        [`GET ${REPO_PATH}/pulls/318`]: { body: livePull() },
        [`PUT ${REPO_PATH}/pulls/318/merge`]: {
          body: { merged: true, sha: `merge-after-${retarget}` },
        },
      });

      await expect(
        mergeTaskPr(
          store.db,
          {
            projectSlug: store.slug,
            taskKey: "VIB-142",
            expectedHeadSha: REVIEWED_HEAD,
          },
          actor,
          { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
        ),
      ).resolves.toMatchObject({ status: "merged", prNumber: 318 });
      expect(gh.callsTo(`PUT ${REPO_PATH}/pulls/318/merge`)).toHaveLength(1);
      const current = readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-142",
        dataRoot: store.dataRoot,
      })!.parsed;
      expect(current.frontmatter.pr?.state).toBe("review");
      expect(
        current.timeline.filter((event) => event.type === "github"),
      ).toHaveLength(0);
      expect(
        listAuditEvents(store.db, { action: "github.pr.merged" })[0]!.details,
      ).toMatchObject({ canonicalApplied: false });
      expect(
        (
          store.db
            .prepare(`SELECT count(*) AS n FROM github_merge_intents`)
            .get() as { n: number }
        ).n,
      ).toBe(1);
    },
  );

  it("rechecks the task incarnation under the task lock after the remote merge succeeds", async () => {
    const { store, actor } = setupWithPr();
    const replacementCreatedAt = "2026-07-15T10:00:00.000Z";
    configureMergeFaultHooksForTests({
      afterTargetCheckBeforeCanonicalWrite: async () => {
        await updateTaskFile(
          {
            projectSlug: store.slug,
            taskKey: "VIB-142",
            dataRoot: store.dataRoot,
          },
          (task) => {
            task.frontmatter.createdAt = replacementCreatedAt;
            task.frontmatter.updatedAt = replacementCreatedAt;
          },
        );
      },
    });
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/318`]: { body: livePull() },
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        body: { merged: true, sha: "merge-after-incarnation-change" },
      },
    });

    await expect(
      mergeTaskPr(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-142",
          expectedHeadSha: REVIEWED_HEAD,
        },
        actor,
        { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(gh.callsTo(`PUT ${REPO_PATH}/pulls/318/merge`)).toHaveLength(1);
    const current = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(current.frontmatter.createdAt).toBe(replacementCreatedAt);
    expect(current.frontmatter.pr?.state).toBe("review");
    expect(
      current.timeline.filter((event) => event.type === "github"),
    ).toHaveLength(0);
    expect(
      listAuditEvents(store.db, { action: "github.pr.merged" }),
    ).toHaveLength(0);
    expect(
      (
        store.db
          .prepare(`SELECT count(*) AS n FROM github_merge_intents`)
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  it("replays missing side effects after a crash immediately after the canonical merge write", async () => {
    const { store, actor } = setupWithPr();
    configureMergeFaultHooksForTests({
      afterCanonicalWrite: () => {
        throw new Error("injected crash after canonical merge write");
      },
    });
    await expect(
      mergeTaskPr(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-142",
          expectedHeadSha: REVIEWED_HEAD,
        },
        actor,
        {
          dataRoot: store.dataRoot,
          fetchImpl: fakeGithubFetch({
            [`GET ${REPO_PATH}/pulls/318`]: { body: livePull() },
            [`PUT ${REPO_PATH}/pulls/318/merge`]: {
              body: { merged: true, sha: "merge-sha-crash-b" },
            },
          }).fetchImpl,
        },
      ),
    ).rejects.toThrow("injected crash after canonical merge write");
    const afterCrash = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(afterCrash.frontmatter.pr?.state).toBe("merged");
    expect(
      afterCrash.timeline.filter((event) => event.type === "github"),
    ).toHaveLength(1);
    expect(
      listAuditEvents(store.db, { action: "github.pr.merged" }),
    ).toHaveLength(0);
    expect(
      store.db
        .prepare(`SELECT 1 FROM provenance WHERE action = 'github.merge'`)
        .all(),
    ).toHaveLength(0);

    configureMergeFaultHooksForTests(null);
    await expect(
      mergeTaskPr(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-142",
          expectedHeadSha: REVIEWED_HEAD,
        },
        actor,
        {
          dataRoot: store.dataRoot,
          fetchImpl: fakeGithubFetch({
            [`GET ${REPO_PATH}/pulls/318`]: {
              body: livePull(REVIEWED_HEAD, {
                state: "closed",
                merged: true,
                merged_at: "2026-07-13T09:05:00.000Z",
                merge_commit_sha: "merge-sha-crash-b",
              }),
            },
          }).fetchImpl,
        },
      ),
    ).resolves.toMatchObject({ status: "merged", prNumber: 318 });
    const replayed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(
      replayed.timeline.filter((event) => event.type === "github"),
    ).toHaveLength(1);
    expect(
      listAuditEvents(store.db, { action: "github.pr.merged" }),
    ).toHaveLength(1);
    expect(
      store.db
        .prepare(`SELECT 1 FROM provenance WHERE action = 'github.merge'`)
        .all(),
    ).toHaveLength(1);
    expect(countOpenPolicyViolations(store.db, store.slug)).toBe(0);
  });

  it("405 → not_mergeable, 409 → head_changed, 404 → pr_not_found, 401 → auth_failed", async () => {
    const cases: [number, string, string][] = [
      [405, "Pull Request is not mergeable", "not_mergeable"],
      [409, "Head branch was modified", "head_changed"],
      [404, "Not Found", "pr_not_found"],
      [401, "Bad credentials", "auth_failed"],
    ];
    for (const [status, message, expected] of cases) {
      const { store, actor } = setupWithPr();
      const routes: Record<string, FakeResponder> = {
        [`GET ${REPO_PATH}/pulls/318`]:
          status === 409
            ? (call) => ({
                body:
                  call.attempt === 1 ? livePull() : livePull(REPLACEMENT_HEAD),
              })
            : { body: livePull() },
        [`PUT ${REPO_PATH}/pulls/318/merge`]: { status, body: { message } },
      };
      const result = await mergeTaskPr(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-142",
          expectedHeadSha: REVIEWED_HEAD,
        },
        actor,
        {
          dataRoot: store.dataRoot,
          fetchImpl: fakeGithubFetch(routes).fetchImpl,
        },
      );
      expect(result.status).toBe(expected);
      expect(
        readTaskFile({
          projectSlug: store.slug,
          taskKey: "VIB-142",
          dataRoot: store.dataRoot,
        })!.parsed.frontmatter.pr?.state,
      ).toBe("review");
    }
  });

  it("never sends an unpinned merge and caches the live head for review", async () => {
    const { store, actor } = setupWithPr();
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-142",
        dataRoot: store.dataRoot,
      },
      (parsed) => {
        parsed.frontmatter.pr = { ...parsed.frontmatter.pr!, headSha: null };
      },
    );
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/318`]: {
        body: { head: { sha: REVIEWED_HEAD } },
      },
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        body: { merged: true, sha: "must-not-run" },
      },
    });

    const result = await mergeTaskPr(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-142",
        expectedHeadSha: null,
      },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );

    expect(result.status).toBe("head_changed");
    expect(gh.callsTo(`PUT ${REPO_PATH}/pulls/318/merge`)).toHaveLength(0);
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-142",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.pr?.headSha,
    ).toBe(REVIEWED_HEAD);
  });

  it("refreshes a 409 head once, requires fresh review, then merges that exact head", async () => {
    const { store, actor } = setupWithPr();
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-142",
        dataRoot: store.dataRoot,
      },
      (parsed) => {
        parsed.frontmatter.reviewers = [
          { profileId: "reviewer", backend: "claude", role: "Reviewer" },
        ];
        parsed.frontmatter.validation = "healthy";
        parsed.frontmatter.reviewerVerdicts = [
          {
            profileId: "reviewer",
            verdict: "approve",
            summary: "Approved the old head.",
            runId: "run-old-head",
            reviewedAt: "2026-07-13T00:00:00.000Z",
            evidenceFingerprint: reviewEvidenceFingerprint(
              parsed,
              "akin-ozer/viberr",
            ),
          },
        ];
      },
    );
    const first = fakeGithubFetch({
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        status: 409,
        body: { message: "Head branch was modified" },
      },
      [`GET ${REPO_PATH}/pulls/318`]: (call) => ({
        body: call.attempt === 1 ? livePull() : livePull(REPLACEMENT_HEAD),
      }),
    });
    const changed = await mergeTaskPr(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-142",
        expectedHeadSha: REVIEWED_HEAD,
      },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: first.fetchImpl },
    );
    expect(changed.status).toBe("head_changed");
    let parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(parsed.frontmatter.pr?.headSha).toBe(REPLACEMENT_HEAD);
    expect(parsed.frontmatter.reviewerVerdicts).toEqual([]);
    expect(parsed.frontmatter.validation).toBe("changed");
    expect(
      listAuditEvents(store.db, { action: "github.pr.head_rebound" }),
    ).toHaveLength(1);

    // Repeating the stale request cannot create another invalidation/audit.
    await mergeTaskPr(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-142",
        expectedHeadSha: REVIEWED_HEAD,
      },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: first.fetchImpl },
    );
    expect(
      listAuditEvents(store.db, { action: "github.pr.head_rebound" }),
    ).toHaveLength(1);

    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-142",
        dataRoot: store.dataRoot,
      },
      (task) => {
        task.frontmatter.validation = "healthy";
        task.frontmatter.reviewerVerdicts = [
          {
            profileId: "reviewer",
            verdict: "approve",
            summary: "Approved the replacement head.",
            runId: "run-new-head",
            reviewedAt: "2026-07-13T00:05:00.000Z",
            evidenceFingerprint: reviewEvidenceFingerprint(
              task,
              "akin-ozer/viberr",
            ),
          },
        ];
      },
    );
    const retry = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/318`]: {
        body: livePull(REPLACEMENT_HEAD),
      },
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        body: { merged: true, sha: "merge-sha" },
      },
    });
    const merged = await mergeTaskPr(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-142",
        expectedHeadSha: REPLACEMENT_HEAD,
      },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: retry.fetchImpl },
    );
    expect(merged.status).toBe("merged");
    expect(retry.callsTo(`PUT ${REPO_PATH}/pulls/318/merge`)[0]?.body).toEqual({
      sha: REPLACEMENT_HEAD,
    });
    parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(parsed.frontmatter.pr?.state).toBe("merged");
  });

  it("preserves the review round when a 409 reports the same verified head", async () => {
    const { store, actor } = setupWithPr();
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-142",
        dataRoot: store.dataRoot,
      },
      (parsed) => {
        parsed.frontmatter.reviewers = [
          { profileId: "reviewer", backend: "claude", role: "Reviewer" },
        ];
        parsed.frontmatter.validation = "healthy";
        parsed.frontmatter.reviewerVerdicts = [
          {
            profileId: "reviewer",
            verdict: "approve",
            summary: "Approved the current head.",
            runId: "run-current-head",
            reviewedAt: "2026-07-13T00:00:00.000Z",
            evidenceFingerprint: reviewEvidenceFingerprint(
              parsed,
              "akin-ozer/viberr",
            ),
          },
        ];
      },
    );
    const gh = fakeGithubFetch({
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        status: 409,
        body: { message: "Pull Request is not mergeable" },
      },
      [`GET ${REPO_PATH}/pulls/318`]: {
        body: livePull(),
      },
    });

    const result = await mergeTaskPr(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-142",
        expectedHeadSha: REVIEWED_HEAD,
      },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );

    expect(result.status).toBe("not_mergeable");
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr?.headSha).toBe(REVIEWED_HEAD);
    expect(fm.reviewerVerdicts).toHaveLength(1);
    expect(fm.validation).toBe("healthy");
    expect(
      listAuditEvents(store.db, { action: "github.pr.head_rebound" }),
    ).toHaveLength(0);
  });

  it("does not wipe a fresh approval when an older completion snapshot loses the race", async () => {
    const { store, actor } = setupWithPr();
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-142",
        dataRoot: store.dataRoot,
      },
      (parsed) => {
        parsed.frontmatter.pr = {
          ...parsed.frontmatter.pr!,
          headSha: REPLACEMENT_HEAD,
        };
        parsed.frontmatter.reviewers = [
          { profileId: "reviewer", backend: "claude", role: "Reviewer" },
        ];
        parsed.frontmatter.validation = "healthy";
        parsed.frontmatter.reviewerVerdicts = [
          {
            profileId: "reviewer",
            verdict: "approve",
            summary: "Approved the replacement head.",
            runId: "run-new-head",
            reviewedAt: "2026-07-13T00:05:00.000Z",
            evidenceFingerprint: reviewEvidenceFingerprint(
              parsed,
              "akin-ozer/viberr",
            ),
          },
        ];
      },
    );

    const stale = await mergeTaskPr(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-142",
        expectedHeadSha: REVIEWED_HEAD,
      },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch({}).fetchImpl },
    );

    expect(stale.status).toBe("head_changed");
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr?.headSha).toBe(REPLACEMENT_HEAD);
    expect(fm.reviewerVerdicts).toHaveLength(1);
    expect(fm.validation).toBe("healthy");
  });

  it("403 → typed scope_violation reusing the seeded VIB-142 row (idempotent, no duplicate events)", async () => {
    const { store, actor } = setupWithPr();
    const seeded = findOpenScopeViolation(
      store.db,
      store.slug,
      "pull_request:write",
      "VIB-142",
    )!;
    const merge = () =>
      mergeTaskPr(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-142",
          expectedHeadSha: REVIEWED_HEAD,
        },
        actor,
        {
          dataRoot: store.dataRoot,
          fetchImpl: fakeGithubFetch({
            [`GET ${REPO_PATH}/pulls/318`]: { body: livePull() },
            [`PUT ${REPO_PATH}/pulls/318/merge`]: {
              status: 403,
              body: {
                message: "Resource not accessible by personal access token",
              },
            },
          }).fetchImpl,
        },
      );
    const result = await merge();
    expect(result).toMatchObject({
      status: "scope_violation",
      prNumber: 318,
      scope: "pull_request:write",
      violationId: seeded.id, // the open row is REUSED, not duplicated
    });
    expect(countOpenPolicyViolations(store.db, store.slug)).toBe(1);
    // Reused violation → no new policy event on the task.
    const eventsAfterFirst = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.length;

    const retry = await merge();
    expect(retry.status).toBe("scope_violation");
    expect(countOpenPolicyViolations(store.db, store.slug)).toBe(1);
    const eventsAfterRetry = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!.parsed.timeline.length;
    expect(eventsAfterRetry).toBe(eventsAfterFirst);
    // Typed failure the accept_completion caller renders (VIB-142 scenario).
    expect(
      listAuditEvents(store.db, { action: "github.pr.merge_refused" }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("403 on a task WITHOUT a prior violation flags it with event + owner notification", async () => {
    const { store, actor } = setup(); // VIB-301, owner arda, no violation yet
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "review",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr: {
          number: 400,
          state: "review",
          title: "Workspace PR",
          headSha: REVIEWED_HEAD,
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const result = await mergeTaskPr(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-301",
        expectedHeadSha: REVIEWED_HEAD,
      },
      actor,
      {
        dataRoot: store.dataRoot,
        fetchImpl: fakeGithubFetch({
          [`GET ${REPO_PATH}/pulls/400`]: { body: livePull() },
          [`PUT ${REPO_PATH}/pulls/400/merge`]: {
            status: 403,
            body: {
              message: "Resource not accessible by personal access token",
            },
          },
        }).fetchImpl,
      },
    );
    expect(result.status).toBe("scope_violation");
    const violation = findOpenScopeViolation(
      store.db,
      store.slug,
      "pull_request:write",
      "VIB-301",
    );
    expect(violation).not.toBeNull();
    // Policy event written to THE VIOLATION'S OWN task (ruling 5).
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.timeline[0]).toMatchObject({
      type: "policy",
      text: expect.stringContaining(
        "**Policy violation:** active PAT is missing `pull_request:write`.",
      ),
    });
    // Owner notification (kind policy).
    const notification = store.db
      .prepare(
        `SELECT kind, task_key FROM notifications WHERE user_id = ? AND task_key = 'VIB-301'`,
      )
      .get(store.users.arda.id) as { kind: string; task_key: string };
    expect(notification).toMatchObject({ kind: "policy", task_key: "VIB-301" });
  });

  it("degrades typed: no PR, unknown task, no PAT", async () => {
    const { store, actor } = setup(); // VIB-301 has no pr in frontmatter
    expect(
      await mergeTaskPr(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-301",
          expectedHeadSha: null,
        },
        actor,
        { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch({}).fetchImpl },
      ),
    ).toEqual({ status: "no_pr", taskKey: "VIB-301" });
    expect(
      await mergeTaskPr(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-999",
          expectedHeadSha: null,
        },
        actor,
        { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch({}).fetchImpl },
      ),
    ).toEqual({ status: "task_not_found", taskKey: "VIB-999" });

    const bare = setupTestStore(ctx);
    writeTask(bare.dataRoot, bare.slug, {
      frontmatter: baseTaskFrontmatter("VIB-500", {
        pr: { number: 1, state: "review", title: "x" },
      }),
    });
    rebuildAll(bare.db, { dataRoot: bare.dataRoot });
    expect(
      await mergeTaskPr(
        bare.db,
        {
          projectSlug: bare.slug,
          taskKey: "VIB-500",
          expectedHeadSha: null,
        },
        actor,
        { dataRoot: bare.dataRoot, fetchImpl: fakeGithubFetch({}).fetchImpl },
      ),
    ).toEqual({ status: "no_pat_configured", repo: "akin-ozer/viberr" });
  });
});
