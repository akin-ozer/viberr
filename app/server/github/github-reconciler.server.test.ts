import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import {
  fakeGithubFetch,
  unreadableResponse,
  type FakeResponder,
} from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readProjectFile } from "~/server/files/project-writer.server";
import { checksPill } from "~/features/github/github-pills";
import { mapPrChecks } from "~/shared/mapping/task.server";
import { updateUserFields } from "~/server/auth/user-store.server";
import { readPrHumanApproval } from "./pr-human-approval.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { listNotifications } from "~/server/projections/notifications.server";
import {
  countOpenPolicyViolations,
  findOpenScopeViolation,
  openScopeViolation,
} from "~/server/projections/policy-violations.server";
import type { PrRef, WorkRevision } from "~/schemas/task-file.schema";
import type { RevisionDrift } from "~/shared/revision-drift";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { setupProjectedStore } from "../../../test-support/projected-store";
import { getTaskDetail } from "~/server/projections/task-query.server";
import {
  createPat,
  getProjectCredential,
  getProjectCredentialHealth,
  recordPatValidation,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";
import {
  operatorSnapshot,
  resolveOperatorAuthority,
} from "~/server/tasks/operator-actions.server";
import {
  BRANCH_CLEANUP_GUARDRAIL_DESC,
  BRANCH_CLEANUP_GUARDRAIL_ID,
} from "./branch-cleanup.server";

import {
  mergeTaskPr,
  RECONCILE_TASK_CONCURRENCY,
  recheckOpenReviewPrs,
  reconcileProject,
  reconcileTask,
  resetReconcileCursorsForTests,
  resolveRemoteBranchCollision,
  type OperatorWake,
} from "./github-reconciler.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const REPO_PATH = "/repos/akin-ozer/viberr";

function setup() {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-301", {
      title: "Attach execution workspace",
      stage: "review",
      branch: "vib-301-workspace",
      ownerUserId: store.users.arda.id,
      // R15-15: the task OWNS PR #318 — the state `openTaskPr` leaves behind, and
      // the only state in which the reconciler may track a PR at all. The fixture
      // used to start with no `pr` and let the reconciler adopt whatever sat on
      // the branch, which is precisely the bug: a task-key branch is not unique,
      // and on a reused key that adopts a previous task's PR.
      pr: { number: 318, state: "review", title: "Attach execution workspace" },
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

/**
 * The fake transport's route table. Deliberately OPEN: the helpers below hand
 * back a base table and each test overlays the one or two routes its scenario
 * turns on, so the key set is not knowable at the point the base is built.
 */
interface FakeRoutes {
  [routeKey: string]: FakeResponder;
}

function happyRoutes(): FakeRoutes {
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
    // Ruling 187: each entry is stamped with whether the remote has it. These
    // came FROM the compare, so they are pushed.
    expect(fm.github?.commits).toEqual([
      { sha: "a91f7c2", msg: "[VIB-301] add repo attach policy gate", pushed: true },
      { sha: "4ce0b18", msg: "[VIB-301] branch reconciler", pushed: true },
    ]);
    expect(fm.github?.changed).toEqual({ files: 9, add: 412, del: 87 });

    // Reprojected into SQLite.
    // SAFETY: the reconcile above wrote both caches into task.md and
    // reprojected it, so this row exists and both columns carry their JSON.
    const row = store.db
      .prepare(
        `SELECT pr_json, github_json FROM task_projections
         WHERE project_slug = ? AND task_key = 'VIB-301'`,
      )
      .get(store.slug) as { pr_json: string; github_json: string };
    expect(JSON.parse(row.pr_json)).toMatchObject({ number: 318, state: "review" });
    expect(JSON.parse(row.github_json).commits).toHaveLength(2);

    // Provenance + audit recorded.
    // SAFETY: the SELECT names the two columns, and the reconciler records a
    // details payload on every `github.reconcile` row it writes.
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

  it("F21-7: a drifted check-runs payload persists as UNKNOWN, and the board reads it that way", async () => {
    const { store, actor } = setup();
    const routes = happyRoutes();
    // GitHub reports three runs and sends two entries this reader cannot use.
    routes[`GET ${REPO_PATH}/commits/headsha318/check-runs`] = {
      body: { total_count: 3, check_runs: [null, "x"] },
    };
    const gh = fakeGithubFetch(routes);
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    // What task.md keeps is the honest count — not "3 checks, none of them bad".
    expect(fm.pr).toMatchObject({
      checks: { total: 3, passing: 0, failing: 0, pending: 0, unknown: 3 },
    });
    // And every surface that renders that cache says unknown, not passing.
    expect(mapPrChecks(fm.pr ?? null)).toMatchObject({ state: "unknown" });
    expect(checksPill(mapPrChecks(fm.pr ?? null)!).kind).not.toBe("ready");
  });

  it("F21-8: one malformed compare commit drops only itself, and the observation says so", async () => {
    const { store, actor } = setup();
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/compare/main...vib-301-workspace`] = {
      body: {
        ahead_by: 3,
        behind_by: 0,
        status: "ahead",
        commits: [
          { sha: "a91f7c2ffff", commit: { message: "[VIB-301] add repo attach policy gate" } },
          { commit: { message: "[VIB-301] a commit with no sha" } },
          { sha: "4ce0b18ffff", commit: { message: "[VIB-301] branch reconciler" } },
        ],
      },
    };
    const gh = fakeGithubFetch(routes);
    const result = await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    // The two readable commits survive — the branch footprint is not emptied.
    expect(result).toMatchObject({ status: "reconciled", commits: 2 });
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    // Ruling 187: this compare DROPPED an entry, so it is incomplete and no
    // commit is judged — an unjudged entry must not read as judged.
    expect(fm.github?.commits).toEqual([
      { sha: "a91f7c2", msg: "[VIB-301] add repo attach policy gate" },
      { sha: "4ce0b18", msg: "[VIB-301] branch reconciler" },
    ]);
    // SAFETY: the SELECT names one column of the row this reconcile just wrote.
    const prov = store.db
      .prepare(`SELECT details_json FROM provenance WHERE action = 'github.reconcile'`)
      .all() as { details_json: string }[];
    expect(JSON.parse(prov[0]!.details_json)).toMatchObject({ commitsDropped: 1 });
  });

  it("R17-1: an owned PR head AHEAD of the reviewed revision records revisionDrift", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "review",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr: { number: 318, state: "review", title: "Attach execution workspace" },
        // The delivered/reviewed revision is NOT the current PR head.
        workRevision: {
          id: "rev_1",
          headSha: "rev0delivered",
          treeSha: null,
          branch: "vib-301-workspace",
          createdAt: "2026-08-04T08:00:00.000Z",
          sourceProfileId: "developer",
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
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);

    const routes = happyRoutes();
    // The reviewed revision is an ancestor of the head, plus 2 extra commits.
    routes[`GET ${REPO_PATH}/compare/rev0delivered...headsha318`] = {
      body: { ahead_by: 2, behind_by: 0, status: "ahead", commits: [] },
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr?.revisionDrift).toEqual({ headSha: "headsha318", authored: 2, baseRefresh: null });
  });

  it("F21-17: the drift fact SURVIVES the PR closing — the recovery packet can still state it", async () => {
    // Drift was computed ONLY for an open PR and written nowhere else, so the
    // moment a human closed the PR the reconciler rewrote `pr` without it. The
    // pr-closed recovery packet — the one surface that has to say "the head is 2
    // commits past what was reviewed" while a human decides rework vs archive —
    // was therefore structurally blind to it, one pass after it was true.
    // Canary: drop the carry-forward → drift is `undefined` after the close.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "review",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr: { number: 318, state: "review", title: "Attach execution workspace" },
        workRevision: {
          id: "rev_1",
          headSha: "rev0delivered",
          treeSha: null,
          branch: "vib-301-workspace",
          createdAt: "2026-08-04T08:00:00.000Z",
          sourceProfileId: "developer",
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
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
    const readFm = () =>
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-301",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter;

    // Pass 1 — the PR is open and its head carries 2 commits the review never saw.
    const openRoutes = happyRoutes();
    openRoutes[`GET ${REPO_PATH}/compare/rev0delivered...headsha318`] = {
      body: { ahead_by: 2, behind_by: 0, status: "ahead", commits: [] },
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(openRoutes).fetchImpl },
    );
    expect(readFm().pr?.revisionDrift).toEqual({ headSha: "headsha318", authored: 2, baseRefresh: null });

    // Pass 2 — a human CLOSES the PR on GitHub. A settled PR deliberately buys
    // no compare call, and NO drift compare route is registered here, so the
    // only place the surviving fact can come from is the cache.
    const closedRoutes = happyRoutes();
    closedRoutes[`GET ${REPO_PATH}/pulls/318`] = {
      body: {
        number: 318,
        title: "Attach execution workspace",
        state: "closed",
        merged: false,
        merged_at: null,
        head: { sha: "headsha318" },
        additions: 412,
        deletions: 87,
        changed_files: 9,
      },
    };
    // The branch still points at the PR head, so the closed PR stays linked (F26).
    closedRoutes[`GET ${REPO_PATH}/branches/vib-301-workspace`] = {
      body: { commit: { sha: "headsha318" } },
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(closedRoutes).fetchImpl },
    );
    const closed = readFm();
    expect(closed.pr?.state).toBe("closed");
    expect(closed.pr?.revisionDrift).toEqual({ headSha: "headsha318", authored: 2, baseRefresh: null });

    // …and it reaches the operator on the surface where that packet is written:
    // `get_task` carries the same fact after the close, not just the task file.
    const snapshot = operatorSnapshot(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-301",
      resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug),
    );
    expect(snapshot.pr).toMatchObject({
      state: "closed",
      revisionDrift: { headSha: "headsha318", authored: 2, baseRefresh: null },
    });
  });

  it("R17-1: a head IDENTICAL to the reviewed revision records no drift (no extra compare)", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "review",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr: { number: 318, state: "review", title: "Attach execution workspace" },
        // Reviewed revision == the live PR head — no drift, no compare call.
        workRevision: {
          id: "rev_1",
          headSha: "headsha318",
          treeSha: null,
          branch: "vib-301-workspace",
          createdAt: "2026-08-04T08:00:00.000Z",
          sourceProfileId: "developer",
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
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
    // No `rev...head` compare route registered — if the reconciler asked for one
    // (it must not, the shas are equal) the fake would throw an unknown route.
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl },
    );
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr?.revisionDrift).toBeUndefined();
  });

  it("R15-15: a PR this task did NOT open is never adopted — a task-key branch is not unique", async () => {
    // Reported live. A data root was wiped, so task keys restarted at 1 and a
    // brand-new VIB-1 got branch `vib-1` — which on GitHub still carried the
    // MERGED PR of the previous instance's VIB-1. The reconciler matched on
    // branch name alone, adopted that PR, the divergence rule fired "PR #109 was
    // merged but VIB-1 hasn't been accepted", and the operator recommended
    // moving the task to Review while its developer was still writing code.
    // The task's own delivered revision was not in that PR and never had been.
    // Canary: drop `&& ownsAPr` from newPr and this adopts #318 again.
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "impl",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        // No `pr`: this task never opened one. The PR on the branch is a
        // stranger's.
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl },
    );

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr, "an unowned PR must never become this task's PR").toBeNull();

    // …and the collision is REPORTED, not silently swallowed — with the same
    // remedy the non-fast-forward push gives, because it is one cause.
    // SAFETY: the SELECT names one column, declared `text TEXT NOT NULL`.
    const events = store.db
      .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
      .all() as { text: string }[];
    const collision = events.find((e) => /Branch name collision/.test(e.text));
    expect(collision, "the collision must be surfaced").toBeTruthy();
    expect(collision!.text).toContain("#318");
    expect(collision!.text).toContain("is NOT VIB-301's review PR");
    expect(collision!.text).toContain("vib-301-workspace");
    // Crucially it must NOT read as a divergence — nothing about this task
    // changed on GitHub, and calling it one is what produced the bad advice.
    expect(collision!.text).not.toContain("Divergence");
    expect(events.some((e) => /Divergence/.test(e.text))).toBe(false);
  });

  it("F31-1: a colliding branch's footprint is never recorded as this task's stats", async () => {
    // Pass-31 live: a fresh VIB-1 whose agent errored before creating ANY
    // branch showed "14 files · +313 −30" and two commits from a wiped
    // instance's `vib-1`, and the completion evidence later claimed
    // "2 commit(s) delivered". The prefix filter cannot save the commits half
    // — the stranger's commits carry the SAME `[VIB-301]` prefix here. While
    // an unowned PR stands on the branch, the compare/PR footprint records
    // nothing as this task's.
    // Canary: drop `&& !unownedPr` from `prefixCommits` and the foreign
    // `[VIB-301]` commits land in `github.commits` again.
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "impl",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        // No pr, no workRevision: nothing was ever delivered by THIS task.
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl },
    );

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    // The collision itself is recorded…
    expect(fm.github?.unownedPr).toBe(318);
    // …but the stranger's footprint is not: no commits (despite the
    // prefix-matched `[VIB-301]` entries in the compare) and no diff stats.
    expect(fm.github?.commits ?? []).toEqual([]);
    expect(fm.github?.changed ?? null).toBeNull();
  });

  it("U36-7: a NEW branch collision reaches the task watchers' inbox once — a persisting one never re-notifies", async () => {
    // Pass-36 live (HLC-10): the reconciler wrote `github.unownedPr: 7` and a
    // timeline note, and nothing else — no inbox row, so the owner learned of
    // the collision only by visiting the task page. The adoption and the
    // divergence trio already notify from this same pass; the collision did
    // not. Canary: drop the collision `notifyTaskWatchers` call.
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "impl",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const policyNotes = () =>
      listNotifications(store.db, store.users.arda.id).filter((n) => n.kind === "policy");

    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl },
    );
    const first = policyNotes();
    expect(first.map((n) => n.title)).toContain(
      "Branch name collision on VIB-301: PR #318 is not this task's",
    );
    const notice = first.find((n) => (n.title ?? "").startsWith("Branch name collision"))!;
    // The inbox text IS the collision note: whose PR it is not, and the remedy.
    expect(notice.text).toContain("is NOT VIB-301's review PR");
    expect(notice.text).toContain("`resolve_remote_collision`");

    // The same collision on the next pass is not news.
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl },
    );
    expect(policyNotes().filter((n) => (n.title ?? "").startsWith("Branch name collision"))).toHaveLength(1);
  });

  it("U36-7: clearing a collision writes ONE event that names the closed PR and the deleted branch — even when GitHub refused the explicit close", async () => {
    // Live (HLC-10, 15:38Z): the resolution closed PR #7 and deleted the
    // branch, but the timeline said only "Deleted branch `hlc-10-0c88`" —
    // the close is recorded only when GitHub answers the PATCH with 200, and
    // it did not (the ref delete had already taken the head with it). The
    // ceremony's own event now names the PR's fate in every arm, confirming
    // it against GitHub when the explicit close was refused.
    // Canary: gate the event on `close.ok` again and the 422 arm below writes
    // nothing about PR #318.
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "review",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        github: { commits: [], changed: null, unownedPr: 318 },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const gh = fakeGithubFetch({
      [`DELETE ${REPO_PATH}/git/refs/heads/vib-301-workspace`]: { status: 204, body: "" },
      [`PATCH ${REPO_PATH}/pulls/318`]: {
        status: 422,
        body: { message: "Validation Failed" },
      },
      // The re-read that stands in for the refused close: GitHub closed the
      // PR with its head.
      [`GET ${REPO_PATH}/pulls/318`]: {
        body: { number: 318, state: "closed", merged: false, merged_at: null, head: { sha: "headsha318" } },
      },
    });

    const result = await resolveRemoteBranchCollision(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toMatchObject({ status: "cleared", branch: "vib-301-workspace", closedUnownedPr: null });

    const events = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!
      .parsed.timeline;
    const cleared = events.find((e) => e.text.startsWith("Branch collision cleared:"));
    expect(cleared).toBeDefined();
    expect(cleared!.type).toBe("github");
    expect(cleared!.text).toContain("deleted branch `vib-301-workspace`");
    expect(cleared!.text).toContain("PR #318");
    expect(cleared!.text).toContain("is closed on GitHub");
    expect(cleared!.text).toContain("not VIB-301's review PR");
    // Honest about the refusal: Viberr's own close did not go through.
    expect(cleared!.text).toContain("Validation Failed");
    // No close is CLAIMED as Viberr's: the audit row for a Viberr close stays absent.
    expect(listAuditEvents(store.db, { action: "github.pr.closed_unowned" })).toHaveLength(0);
  });

  it("V5: a PR-LESS stale branch's foreign commits are never recorded as this task's", async () => {
    // F31-1 gated on `!unownedPr`, which is only ever set when a PR was FOUND on
    // the branch. A stale remote branch under a reused key needs no PR to tell
    // the same lie: its `[VIB-301]`-prefixed commits match the prefix filter,
    // the absence test passed, and the stranger's commits were recorded as this
    // task's footprint with no collision row to explain them.
    // Canary: relax `deliveredThisBranch` back to `!unownedPr` (drop the
    // positive test) and the two foreign commits land in `github.commits`.
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "impl",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        // No pr, no workRevision: this task has delivered nothing anywhere.
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const routes = happyRoutes();
    // Nobody opened a PR on the branch — the squatter is the branch itself.
    routes[`GET ${REPO_PATH}/pulls`] = { body: [] };
    const result = await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );

    expect(result).toMatchObject({ status: "reconciled", commits: 0 });
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.github?.commits ?? []).toEqual([]);
    expect(fm.github?.changed ?? null).toBeNull();
    // Residual, deliberately asserted: the collision SURFACE keys on a PR
    // number, so a PR-less squatter has nothing to render. The lie is stopped;
    // naming it needs a marker the file format does not have.
    expect(fm.github?.unownedPr ?? null).toBeNull();
  });

  it("ruling 161 (U35-8): a head the task's record does not account for is written as github.foreignHead", async () => {
    // Canary: drop the `foreignHead` write in the reconciler and both records
    // below are absent; the archive dialog then cannot say what origin holds.
    const { store, actor } = setup();
    const fmOf = () =>
      readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!
        .parsed.frontmatter;
    // 1. A stranger's PR stands on the branch: its head is the foreign head.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "impl",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl },
    );
    expect(fmOf().github?.unownedPr).toBe(318);
    expect(fmOf().github?.foreignHead).toEqual({ sha: "headsha318", prNumber: 318 });

    // 2. No PR at all, the branch ahead of the base with no delivery of this
    //    task behind it (the V5 squatter): the compare's tip is the head.
    const prLess = happyRoutes();
    prLess[`GET ${REPO_PATH}/pulls`] = { body: [] };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(prLess).fetchImpl },
    );
    expect(fmOf().github?.unownedPr ?? null).toBeNull();
    expect(fmOf().github?.foreignHead).toEqual({ sha: "0000000ffff", prNumber: null });

    // 3. KNC-21 itself: the agent REPORTED a revision on this branch, the
    //    delivery push was refused non-fast-forward, and origin's branch holds
    //    a stranger's commit. Ruling 161(a) is explicit that a reported head is
    //    not a delivered one, so this head is NOT proven the task's and the
    //    disclosure the archive dialog needs must be recorded. Canary: gate the
    //    record on `deliveredThisBranch` (which counts the report) and this is
    //    null again, exactly as it was live.
    const reported = {
      id: "rev_1",
      headSha: "a91f7c2ffff",
      treeSha: null,
      branch: "vib-301-workspace",
      createdAt: "2026-08-31T08:00:00.000Z",
      sourceProfileId: "developer",
    };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "impl",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        workRevision: reported,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(prLess).fetchImpl },
    );
    expect(fmOf().github?.foreignHead).toEqual({ sha: "0000000ffff", prNumber: null });

    // 4. The same revision once the delivery push PUBLISHED its head: it left
    //    the workspace on this branch, so the head is proven the task's and the
    //    record is dropped.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "impl",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        github: { commits: [], changed: null, foreignHead: { sha: "0000000ffff", prNumber: null } },
        workRevision: { ...reported, pushedAt: "2026-08-31T09:00:00.000Z" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(prLess).fetchImpl },
    );
    expect(fmOf().github?.foreignHead ?? null).toBeNull();
  });

  it("V5: a branch this task delivered still records its commits with no PR at all", async () => {
    // The other half of positive provenance: the evidence is not only an owned
    // PR. A task whose work revision was minted ON THIS BRANCH delivered here,
    // so the branch's `[VIB-301]` commits are its own — before any PR exists.
    // Canary: narrow `deliveredThisBranch` to `ownsAPr || fm.pr !== null` and
    // this task's real commits vanish from its footprint.
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "impl",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        workRevision: {
          id: "rev_1",
          headSha: "a91f7c2ffff",
          treeSha: null,
          branch: "vib-301-workspace",
          createdAt: "2026-08-31T08:00:00.000Z",
          sourceProfileId: "developer",
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/pulls`] = { body: [] };
    const result = await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );

    expect(result).toMatchObject({ status: "reconciled", commits: 2 });
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    // Ruling 187: each entry is stamped with whether the remote has it. These
    // came FROM the compare, so they are pushed.
    expect(fm.github?.commits).toEqual([
      { sha: "a91f7c2", msg: "[VIB-301] add repo attach policy gate", pushed: true },
      { sha: "4ce0b18", msg: "[VIB-301] branch reconciler", pushed: true },
    ]);
  });

  it("V5: a foreign footprint cached before the collision was visible is DROPPED, not carried", async () => {
    // Cache permanence. The pass that recorded "14 files · +313 −30" and two
    // foreign commits ran BEFORE the collision was detectable; every pass after
    // it skipped re-derivation and fell back to `existingCommits`, so the lie
    // outlived the fix that stopped writing it. A cache with no delivery record
    // behind it is compare-derived and goes with the provenance that failed.
    // Canary: restore `commits: branchCommits ?? existingCommits` and
    // `changed: ownedChanged ?? existingGithub?.changed ?? null` and the stale
    // foreign footprint survives every reconcile forever.
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "impl",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        // No pr, no workRevision — but a footprint an earlier pass wrote.
        github: {
          commits: [
            { sha: "a91f7c2", msg: "[VIB-301] add repo attach policy gate" },
            { sha: "4ce0b18", msg: "[VIB-301] branch reconciler" },
          ],
          changed: { files: 14, add: 313, del: 30 },
          unownedPr: null,
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl },
    );

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.github?.commits ?? []).toEqual([]);
    expect(fm.github?.changed ?? null).toBeNull();
    // The collision is still named, and the drop reaches every surface.
    expect(fm.github?.unownedPr).toBe(318);
    const detail = getTaskDetail(store.db, store.slug, "VIB-301");
    expect(detail?.commits).toEqual([]);
    expect(detail?.changed).toBeNull();
  });

  it("V5: a delivered branch KEEPS its workspace-captured cache while a collision stands", async () => {
    // The counterweight to the drop above. The workspace-delivery path writes
    // `github.commits` and `workRevision` together, so a cache with that record
    // behind it was captured from the task's OWN run — a stranger appearing on
    // the branch stops new derivation (F31-1) but must not erase honest history.
    // Canary: gate `cachedCommits` on `provenBranchHead` instead of
    // `deliveredThisBranch` and the delivered footprint is wiped by the squatter.
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "review",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        // Delivered here, but the PR standing on the branch is somebody else's
        // (its head is not this revision, so R16-1 refuses adoption).
        workRevision: {
          id: "rev_1",
          headSha: "deliveredsha",
          treeSha: null,
          branch: "vib-301-workspace",
          createdAt: "2026-08-31T08:00:00.000Z",
          sourceProfileId: "developer",
        },
        github: {
          commits: [{ sha: "de11ver", msg: "delivered from the workspace" }],
          changed: null,
          unownedPr: null,
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl },
    );

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.github?.unownedPr).toBe(318);
    expect(fm.github?.commits).toEqual([
      { sha: "de11ver", msg: "delivered from the workspace" },
    ]);
    // …and the stranger's prefix-matched commits are still not adopted into it.
    expect(fm.github?.commits?.some((c) => c.sha === "a91f7c2")).toBe(false);
  });

  it("T3/R15-15: the recorded collision reaches the PROJECTION every surface reads", async () => {
    // The frontmatter write is only half of it. `unownedPr` is a DISPLAY fact:
    // the task-detail GitHub card renders collision framing off it, and the
    // archive ceremony asks for a remote-branch decision because of it. Both
    // read the projection, never the file — so a reconcile that recorded the
    // collision and did not reproject would leave every surface still saying
    // "no pull request", which is the state that produced the bad advice
    // R15-15 was filed for.
    // Canary: drop `unownedPr: unownedPr?.number ?? null` from `newGithub` in
    // `reconcileTaskUnlocked` and the projected value reads null while the
    // task's own `pr` assertion still passes.
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "impl",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        // No `pr`: this task opened nothing. #318 on the branch is a stranger's.
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl },
    );

    const detail = getTaskDetail(store.db, store.slug, "VIB-301");
    expect(detail?.unownedPr).toBe(318);
    // …and the stranger never becomes the task's own PR on the way through.
    expect(detail?.pr).toBeNull();
  });

  it("R16-1/H8: a name-matched MERGED stranger never replaces the PR the task owns", async () => {
    // Live H8, 2026-08-04: a brand-new VIB-4 ended up with
    // `pr: {number: 113, state: merged, title: "[VIB-4] Verify MCP tool…",
    // checks 2/2}` — PR #113 was merged a week earlier by an unrelated task
    // whose head branch happened to be `vib-4`. R15-15's ownership test was
    // `fm.pr != null`, so ANY discovery on the branch was written into the
    // owned slot, number and all: the rail wore a green "merged" badge and a
    // green checks pill for work that was never delivered.
    // Canary: relax `ownsAPr` back to `fm.pr != null` and #113 lands again.
    const { store, actor } = setup();
    const gh = fakeGithubFetch({
      ...happyRoutes(),
      [`GET ${REPO_PATH}/pulls`]: {
        body: [
          {
            number: 113,
            title: "[VIB-4] Verify MCP tool and knowledge-base wiring",
            state: "closed",
            draft: false,
            merged_at: "2026-07-28T10:00:00Z",
            head: { sha: "93435df" },
          },
        ],
      },
      [`GET ${REPO_PATH}/pulls/113`]: {
        body: {
          number: 113,
          title: "[VIB-4] Verify MCP tool and knowledge-base wiring",
          state: "closed",
          merged: true,
          merged_at: "2026-07-28T10:00:00Z",
          head: { sha: "93435df" },
          additions: 5,
          deletions: 0,
          changed_files: 1,
        },
      },
      [`GET ${REPO_PATH}/commits/93435df/check-runs`]: {
        body: {
          total_count: 2,
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "success" },
          ],
        },
      },
    });
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr, "the owned link stands").toMatchObject({
      number: 318,
      state: "review",
    });
    // …and nothing about a merge is announced, because nothing of THIS task's
    // merged — the false "merged out of band" divergence is what then told the
    // operator to accept a completion that never happened.
    // SAFETY: the SELECT names one column, declared `text TEXT NOT NULL`.
    const events = store.db
      .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
      .all() as { text: string }[];
    expect(events.some((e) => /Divergence/.test(e.text))).toBe(false);
    expect(events.some((e) => /Branch name collision/.test(e.text))).toBe(true);
  });

  it("R15-15: the collision is reported ONCE, not on every 5-minute poll", async () => {
    // Polling stays — tracking PR updates is the point of it. What must not
    // repeat is the warning: ~288 identical notes a day would bury the timeline
    // the note exists to inform.
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "impl",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const run = () =>
      reconcileTask(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-301" },
        actor,
        { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl },
      );
    await run();
    await run();
    await run();

    // SAFETY: the SELECT names one column, declared `text TEXT NOT NULL`.
    const notes = (
      store.db
        .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
        .all() as { text: string }[]
    ).filter((e) => /Branch name collision/.test(e.text));
    expect(notes).toHaveLength(1);
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

  it("F19-19: two OVERLAPPING passes announce the divergence once, and notify once", async () => {
    // `reconcileTask` reads the task file, then awaits 2-4 GitHub round trips
    // before writing, and every out-of-band guard compares the live PR state
    // against the PRE-await snapshot. Nothing serialized two passes over one
    // task: no lock in reconcileProject/runReconcile, the poller runs
    // independently of the "Update status" button, and that button's disabled
    // guard is per-fetcher — so two maintainers (or one in two tabs) both saw
    // `pr.state: review`, both computed "just merged", and the task got the
    // divergence note TWICE plus two inbox rows for one event.
    //
    // The sequential case was already covered (the test above) and always
    // passed; only the concurrent one was uncovered. Canary: call
    // `reconcileTaskExclusive` directly (drop `serializePerTask`) and the
    // counts below become 2.
    const { store, actor } = setup(); // VIB-301 at "review", owner arda (admin)
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: {
        number: 318, title: "Attach execution workspace", state: "closed",
        merged: true, merged_at: "2026-07-05T09:00:00Z", head: { sha: "headsha318" },
        additions: 1, deletions: 0, changed_files: 1,
      },
    };
    const pass = () =>
      reconcileTask(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-301" },
        actor,
        { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
      );
    // Started together, never awaited in between — the real overlap.
    await Promise.all([pass(), pass()]);

    // SAFETY: the SELECT names one column, declared `text TEXT NOT NULL`.
    const events = store.db
      .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
      .all() as { text: string }[];
    expect(events.filter((e) => /\*\*Divergence:\*\*/.test(e.text))).toHaveLength(1);
    const notifs = listNotifications(store.db, store.users.arda.id).filter(
      (n) => n.kind === "policy" && /merged on GitHub/.test(n.text),
    );
    expect(notifs).toHaveLength(1);
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
        pr: { number: 318, state: "accepted", title: "Attach execution workspace" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_reconciler02" },
      actor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl },
    );
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr?.state).toBe("accepted"); // still open on GitHub → stays accepted
  });

  /**
   * The same D3/S2 guard, but for an acceptance that lands DURING the pass.
   * A reconcile decides its whole `pr` cache from a snapshot taken before
   * several awaited GitHub round trips and then writes that key wholesale, so
   * an acceptance stamping "accepted" in that window was overwritten with the
   * "review" the pass set out with — and nothing ever writes "accepted" again,
   * because only an acceptance does and the task is already in Done. "Complete
   * merge" then refuses forever.
   */
  it("does not clobber an acceptance that lands mid-pass", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-302", {
        title: "Attach execution workspace",
        stage: "impl",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr: { number: 318, state: "review", title: "Attach execution workspace" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_reconciler03" },
      actor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);

    // The acceptance lands on the FIRST GitHub round trip — i.e. after the
    // pass has taken its snapshot and before it writes.
    const inner = fakeGithubFetch(happyRoutes()).fetchImpl;
    let accepted = false;
    const fetchImpl: typeof inner = async (input, init) => {
      if (!accepted) {
        accepted = true;
        await updateTaskFile(
          { projectSlug: store.slug, taskKey: "VIB-302", dataRoot: store.dataRoot },
          (parsed) => {
            parsed.frontmatter.pr = { ...parsed.frontmatter.pr!, state: "accepted" };
            parsed.frontmatter.stage = "done";
          },
        );
      }
      return inner(input, init);
    };

    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-302" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl },
    );

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-302",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr?.state).toBe("accepted");
  });

  // Ruling 474: a delivery that rewrites the PR body during a pass's GitHub
  // round trips records the body it wrote; the pass's older snapshot must not
  // put the previous record back (the next delivery would read Viberr's own
  // rewrite as a person's edit). Canary: drop the carry under the lock.
  it("ruling 474: a body record a delivery writes mid-pass survives the pass", async () => {
    const { store, actor } = setup();
    const ref = { projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot };
    const before = { sha256: "a".repeat(64), revision: "oldhead" };
    const rewritten = { sha256: "b".repeat(64), revision: "headsha318" };
    await updateTaskFile(ref, (parsed) => {
      if (parsed.frontmatter.pr) parsed.frontmatter.pr.bodyWritten = before;
    });
    const inner = fakeGithubFetch(happyRoutes()).fetchImpl;
    let delivered = false;
    const fetchImpl: typeof inner = async (input, init) => {
      if (!delivered) {
        delivered = true;
        await updateTaskFile(ref, (parsed) => {
          if (parsed.frontmatter.pr) parsed.frontmatter.pr.bodyWritten = rewritten;
        });
      }
      return inner(input, init);
    };
    await reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor, {
      dataRoot: store.dataRoot,
      fetchImpl,
    });
    const pr = readTaskFile(ref)!.parsed.frontmatter.pr;
    // The pass did write (it learned the checks), and kept the newer record.
    expect(pr?.checks).toBeTruthy();
    expect(pr?.bodyWritten).toEqual(rewritten);
  });

  it("advances 'accepted' → 'merged' once GitHub reports the PR merged", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "done",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr: { number: 318, state: "accepted", title: "Attach execution workspace" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_reconciler02" },
      actor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: {
        number: 318, title: "Attach execution workspace", state: "closed",
        merged: true, merged_at: "2026-07-05T09:00:00Z", head: { sha: "headsha318" },
        additions: 412, deletions: 87, changed_files: 9,
      },
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr?.state).toBe("merged"); // real terminal state overrides "accepted"
  });

  it("R8-6: a PR merged out-of-band while the task isn't Done surfaces a divergence event + notifies supervisors, WITHOUT auto-advancing", async () => {
    const { store, actor } = setup(); // VIB-301 at "review", owner arda (admin)
    const routes = happyRoutes();
    // GitHub reports the PR merged directly (not through Viberr's accept flow).
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: {
        number: 318, title: "Attach execution workspace", state: "closed",
        merged: true, merged_at: "2026-07-05T09:00:00Z", head: { sha: "headsha318" },
        additions: 1, deletions: 0, changed_files: 1,
      },
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );
    // Stage is UNCHANGED — files stay canonical, no auto-advance.
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.stage).toBe("review");
    // A typed divergence event landed on the timeline (projected to task_events).
    // SAFETY: the SELECT names one column, declared `text TEXT NOT NULL`.
    const events = store.db
      .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
      .all() as { text: string }[];
    expect(events.some((e) => /\*\*Divergence:\*\* PR #318 was merged on GitHub/.test(e.text))).toBe(true);
    // The supervisor (arda: admin + owner) got a policy notification.
    const notifs = listNotifications(store.db, store.users.arda.id);
    expect(notifs.some((n) => n.kind === "policy" && /merged on GitHub/.test(n.text))).toBe(true);
    // Idempotent: a second reconcile (PR still merged in the cache) does NOT
    // re-announce the divergence.
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );
    // SAFETY: the SELECT names one column, declared `text TEXT NOT NULL`.
    const events2 = store.db
      .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
      .all() as { text: string }[];
    expect(events2.filter((e) => /\*\*Divergence:\*\*/.test(e.text))).toHaveLength(1);
  });

  /** The merged-out-of-band routes, shared by the concurrency tests below. */
  function mergedOutOfBandRoutes(): FakeRoutes {
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: {
        number: 318, title: "Attach execution workspace", state: "closed",
        merged: true, merged_at: "2026-07-05T09:00:00Z", head: { sha: "headsha318" },
        additions: 1, deletions: 0, changed_files: 1,
      },
    };
    return routes;
  }

  it("F19-19: two OVERLAPPING passes announce an out-of-band merge exactly once", async () => {
    // The test above fires the two passes SEQUENTIALLY, which is the one
    // ordering the defect cannot reach. Two OVERLAPPING passes — the poller's
    // boot pass while a maintainer presses "Update status", or two tabs — both
    // read `pr.state: review` before either writes, both learn GitHub says
    // merged, and one merge produces two divergence notes and two identical
    // inbox alerts per supervisor. NFR16 calls that chatter.
    // Canary: replace withTaskReconcileLock's body with `return work()` → both
    // counts below become 2.
    const { store, actor } = setup();
    const gh = fakeGithubFetch(mergedOutOfBandRoutes());
    const results = await Promise.all([
      reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
        { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl }),
      reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
        { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl }),
    ]);

    // SAFETY: the SELECT names one column, declared `text TEXT NOT NULL`.
    const events = store.db
      .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
      .all() as { text: string }[];
    expect(
      events.filter((e) => /\*\*Divergence:\*\* PR #318 was merged on GitHub/.test(e.text)),
    ).toHaveLength(1);
    const notifs = listNotifications(store.db, store.users.arda.id);
    expect(notifs.filter((n) => n.kind === "policy" && /merged on GitHub/.test(n.text)))
      .toHaveLength(1);
    // The mutex must not change the no-auto-advance rule.
    expect(
      readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!
        .parsed.frontmatter.stage,
    ).toBe("review");
    // A QUEUE, not a coalescer: the second pass ran its own read AFTER the
    // first wrote, so it saw the merged cache and found nothing new — rather
    // than being handed the answer computed before it was called.
    expect(results[0]).toMatchObject({ status: "reconciled", changed: true });
    expect(results[1]).toMatchObject({ status: "reconciled", changed: false });
  });

  it("F19-19/F21-9: a THROWN pass returns task_error and never strands the next one", async () => {
    // Two invariants on one fault. F21-9: an unexpected throw inside the pass
    // comes back as a typed per-task failure, so a project sweep finishes and
    // the Reconcile button answers instead of 500ing. F19-19: the chain link
    // stored in the map absorbs it, so later passes on the SAME task still run
    // — without that, poller and button alike would silently never run again.
    // Canary: drop the try/catch in `reconcileTask` → pass 1 rejects; drop the
    // rejection handler from `tail` → passes 2 and 3 never run (test times out).
    const { store, actor } = setup();
    // Fault injection: a transport whose every answer is unreadable, so the
    // first GitHub read of the pass throws instead of degrading.
    const explodingFetch: typeof fetch = async () => unreadableResponse();
    const gh = fakeGithubFetch(happyRoutes());
    const settled = await Promise.allSettled([
      reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
        { dataRoot: store.dataRoot, fetchImpl: explodingFetch }),
      reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
        { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl }),
      reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
        { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl }),
    ]);
    expect(settled[0]).toMatchObject({
      status: "fulfilled",
      value: { status: "task_error", taskKey: "VIB-301" },
    });
    expect(settled[1]).toMatchObject({ status: "fulfilled", value: { status: "reconciled" } });
    expect(settled[2]).toMatchObject({ status: "fulfilled", value: { status: "reconciled" } });
  });

  function seedWithRecs(store: TestStore) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "review",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        // R15-15: this rewrite replaces setup()'s task wholesale, so it has to
        // carry the same PR ownership — a divergence is only reportable about a
        // PR the task actually owns.
        pr: { number: 318, state: "review", title: "Attach execution workspace" },
        recommendations: [
          { id: "r-trans", kind: "transition", toStageId: "done", label: "Move VIB-301 to Done", detail: "" },
          { id: "r-accept", kind: "accept_completion", toStageId: "done", label: "Accept completion", detail: "" },
          { id: "r-assign", kind: "run_agent", profileId: "developer", label: "Run Developer", detail: "" },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  it("R8-6: a CLOSED-out-of-band divergence withdraws the moot transition + accept_completion recs (assign survives)", async () => {
    const { store, actor } = setup();
    seedWithRecs(store);
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: { number: 318, title: "Attach execution workspace", state: "closed",
        merged: false, head: { sha: "headsha318" }, additions: 1, deletions: 0, changed_files: 1 },
    };
    await reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl });
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed.frontmatter;
    // transition + accept_completion withdrawn (PR is gone); assign_specialist survives.
    expect(fm.recommendations.map((r) => r.id).sort()).toEqual(["r-assign"]);
    // SAFETY: the SELECT names one column, declared `text TEXT NOT NULL`.
    const events = store.db.prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`).all() as { text: string }[];
    expect(events.some((e) => /closed on GitHub without merging/.test(e.text) && /withdrawn/.test(e.text))).toBe(true);
  });

  const mergedOutOfBand = async (store: TestStore, actor: Parameters<typeof reconcileTask>[2]) => {
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: { number: 318, title: "Attach execution workspace", state: "closed",
        merged: true, merged_at: "2026-07-05T09:00:00Z", head: { sha: "headsha318" },
        additions: 1, deletions: 0, changed_files: 1 },
    };
    await reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl });
    // SAFETY: the SELECT names one column, declared `text TEXT NOT NULL`.
    const events = store.db
      .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
      .all() as { text: string }[];
    return {
      fm: readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!
        .parsed.frontmatter,
      divergence: events.find((e) => /was merged on GitHub/.test(e.text))?.text ?? "",
    };
  };

  it("R8-6 / U36-12: a MERGED-out-of-band divergence keeps BOTH the accept and the transition that leads to it", async () => {
    // Live (HLC-14, 18:13Z): the note said "Accept the completion (or move it
    // to Done)" while the same pass withdrew the "Move the task to Merge
    // Approval" card — the only route to an Accept the page does not offer at
    // Agent Review. A merged PR does not falsify advancing; it is the reason to.
    // Canary: put `divergenceText !== null` back in the transition filter and
    // `r-trans` disappears again.
    const { store, actor } = setup();
    seedWithRecs(store);
    const { fm, divergence } = await mergedOutOfBand(store, actor);
    expect(fm.recommendations.map((r) => r.id).sort()).toEqual(["r-accept", "r-assign", "r-trans"]);
    // This task IS at the boundary (`review` → `done`), so the note says accept.
    expect(divergence).toContain("Accept the completion so the task reflects the merge.");
    expect(divergence).not.toContain("Move it to");
  });

  it("U36-12: at a stage that cannot accept, the note names the boundary instead of an Accept the page does not offer", async () => {
    // Canary: drop the `canAcceptFromStage` branch and the note tells a human
    // at In Progress to "Accept the completion" — the operator's own
    // `accept_completion` is refused there with "not Review", and no control
    // offers it.
    const { store, actor } = setup();
    seedWithRecs(store);
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: { ...file.parsed.frontmatter, stage: "impl" },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const { fm, divergence } = await mergedOutOfBand(store, actor);
    expect(divergence).toContain(
      "Move it to Review first — a completion can only be accepted from there — then accept it",
    );
    expect(divergence).not.toContain("Accept the completion so");
    // …and the card that gets there is still on the task.
    expect(fm.recommendations.map((r) => r.id)).toContain("r-trans");
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
        // The workspace delivery that captured those commits stamped the
        // revision they came from in the same pass — the record that makes this
        // branch (and so this cache) demonstrably the task's own (V5). Its head
        // is the branch's PR head, so the reconcile owns the PR it discovers
        // and the prefix filter actually runs.
        workRevision: {
          id: "rev_1",
          headSha: "headsha318",
          treeSha: null,
          branch: "vib-301-workspace",
          createdAt: "2026-07-01T09:00:00.000Z",
          sourceProfileId: "developer",
        },
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
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);

    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/compare/main...vib-301-workspace`] = {
      body: {
        ahead_by: 2,
        behind_by: 0,
        status: "ahead",
        commits: [
          // Same real work — but no `[VIB-301]` bracket prefix anywhere.
          { sha: "a91f7c2ffff", commit: { message: "VIB-301: add repo attach policy gate" } },
          { sha: "4ce0b18ffff", commit: { message: "wire the branch reconciler" } },
        ],
      },
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.github?.commits).toEqual([
      // Ruling 187: the carve-out's real case — the agent skipped the `[KEY]`
      // prefix so the filter found nothing, the cache is kept, AND the compare
      // proves both commits are genuinely on the branch.
      { sha: "a91f7c2", msg: "VIB-301: add repo attach policy gate", pushed: true },
      { sha: "4ce0b18", msg: "wire the branch reconciler", pushed: true },
    ]);
  });

  it("a Complete-merge landing mid-pass is not clobbered back to accepted (bug-sweep #3)", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-302", {
        title: "Race merge",
        stage: "done",
        branch: "vib-302-race",
        ownerUserId: store.users.arda.id,
        pr: { number: 319, state: "accepted", title: "Race merge" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_reconciler05" },
      actor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);

    const routes = happyRoutes();
    // PR still OPEN on GitHub, so the pass carries the local "accepted" forward.
    routes[`GET ${REPO_PATH}/pulls/319`] = {
      body: {
        number: 319, title: "Race merge", state: "open",
        merged: false, merged_at: null, head: { sha: "headsha319" },
        additions: 1, deletions: 0, changed_files: 1,
      },
    };
    const base = fakeGithubFetch(routes).fetchImpl;
    let raced = false;
    const fetchImpl: typeof base = async (url, init) => {
      // A human clicks Complete merge DURING the pass's awaited round trips:
      // stamp pr.state "merged" once, before the pass writes its snapshot back.
      if (!raced) {
        raced = true;
        await updateTaskFile(
          { projectSlug: store.slug, taskKey: "VIB-302", dataRoot: store.dataRoot },
          (p) => {
            if (p.frontmatter.pr) p.frontmatter.pr.state = "merged";
          },
        );
      }
      return base(url, init);
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-302" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl },
    );
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-302",
      dataRoot: store.dataRoot,
    })!;
    // The irreversible merge survived; the accepted pass did NOT stamp it back
    // down (which would re-offer "Complete merge" on an already-merged PR).
    expect(file.parsed.frontmatter.pr?.state).toBe("merged");
  });

  it("accepted PR closed on GitHub without merging → downgrade + typed policy event explaining why (B9)", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "done",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr: { number: 318, state: "accepted", title: "Attach execution workspace" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_reconciler04" },
      actor,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);

    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: {
        number: 318, title: "Attach execution workspace", state: "closed",
        merged: false, merged_at: null, head: { sha: "headsha318" },
        additions: 412, deletions: 87, changed_files: 9,
      },
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!;
    expect(file.parsed.frontmatter.pr?.state).toBe("closed");
    // P13-LV-03: a neutral divergence note, not a policy VIOLATION.
    const policy = file.parsed.timeline.find((e) => e.type === "note");
    expect(policy?.text).toContain(
      "accepted PR #318 was closed on GitHub without merging",
    );
    // P14-GV-09: this is a divergence like the other two — the Complete-merge
    // affordance just VANISHED from an accepted task — so it must reach the
    // supervisors' inbox, not only a visitor to the task page.
    const notifs = listNotifications(store.db, store.users.arda.id);
    const alert = notifs.find(
      (n) => n.kind === "policy" && /closed on GitHub without merging/.test(n.text),
    );
    expect(alert).toBeDefined();
    expect(alert!.title).toContain("merge can't complete");
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

  it("a RATE-LIMIT 403 is transient — no bogus repo scope violation (DG-3)", async () => {
    const { store, actor } = setup();
    const result = await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      {
        dataRoot: store.dataRoot,
        fetchImpl: fakeGithubFetch({
          [`GET ${REPO_PATH}/compare/main...vib-301-workspace`]: {
            status: 403,
            headers: { "x-ratelimit-remaining": "0" },
            body: { message: "API rate limit exceeded for installation" },
          },
        }).fetchImpl,
      },
    );
    // Transient, NOT a permissions failure: skip without a scope violation.
    expect(result.status).toBe("network_unavailable");
    expect(findOpenScopeViolation(store.db, store.slug, "repo", "VIB-301")).toBeNull();
  });
});

// ---------------------------------------- P13-D-28 checks + review persistence

describe("reconcileTask persists CI health and review state (P13-D-28)", () => {
  const REVIEWS = `GET ${REPO_PATH}/pulls/318/reviews`;

  function readPr(store: TestStore) {
    return readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter.pr;
  }

  it("writes pr.review onto the PR ref and projects it", async () => {
    const { store, actor } = setup();
    const routes = happyRoutes();
    routes[REVIEWS] = {
      body: [
        { user: { login: "ayse" }, state: "APPROVED" },
        { user: { login: "mert" }, state: "CHANGES_REQUESTED" },
      ],
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );
    expect(readPr(store)).toMatchObject({
      number: 318,
      state: "review",
      review: "changes_requested",
      checks: { total: 2, passing: 2, failing: 0, pending: 0 },
    });
    // SAFETY: the reconcile above cached the PR and reprojected it, so this
    // row exists and `pr_json` carries it.
    const row = store.db
      .prepare(
        `SELECT pr_json FROM task_projections
         WHERE project_slug = ? AND task_key = 'VIB-301'`,
      )
      .get(store.slug) as { pr_json: string };
    expect(JSON.parse(row.pr_json)).toMatchObject({ review: "changes_requested" });
    // The observation row carries the two newly-consumed facts.
    // SAFETY: the reconciler records a details payload on every
    // `github.reconcile` row it writes.
    const prov = store.db
      .prepare(
        `SELECT details_json FROM provenance WHERE action = 'github.reconcile'`,
      )
      .all() as { details_json: string }[];
    expect(JSON.parse(prov[0]!.details_json)).toMatchObject({
      prReview: "changes_requested",
      prChecks: { total: 2, passing: 2 },
    });
  });

  it("a FAILED reviews/check-runs read keeps the last-known values (unknown ≠ none)", async () => {
    const { store, actor } = setup();
    const good = happyRoutes();
    good[REVIEWS] = { body: [{ user: { login: "ayse" }, state: "APPROVED" }] };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(good).fetchImpl },
    );
    expect(readPr(store)).toMatchObject({
      review: "approved",
      checks: { total: 2, passing: 2 },
    });

    // Second pass: GitHub 500s on BOTH quality endpoints. Blanking the pills on
    // a transient hiccup would read as "CI never ran" / "nobody reviewed".
    const flaky = happyRoutes();
    flaky[REVIEWS] = { status: 500, body: { message: "Server Error" } };
    flaky[`GET ${REPO_PATH}/commits/headsha318/check-runs`] = {
      status: 500,
      body: { message: "Server Error" },
    };
    const second = await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(flaky).fetchImpl },
    );
    expect(second).toMatchObject({ status: "reconciled", changed: false });
    expect(readPr(store)).toMatchObject({
      review: "approved",
      checks: { total: 2, passing: 2 },
    });
  });

  it("ruling 360: a REFUSED check-runs read is persisted, flags `checks:read`, and the first successful read clears both", async () => {
    // CANARY: drop `owned.checksUnread` (the file stays silent) or the flag
    // (the credential never learns why CI is invisible).
    const { store, actor } = setup();
    const refused = happyRoutes();
    refused[`GET ${REPO_PATH}/commits/headsha318/check-runs`] = {
      status: 403,
      body: { message: "Resource not accessible by personal access token" },
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(refused).fetchImpl },
    );
    const pr = readPr(store);
    expect(pr?.checks).toBeUndefined();
    expect(pr?.checksUnread).toMatchObject({
      status: 403,
      message: "Resource not accessible by personal access token",
    });
    expect(findOpenScopeViolation(store.db, store.slug, "checks:read", "VIB-301")).not.toBeNull();
    // Another task's row, opened while its PR was still open; that PR has
    // since merged, so nothing will ever read its checks again.
    openScopeViolation(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-777",
      scope: "checks:read",
      detail: "seeded",
    });

    // The read succeeds: the summary lands, the refusal goes, and EVERY open
    // checks:read row in the project resolves (CANARY: resolve this task's only).
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl },
    );
    const after = readPr(store);
    expect(after?.checks).toMatchObject({ total: 2, passing: 2 });
    expect(after?.checksUnread).toBeUndefined();
    expect(findOpenScopeViolation(store.db, store.slug, "checks:read", "VIB-301")).toBeNull();
    expect(findOpenScopeViolation(store.db, store.slug, "checks:read", "VIB-777")).toBeNull();
  });

  it("a real CI/review change overwrites the cache (preservation is not stickiness)", async () => {
    const { store, actor } = setup();
    const first = happyRoutes();
    first[REVIEWS] = { body: [{ user: { login: "ayse" }, state: "CHANGES_REQUESTED" }] };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(first).fetchImpl },
    );
    expect(readPr(store)).toMatchObject({ review: "changes_requested" });

    const second = happyRoutes();
    second[REVIEWS] = {
      body: [
        { user: { login: "ayse" }, state: "CHANGES_REQUESTED" },
        { user: { login: "ayse" }, state: "APPROVED" },
      ],
    };
    second[`GET ${REPO_PATH}/commits/headsha318/check-runs`] = {
      body: {
        total_count: 2,
        check_runs: [
          { status: "completed", conclusion: "failure" },
          { status: "in_progress", conclusion: null },
        ],
      },
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(second).fetchImpl },
    );
    expect(readPr(store)).toMatchObject({
      review: "approved",
      checks: { total: 2, passing: 0, failing: 1, pending: 1 },
    });
  });

  it("a settled PR drops pr.review — a frozen verdict next to 'merged' is a lie", async () => {
    const { store, actor } = setup();
    const open = happyRoutes();
    open[REVIEWS] = { body: [{ user: { login: "ayse" }, state: "APPROVED" }] };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(open).fetchImpl },
    );
    expect(readPr(store)).toMatchObject({ review: "approved" });

    const merged = happyRoutes();
    merged[`GET ${REPO_PATH}/pulls/318`] = {
      body: {
        number: 318,
        title: "Attach execution workspace",
        state: "closed",
        merged: true,
        merged_at: "2026-07-20T09:00:00Z",
        head: { sha: "headsha318" },
        additions: 412,
        deletions: 87,
        changed_files: 9,
      },
    };
    merged[`GET ${REPO_PATH}/branches/vib-301-workspace`] = {
      body: { commit: { sha: "headsha318" } },
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(merged).fetchImpl },
    );
    const pr = readPr(store);
    expect(pr).toMatchObject({ state: "merged" });
    expect("review" in pr!).toBe(false);
  });

  it("a task.md `repo:` override is inert — the PROJECT repo is used (P13-D-5)", async () => {
    const { store, actor } = setup();
    // The override used to win here. Nothing can write the field any more, so a
    // leftover line must not redirect reconcile at a repo the project never set.
    // SAFETY: deliberately INVALID input — `repo:` is that retired override and
    // the frontmatter type no longer declares it. The assertions below prove it
    // survives as an unknown key and is never read back as frontmatter.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: {
        ...baseTaskFrontmatter("VIB-301", {
          title: "Attach execution workspace",
          stage: "review",
          branch: "vib-301-workspace",
          ownerUserId: store.users.arda.id,
        }),
        repo: "akin-ozer/some-other-repo",
      } as ReturnType<typeof baseTaskFrontmatter>,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!;
    // The line really is on disk (so the assertion below is not vacuous) — and
    // it is preserved as an UNKNOWN key, not read back as frontmatter.
    expect(file.content).toContain("repo: akin-ozer/some-other-repo");
    expect(file.parsed.unknownFrontmatter).toMatchObject({
      repo: "akin-ozer/some-other-repo",
    });

    const gh = fakeGithubFetch(happyRoutes());
    const result = await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toMatchObject({ status: "reconciled", repo: "akin-ozer/viberr" });
    expect(
      gh.calls.every((c) => c.url.pathname.startsWith("/repos/akin-ozer/viberr/")),
    ).toBe(true);
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
    const bare = setupProjectedStore(ctx);
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
    // Open the VIB-142 pull_request:write violation explicitly — it used to be
    // seeded by migration 0005; the squashed baseline is schema-only, so tests
    // that resolve it now create it (self-contained, no reliance on a mock seed).
    openScopeViolation(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-142",
      scope: "pull_request:write",
      detail: "Project credential is missing pull_request:write.",
    });
    return { store, actor };
  }

  it("F28-U2a / ruling 480: a merge with NO open violation proves pull_request:write, and repo", async () => {
    const { store, actor } = setup(); // VIB-301 owns PR #318, PAT bound, NO violation
    // Give the bound PAT the state the connection's own Re-check leaves on a
    // fine-grained token (ruling 480, F40-43): asked about no repository, so
    // BOTH scopes are assumed, "verified on first use".
    const bound = getProjectCredential(store.db, store.slug)!;
    recordPatValidation(store.db, bound.id, {
      status: "valid",
      checkedAt: "2026-08-24T00:00:00.000Z",
      login: "viberr-bot",
      tokenKind: "fine_grained",
      expiresAt: null,
      repo: null,
      scopes: [
        { id: "repo", ok: true, source: "assumed" },
        { id: "pull_request:write", ok: true, source: "assumed" },
      ],
      missingScopes: [],
      headerScopes: null,
      detail: "Authenticated.",
    });
    // Ruling 480: read as the card reads it, the project's repository's proof.
    const sourceOf = (id: string) =>
      getProjectCredentialHealth(store.db, store.slug).scopes.find((s) => s.id === id)!
        .source;
    const scopeSource = () => sourceOf("pull_request:write");
    // The PR was opened out-of-band (e.g. an agent's own git creds), so nothing
    // ever exercised viberr's PAT — no violation is open, chip still "assumed".
    expect(countOpenPolicyViolations(store.db, store.slug)).toBe(0);
    expect(scopeSource()).toBe("assumed");
    expect(sourceOf("repo")).toBe("assumed");

    const gh = fakeGithubFetch({
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        body: { merged: true, sha: "mergesha02", message: "merged" },
      },
      [`DELETE ${REPO_PATH}/git/refs/heads/vib-301-workspace`]: { status: 204 },
    });
    const result = await mergeTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toEqual({ status: "merged", prNumber: 318, sha: "mergesha02" });
    // The merge — the FIRST real use of the bound PAT — proved the scope, even
    // though there was no violation to resolve. Ruling 480: merging moved the
    // base branch (Contents write), so `repo` is proven on this repository too.
    // Canary: prove only `pull_request:write` on a merge (WRITE_PROOF.merge).
    expect(scopeSource()).toBe("probe");
    expect(sourceOf("repo")).toBe("probe");
  });

  it("merges, flips the cache, writes the github event, resolves the task's pull_request:write violation", async () => {
    const { store, actor } = setupWithPr();
    // The VIB-142 violation opened in setup is open on this slug.
    expect(countOpenPolicyViolations(store.db, store.slug)).toBe(1);

    const gh = fakeGithubFetch({
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        body: { merged: true, sha: "mergesha01", message: "Pull Request successfully merged" },
      },
      // R15-6: cleanup rides the merge now (project policy default ON).
      [`DELETE ${REPO_PATH}/git/refs/heads/vib-142-attach-workspace`]: {
        status: 204,
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
    // Newest first: branch cleanup, policy update (violation resolved), merge.
    const texts = file.parsed.timeline.map((e) => e.text);
    expect(texts[0]).toContain("Deleted branch `vib-142-attach-workspace`");
    expect(file.parsed.timeline[1]).toMatchObject({
      type: "policy",
      text: expect.stringContaining("**Policy update:** `pull_request:write` granted"),
    });
    expect(file.parsed.timeline[2]).toMatchObject({
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

  it("F7-GH5: a DRAFT PR is marked ready-for-review via GraphQL before the merge", async () => {
    const { store, actor } = setupWithPr();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/318`]: {
        body: { number: 318, draft: true, node_id: "PR_node318" },
      },
      "POST /graphql": {
        body: { data: { markPullRequestReadyForReview: { clientMutationId: null } } },
      },
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        body: { merged: true, sha: "mergesha02", message: "merged" },
      },
    });
    const result = await mergeTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-142" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toEqual({ status: "merged", prNumber: 318, sha: "mergesha02" });
    // The un-draft GraphQL mutation was issued with the PR's node id.
    const graphql = gh.calls.find((c) => c.url.pathname === "/graphql");
    expect(graphql).toBeDefined();
    expect(JSON.stringify(graphql!.body)).toContain("PR_node318");
    expect(JSON.stringify(graphql!.body)).toContain("markPullRequestReadyForReview");
  });

  it("a NON-draft PR is merged without any GraphQL un-draft call", async () => {
    const { store, actor } = setupWithPr();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/318`]: { body: { number: 318, draft: false, node_id: "PR_node318" } },
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        body: { merged: true, sha: "mergesha03", message: "merged" },
      },
    });
    const result = await mergeTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-142" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result.status).toBe("merged");
    expect(gh.calls.some((c) => c.url.pathname === "/graphql")).toBe(false);
  });

  it("P14-LV-07: a CONFLICTING PR is refused before the merge call, and the conflict is cached", async () => {
    const { store, actor } = setupWithPr();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/318`]: {
        body: { number: 318, draft: false, mergeable: false, mergeable_state: "dirty" },
      },
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        body: { merged: true, sha: "shouldnothappen", message: "merged" },
      },
    });
    const result = await mergeTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-142" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    // Typed refusal that NAMES the conflict — the caller used to see only a
    // generic false and blamed unreachable GitHub / missing credentials.
    expect(result).toMatchObject({
      status: "not_mergeable",
      prNumber: 318,
      mergeable: "conflicting",
    });
    expect(result).toMatchObject({ message: expect.stringContaining("conflicts with") });
    // The merge was never attempted.
    expect(
      gh.calls.some((c) => c.url.pathname.endsWith("/pulls/318/merge")),
    ).toBe(false);
    // …and the conflict is recorded, so the task card / GitHub page can show it.
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr).toMatchObject({ state: "review", mergeable: "conflicting" });
  });

  it("P14-LV-07: a mergeable PR clears a stale cached conflict and merges", async () => {
    const { store, actor } = setupWithPr();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-142", {
        stage: "review",
        branch: "vib-142-attach-workspace",
        pr: {
          number: 318,
          state: "review",
          title: "Attach execution workspace",
          mergeable: "conflicting",
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/318`]: {
        body: { number: 318, draft: false, mergeable: true, mergeable_state: "clean" },
      },
      [`PUT ${REPO_PATH}/pulls/318/merge`]: {
        body: { merged: true, sha: "mergesha04", message: "merged" },
      },
    });
    const result = await mergeTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-142" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toMatchObject({ status: "merged", prNumber: 318 });
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-142",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    // A merged PR is settled: the stale "conflicting" is gone, and no
    // mergeability is frozen onto it.
    expect(fm.pr).toMatchObject({ state: "merged" });
    expect(fm.pr?.mergeable ?? null).toBeNull();
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
    // SAFETY: `kind` is NOT NULL and the WHERE pins `task_key = 'VIB-301'`, so
    // a matched row has both columns as strings.
    const notification = store.db
      .prepare(
        `SELECT kind, task_key FROM notifications WHERE user_id = ? AND task_key = 'VIB-301'`,
      )
      .get(store.users.arda.id) as { kind: string; task_key: string };
    expect(notification).toMatchObject({ kind: "policy", task_key: "VIB-301" });
  });

  it("degrades typed: no PR, unknown task, no PAT", async () => {
    // The shared fixture now OWNS a PR (R15-15), so the "no PR on the task"
    // branch needs a task that genuinely has none — which is the state this
    // assertion was always about.
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-302", {
        stage: "review",
        branch: "vib-302-workspace",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(
      await mergeTaskPr(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-302" },
        actor,
        { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch({}).fetchImpl },
      ),
    ).toEqual({ status: "no_pr", taskKey: "VIB-302" });
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

/**
 * R15-6 (owner ruling 2026-07-28): merged task branches piled up on the repo
 * (vib-1..4, 7, 9 were still sitting there). Cleanup is a per-project setting,
 * default ON, and it rides the successful merge — but it is housekeeping: it
 * can never turn a merge that happened into a failure.
 */
describe("R15-6 post-merge branch cleanup", () => {
  function mergeableTask(): ReturnType<typeof setup> {
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-410", {
        title: "Cleanup after merge",
        stage: "review",
        branch: "vib-410",
        ownerUserId: store.users.arda.id,
        pr: { number: 410, state: "review", title: "Cleanup after merge" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    return { store, actor };
  }

  const mergeRoutes = (extra: FakeRoutes = {}) => ({
    [`PUT ${REPO_PATH}/pulls/410/merge`]: {
      body: { merged: true, sha: "mergesha410" },
    },
    ...extra,
  });

  it("deletes the task branch on GitHub by default", async () => {
    const { store, actor } = mergeableTask();
    const gh = fakeGithubFetch(
      mergeRoutes({
        [`DELETE ${REPO_PATH}/git/refs/heads/vib-410`]: { status: 204 },
      }),
    );
    const result = await mergeTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-410" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result.status).toBe("merged");
    // Fails on main: nothing ever deleted a merged task's branch.
    expect(
      gh.callsTo(`DELETE ${REPO_PATH}/git/refs/heads/vib-410`),
    ).toHaveLength(1);
    expect(
      listAuditEvents(store.db, { action: "github.branch.deleted" }),
    ).toHaveLength(1);
  });

  it("respects the project's opt-out — the branch stays", async () => {
    const { store, actor } = mergeableTask();
    const file = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(
      store.dataRoot,
      {
        ...file.parsed.frontmatter,
        guardrails: [
          {
            id: BRANCH_CLEANUP_GUARDRAIL_ID,
            desc: BRANCH_CLEANUP_GUARDRAIL_DESC,
            on: false,
          },
        ],
      },
      file.parsed.description,
    );
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const gh = fakeGithubFetch(mergeRoutes());
    const result = await mergeTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-410" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result.status).toBe("merged");
    expect(
      gh.calls.filter((c) => c.method === "DELETE"),
    ).toHaveLength(0);
  });

  it("a failed cleanup never demotes the merge — it lands as a plain-words note", async () => {
    const { store, actor } = mergeableTask();
    const gh = fakeGithubFetch(
      mergeRoutes({
        [`DELETE ${REPO_PATH}/git/refs/heads/vib-410`]: {
          status: 403,
          body: { message: "Resource not accessible" },
        },
      }),
    );
    const result = await mergeTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-410" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result.status).toBe("merged");
    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-410",
      dataRoot: store.dataRoot,
    })!;
    expect(task.parsed.timeline[0]).toMatchObject({
      type: "note",
      text: expect.stringContaining("was **not** deleted after the merge"),
    });
  });

  it("a THROWING cleanup never demotes the merge either", async () => {
    const { store, actor } = mergeableTask();
    const gh = fakeGithubFetch(mergeRoutes());
    // The merge succeeds; the branch delete that rides it comes back unreadable,
    // so the client throws INSIDE the cleanup block — after GitHub has merged.
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.pathname === `${REPO_PATH}/git/refs/heads/vib-410`
        ? unreadableResponse()
        : gh.fetchImpl(input, init);
    };
    const result = await mergeTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-410" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl },
    );
    // Fails on wave-2b: the cleanup block was unguarded, so a post-merge
    // housekeeping throw escaped mergeTaskPr and the caller surfaced a
    // COMPLETED merge as a failed acceptance.
    expect(result.status).toBe("merged");
    // The merge itself is still fully recorded.
    expect(
      listAuditEvents(store.db, { action: "github.pr.merged" }),
    ).toHaveLength(1);
  });
});

/**
 * B-GH5: `reconcileProject` fired `Promise.all` over EVERY branched task, each
 * costing 3-6 GitHub calls, every five minutes, per project — one PAT's whole
 * rate-limit budget in a single burst on a large board.
 */
describe("reconcileProject fan-out control", () => {
  // The rotation cursor is module-global and keyed by slug — without this a
  // second budgeted test inherits the first one's resume point.
  beforeEach(resetReconcileCursorsForTests);

  function boardOf(count: number): ReturnType<typeof setup> {
    const { store, actor } = setup();
    for (let i = 0; i < count; i++) {
      const key = `VIB-9${String(i).padStart(2, "0")}`;
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter(key, {
          stage: "review",
          branch: key.toLowerCase(),
          ownerUserId: store.users.arda.id,
        }),
      });
    }
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    return { store, actor };
  }

  /** Records the peak number of simultaneously in-flight GitHub requests. */
  function concurrencyProbe() {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl: typeof fetch = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return new Response(JSON.stringify({}), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    };
    return { fetchImpl, peak: () => peak };
  }

  it("keeps at most RECONCILE_TASK_CONCURRENCY reconciles in flight", async () => {
    const { store, actor } = boardOf(12);
    const probe = concurrencyProbe();
    const summary = await reconcileProject(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: probe.fetchImpl,
    });
    expect(summary.results).toHaveLength(13); // 12 + the setup task
    // Fails on main: Promise.all put all 13 in flight at once.
    expect(probe.peak()).toBeLessThanOrEqual(RECONCILE_TASK_CONCURRENCY);
  });

  /** Every branch compares clean and carries no PR — enough for a real
   *  `reconciled` result per task, so the budget slices are identifiable. */
  function boardRoutes(store: TestStore): FakeRoutes {
    // SAFETY: the SELECT names one column, and its own `branch IS NOT NULL`
    // predicate excludes the rows where that (nullable) column is null.
    const branches = (
      store.db
        .prepare(
          `SELECT branch FROM task_projections
            WHERE project_slug = ? AND branch IS NOT NULL`,
        )
        .all(store.slug) as { branch: string }[]
    ).map((r) => r.branch);
    const routes: FakeRoutes = {
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
    };
    for (const branch of branches) {
      routes[`GET ${REPO_PATH}/compare/main...${branch}`] = {
        body: { ahead_by: 0, behind_by: 0, status: "identical", commits: [] },
      };
    }
    return routes;
  }

  const reconciledKeys = (summary: {
    results: { status: string; taskKey?: string }[];
  }) => summary.results.flatMap((r) => (r.taskKey ? [r.taskKey] : []));

  it("a budgeted pass reconciles a slice and carries the rest to the next pass", async () => {
    const { store, actor } = boardOf(9); // 10 branched tasks in total
    const routes = boardRoutes(store);

    const first = await reconcileProject(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: fakeGithubFetch(routes).fetchImpl,
      taskBudget: 4,
    });
    // Fails on main: `taskBudget` did not exist and every task ran every tick.
    expect(first.results).toHaveLength(4);
    expect(first.skipped).toBe(6);

    const second = await reconcileProject(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: fakeGithubFetch(routes).fetchImpl,
      taskBudget: 4,
    });
    expect(second.results).toHaveLength(4);
    // The second pass resumes where the first stopped — no task is starved.
    const before = reconciledKeys(first);
    expect(before).toHaveLength(4);
    expect(reconciledKeys(second).some((k) => before.includes(k))).toBe(false);
  });

  it("a human-triggered pass has no budget — the whole board is the answer", async () => {
    const { store, actor } = boardOf(9);
    const summary = await reconcileProject(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: fakeGithubFetch(boardRoutes(store)).fetchImpl,
    });
    expect(summary.results).toHaveLength(10);
    expect(summary.skipped).toBe(0);
  });

  /**
   * R15-6 + B-GH5 compounding: cleanup deletes the remote ref but `branch:`
   * stays on the task, so merged tasks kept matching the reconcile selection
   * and kept buying a guaranteed 404 compare every pass. Under the poll budget
   * they also ate the rotation — and they sort FIRST here, so the live tasks
   * were the ones starved.
   */
  function zombieBoard(merged: number, live: number): ReturnType<typeof setup> {
    const { store, actor } = setup(); // VIB-301: branched, no PR — live
    for (let i = 0; i < merged; i++) {
      const key = `VIB-8${String(i).padStart(2, "0")}`;
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter(key, {
          stage: "review",
          branch: key.toLowerCase(),
          ownerUserId: store.users.arda.id,
          pr: { number: 800 + i, state: "merged", title: `Merged ${key}` },
        }),
      });
    }
    for (let i = 0; i < live; i++) {
      const key = `VIB-9${String(i).padStart(2, "0")}`;
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter(key, {
          stage: "review",
          branch: key.toLowerCase(),
          ownerUserId: store.users.arda.id,
        }),
      });
    }
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    return { store, actor };
  }

  it("a budgeted pass spends the whole budget on live tasks, not on merged-and-cleaned ones", async () => {
    const { store, actor } = zombieBoard(6, 2);
    const gh = fakeGithubFetch(boardRoutes(store));
    const summary = await reconcileProject(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
      taskBudget: 4,
    });
    // Fails on wave-2b: the 4-task budget was spent on VIB-301 + the first
    // three merged zombies, and the live VIB-900/901 waited for a later tick.
    expect(reconciledKeys(summary).sort()).toEqual([
      "VIB-301",
      "VIB-900",
      "VIB-901",
    ]);
    expect(summary.skipped).toBe(0);
    // Not one GitHub call is spent on a merged task's deleted branch.
    expect(gh.callsTo(`GET ${REPO_PATH}/compare/main...vib-800`)).toHaveLength(0);
  });

  it("ruling 177: a budgeted pass skips a task at the terminal stage even when its PR never merged", async () => {
    // F36-5 sub-item: a force-accepted task (Shipped, PR-less or PR open) kept
    // polling its deleted branch every 5 minutes forever because "terminal"
    // was spelled archived-OR-merged. Canary: put `archived = 1 OR merged` back
    // as the whole predicate.
    const { store, actor } = zombieBoard(0, 1);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-700", {
        stage: "done",
        branch: "vib-700",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const gh = fakeGithubFetch(boardRoutes(store));
    const summary = await reconcileProject(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
      taskBudget: 4,
    });
    expect(reconciledKeys(summary).sort()).toEqual(["VIB-301", "VIB-900"]);
    expect(gh.callsTo(`GET ${REPO_PATH}/compare/main...vib-700`)).toHaveLength(0);
  });

  it("a budgeted pass still visits a CLOSED PR — it can be reopened", async () => {
    // A closed PR is not terminal: GitHub allows reopening, and this
    // reconciler is the only thing that notices — it writes the "PR live
    // again" note, alerts the watchers and re-invokes the operator to withdraw
    // the moot recovery packet. Folding `closed` into the terminal filter made
    // all three unreachable from the poller, the only budgeted caller.
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-777", {
        stage: "review",
        branch: "vib-777",
        ownerUserId: store.users.arda.id,
        pr: { number: 777, state: "closed", title: "Closed VIB-777" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const gh = fakeGithubFetch(boardRoutes(store));
    const summary = await reconcileProject(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
      taskBudget: 4,
    });
    expect(reconciledKeys(summary)).toContain("VIB-777");
  });

  it("a manual Update status still re-checks a merged task", async () => {
    const { store, actor } = zombieBoard(6, 2);
    const summary = await reconcileProject(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: fakeGithubFetch(boardRoutes(store)).fetchImpl,
    });
    expect(reconciledKeys(summary)).toContain("VIB-800");
    expect(summary.results).toHaveLength(9);
  });
});

// ------------------------------------- R19-B human GitHub approval as verdict

/**
 * R19-B (owner ruling, pass 19) — a project member's GitHub approval on the PR
 * counts as the approving verdict. The reconciler is where that fact enters the
 * system: same `/reviews` payload the pill already costs, mapped to a member
 * through `users.github_handle`, bound to the DELIVERED revision.
 */
describe("reconcileTask records the human PR approval (R19-B)", () => {
  const REVIEWS = `GET ${REPO_PATH}/pulls/318/reviews`;

  /** The happy fixture, plus a delivered revision whose head IS the PR head. */
  function setupDelivered(headSha = "headsha318"): ReturnType<typeof setup> {
    const s = setup();
    writeTask(s.store.dataRoot, s.store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "review",
        branch: "vib-301-workspace",
        ownerUserId: s.store.users.arda.id,
        pr: { number: 318, state: "review", title: "Attach execution workspace" },
        workRevision: {
          id: "rev_1",
          headSha,
          treeSha: null,
          branch: "vib-301-workspace",
          createdAt: "2026-08-08T08:00:00Z",
          sourceProfileId: "developer",
          kind: "delivered",
        },
      }),
    });
    rebuildAll(s.store.db, { dataRoot: s.store.dataRoot, force: true });
    return s;
  }

  function readPr(store: TestStore) {
    return readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter.pr;
  }

  it("counts a project member's approval of the delivered head", async () => {
    const { store, actor } = setupDelivered();
    updateUserFields(store.db, store.users.murat.id, { githubHandle: "muratdev" });
    const routes = happyRoutes();
    routes[REVIEWS] = {
      body: [
        {
          user: { login: "muratdev" },
          state: "APPROVED",
          commit_id: "headsha318",
          submitted_at: "2026-08-08T09:00:00Z",
        },
      ],
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );
    expect(readPrHumanApproval(readPr(store))).toMatchObject({
      login: "muratdev",
      userId: store.users.murat.id,
      commitSha: "headsha318",
      status: "counted",
    });
  });

  it("fails CLOSED on an approver whose GitHub handle maps to nobody — and records WHY", async () => {
    const { store, actor } = setupDelivered();
    const routes = happyRoutes();
    routes[REVIEWS] = {
      body: [{ user: { login: "octocat" }, state: "APPROVED", commit_id: "headsha318" }],
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );
    expect(readPrHumanApproval(readPr(store))).toMatchObject({
      login: "octocat",
      userId: null,
      status: "unlinked_handle",
    });
  });

  it("fails CLOSED on a registered NON-member's approval", async () => {
    const { store, actor } = setupDelivered();
    // deniz has an account but no membership on this project.
    updateUserFields(store.db, store.users.deniz.id, { githubHandle: "denizdev" });
    const routes = happyRoutes();
    routes[REVIEWS] = {
      body: [{ user: { login: "denizdev" }, state: "APPROVED", commit_id: "headsha318" }],
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );
    expect(readPrHumanApproval(readPr(store))).toMatchObject({
      userId: store.users.deniz.id,
      status: "not_a_member",
    });
  });

  it("binds to the DELIVERED revision — an approval of an older commit does not count", async () => {
    // The PR head advanced past what was reviewed: the approval sits on an
    // earlier commit, which is exactly the R15-1 case a status pill cannot see.
    const { store, actor } = setupDelivered();
    updateUserFields(store.db, store.users.murat.id, { githubHandle: "muratdev" });
    const routes = happyRoutes();
    routes[REVIEWS] = {
      body: [{ user: { login: "muratdev" }, state: "APPROVED", commit_id: "oldersha" }],
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );
    expect(readPrHumanApproval(readPr(store))).toMatchObject({
      status: "stale_revision",
      commitSha: "oldersha",
    });
  });

  it("an UNREACHABLE GitHub keeps a satisfied gate satisfied (unknown ≠ withdrawn)", async () => {
    const { store, actor } = setupDelivered();
    updateUserFields(store.db, store.users.murat.id, { githubHandle: "muratdev" });
    const good = happyRoutes();
    good[REVIEWS] = {
      body: [{ user: { login: "muratdev" }, state: "APPROVED", commit_id: "headsha318" }],
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(good).fetchImpl },
    );
    expect(readPrHumanApproval(readPr(store))?.status).toBe("counted");

    // The reviews endpoint 500s on the next pass. Erasing the approval here
    // would flip a gate a human really satisfied into a confusing red — the
    // same "unknown is not none" rule `checks` and `review` already follow.
    const flaky = happyRoutes();
    flaky[REVIEWS] = { status: 500, body: { message: "Server Error" } };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(flaky).fetchImpl },
    );
    expect(readPrHumanApproval(readPr(store))?.status).toBe("counted");
  });

  it("a WITHDRAWN approval is a real fact and does close the gate again", async () => {
    const { store, actor } = setupDelivered();
    updateUserFields(store.db, store.users.murat.id, { githubHandle: "muratdev" });
    const good = happyRoutes();
    good[REVIEWS] = {
      body: [{ user: { login: "muratdev" }, state: "APPROVED", commit_id: "headsha318" }],
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(good).fetchImpl },
    );
    const dismissed = happyRoutes();
    dismissed[REVIEWS] = {
      body: [
        { user: { login: "muratdev" }, state: "APPROVED", commit_id: "headsha318" },
        { user: { login: "muratdev" }, state: "DISMISSED" },
      ],
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(dismissed).fetchImpl },
    );
    expect(readPrHumanApproval(readPr(store))).toBeNull();
  });

  // Ruling 474: `pr.bodyWritten` is the delivery's record of the PR body it
  // wrote, and no pass reads anything that could replace it. Canary: drop the
  // carry and the first pass erases it, so the next delivery would take a
  // person's edit for Viberr's own text. Canary: set the approval before the
  // carried key again and the second pass rewrites a file nothing changed.
  it("ruling 474: the delivery's body record rides every pass, and an unchanged PR still writes nothing", async () => {
    const { store, actor } = setupDelivered();
    const ref = { projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot };
    const bodyWritten = { sha256: "a".repeat(64), revision: "headsha318" };
    await updateTaskFile(ref, (parsed) => {
      if (parsed.frontmatter.pr) parsed.frontmatter.pr.bodyWritten = bodyWritten;
    });
    updateUserFields(store.db, store.users.murat.id, { githubHandle: "muratdev" });
    const routes = happyRoutes();
    routes[REVIEWS] = {
      body: [{ user: { login: "muratdev" }, state: "APPROVED", commit_id: "headsha318" }],
    };
    const pass = () =>
      reconcileTask(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-301" },
        actor,
        { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
      );
    await pass();
    expect(readPr(store)?.bodyWritten).toEqual(bodyWritten);
    expect(readPrHumanApproval(readPr(store))).toMatchObject({ status: "counted" });

    const before = readTaskFile(ref)!.content;
    expect(await pass()).toMatchObject({ status: "reconciled", changed: false });
    expect(readTaskFile(ref)!.content).toBe(before);
  });
});

/**
 * Ruling 135 (pass 34, F34-11): the reconciler records the PR head and, when
 * the delivered revision is not reachable from it, `pr.unpushedRevision`.
 * The PRIMARY arm is the never-pushed one: the compare's base is a LOCAL sha,
 * GitHub answers 404, and one direct commit read confirms the object is not
 * there at all. Canary: keep only the `ahead` arm of the drift compare and
 * every case below loses its record.
 */
describe("ruling 135: the unpushed delivered revision", () => {
  const REV = "rev0delivered";
  function seedOwned(opts: { unpushed?: PrRef["unpushedRevision"]; kind?: "delivered" | "verified" } = {}) {
    const store = setupTestStore(ctx);
    const pr: PrRef = { number: 318, state: "review", title: "Attach execution workspace" };
    if (opts.unpushed) pr.unpushedRevision = opts.unpushed;
    const workRevision: WorkRevision = {
      id: "rev_1",
      headSha: REV,
      treeSha: null,
      branch: "vib-301-workspace",
      createdAt: "2026-08-04T08:00:00.000Z",
      sourceProfileId: "developer",
    };
    if (opts.kind) workRevision.kind = opts.kind;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "review",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr,
        workRevision,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    const pat = createPat(store.db, { userId: store.users.arda.id, label: "bot", token: "ghp_reconciler135" }, actor);
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
    const run = async (routes: FakeRoutes) => {
      await reconcileTask(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-301" },
        actor,
        { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
      );
      return readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed.frontmatter;
    };
    return { store, run };
  }
  const compareRoute = `GET ${REPO_PATH}/compare/${REV}...headsha318`;
  const commitRoute = `GET ${REPO_PATH}/commits/${REV}`;

  it("PRIMARY: a 404 compare plus the commit read's 422 records `unknown` and the PR head", async () => {
    // Ruling 427: this fixture used to answer the commit read with 404, which
    // is what the code believed and not what GitHub says. Probed live on
    // 2026-09-23 against akin-ozer/ax-clone for AX-20's never-pushed 7ce74b2:
    // the compare answered 404 "Not Found", the commit read 422 "No commit
    // found for SHA: 7ce74b2f…". CANARY: ask `isMissingRefAnswer` again.
    const { run } = seedOwned();
    const routes = happyRoutes();
    routes[compareRoute] = { status: 404, body: { message: "Not Found" } };
    routes[commitRoute] = { status: 422, body: { message: "No commit found for SHA: rev0delivered" } };
    const fm = await run(routes);
    expect(fm.pr?.headSha).toBe("headsha318");
    expect(fm.pr?.unpushedRevision).toEqual({ revisionSha: REV, prHeadSha: "headsha318", relation: "unknown" });
    expect(fm.pr?.revisionDrift).toBeUndefined();
  });

  it("ruling 427: a 422 that is not the missing-commit sentence measures nothing", async () => {
    // 422 is GitHub's generic validation status (ruling 223 kept it scoped to
    // this sentence); anything else carries the cached record forward.
    const cached = { revisionSha: REV, prHeadSha: "olderhead", relation: "behind" as const };
    const { run } = seedOwned({ unpushed: cached });
    const routes = happyRoutes();
    routes[compareRoute] = { status: 404, body: { message: "Not Found" } };
    routes[commitRoute] = { status: 422, body: { message: "Validation Failed" } };
    const fm = await run(routes);
    expect(fm.pr?.unpushedRevision).toEqual(cached);
  });

  it("a 404 compare whose commit read answers 200 is NOT measured: nothing is invented, nothing cached is erased", async () => {
    const cached = { revisionSha: REV, prHeadSha: "olderhead", relation: "behind" as const };
    const { run } = seedOwned({ unpushed: cached });
    const routes = happyRoutes();
    routes[compareRoute] = { status: 404, body: { message: "Not Found" } };
    routes[commitRoute] = { body: { sha: REV } };
    const fm = await run(routes);
    expect(fm.pr?.headSha).toBe("headsha318");
    expect(fm.pr?.unpushedRevision).toEqual(cached);
  });

  it("SECONDARY: a `behind` compare records `behind`; a `diverged` one records `diverged`", async () => {
    for (const status of ["behind", "diverged"] as const) {
      const { run } = seedOwned();
      const routes = happyRoutes();
      routes[compareRoute] = { body: { ahead_by: 0, behind_by: 2, status, commits: [] } };
      const fm = await run(routes);
      expect(fm.pr?.unpushedRevision).toEqual({ revisionSha: REV, prHeadSha: "headsha318", relation: status });
    }
  });

  it("a head that carries the revision (identical, ahead, or the same sha) CLEARS a cached record", async () => {
    // Canary: never clear on identical — the stale record survives.
    const cached = { revisionSha: REV, prHeadSha: "olderhead", relation: "behind" as const };
    const identical = seedOwned({ unpushed: cached });
    const routes = happyRoutes();
    routes[compareRoute] = { body: { ahead_by: 0, behind_by: 0, status: "identical", commits: [] } };
    expect((await identical.run(routes)).pr).not.toHaveProperty("unpushedRevision");

    const ahead = seedOwned({ unpushed: cached });
    const aheadRoutes = happyRoutes();
    aheadRoutes[compareRoute] = { body: { ahead_by: 2, behind_by: 0, status: "ahead", commits: [] } };
    const fm = await ahead.run(aheadRoutes);
    expect(fm.pr).not.toHaveProperty("unpushedRevision");
    expect(fm.pr?.revisionDrift).toEqual({ headSha: "headsha318", authored: 2, baseRefresh: null });

    const same = seedOwned({ unpushed: cached });
    const sameRoutes = happyRoutes();
    for (const route of [`GET ${REPO_PATH}/pulls`, `GET ${REPO_PATH}/pulls/318`]) {
      const entry = sameRoutes[route]!;
      // SAFETY: the two happy routes are static bodies (no function form).
      const body = (entry as { body: unknown }).body;
      // SAFETY: `JSON.parse` of a re-serialised static fixture is the fixture's own shape; `unknown` widens, never narrows.
      const patched = JSON.parse(JSON.stringify(body).replaceAll("headsha318", REV)) as unknown;
      sameRoutes[route] = { body: patched };
    }
    sameRoutes[`GET ${REPO_PATH}/commits/${REV}/check-runs`] = sameRoutes[`GET ${REPO_PATH}/commits/headsha318/check-runs`]!;
    const sameFm = await same.run(sameRoutes);
    expect(sameFm.pr?.headSha).toBe(REV);
    expect(sameFm.pr).not.toHaveProperty("unpushedRevision");
  });

  it("an unreadable compare and a settled PR CARRY the cached record; a `verified` revision never gets one", async () => {
    const cached = { revisionSha: REV, prHeadSha: "olderhead", relation: "diverged" as const };
    const unreadable = seedOwned({ unpushed: cached });
    const routes = happyRoutes();
    routes[compareRoute] = { status: 500, body: { message: "boom" } };
    expect((await unreadable.run(routes)).pr?.unpushedRevision).toEqual(cached);

    const closed = seedOwned({ unpushed: cached });
    const closedRoutes = happyRoutes();
    closedRoutes[`GET ${REPO_PATH}/pulls/318`] = {
      body: { number: 318, title: "Attach execution workspace", state: "closed", merged: false, merged_at: null, head: { sha: "headsha318" }, additions: 1, deletions: 1, changed_files: 1 },
    };
    closedRoutes[`GET ${REPO_PATH}/branches/vib-301-workspace`] = { body: { commit: { sha: "headsha318" } } };
    const closedFm = await closed.run(closedRoutes);
    expect(closedFm.pr?.state).toBe("closed");
    expect(closedFm.pr?.unpushedRevision).toEqual(cached);

    const verified = seedOwned({ kind: "verified" });
    const vRoutes = happyRoutes();
    vRoutes[compareRoute] = { status: 404, body: { message: "Not Found" } };
    vRoutes[commitRoute] = { status: 404, body: { message: "Not Found" } };
    expect((await verified.run(vRoutes)).pr).not.toHaveProperty("unpushedRevision");
  });
});

/**
 * F34-9 (pass 34): PR adoption is recorded. Adopting a PR Viberr did not open
 * (found on the branch with the delivered head, ruling 35) writes one `github`
 * event naming the PR, its head and the PR it replaces, an audit row
 * `github.pr.adopted`, and its own notification; a refresh of the same number
 * writes nothing; replacing a LIVE cached PR wakes the operator. Canaries:
 * delete the `recordPrAdoption` call; fire on every `ownsAPr` (the refresh
 * writes a second line).
 */
describe("F34-9: PR adoption is recorded", () => {
  const REV = "rev0delivered";
  function adoptionRoutes(): FakeRoutes {
    const pr = {
      number: 318,
      title: "Attach execution workspace",
      state: "open",
      draft: false,
      merged: false,
      merged_at: null,
      head: { sha: REV },
      additions: 4,
      deletions: 1,
      changed_files: 2,
    };
    return {
      [`GET ${REPO_PATH}/compare/main...vib-301-workspace`]: {
        body: { ahead_by: 1, behind_by: 0, status: "ahead", commits: [] },
      },
      [`GET ${REPO_PATH}/pulls`]: { body: [pr] },
      [`GET ${REPO_PATH}/pulls/318`]: { body: pr },
      [`GET ${REPO_PATH}/commits/${REV}/check-runs`]: { body: { total_count: 0, check_runs: [] } },
    };
  }
  function seedDelivered(pr: PrRef | null) {
    const store = setupTestStore(ctx);
    const fmPatch: Parameters<typeof baseTaskFrontmatter>[1] = {
      title: "Attach execution workspace",
      stage: "review",
      branch: "vib-301-workspace",
      ownerUserId: store.users.arda.id,
      workRevision: {
        id: "rev_1",
        headSha: REV,
        treeSha: null,
        branch: "vib-301-workspace",
        createdAt: "2026-08-04T08:00:00.000Z",
        sourceProfileId: "developer",
      },
    };
    if (pr) fmPatch.pr = pr;
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-301", fmPatch) });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    const pat = createPat(store.db, { userId: store.users.arda.id, label: "bot", token: "ghp_reconciler349" }, actor);
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
    return { store, actor };
  }
  const adoptedLines = (store: ReturnType<typeof setupTestStore>) =>
    readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed.timeline.filter(
      (e) => e.type === "github" && e.text.includes("Adopted **PR #"),
    );

  it("adopting a human-opened PR on the delivered head writes the event, the audit row and a notification; a refresh writes nothing", async () => {
    const { store, actor } = seedDelivered(null);
    const wakes: string[] = [];
    const ctxWith = {
      dataRoot: store.dataRoot,
      fetchImpl: fakeGithubFetch(adoptionRoutes()).fetchImpl,
      wakeOperator: async (_db: DatabaseSync, _ctx: { dataRoot?: string }, _slug: string, _key: string, trigger: string) => {
        wakes.push(trigger);
      },
    };
    await reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor, ctxWith);
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toMatchObject({ number: 318, state: "review", headSha: REV });
    const lines = adoptedLines(store);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain("Adopted **PR #318** (head `rev0del`, the delivered revision) as VIB-301's review PR.");
    expect(lines[0]!.text).toContain("Viberr did not open it");
    expect(lines[0]!.actor).toEqual({ kind: "system", systemId: "policy-engine" });
    const audit = listAuditEvents(store.db, { action: "github.pr.adopted" });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ prNumber: 318, previousPrNumber: null, headSha: REV, source: "reconciler" });
    const notes = listNotifications(store.db, store.users.arda.id).filter((n) => n.kind === "policy");
    expect(notes.map((n) => n.title)).toContain("PR #318 adopted for VIB-301");
    // A first adoption informs; it does not wake the operator.
    expect(wakes).toEqual([]);

    // A refresh of the SAME number, with a fact that changed (a check landed)
    // so the pass really writes: still one adoption line, one audit row.
    const refreshed = adoptionRoutes();
    refreshed[`GET ${REPO_PATH}/commits/${REV}/check-runs`] = {
      body: { total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] },
    };
    await reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor, {
      ...ctxWith,
      fetchImpl: fakeGithubFetch(refreshed).fetchImpl,
    });
    expect(readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed.frontmatter.pr?.checks?.total).toBe(1);
    expect(adoptedLines(store)).toHaveLength(1);
    expect(listAuditEvents(store.db, { action: "github.pr.adopted" })).toHaveLength(1);
  });

  it("replacing a LIVE cached PR names the replaced PR and wakes the operator", async () => {
    const { store, actor } = seedDelivered({ number: 5, state: "review", title: "old" });
    const wakes: string[] = [];
    await reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: fakeGithubFetch(adoptionRoutes()).fetchImpl,
      wakeOperator: async (_db: DatabaseSync, _ctx: { dataRoot?: string }, _slug: string, _key: string, trigger: string) => {
        wakes.push(trigger);
      },
    });
    const lines = adoptedLines(store);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain("replacing PR #5 (review)");
    expect(listAuditEvents(store.db, { action: "github.pr.adopted" })[0]!.details).toMatchObject({ previousPrNumber: 5, previousState: "review" });
    const notes = listNotifications(store.db, store.users.arda.id).filter((n) => n.kind === "policy");
    expect(notes.map((n) => n.title)).toContain("PR #318 adopted for VIB-301: replaces PR #5");
    expect(wakes).toEqual(["pr-diverged"]);
  });
});

/**
 * Ruling 132 (pass 34, F34-14): the reconciler classifies the commits since
 * the reviewed revision instead of counting them, so an operator's base
 * refresh (four base commits plus its recorded merge) is reported as a base
 * refresh and never as five unreviewed commits. Canaries: drop the
 * `notOnBase` membership test; treat any two-parent commit as clean; remove the
 * base-compare completeness guard.
 */
describe("ruling 132: drift is classified, not counted", () => {
  const REV = "rev0delivered";
  const HEAD = "headsha318";
  const M = "m".repeat(40);
  const commit = (sha: string, parents: string[] = ["p".repeat(40)]) => ({
    sha,
    commit: { message: `[VIB-301] ${sha.slice(0, 4)}` },
    parents: parents.map((p) => ({ sha: p })),
  });
  const B = ["b1", "b2", "b3", "b4"].map((x) => x.padEnd(40, "0"));
  const A0 = "a0".padEnd(40, "0");
  function seedReviewed(opts: { recordMerge?: boolean; cachedDrift?: RevisionDrift } = {}) {
    const store = setupTestStore(ctx);
    const pr: PrRef = { number: 318, state: "review", title: "Attach execution workspace" };
    if (opts.cachedDrift) pr.revisionDrift = opts.cachedDrift;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "review",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr,
        workRevision: {
          id: "rev_1", headSha: REV, treeSha: null, branch: "vib-301-workspace",
          createdAt: "2026-08-04T08:00:00.000Z", sourceProfileId: "developer",
        },
        baseRefreshes: opts.recordMerge === false ? [] : [{ mergeSha: M, baseSha: B[3]!, base: "main", commits: 4, at: "2026-09-04T00:00:00.000Z" }],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    const pat = createPat(store.db, { userId: store.users.arda.id, label: "bot", token: "ghp_reconciler132" }, actor);
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
    const run = async (routes: FakeRoutes) => {
      await reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor, {
        dataRoot: store.dataRoot,
        fetchImpl: fakeGithubFetch(routes).fetchImpl,
      });
      return readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed.frontmatter;
    };
    return { store, run };
  }
  /** The branch's OWN commits (base...branch): the reviewed A0 and the merge. */
  const baseCompare = (commits: unknown[], extra: Partial<{ ahead_by: number }> = {}) => ({
    body: { ahead_by: extra.ahead_by ?? commits.length, behind_by: 0, status: "ahead", commits },
  });
  const sinceRoute = `GET ${REPO_PATH}/compare/${REV}...${HEAD}`;
  const baseRoute = `GET ${REPO_PATH}/compare/main...vib-301-workspace`;

  it("a base refresh records `authored: 0` with the merge and base commits reported separately", async () => {
    const { run } = seedReviewed();
    const routes = happyRoutes();
    routes[baseRoute] = baseCompare([commit(A0), commit(M, [A0, B[3]!])]);
    routes[sinceRoute] = { body: { ahead_by: 5, behind_by: 0, status: "ahead", commits: [...B.map((b) => commit(b)), commit(M, [A0, B[3]!])] } };
    const fm = await run(routes);
    expect(fm.pr?.revisionDrift).toEqual({ headSha: HEAD, authored: 0, baseRefresh: { merges: 1, commits: 4 } });
    // `github.commits` keeps its narrow shape: the compare reader's own fields
    // (`fullSha`, `parents`) never reach the file — ruling 132. Ruling 187 adds
    // exactly one more, `pushed`, which is schema'd and deliberate; the guard
    // stays so a THIRD field cannot arrive by accident.
    for (const c of fm.github?.commits ?? [])
      expect(Object.keys(c).sort()).toEqual(["msg", "pushed", "sha"]);
  });

  it("an authored commit on top of a refresh counts; a merge Viberr did not record counts as authored", async () => {
    const { run } = seedReviewed();
    const A2 = "a2".padEnd(40, "0");
    const routes = happyRoutes();
    routes[baseRoute] = baseCompare([commit(A0), commit(M, [A0, B[0]!]), commit(A2)]);
    routes[sinceRoute] = { body: { ahead_by: 3, behind_by: 0, status: "ahead", commits: [commit(B[0]!), commit(M, [A0, B[0]!]), commit(A2)] } };
    expect((await run(routes)).pr?.revisionDrift).toEqual({ headSha: HEAD, authored: 1, baseRefresh: { merges: 1, commits: 1 } });

    const unrecorded = seedReviewed({ recordMerge: false });
    expect((await unrecorded.run(routes)).pr?.revisionDrift).toEqual({ headSha: HEAD, authored: 2, baseRefresh: { merges: 0, commits: 1 } });
  });

  it("a fast-forward refresh records `{merges: 0, commits: N}`", async () => {
    const { run } = seedReviewed({ recordMerge: false });
    const routes = happyRoutes();
    routes[baseRoute] = baseCompare([]);
    routes[sinceRoute] = { body: { ahead_by: 2, behind_by: 0, status: "ahead", commits: [commit(B[0]!), commit(B[1]!)] } };
    expect((await run(routes)).pr?.revisionDrift).toEqual({ headSha: HEAD, authored: 0, baseRefresh: { merges: 0, commits: 2 } });
  });

  it("an unclassifiable pass CARRIES the cached record, or records every commit as authored with nothing to carry", async () => {
    const cached = { headSha: HEAD, authored: 0, baseRefresh: { merges: 1, commits: 4 } };
    // The base compare answers 404 (`missing_ref`): the only status that reaches the drift block with no base compare.
    const carried = seedReviewed({ cachedDrift: cached });
    const routes = happyRoutes();
    routes[baseRoute] = { status: 404, body: { message: "Not Found" } };
    routes[sinceRoute] = { body: { ahead_by: 5, behind_by: 0, status: "ahead", commits: [...B.map((b) => commit(b)), commit(M, [A0, B[3]!])] } };
    expect((await carried.run(routes)).pr?.revisionDrift).toEqual(cached);

    const bare = seedReviewed();
    expect((await bare.run(routes)).pr?.revisionDrift).toEqual({ headSha: HEAD, authored: 5, baseRefresh: null });

    // A base compare with an undecodable entry is partial: carried, never classified.
    const partial = seedReviewed({ cachedDrift: cached });
    const partialRoutes = happyRoutes();
    partialRoutes[baseRoute] = { body: { ahead_by: 2, behind_by: 0, status: "ahead", commits: [commit(A0), { commit: { message: "no sha" } }] } };
    partialRoutes[sinceRoute] = routes[sinceRoute]!;
    expect((await partial.run(partialRoutes)).pr?.revisionDrift).toEqual(cached);
  });
});

/**
 * Ruling 179 (pass 36, F36-7): authored drift after a verdict VOIDS it. Live:
 * an observer commit on hlc-7 at Merge Approval — `pr.revisionDrift
 * {authored: 1}` was written, nothing woke, nothing notified, the accept card
 * stayed applicable and the Commits card (prefix-filtered) hid the commit.
 */
describe("ruling 179: a PR head moved after the verdict voids it", () => {
  const REV = "rev0delivered";
  const HEAD = "headsha318";
  const A0 = "a0".padEnd(40, "0");
  const X1 = "x1".padEnd(40, "0");
  const commit = (sha: string, message: string, parents: string[] = ["p".repeat(40)]) => ({
    sha,
    commit: { message },
    parents: parents.map((p) => ({ sha: p })),
  });
  const baseRoute = `GET ${REPO_PATH}/compare/main...vib-301-workspace`;
  const sinceRoute = `GET ${REPO_PATH}/compare/${REV}...${HEAD}`;

  function seedApproved(opts: { stage?: string; deployReviewerAt?: string[]; recs?: boolean } = {}) {
    const store = setupTestStore(ctx);
    if (opts.deployReviewerAt) {
      const pf = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
      writeProject(store.dataRoot, {
        ...pf.parsed.frontmatter,
        agents: [
          ...pf.parsed.frontmatter.agents,
          {
            profileId: "reviewer",
            capabilities: [{ capabilityId: "report-validation-verdict", mode: "direct" }],
            extras: [],
            definition: {
              kind: "specialist",
              name: "Reviewer",
              role: "Review",
              backends: ["claude"],
              model: "sonnet",
              stages: opts.deployReviewerAt,
            },
          },
        ],
      });
    }
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: opts.stage ?? "review",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        engagements: [
          { profileId: "reviewer", backend: "claude", role: "Review", delivers: false, verdictCapable: true },
        ],
        pr: { number: 318, state: "review", title: "Attach execution workspace", headSha: REV },
        workRevision: {
          id: "rev_1", headSha: REV, treeSha: null, branch: "vib-301-workspace",
          createdAt: "2026-08-04T08:00:00.000Z", sourceProfileId: "developer", kind: "delivered",
        },
        verdicts: [
          { profileId: "reviewer", revisionId: "rev_1", headSha: REV, result: "approve", reason: "clean", at: "2026-09-11T15:00:00.000Z", rounds: 1 },
        ],
        validation: "healthy",
        recommendations: opts.recs
          ? [
              { id: "rec_accept", kind: "accept_completion", toStageId: "done", label: "Accept completion and move VIB-301 to Done", detail: "for revision rev0del", forHeadSha: REV },
            ]
          : [],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
    const pat = createPat(store.db, { userId: store.users.arda.id, label: "bot", token: "ghp_reconciler179" }, actor);
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
    const wakes: string[] = [];
    const run = async () => {
      const routes = happyRoutes();
      routes[baseRoute] = { body: { ahead_by: 2, behind_by: 0, status: "ahead", commits: [commit(A0, "[VIB-301] the work"), commit(X1, "observer fixture: drift after review")] } };
      routes[sinceRoute] = { body: { ahead_by: 1, behind_by: 0, status: "ahead", commits: [commit(X1, "observer fixture: drift after review")] } };
      await reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor, {
        dataRoot: store.dataRoot,
        fetchImpl: fakeGithubFetch(routes).fetchImpl,
        wakeOperator: async (_db: DatabaseSync, _ctx: { dataRoot?: string }, _slug: string, _key: string, trigger: string) => {
          wakes.push(trigger);
        },
      });
      return readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed;
    };
    return { store, run, wakes };
  }

  it("mints an external revision from the moved head, voids the verdict, withdraws the accept card, notes, notifies and wakes", async () => {
    // Canary: delete the `authoredDriftVoidsVerdict` block in reconcileTask —
    // validation stays `healthy`, the accept card survives, nothing wakes.
    const { store, run, wakes } = seedApproved({ recs: true });
    const parsed = await run();
    const fm = parsed.frontmatter;
    expect(fm.workRevision).toMatchObject({ headSha: HEAD, kind: "external", sourceProfileId: null });
    expect(fm.workRevision!.id).not.toBe("rev_1");
    expect(fm.validation).toBe("changed");
    expect(fm.pr?.revisionDrift).toMatchObject({ headSha: HEAD, authored: 1 });
    expect(fm.recommendations).toEqual([]);
    // The foreign commit is on the record beside the task's own.
    // Ruling 187: derived from the compare, so the remote demonstrably has it.
    expect(fm.github?.commits).toEqual([
      { sha: A0.slice(0, 7), msg: "[VIB-301] the work", pushed: true },
    ]);
    expect(fm.github?.otherCommits).toEqual([{ sha: X1.slice(0, 7), msg: "observer fixture: drift after review" }]);
    const note = parsed.timeline.find((e) => e.type === "note" && e.title === "Revision moved after review")!;
    expect(note).toBeDefined();
    expect(note.text).toContain("ruling 179");
    expect(note.text).toContain("no longer binds");
    // Live 19:45Z: the drift sentence carries no terminal punctuation, so the
    // note read "…merges unreviewed The verdict on…". Canary: drop the period.
    expect(note.text).toMatch(/unreviewed\. The verdict on `[^`]+` no longer binds/);
    expect(note.text).toContain("“Accept completion and move VIB-301 to Done”");
    const inbox = listNotifications(store.db, store.users.arda.id).filter((n) => n.taskKey === "VIB-301");
    expect(inbox.some((n) => n.title === "PR #318 moved after review: VIB-301 needs a fresh verdict")).toBe(true);
    expect(wakes).toEqual(["pr-diverged"]);
    // The same head on the next pass is old news: nothing fires twice.
    const again = await run();
    expect(again.frontmatter.workRevision!.id).toBe(fm.workRevision!.id);
    expect(again.timeline.filter((e) => e.title === "Revision moved after review")).toHaveLength(1);
    expect(wakes).toEqual(["pr-diverged"]);
  });

  it("returns a task that sits past its verdict stage to the stage where the reviewer works", async () => {
    // The reviewer is eligible at `impl`; the task sits at `review` (the
    // acceptance boundary on the GOVERNED template). The moved head sends it
    // back to `impl` through the rework route, audited `via: authored-drift`.
    const { store, run } = seedApproved({ stage: "review", deployReviewerAt: ["impl"] });
    const parsed = await run();
    expect(parsed.frontmatter.stage).toBe("impl");
    const move = parsed.timeline.find((e) => e.type === "transition")!;
    expect(move.text).toContain("ruling 179");
    expect(move.actor).toMatchObject({ kind: "system", systemId: "policy-engine" });
    const rows = listAuditEvents(store.db, { action: "task.transition" }).filter((r) => r.taskKey === "VIB-301");
    expect(rows.at(-1)!.details).toMatchObject({ from: "review", to: "impl", boundary: "rework", via: "authored-drift" });
  });

  it("drift before any verdict is plain delivery news: no revision minted, nothing voided", async () => {
    const { store, run, wakes } = seedApproved();
    // Strip the verdict: a head that moves before anyone judged it is not a
    // voided review, it is the branch growing.
    const ref = { projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot };
    const before = readTaskFile(ref)!.parsed;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: { ...before.frontmatter, verdicts: [], validation: "changed" },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const parsed = await run();
    expect(parsed.frontmatter.workRevision!.id).toBe("rev_1");
    expect(parsed.frontmatter.pr?.revisionDrift).toMatchObject({ headSha: HEAD, authored: 1 });
    expect(parsed.timeline.some((e) => e.title === "Revision moved after review")).toBe(false);
    expect(wakes).toEqual([]);
  });
});

/**
 * Pass 35 S15: ruling 162 (F35-12 (a0) and (d)). The conflict the acceptance
 * gate refuses on reaches the file from BOTH GitHub answers (the detail read
 * and the merge refusal), and a flip to conflicting withdraws the acceptance
 * offer the gate would refuse.
 */
describe("pass 35 S15: ruling 162 in the reconciler", () => {
  function seedWithAcceptRec(store: TestStore) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "review",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr: { number: 318, state: "review", title: "Attach execution workspace", mergeable: "clean" },
        recommendations: [
          { id: "r-accept", kind: "accept_completion", toStageId: "done", label: "Accept completion and move VIB-301 to Done", detail: "" },
          { id: "r-trans", kind: "transition", toStageId: "done", label: "Move VIB-301 to Done", detail: "" },
          { id: "r-assign", kind: "run_agent", profileId: "developer", label: "Run Developer", detail: "" },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  it("(d): a PR that flips to conflicting withdraws the pending accept_completion card with the gate's sentence on the timeline", async () => {
    // Canary: drop `conflictText` from the superseded filter.
    const { store, actor } = setup();
    seedWithAcceptRec(store);
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: { number: 318, title: "Attach execution workspace", state: "open", merged: false,
        merged_at: null, head: { sha: "headsha318" }, mergeable: false, mergeable_state: "dirty",
        additions: 1, deletions: 0, changed_files: 1 },
    };
    await reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl });
    const parsed = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed;
    expect(parsed.frontmatter.pr?.mergeable).toBe("conflicting");
    expect(parsed.frontmatter.recommendations.map((r) => r.id).sort()).toEqual(["r-assign", "r-trans"]);
    const note = parsed.timeline.find((e) => e.type === "note" && e.text.startsWith("**Conflict:**"))!;
    expect(note.text).toContain("VIB-301's review PR #318 conflicts with the base branch");
    expect(note.text).toContain("“Accept completion and move VIB-301 to Done” recommendation was withdrawn");
    // A second pass on the same answer flips nothing and writes nothing new.
    await reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl });
    const again = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed;
    expect(again.timeline.filter((e) => e.text.startsWith("**Conflict:**"))).toHaveLength(1);
  });

  it("(a0): a 405 whose re-read pull conflicts records `mergeable: conflicting` and says so in the result", async () => {
    // Canary: return the bare `not_mergeable` on every 405. The pre-merge
    // detail read still sees GitHub computing (`mergeable: null`), so only the
    // re-read AFTER the 405 can learn the conflict (KNC-16: the base moved
    // between the two calls).
    const { store, actor } = setup();
    const gh = fakeGithubFetch({
      [`PUT ${REPO_PATH}/pulls/318/merge`]: { status: 405, body: { message: "Pull Request is not mergeable" } },
      [`GET ${REPO_PATH}/pulls/318`]: (call) => ({
        body:
          call.attempt === 1
            ? { number: 318, state: "open", merged: false, head: { sha: "headsha318" }, mergeable: null }
            : { number: 318, state: "open", merged: false, head: { sha: "headsha318" }, mergeable: false, mergeable_state: "dirty" },
      }),
    });
    const result = await mergeTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toMatchObject({ status: "not_mergeable", prNumber: 318, mergeable: "conflicting" });
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr?.mergeable).toBe("conflicting");
    expect(fm.pr?.state).toBe("review");
  });

  it("(a0): a 405 that names merge conflicts while GitHub is still computing counts as conflicting too", async () => {
    const { store, actor } = setup();
    const gh = fakeGithubFetch({
      [`PUT ${REPO_PATH}/pulls/318/merge`]: { status: 405, body: { message: "Pull Request has merge conflicts" } },
      [`GET ${REPO_PATH}/pulls/318`]: {
        body: { number: 318, state: "open", merged: false, head: { sha: "headsha318" }, mergeable: null },
      },
    });
    const result = await mergeTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(result).toMatchObject({ status: "not_mergeable", mergeable: "conflicting" });
    expect(readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed.frontmatter.pr?.mergeable).toBe("conflicting");
  });
});

// ------------------------------------------------- ruling 475 (F40-55)

/**
 * Ruling 475 (F40-55): live on akinozer-com the owner accepted WEB-4 at
 * 00:26:20 and Viberr merged PR #2. WEB-2's PR #3 changed the same
 * `package.json`. Nothing re-read PR #3 until the five-minute poll, the flip
 * to conflicting withdrew only the recommendation cards, and nobody was woken,
 * so the owner pressed Accept on WEB-2's still-open packet at 00:27:54 and was
 * refused.
 */
describe("ruling 475 (F40-55): a merge re-checks its siblings, and a flip to conflicting is acted on", () => {
  /** One recorded wake: which task, which trigger. */
  function wakeRecorder() {
    const wakes: string[] = [];
    const wakeOperator: OperatorWake = async (_db, _ctx, _slug, taskKey, trigger) => {
      wakes.push(`${taskKey}:${trigger}`);
    };
    return { wakes, wakeOperator };
  }

  const SIBLING_PR = {
    number: 319,
    title: "Shared config",
    state: "open",
    draft: false,
    merged_at: null,
    head: { sha: "headsha319" },
  };

  /** VIB-302, the sibling: its own open PR #319, last read as mergeable. */
  function seedSibling(store: TestStore): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-302", {
        title: "Shared config",
        stage: "review",
        branch: "vib-302-config",
        ownerUserId: store.users.arda.id,
        pr: { number: 319, state: "review", title: "Shared config", mergeable: "clean" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  /** The routes both tasks' passes read. PR #319's detail read answers from
   *  `sibling`, called with the attempt number. */
  function siblingRoutes(sibling: (attempt: number) => object): FakeRoutes {
    return {
      ...happyRoutes(),
      [`GET ${REPO_PATH}/compare/main...vib-302-config`]: {
        body: { ahead_by: 1, behind_by: 1, status: "diverged", commits: [] },
      },
      [`GET ${REPO_PATH}/pulls`]: (call) => ({
        body: (call.url.searchParams.get("head") ?? "").endsWith("vib-302-config")
          ? [SIBLING_PR]
          : [
              { number: 318, title: "Attach execution workspace", state: "open", draft: false, merged_at: null, head: { sha: "headsha318" } },
            ],
      }),
      [`GET ${REPO_PATH}/pulls/319`]: (call) => ({
        body: { ...SIBLING_PR, merged: false, additions: 1, deletions: 0, changed_files: 1, ...sibling(call.attempt) },
      }),
      [`GET ${REPO_PATH}/commits/headsha319/check-runs`]: { body: { total_count: 0, check_runs: [] } },
    };
  }

  it("(b): the flip withdraws an open packet offering acceptance, tells the owner why, and wakes the operator", async () => {
    // CANARY: drop the `withdrawAcceptancePacket` call (the packet survives,
    // still offering a click the gate refuses) or the `pr-conflicting` wake.
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "review",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr: { number: 318, state: "review", title: "Attach execution workspace", mergeable: "clean" },
      }),
      packet: {
        id: "pkt_accept",
        type: "input",
        kind: "Completion report",
        from: "operator",
        title: "Accept VIB-301",
        body: "The PR is mergeable.",
        observations: [],
        options: [{ kind: "accept_completion", t: "Accept and merge", d: "", rec: true }],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: { number: 318, title: "Attach execution workspace", state: "open", merged: false,
        merged_at: null, head: { sha: "headsha318" }, mergeable: false, mergeable_state: "dirty",
        additions: 1, deletions: 0, changed_files: 1 },
    };
    const { wakes, wakeOperator } = wakeRecorder();
    const pass = () =>
      reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
        { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl, wakeOperator });
    await pass();
    const parsed = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed;
    expect(parsed.frontmatter.pr?.mergeable).toBe("conflicting");
    expect(parsed.packet).toBeNull();
    expect(parsed.timeline.find((e) => e.text.startsWith("**Packet withdrawn:**"))!.text).toBe(
      '**Packet withdrawn:** "Accept VIB-301" no longer holds: PR #318 now conflicts with the base branch, so the acceptance it offers would be refused.',
    );
    expect(listAuditEvents(store.db, { action: "task.packet.withdrawn_superseded" })[0]!.details).toMatchObject({
      reason: "pr_conflicting",
      title: "Accept VIB-301",
    });
    const notice = listNotifications(store.db, store.users.arda.id).find((n) => n.kind === "policy")!;
    expect(notice.title).toBe("PR #318 now conflicts with the base: VIB-301's acceptance is withdrawn");
    expect(wakes).toEqual(["VIB-301:pr-conflicting"]);
    // The same answer again flips nothing, withdraws nothing, wakes nobody.
    await pass();
    expect(wakes).toEqual(["VIB-301:pr-conflicting"]);
  });

  it("(a): the post-merge re-check reads every other open PR, and reads one GitHub is still computing again", async () => {
    // CANARY: stop after the first pass (`SIBLING_RECHECK_DELAYS_MS` of one
    // entry) and the sibling's conflict is never read.
    const { store } = setup();
    seedSibling(store);
    const gh = fakeGithubFetch(
      siblingRoutes((attempt) =>
        attempt === 1 ? { mergeable: null } : { mergeable: false, mergeable_state: "dirty" },
      ),
    );
    const { wakes, wakeOperator } = wakeRecorder();
    const results = await recheckOpenReviewPrs(
      store.db,
      { projectSlug: store.slug, mergedTaskKey: "VIB-301" },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl, wakeOperator, siblingRecheckDelaysMs: [0, 0, 0] },
    );
    // VIB-301 is the merged one: never re-read. VIB-302 twice, then settled.
    expect(results.map((r) => ("taskKey" in r ? r.taskKey : r.status))).toEqual(["VIB-302", "VIB-302"]);
    expect(gh.callsTo(`GET ${REPO_PATH}/pulls/319`)).toHaveLength(2);
    expect(gh.callsTo(`GET ${REPO_PATH}/compare/main...vib-301-workspace`)).toHaveLength(0);
    const sibling = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-302", dataRoot: store.dataRoot })!.parsed;
    expect(sibling.frontmatter.pr?.mergeable).toBe("conflicting");
    expect(wakes).toEqual(["VIB-302:pr-conflicting"]);
  });

  it("(a): a successful merge starts the re-check of the project's other open PRs", async () => {
    // CANARY: drop the `recheckOpenReviewPrs` call in `mergeTaskPr`'s merged
    // arm and PR #319 is read by nobody until the poll.
    const { store, actor } = setup();
    seedSibling(store);
    const routes = siblingRoutes(() => ({ mergeable: false, mergeable_state: "dirty" }));
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: { number: 318, state: "open", merged: false, head: { sha: "headsha318" }, mergeable: true, mergeable_state: "clean" },
    };
    routes[`PUT ${REPO_PATH}/pulls/318/merge`] = { body: { sha: "m".repeat(40), merged: true } };
    const gh = fakeGithubFetch(routes);
    const { wakes, wakeOperator } = wakeRecorder();
    const merged = await mergeTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl, wakeOperator, siblingRecheckDelaysMs: [0] },
    );
    expect(merged.status).toBe("merged");
    // Not awaited by the merge: wait for its effect.
    for (let i = 0; i < 100 && wakes.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(gh.callsTo(`GET ${REPO_PATH}/pulls/319`).length).toBeGreaterThan(0);
    expect(wakes).toEqual(["VIB-302:pr-conflicting"]);
  });
});

// ------------------------------------------------- ruling 160: pr.closure

/**
 * Ruling 160 (pass 35, F35-11): a PR that went `closed` without merging was
 * closed by a person. The reconciler, the one writer of the closure RECORD (the
 * workspace reconcile writes the closed state too, knowing neither), stamps the
 * closure with the closer GitHub names, carries it while the PR stays closed
 * and drops it the moment the PR is live again. Canaries: drop the `closure`
 * assignment in the owned-PR assembly (first test), or copy it unconditionally
 * (third test).
 */
describe("ruling 160: the reconciler records who closed the PR", () => {
  const read = (store: TestStore) =>
    readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed.frontmatter.pr;

  it("the transition into closed stamps `closure` with the closer from the issue payload", async () => {
    const { store, actor } = setup();
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: { number: 318, title: "Attach execution workspace", state: "closed",
        merged: false, head: { sha: "headsha318" }, additions: 1, deletions: 0, changed_files: 1 },
    };
    routes[`GET ${REPO_PATH}/issues/318`] = { body: { closed_by: { login: "akin-ozer" } } };
    await reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl });
    const pr = read(store);
    expect(pr).toMatchObject({ number: 318, state: "closed", closure: { by: "akin-ozer", answered: null } });
    expect(Number.isNaN(Date.parse(pr!.closure!.at))).toBe(false);
  });

  it("a closer GitHub does not name is recorded as null, never as a guess", async () => {
    const { store, actor } = setup();
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: { number: 318, title: "Attach execution workspace", state: "closed",
        merged: false, head: { sha: "headsha318" }, additions: 1, deletions: 0, changed_files: 1 },
    };
    // No issues route: the fake answers 404.
    await reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl });
    expect(read(store)!.closure).toEqual({ at: expect.any(String), by: null, answered: null });
  });

  it("a reopened PR drops the closure with the closed state", async () => {
    const { store, actor } = setup();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "review",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr: {
          number: 318,
          state: "closed",
          title: "Attach execution workspace",
          closure: { at: "2026-09-06T19:33:19.000Z", by: "akin-ozer", answered: null },
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    // happyRoutes: PR #318 is open again on GitHub.
    await reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(happyRoutes()).fetchImpl });
    const pr = read(store);
    expect(pr).toMatchObject({ number: 318, state: "review" });
    expect(pr!.closure).toBeUndefined();
  });
});

/**
 * Ruling 187 (pass 37, F37-8): the cache never claims a commit the remote does
 * not have, and a commit that vanished with its workspace is announced as lost.
 *
 * Live: SHOP-2's `github.commits` held `3aad6ff` — the agent's workspace
 * commit, committed while the task was held (F37-2) and never delivered.
 * Origin's `shop-2` held only the bootstrap commit, whose message carries no
 * `[SHOP-2]` prefix, so the prefix filter found nothing and the "agents don't
 * always follow the prefix convention" carve-out KEPT the phantom. The GitHub
 * page then rendered "1 commit · synced" for a change that existed nowhere:
 * the run's workspace had been disposed, so it was not pending push, it was
 * gone.
 */
describe("ruling 187: a workspace commit the remote does not have", () => {
  type Store = ReturnType<typeof setup>["store"];

  /** The exact live shape: a remote whose only commit is unprefixed, so the
   *  prefix filter yields nothing and the workspace cache is what survives. */
  function phantomRoutes(): FakeRoutes {
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/compare/main...vib-301-workspace`] = {
      body: {
        ahead_by: 0,
        behind_by: 3,
        status: "behind",
        commits: [{ sha: "f6166a9ffff", commit: { message: "Initialize the project" } }],
      },
    };
    return routes;
  }

  function seedCached(
    store: Store,
    sha: string,
    msg: string,
    over: { prState?: "review" | "merged"; pushed?: boolean } = {},
  ): void {
    const commit =
      over.pushed === undefined ? { sha, msg } : { sha, msg, pushed: over.pushed };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-301", {
        title: "Attach execution workspace",
        stage: "review",
        branch: "vib-301-workspace",
        ownerUserId: store.users.arda.id,
        pr: {
          number: 318,
          state: over.prState ?? "review",
          title: "Attach execution workspace",
        },
        github: { commits: [commit], changed: null, unownedPr: null },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  /** A MERGED PR's compare: the branch has nothing the base lacks, because the
   *  base now has all of it. `droppedCommits` is 0 — an empty list drops
   *  nothing — so the completeness guard alone cannot tell this apart from a
   *  branch that never received the work. */
  function mergedRoutes(): FakeRoutes {
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/compare/main...vib-301-workspace`] = {
      body: { ahead_by: 0, behind_by: 0, status: "identical", commits: [] },
    };
    // Coherent with the compare: GitHub says the pull request merged, and the
    // branch still exists (the post-merge delete is best-effort and can be
    // refused, which is exactly when this path is reachable).
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: {
        number: 318,
        title: "Attach execution workspace",
        state: "closed",
        merged: true,
        merged_at: "2026-09-13T12:00:00Z",
        head: { sha: "headsha318" },
        additions: 412,
        deletions: 87,
        changed_files: 9,
      },
    };
    // `findPrForBranch` asks for `state=all`, so a merged PR IS listed.
    routes[`GET ${REPO_PATH}/pulls`] = {
      body: [
        {
          number: 318,
          title: "Attach execution workspace",
          state: "closed",
          draft: false,
          merged_at: "2026-09-13T12:00:00Z",
          head: { sha: "headsha318" },
        },
      ],
    };
    return routes;
  }

  const fileOf = (store: Store) =>
    readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed;

  async function reconcileWith(store: Store, actor: { userId: string; label: string }, routes: FakeRoutes): Promise<void> {
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
    );
  }

  it("is marked NOT pushed instead of being rendered as repository state", async () => {
    const { store, actor } = setup();
    seedCached(store, "3aad6ff", "[VIB-301] Define identity service slice");
    await reconcileWith(store, actor, phantomRoutes());
    // The entry SURVIVES — it is real work somebody did — and carries the one
    // fact that was missing: the remote does not have it. Live, SHOP-2's
    // GitHub row read "1 commit · synced" for exactly this state.
    expect(fileOf(store).frontmatter.github?.commits).toEqual([
      { sha: "3aad6ff", msg: "[VIB-301] Define identity service slice", pushed: false },
    ]);
  });

  it("never claims the work is LOST — a pending commit and an abandoned one look identical here", async () => {
    const { store, actor } = setup();
    seedCached(store, "3aad6ff", "[VIB-301] Define identity service slice");
    await reconcileWith(store, actor, phantomRoutes());
    // The first version of this fix DROPPED the entry and announced "Work
    // lost". Live, that fired on SHOP-7 seconds before Viberr pushed the very
    // commit it had just called lost: at reconcile time a commit awaiting
    // delivery and one whose workspace is gone are indistinguishable — neither
    // is on the remote, neither carries `pushedAt`. "Not pushed" is the only
    // claim this code can honestly make.
    expect(fileOf(store).timeline.some((e) => e.text.includes("Work lost"))).toBe(false);
  });

  /**
   * Found by the pass's own adversarial self-review, not by me: `compare` is an
   * AHEAD-only list, so a merged branch answers with an EMPTY one — and the
   * carve-out then stamped every cached commit `pushed: false`, announcing that
   * origin lacks commits that are sitting in `main`. This ruling's own
   * prohibited lie, pointed the other way. It never fired live only because
   * Viberr deletes the branch after merging, and that delete is best-effort.
   */
  it("ruling 187(b): a MERGED pr does not flip its commits to `not pushed`", async () => {
    const { store, actor } = setup();
    seedCached(store, "3aad6ff", "[VIB-301] Define identity service slice", {
      prState: "merged",
      pushed: true,
    });
    await reconcileWith(store, actor, mergedRoutes());
    // CANARY: drop `&& !landed` from `compareComplete` and this reads
    // `pushed: false` — the record claiming the remote lost work it merged.
    expect(fileOf(store).frontmatter.github?.commits).toEqual([
      { sha: "3aad6ff", msg: "[VIB-301] Define identity service slice", pushed: true },
    ]);
  });

  it("ruling 187(b): an unjudged commit on a merged pr stays unjudged, never `false`", async () => {
    const { store, actor } = setup();
    seedCached(store, "3aad6ff", "[VIB-301] Define identity service slice", {
      prState: "merged",
    });
    await reconcileWith(store, actor, mergedRoutes());
    const commits = fileOf(store).frontmatter.github?.commits ?? [];
    expect(commits).toHaveLength(1);
    // Absent, not false: after a landing the compare cannot judge the cache,
    // and "not judged" is the honest record of that.
    expect(commits[0]).not.toHaveProperty("pushed");
  });

  it("marks a commit the remote DOES have as pushed, prefix or no prefix", async () => {
    const { store, actor } = setup();
    seedCached(store, "f6166a9", "unprefixed but really pushed");
    await reconcileWith(store, actor, phantomRoutes());
    expect(fileOf(store).frontmatter.github?.commits).toEqual([
      { sha: "f6166a9", msg: "unprefixed but really pushed", pushed: true },
    ]);
  });

  it("judges NOTHING when the compare list is incomplete — unjudged must not read as judged", async () => {
    const { store, actor } = setup();
    seedCached(store, "3aad6ff", "[VIB-301] Define identity service slice");
    const routes = phantomRoutes();
    routes[`GET ${REPO_PATH}/compare/main...vib-301-workspace`] = {
      body: {
        ahead_by: 0,
        behind_by: 3,
        status: "behind",
        // One entry the tolerant reader cannot decode: the list is SHORT, so a
        // genuinely pushed commit could be missing from it and would otherwise
        // be stamped `pushed: false` — a lie in the other direction.
        commits: [null, { sha: "f6166a9ffff", commit: { message: "Initialize the project" } }],
      },
    };
    await reconcileWith(store, actor, routes);
    expect(fileOf(store).frontmatter.github?.commits).toEqual([
      { sha: "3aad6ff", msg: "[VIB-301] Define identity service slice" },
    ]);
  });
});

describe("F37-9: a sync verdict that changes is recorded, even on a quiet poll", () => {
  const syncRows = (store: ReturnType<typeof setup>["store"]): string[] => {
    // SAFETY: the SELECT names the one nullable TEXT column, and every
    // `github.reconcile` row the reconciler writes carries a details payload.
    const rows = store.db
      .prepare(
        `SELECT details_json FROM provenance WHERE action = 'github.reconcile' ORDER BY id ASC`,
      )
      .all() as { details_json: string | null }[];
    return rows.map((r) => String(JSON.parse(r.details_json ?? "{}").sync));
  };

  it("writes a row when the verdict flips, with nothing else changed", async () => {
    const { store, actor } = setup();
    // Pass 1: level with main.
    const level = happyRoutes();
    level[`GET ${REPO_PATH}/compare/main...vib-301-workspace`] = {
      body: { ahead_by: 0, behind_by: 0, status: "identical", commits: [] },
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(level).fetchImpl },
    );
    expect(syncRows(store)).toEqual(["synced"]);

    // Pass 2: main moved. NOTHING in the task file changes — same PR, same
    // commit cache — so `changed` is false and the poller skips unchanged
    // provenance. The verdict must still be recorded.
    const behind = happyRoutes();
    behind[`GET ${REPO_PATH}/compare/main...vib-301-workspace`] = {
      body: { ahead_by: 0, behind_by: 3, status: "behind", commits: [] },
    };
    await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      {
        dataRoot: store.dataRoot,
        fetchImpl: fakeGithubFetch(behind).fetchImpl,
        skipUnchangedProvenance: true,
      },
    );
    expect(syncRows(store)).toEqual(["synced", "behind_main"]);
  });

  it("stays quiet while the verdict holds, so a healthy poller adds no rows", async () => {
    const { store, actor } = setup();
    const behind = happyRoutes();
    behind[`GET ${REPO_PATH}/compare/main...vib-301-workspace`] = {
      body: { ahead_by: 0, behind_by: 3, status: "behind", commits: [] },
    };
    for (let i = 0; i < 3; i += 1) {
      await reconcileTask(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-301" },
        actor,
        {
          dataRoot: store.dataRoot,
          fetchImpl: fakeGithubFetch(behind).fetchImpl,
          skipUnchangedProvenance: true,
        },
      );
    }
    // One row for the first (changing) pass; the two repeats add nothing. The
    // "grow unboundedly" concern the original condition names is untouched.
    expect(syncRows(store)).toEqual(["behind_main"]);
  });
});
