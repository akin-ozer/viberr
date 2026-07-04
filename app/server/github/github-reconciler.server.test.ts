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
import { listAuditEvents } from "~/server/audit/audit-recorder.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import {
  countOpenPolicyViolations,
  findOpenScopeViolation,
} from "~/server/projections/policy-violations.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import {
  mergeTaskPr,
  reconcileProject,
  reconcileTask,
} from "./github-reconciler.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const REPO_PATH = "/repos/akin-ozer/viberr";

function setup(): { store: TestStore; actor: { userId: string; label: string } } {
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
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
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
          { sha: "a91f7c2ffff", commit: { message: "[VIB-301] add repo attach policy gate" } },
          { sha: "4ce0b18ffff", commit: { message: "[VIB-301] branch reconciler\n\nbody" } },
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
          head: { sha: "headsha318" },
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
        head: { sha: "headsha318" },
        additions: 412,
        deletions: 87,
        changed_files: 9,
      },
    },
    [`GET ${REPO_PATH}/commits/headsha318/check-runs`]: {
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
    expect(JSON.parse(row.pr_json)).toMatchObject({ number: 318, state: "review" });
    expect(JSON.parse(row.github_json).commits).toHaveLength(2);

    // Provenance + audit recorded.
    const prov = store.db
      .prepare(`SELECT action, details_json FROM provenance WHERE action = 'github.reconcile'`)
      .all() as { action: string; details_json: string }[];
    expect(prov).toHaveLength(1);
    expect(JSON.parse(prov[0]!.details_json)).toMatchObject({
      branch: "vib-301-workspace",
      changed: true,
      prNumber: 318,
    });
    expect(listAuditEvents(store.db, { action: "github.reconcile.task" })).toHaveLength(1);
  });

  it("is idempotent: identical GitHub facts → no file write (changed: false)", async () => {
    const { store, actor } = setup();
    const run = () =>
      reconcileTask(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-301" },
        actor,
        { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl },
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
        head: { sha: "headsha318" },
        additions: 412,
        deletions: 87,
        changed_files: 9,
      },
    };
    const result = await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );
    expect(result).toMatchObject({ status: "reconciled", sync: "merged" });
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
            body: { message: "Resource not accessible by personal access token" },
          },
        }).fetchImpl,
      },
    );
    expect(forbidden.status).toBe("scope_violation");
    expect(findOpenScopeViolation(store.db, store.slug, "repo", "VIB-301")).not.toBeNull();
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
    expect(summary.results.map((r) => r.status)).toEqual(["reconciled", "reconciled"]);
    expect(listAuditEvents(store.db, { action: "github.reconcile.project" })).toHaveLength(1);

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
        pr: { number: 318, state: "review", title: "Attach execution workspace" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    return { store, actor };
  }

  it("merges, flips the cache, writes the github event, resolves the task's pull_request:write violation", async () => {
    const { store, actor } = setupWithPr();
    // The migration-seeded VIB-142 violation is open on this slug.
    expect(countOpenPolicyViolations(store.db, store.slug)).toBe(1);

    const gh = fakeGithubFetch({
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        body: { merged: true, sha: "mergesha01", message: "Pull Request successfully merged" },
      },
    });
    const result = await mergeTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-142" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toEqual({ status: "merged", prNumber: 318, sha: "mergesha01" });

    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.frontmatter.pr).toMatchObject({ number: 318, state: "merged" });
    // Newest events: policy update (violation resolved) above the merge event.
    const [first, second] = file.parsed.timeline;
    expect(first).toMatchObject({
      type: "policy",
      text: expect.stringContaining("**Policy update:** `pull_request:write` granted"),
    });
    expect(second).toMatchObject({
      type: "github",
      text: "Merged **PR #318** into `main`.",
      actor: { kind: "human", userId: actor.userId },
    });
    // The successful write proved the scope — violation resolved.
    expect(countOpenPolicyViolations(store.db, store.slug)).toBe(0);
    expect(listAuditEvents(store.db, { action: "github.pr.merged" })).toHaveLength(1);
    // Provenance row for the merge observation.
    const prov = store.db
      .prepare(`SELECT action FROM provenance WHERE action = 'github.merge'`)
      .all();
    expect(prov).toHaveLength(1);
  });

  it("405 → not_mergeable, 409 → head_changed, 404 → pr_not_found, 401 → auth_failed", async () => {
    const { store, actor } = setupWithPr();
    const cases: [number, string, string][] = [
      [405, "Pull Request is not mergeable", "not_mergeable"],
      [409, "Head branch was modified", "head_changed"],
      [404, "Not Found", "pr_not_found"],
      [401, "Bad credentials", "auth_failed"],
    ];
    for (const [status, message, expected] of cases) {
      const result = await mergeTaskPr(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-142" },
        actor,
        {
          dataRoot: store.dataRoot,
          fetchImpl: fakeGithubFetch({
            [`PUT ${REPO_PATH}/pulls/318/merge`]: { status, body: { message } },
          }).fetchImpl,
        },
      );
      expect(result.status).toBe(expected);
    }
    // No cache flip on failures.
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.frontmatter.pr?.state).toBe("review");
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
        { projectSlug: store.slug, taskKey: "VIB-142" },
        actor,
        {
          dataRoot: store.dataRoot,
          fetchImpl: fakeGithubFetch({
            [`PUT ${REPO_PATH}/pulls/318/merge`]: {
              status: 403,
              body: { message: "Resource not accessible by personal access token" },
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
        pr: { number: 400, state: "review", title: "Workspace PR" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const result = await mergeTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      {
        dataRoot: store.dataRoot,
        fetchImpl: fakeGithubFetch({
          [`PUT ${REPO_PATH}/pulls/400/merge`]: {
            status: 403,
            body: { message: "Resource not accessible by personal access token" },
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
        { projectSlug: store.slug, taskKey: "VIB-301" },
        actor,
        { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch({}).fetchImpl },
      ),
    ).toEqual({ status: "no_pr", taskKey: "VIB-301" });
    expect(
      await mergeTaskPr(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-999" },
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
        { projectSlug: bare.slug, taskKey: "VIB-500" },
        actor,
        { dataRoot: bare.dataRoot, fetchImpl: fakeGithubFetch({}).fetchImpl },
      ),
    ).toEqual({ status: "no_pat_configured", repo: "akin-ozer/viberr" });
  });
});
