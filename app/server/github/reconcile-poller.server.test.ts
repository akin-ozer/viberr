import { afterEach, describe, expect, it, vi } from "vitest";
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
  unreachableFetch,
  type FakeResponder,
} from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { setupProjectedStore } from "../../../test-support/projected-store";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import {
  pollGithubReconcile,
  startGithubReconcilePoller,
  stopGithubReconcilePoller,
} from "./reconcile-poller.server";
import * as reconciler from "./github-reconciler.server";
import { listNotifications } from "~/server/projections/notifications.server";

/** The registry symbol `reconcile-poller.server.ts` parks its interval handle
 *  under, and the shape of that process-global slot — mirrored here so the test
 *  reads the poller's own contract instead of an open dictionary. */
const POLLER_KEY = Symbol.for("viberr.githubReconcilePoller");
interface PollerHost {
  [POLLER_KEY]?: ReturnType<typeof setInterval>;
}

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

  /**
   * Ruling 207(l) (claim audit). The merge-pending nudge asserted "PR #N is
   * still open on GitHub" — a live fact — out of `task_projections.pr_json`,
   * which is a CACHE. What kept that cache honest was the 5-minute reconcile
   * poll, and ruling 177 excludes terminal-stage tasks from every budgeted
   * pass: an accepted task IS terminal, so the exact rows this nudge describes
   * are the rows nothing refreshes. The number is still worth sending; it has
   * to say whose reading it is.
   */
  it("ruling 207(l): the merge-pending nudge reports its own last reading, not live GitHub state", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "done",
        branch: "vib-1",
        pr: { number: 42, state: "accepted", title: "[VIB-1] t" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await pollGithubReconcile(store.db, { dataRoot: store.dataRoot });

    const note = listNotifications(store.db, store.users.arda.id).find(
      (n) => n.taskKey === "VIB-1",
    );
    // CANARY: restore "but PR #42 is still open on GitHub" and this fails —
    // that sentence claims a reading viberr is barred from taking.
    expect(note!.text).toContain("The last state Viberr read for PR #42 was open");
    expect(note!.text).toContain("stops polling a task once it reaches Done");
    expect(note!.text).not.toContain("is still open on GitHub");
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
    // back with it. `decisionsRequiring` (decisions.server.ts) already reads
    // this column with json_extract — this makes the two agree.
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
  // SAFETY: the two selected columns are the aliased `user_id` and `title`, both
  // non-null TEXT on every `notifications` row the baseline can produce.
  const policyRows = (store: TestStore) =>
    store.db
      .prepare(
        `SELECT user_id AS userId, title, href FROM notifications
          WHERE project_slug = ? AND kind = 'policy'
          ORDER BY user_id ASC`,
      )
      .all(store.slug) as { userId: string; title: string; href: string | null }[];

  /**
   * C7 (pass-24 fix): `reconcileProject` never THROWS for the failures the
   * alert names. A revoked, expired or removed credential or a dropped network
   * comes back in the summary (`status !== "ok"`, or per-task
   * `auth_failed`/`network_unavailable` results); before the fix every such
   * tick ran `noteReconcileSuccess` and cleared the streak, so the alert was
   * dead for the exact class its own copy names. Driven through the poll: an
   * unreachable GitHub fails the task's compare.
   */
  it("a pass whose tasks cannot reach GitHub counts toward the alert: silent below the threshold, then admins + maintainers once", async () => {
    // Project the members into `project_members` (what listProjectMembers reads).
    const store = setupProjectedStore(ctx);
    seedBranchedTask(store, "VIB-1");
    const poll = (fetchImpl: typeof fetch) =>
      pollGithubReconcile(store.db, { dataRoot: store.dataRoot, fetchImpl });
    const alerts = () =>
      policyRows(store).filter((r) => r.title === "GitHub sync is failing for this project");

    // The failure streak is process-global and keyed by slug: a clean pass
    // first clears whatever an earlier poll in this file left behind.
    await poll(fakeGithubFetch(happyRoutes("vib-1")).fetchImpl);
    await poll(unreachableFetch());
    await poll(unreachableFetch());
    // Below the threshold: nothing yet.
    expect(alerts()).toHaveLength(0);

    // The third failing pass alerts arda (admin) + murat (maintainer), NOT
    // selin (a contributor cannot fix the credential). CANARY: drop the
    // `reconcileSummaryFailed` read in pollGithubReconcile and nothing alerts.
    await poll(unreachableFetch());
    const alerted = alerts();
    expect(alerted.map((r) => r.userId).sort()).toEqual(
      [store.users.arda.id, store.users.murat.id].sort(),
    );
    // Ruling 497: the credential is fixed on the project's GitHub page, so the
    // row opens there, not on the board. CANARY: drop `href` from the alert.
    expect(alerted[0]!.href).toBe(`/projects/${store.slug}/github`);

    // Further failures do NOT pile up duplicate rows (alerted flag + stable id).
    await poll(unreachableFetch());
    await poll(unreachableFetch());
    expect(alerts()).toHaveLength(2);

    // A clean pass clears the streak again, so later tests start from zero.
    await poll(fakeGithubFetch(happyRoutes("vib-1")).fetchImpl);
  });
})

describe("E4: poller failure isolation + lifecycle", () => {
  // SAFETY: a viberr-namespaced registry symbol the poller parks its interval
  // handle under; the test only reads presence/identity, never the handle's API.
  const pollerHandle = () => (globalThis as PollerHost)[POLLER_KEY];

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
