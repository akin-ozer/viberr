import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { fakeGithubFetch, type FakeResponder } from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import {
  noteReconcileFailure,
  noteReconcileSuccess,
  pollGithubReconcile,
  reconcileSummaryFailed,
  RECONCILE_FAILURE_ALERT_THRESHOLD,
  startGithubReconcilePoller,
  stopGithubReconcilePoller,
} from "./reconcile-poller.server";
import * as reconciler from "./github-reconciler.server";
import type { ProjectReconcileSummary } from "./github-reconciler.server";

/**
 * C7 (pass-24 fix): the alert fires from a returned SUMMARY, not only a thrown
 * error — because `reconcileProject` NEVER throws for a revoked/expired/removed
 * credential or a network drop (those come back as `status !== "ok"` or per-task
 * `auth_failed`/`network_unavailable` results). Before the fix `noteReconcileSuccess`
 * ran every tick and cleared the streak, so the "GitHub sync failing" alert was
 * dead for the exact class its own copy names.
 */
describe("reconcileSummaryFailed (C7)", () => {
  const summary = (
    patch: Partial<ProjectReconcileSummary>,
  ): ProjectReconcileSummary => ({
    status: "ok",
    results: [],
    reconciled: 0,
    changed: 0,
    failed: 0,
    skipped: 0,
    ...patch,
  });

  it("a clean pass is NOT a failure", () => {
    expect(reconcileSummaryFailed(summary({ results: [] }))).toBe(false);
    expect(
      reconcileSummaryFailed(
        summary({ results: [{ status: "no_branch", taskKey: "T-1" }] }),
      ),
    ).toBe(false);
  });

  it("a credential/repo problem at context resolution (status !== ok) is a failure", () => {
    expect(reconcileSummaryFailed(summary({ status: "no_pat_configured" }))).toBe(true);
    expect(reconcileSummaryFailed(summary({ status: "no_repo_configured" }))).toBe(true);
  });

  it("a per-task auth or network failure (a revoked PAT / a dropped network) is a failure", () => {
    expect(
      reconcileSummaryFailed(
        summary({ results: [{ status: "auth_failed", message: "401" }] }),
      ),
    ).toBe(true);
    expect(
      reconcileSummaryFailed(
        summary({
          results: [{ status: "network_unavailable", message: "ENOTFOUND" }],
        }),
      ),
    ).toBe(true);
  });
});

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const REPO_PATH = "/repos/akin-ozer/viberr";

/** A branched review-stage task + a bound PAT for the store's project. */
function seedBranchedTask(store: TestStore, key: string): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(key, {
      title: "Branched task",
      stage: "review",
      branch: key.toLowerCase(),
      ownerUserId: store.users.arda.id,
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_poller0001" },
    actor,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
}

function happyRoutes(branch: string) {
  return {
    [`GET ${REPO_PATH}/compare/main...${branch}`]: {
      body: { ahead_by: 1, behind_by: 0, status: "ahead", commits: [] },
    },
    [`GET ${REPO_PATH}/pulls`]: { body: [] },
  } satisfies Record<string, FakeResponder>;
}

describe("pollGithubReconcile (P11-14)", () => {
  it("reconciles an active branched project WITHOUT the per-project audit (poller path)", async () => {
    const store = setupTestStore(ctx);
    seedBranchedTask(store, "VIB-1");
    const gh = fakeGithubFetch(happyRoutes("vib-1"));

    const summary = await pollGithubReconcile(store.db, {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
    });

    expect(summary.projects).toBe(1);
    // The poller must NOT spam the audit log with a per-project summary each tick.
    const audits = listAuditEvents(store.db, {}).map((a) => a.action);
    expect(audits).not.toContain("github.reconcile.project");
  });

  it("skips an ARCHIVED project", async () => {
    const store = setupTestStore(ctx);
    seedBranchedTask(store, "VIB-1");
    // Archive the project.
    const fm = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed
      .frontmatter;
    writeProject(store.dataRoot, { ...fm, archived: true });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const gh = fakeGithubFetch(happyRoutes("vib-1"));
    const summary = await pollGithubReconcile(store.db, {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
    });
    expect(summary.projects).toBe(0); // archived → not polled
  });

  it("skips a project with no branched tasks", async () => {
    const store = setupTestStore(ctx);
    // A task with NO branch.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", branch: null }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const summary = await pollGithubReconcile(store.db, { dataRoot: store.dataRoot });
    expect(summary.projects).toBe(0);
  });

  it("nudges a merge-pending (accepted, PR open) Done task ONCE, deduped (F12-05)", async () => {
    const store = setupTestStore(ctx);
    // A Done task an autonomous operator accepted — PR still OPEN ("accepted").
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        title: "Autonomously accepted",
        stage: "done",
        branch: "vib-1",
        ownerUserId: store.users.arda.id,
        pr: { number: 77, state: "accepted", title: "[VIB-1] work" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    // SAFETY: `SELECT COUNT(*) AS n` always returns exactly one row whose only
    // column is that integer, so `get` cannot come back undefined here.
    const countNudges = () =>
      (
        store.db
          .prepare(
            `SELECT COUNT(*) AS n FROM notifications WHERE task_key = 'VIB-1' AND kind = 'policy' AND title LIKE 'PR #77 accepted%'`,
          )
          .get() as { n: number }
      ).n;

    await pollGithubReconcile(store.db, { dataRoot: store.dataRoot });
    const first = countNudges();
    expect(first).toBeGreaterThan(0); // owner (+ admins/maintainers) notified

    // A second poll must NOT re-notify — the nudge fires once per (task, PR).
    await pollGithubReconcile(store.db, { dataRoot: store.dataRoot });
    expect(countNudges()).toBe(first);
  });

  it("B9: the merge-pending scan reads pr.state structurally, not as a JSON substring", async () => {
    // The scan was `pr_json LIKE '%\"state\":\"accepted\"%'` — a substring test
    // over a blob. `prRefSchema` is deliberately `.loose()` and task.md is
    // hand-editable, so any nested object carrying a `state` of "accepted"
    // (here: a note of what the PR used to be) matches the blob while the PR
    // itself is plainly still in review.
    //
    // HONEST SCOPE: the loop re-parses and re-checks `pr.state`, so restoring
    // the LIKE would not make this test fail — the substring scan costs wasted
    // rows, not wrong nudges. What this pins is the QUERY's semantics (the two
    // counts below diverge, and the poller follows the structural one), so the
    // day the redundant re-check is refactored away the blob match cannot come
    // back with it. `decisions.server.ts:138` already reads this column with
    // json_extract — this makes the two agree.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        title: "Still in review",
        stage: "review",
        branch: "vib-1",
        ownerUserId: store.users.arda.id,
        pr: {
          number: 77,
          state: "review",
          title: "[VIB-1] work",
          // `prRefSchema` is `.loose()`, so a hand-edited task.md can carry an
          // extra nested key like this one — which is the whole fixture.
          previous: { state: "accepted" },
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    // The fixture is real: the substring the old scan keyed on IS in the blob…
    // SAFETY: as above — a COUNT(*) row always exists and carries `n`.
    const naive = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM task_projections WHERE pr_json LIKE '%"state":"accepted"%'`,
        )
        .get() as { n: number }
    ).n;
    expect(naive).toBe(1);
    // …while the PR's own state is not "accepted".
    // SAFETY: as above — a COUNT(*) row always exists and carries `n`.
    const structural = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM task_projections
            WHERE pr_json IS NOT NULL AND json_valid(pr_json)
              AND json_extract(pr_json, '$.state') = 'accepted'`,
        )
        .get() as { n: number }
    ).n;
    expect(structural).toBe(0);

    await pollGithubReconcile(store.db, { dataRoot: store.dataRoot });
    // SAFETY: as above — a COUNT(*) row always exists and carries `n`.
    const nudges = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM notifications WHERE task_key = 'VIB-1' AND kind = 'policy'`,
        )
        .get() as { n: number }
    ).n;
    expect(nudges).toBe(0);
  });
});

describe("C7: a persistent reconcile failure alerts the people who can fix it", () => {
  const policyRows = (store: TestStore) =>
    store.db
      .prepare(
        `SELECT user_id AS userId, title FROM notifications
          WHERE project_slug = ? AND kind = 'policy'
          ORDER BY user_id ASC`,
      )
      .all(store.slug) as { userId: string; title: string }[];

  it("stays silent below the threshold, then notifies admins + maintainers once", () => {
    const store = setupTestStore(ctx);
    // Project the members into `project_members` (what listProjectMembers reads).
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    noteReconcileSuccess(store.slug); // clear any global streak from a prior test

    for (let i = 1; i < RECONCILE_FAILURE_ALERT_THRESHOLD; i += 1) {
      noteReconcileFailure(store.db, store.slug);
    }
    // Below the threshold: nothing yet.
    expect(policyRows(store)).toHaveLength(0);

    // Crossing the threshold alerts arda (admin) + murat (maintainer), NOT selin
    // (contributor cannot edit policy / fix the credential).
    noteReconcileFailure(store.db, store.slug);
    const alerted = policyRows(store);
    expect(alerted.map((r) => r.userId).sort()).toEqual(
      [store.users.arda.id, store.users.murat.id].sort(),
    );
    expect(alerted[0]!.title).toBe("GitHub sync is failing for this project");

    // Further failures do NOT pile up duplicate rows (alerted flag + stable id).
    noteReconcileFailure(store.db, store.slug);
    noteReconcileFailure(store.db, store.slug);
    expect(policyRows(store)).toHaveLength(2);

    // A success clears the streak so a genuinely-new outage can alert again.
    noteReconcileSuccess(store.slug);
  });
})

describe("E4: poller failure isolation + lifecycle", () => {
  const POLLER_KEY = Symbol.for("viberr.githubReconcilePoller");
  // SAFETY: a viberr-namespaced registry symbol the poller parks its interval
  // handle under; the test only reads presence/identity, never the handle's API.
  const pollerHandle = () =>
    (globalThis as Record<symbol, unknown>)[POLLER_KEY];

  afterEach(() => {
    stopGithubReconcilePoller();
    vi.restoreAllMocks();
  });

  it("a second start is a no-op (same handle); stop clears it", () => {
    const store = setupTestStore(ctx); // no branched tasks → boot pass polls nothing
    stopGithubReconcilePoller();
    expect(pollerHandle()).toBeUndefined();

    startGithubReconcilePoller(store.db);
    const handle = pollerHandle();
    expect(handle).toBeDefined();

    // A repeat start must NOT arm a second interval next to the first.
    startGithubReconcilePoller(store.db);
    expect(pollerHandle()).toBe(handle);

    stopGithubReconcilePoller();
    expect(pollerHandle()).toBeUndefined();
  });

  it("one project's reconcile throwing does not abort the remaining projects", async () => {
    const store = setupTestStore(ctx);
    seedBranchedTask(store, "VIB-1"); // project A: branched + credentialed

    // A SECOND branched project, so the poll iterates two slugs.
    const base = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    const betaSlug = "beta-project";
    writeProject(store.dataRoot, {
      ...base,
      name: "Beta",
      slug: betaSlug,
      taskPrefix: "BETA",
    });
    writeTask(store.dataRoot, betaSlug, {
      frontmatter: baseTaskFrontmatter("BETA-1", {
        title: "Branched",
        stage: "review",
        branch: "beta-1",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    // The FIRST project reconciled throws; the second must still be reached.
    const spy = vi
      .spyOn(reconciler, "reconcileProject")
      .mockImplementation(async (_db, slug) => {
        if (slug === store.slug) throw new Error("boom for project A");
        return {
          status: "ok",
          results: [],
          reconciled: 1,
          changed: 0,
          failed: 0,
          skipped: 0,
        };
      });

    // The poll must NOT throw, and must have called BOTH projects.
    const summary = await pollGithubReconcile(store.db, {
      dataRoot: store.dataRoot,
    });

    const slugsReconciled = spy.mock.calls.map((c) => c[1]).sort();
    expect(slugsReconciled).toEqual([betaSlug, store.slug].sort());
    expect(summary.projects).toBe(2);
    // Project B's success survived project A's throw.
    expect(summary.reconciled).toBe(1);
  });
})
