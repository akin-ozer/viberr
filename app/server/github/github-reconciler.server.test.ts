import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  type FakeResponder,
} from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { listNotifications } from "~/server/projections/notifications.server";
import {
  countOpenPolicyViolations,
  findOpenScopeViolation,
  openScopeViolation,
} from "~/server/projections/policy-violations.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import {
  BRANCH_CLEANUP_GUARDRAIL_DESC,
  BRANCH_CLEANUP_GUARDRAIL_ID,
} from "./branch-cleanup.server";
/** Post-merge cleanup reads the projection, appends an event and reprojects —
 *  all AFTER GitHub has merged. This lets one test make that housekeeping
 *  throw; pass-through otherwise, so every other test sees the real module. */
const cleanupFault = vi.hoisted(() => ({ throws: false }));
vi.mock("./branch-cleanup.server", async () => {
  const actual =
    await vi.importActual<typeof import("./branch-cleanup.server")>(
      "./branch-cleanup.server",
    );
  return {
    ...actual,
    branchCleanupOnMerge: (...args: Parameters<typeof actual.branchCleanupOnMerge>) => {
      if (cleanupFault.throws) throw new Error("projection read failed");
      return actual.branchCleanupOnMerge(...args);
    },
  };
});

import {
  mergeTaskPr,
  RECONCILE_TASK_CONCURRENCY,
  reconcileProject,
  reconcileTask,
  resetReconcileCursorsForTests,
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
    expect(fm.pr?.revisionDrift).toEqual({ aheadBy: 2, headSha: "headsha318" });
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
    const events2 = store.db
      .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
      .all() as { text: string }[];
    expect(events2.filter((e) => /\*\*Divergence:\*\*/.test(e.text))).toHaveLength(1);
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
          { id: "r-assign", kind: "assign_specialist", profileId: "developer", label: "Assign Developer", detail: "" },
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
    const events = store.db.prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`).all() as { text: string }[];
    expect(events.some((e) => /closed on GitHub without merging/.test(e.text) && /withdrawn/.test(e.text))).toBe(true);
  });

  it("R8-6: a MERGED-out-of-band divergence withdraws transition but KEEPS accept_completion (accepting reflects the merge)", async () => {
    const { store, actor } = setup();
    seedWithRecs(store);
    const routes = happyRoutes();
    routes[`GET ${REPO_PATH}/pulls/318`] = {
      body: { number: 318, title: "Attach execution workspace", state: "closed",
        merged: true, merged_at: "2026-07-05T09:00:00Z", head: { sha: "headsha318" },
        additions: 1, deletions: 0, changed_files: 1 },
    };
    await reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
      { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl });
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed.frontmatter;
    // transition withdrawn; accept_completion SURVIVES (the divergence tells the human to accept).
    expect(fm.recommendations.map((r) => r.id).sort()).toEqual(["r-accept", "r-assign"]);
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
    const row = store.db
      .prepare(
        `SELECT pr_json FROM task_projections
         WHERE project_slug = ? AND task_key = 'VIB-301'`,
      )
      .get(store.slug) as { pr_json: string };
    expect(JSON.parse(row.pr_json)).toMatchObject({ review: "changes_requested" });
    // The observation row carries the two newly-consumed facts.
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

  const mergeRoutes = (extra: Record<string, FakeResponder> = {}) => ({
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
    cleanupFault.throws = true;
    try {
      const result = await mergeTaskPr(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-410" },
        actor,
        { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
      );
      // Fails on wave-2b: the cleanup block was unguarded, so a post-merge
      // housekeeping throw escaped mergeTaskPr and the caller surfaced a
      // COMPLETED merge as a failed acceptance.
      expect(result.status).toBe("merged");
    } finally {
      cleanupFault.throws = false;
    }
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
    const fetchImpl = (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return new Response(JSON.stringify({}), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
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
  function boardRoutes(store: TestStore): Record<string, FakeResponder> {
    const branches = (
      store.db
        .prepare(
          `SELECT branch FROM task_projections
            WHERE project_slug = ? AND branch IS NOT NULL`,
        )
        .all(store.slug) as { branch: string }[]
    ).map((r) => r.branch);
    const routes: Record<string, FakeResponder> = {
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
