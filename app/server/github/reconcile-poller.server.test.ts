import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
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
import { pollGithubReconcile } from "./reconcile-poller.server";

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

function happyRoutes(branch: string): Record<string, FakeResponder> {
  return {
    [`GET ${REPO_PATH}/compare/main...${branch}`]: {
      body: { ahead_by: 1, behind_by: 0, status: "ahead", commits: [] },
    },
    [`GET ${REPO_PATH}/pulls`]: { body: [] },
  };
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
          previous: { state: "accepted" },
        } as never,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    // The fixture is real: the substring the old scan keyed on IS in the blob…
    const naive = (
      store.db
        .prepare(
          `SELECT COUNT(*) AS n FROM task_projections WHERE pr_json LIKE '%"state":"accepted"%'`,
        )
        .get() as { n: number }
    ).n;
    expect(naive).toBe(1);
    // …while the PR's own state is not "accepted".
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
