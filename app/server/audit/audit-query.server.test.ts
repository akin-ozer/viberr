import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { recordAudit, type AuditEventInput } from "./audit-recorder.server";
import {
  latestProjectReconcileCheckAt,
  latestTaskReconcileCheckAt,
} from "./audit-query.server";
import {
  latestProjectReconcileAt,
  latestTaskReconcileAt,
} from "~/server/provenance/provenance-query.server";
import { reconcileTask } from "~/server/github/github-reconciler.server";

/**
 * F19-22 — "when did the poller last CHECK?" had no reader, so every freshness
 * cue in the product answered a different question ("when did something last
 * CHANGE?") under a label that promised the first.
 *
 * The first describe below is the premise, proven against the real reconciler
 * rather than asserted: two passes, the second finding nothing new, leave ONE
 * provenance row and TWO audit rows. If DG-3 is ever dropped (or the audit
 * write ever moves behind the `changed` guard), that test fails and the two
 * queries stop meaning what the UI says they mean.
 */

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(() => {
  vi.useRealTimers();
  ctx.cleanup();
});

const REPO_PATH = "/repos/akin-ozer/viberr";

function setup(): { store: TestStore; actor: { userId: string; label: string } } {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-301", {
      title: "Attach execution workspace",
      stage: "review",
      branch: "vib-301-workspace",
      ownerUserId: store.users.arda.id,
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

/** A repository nothing is happening in: every pass reads the same facts. */
function quietRoutes(): Record<string, FakeResponder> {
  return {
    [`GET ${REPO_PATH}/compare/main...vib-301-workspace`]: {
      body: {
        ahead_by: 1,
        behind_by: 0,
        status: "ahead",
        commits: [
          {
            sha: "a91f7c2ffff",
            commit: { message: "[VIB-301] add repo attach policy gate" },
          },
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
      body: { total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] },
    },
  };
}

describe("F19-22 premise: an unchanged poller tick checks without recording a change", () => {
  it("leaves the provenance clock still and the audit clock moving", async () => {
    const { store, actor } = setup();
    const gh = fakeGithubFetch(quietRoutes());
    const pollerCtx = {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
      // Exactly what reconcile-poller.server.ts passes on every 5-min tick.
      skipUnchangedProvenance: true,
    };

    // Only Date is faked — the reconciler awaits real promises, and faking
    // setTimeout too would hang them.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));
    const first = await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      pollerCtx,
    );
    expect(first).toMatchObject({ status: "reconciled", changed: true });

    vi.setSystemTime(new Date("2026-08-06T12:42:00.000Z"));
    const second = await reconcileTask(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      pollerCtx,
    );
    // Nothing moved on GitHub, so DG-3 skips the provenance row — deliberately.
    expect(second).toMatchObject({ status: "reconciled", changed: false });

    // THE defect, in one pair of assertions: the number the product used to
    // render as "Synced 42m ago" is frozen at the first pass, while a second
    // pass really did complete 42 minutes later.
    expect(latestTaskReconcileAt(store.db, store.slug, "VIB-301")).toBe(
      "2026-08-06T12:00:00.000Z",
    );
    expect(latestTaskReconcileCheckAt(store.db, store.slug, "VIB-301")).toBe(
      "2026-08-06T12:42:00.000Z",
    );

    // And the audit row is per-tick, not per-change: two passes, two rows.
    expect(
      listAuditEvents(store.db, { action: "github.reconcile.task" }),
    ).toHaveLength(2);

    // Project-wide, the same two facts.
    expect(latestProjectReconcileAt(store.db, store.slug)).toBe(
      "2026-08-06T12:00:00.000Z",
    );
    expect(latestProjectReconcileCheckAt(store.db, store.slug)).toBe(
      "2026-08-06T12:42:00.000Z",
    );
  });
});

/** recordAudit stamps `new Date()`; these tests want explicit instants. Only
 *  Date is faked, and the clock is restored immediately — nothing else in the
 *  file may inherit a frozen clock. */
function auditAt(
  db: DatabaseSync,
  iso: string,
  event: AuditEventInput,
): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
  recordAudit(db, event);
  vi.useRealTimers();
}

const SYSTEM = { userId: null, label: "system" };

describe("latestTaskReconcileCheckAt", () => {
  const taskPass = (over: Partial<AuditEventInput> = {}): AuditEventInput => ({
    action: "github.reconcile.task",
    actor: SYSTEM,
    projectSlug: "viberr-core",
    taskKey: "VIB-142",
    ...over,
  });

  it("returns the newest pass for THAT task and null when none is on record", () => {
    const db = ctx.makeDb();
    auditAt(db, "2026-08-06T12:07:00.000Z", taskPass());
    auditAt(db, "2026-08-06T12:42:00.000Z", taskPass());
    // Another task in the same project, later — must not leak into VIB-142.
    auditAt(db, "2026-08-06T12:55:00.000Z", taskPass({ taskKey: "VIB-201" }));
    // The same task key in ANOTHER project, later still.
    auditAt(db, "2026-08-06T13:10:00.000Z", taskPass({ projectSlug: "other-project" }));
    // A different action on the same task, later still.
    auditAt(db, "2026-08-06T13:20:00.000Z", taskPass({ action: "task.transitioned" }));

    expect(latestTaskReconcileCheckAt(db, "viberr-core", "VIB-142")).toBe(
      "2026-08-06T12:42:00.000Z",
    );
    // Null = "cannot prove when we last looked", NOT "never synced" — the whole
    // point of F19-22 is that the two are different claims.
    expect(latestTaskReconcileCheckAt(db, "viberr-core", "VIB-999")).toBeNull();
    expect(latestTaskReconcileCheckAt(db, "nothing-here", "VIB-142")).toBeNull();
  });
});

describe("latestProjectReconcileCheckAt", () => {
  it("unions the per-task and project-sweep actions, scoped to the project", () => {
    const db = ctx.makeDb();
    // A poller tick: per-task rows only (skipProjectAudit).
    auditAt(db, "2026-08-06T12:42:00.000Z", {
      action: "github.reconcile.task",
      actor: SYSTEM,
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
    });
    // A human "Update status" over a board with no reconcilable task: the
    // project row is the ONLY evidence the pass happened.
    auditAt(db, "2026-08-06T12:50:00.000Z", {
      action: "github.reconcile.project",
      actor: SYSTEM,
      projectSlug: "viberr-core",
    });
    // Another project's sweep, later — must not leak.
    auditAt(db, "2026-08-06T13:30:00.000Z", {
      action: "github.reconcile.project",
      actor: SYSTEM,
      projectSlug: "other-project",
    });

    expect(latestProjectReconcileCheckAt(db, "viberr-core")).toBe(
      "2026-08-06T12:50:00.000Z",
    );
    expect(latestProjectReconcileCheckAt(db, "other-project")).toBe(
      "2026-08-06T13:30:00.000Z",
    );
    expect(latestProjectReconcileCheckAt(db, "nothing-here")).toBeNull();
  });

  it("answers from per-task rows alone — the only ones a poller tick writes", () => {
    const db = ctx.makeDb();
    auditAt(db, "2026-08-06T12:42:00.000Z", {
      action: "github.reconcile.task",
      actor: SYSTEM,
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
    });
    expect(latestProjectReconcileCheckAt(db, "viberr-core")).toBe(
      "2026-08-06T12:42:00.000Z",
    );
  });
});
