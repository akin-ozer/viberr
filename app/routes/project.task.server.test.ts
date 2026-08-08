import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * F19-22 — the task page's GitHub panel needs the last CHECK as well as the
 * last change, and only the loader can supply it.
 *
 * `githubReconciledAt` is `MAX(observed_at)` over `github.reconcile` provenance,
 * which DG-3 withholds when a poller tick finds nothing new — so on a healthy,
 * quiet task it drifts to hours while passes keep completing every few minutes
 * (proven against the real reconciler in
 * `server/audit/audit-query.server.test.ts`). `githubCheckedAt` is the pass
 * itself, off the per-tick `github.reconcile.task` audit row.
 *
 * This route's OTHER loader/action tests live in
 * `features/task-detail/task-detail-route.server.test.ts`; this file is the
 * co-located home for the two facts the freshness cue is built from.
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
});
afterAll(() => app.cleanup());

interface TaskLoaderData {
  githubReconciledAt: string | null;
  githubCheckedAt: string | null;
}

async function loadTask(taskKey: string): Promise<TaskLoaderData> {
  const { loader } = await import("~/routes/project.task");
  const { cookie } = await app.cookieFor(ardaId);
  return (await loader({
    request: app.request(`/projects/viberr-core/tasks/${taskKey}`, { cookie }),
    params: { slug: "viberr-core", key: taskKey },
    context: {},
  } as never)) as TaskLoaderData;
}

/** One completed per-task pass, re-dated in place (recordAudit stamps now). */
async function recordPass(taskKey: string, iso: string, projectSlug = "viberr-core") {
  const { recordAudit } = await import("~/server/audit/audit-recorder.server");
  recordAudit(app.db, {
    action: "github.reconcile.task",
    actor: { userId: null, label: "system" },
    projectSlug,
    taskKey,
    details: { changed: false },
  });
  app.db
    .prepare(
      `UPDATE audit_events SET occurred_at = ?
        WHERE id = (SELECT id FROM audit_events
                     WHERE action = 'github.reconcile.task'
                     ORDER BY rowid DESC LIMIT 1)`,
    )
    .run(iso);
}

/** One recorded CHANGE, the provenance row DG-3 skips on a quiet tick. */
async function recordChange(taskKey: string, iso: string) {
  const { recordProvenance } = await import(
    "~/server/provenance/provenance-recorder.server"
  );
  const { taskProvenancePath } = await import(
    "~/server/provenance/provenance-query.server"
  );
  recordProvenance(app.db, {
    sourcePath: taskProvenancePath("viberr-core", taskKey),
    action: "github.reconcile",
    observedAt: iso,
  });
}

describe("F19-22: the task loader ships the last CHECK beside the last change", () => {
  it("reports null for a task with no completed pass on record", async () => {
    const data = await loadTask("VIB-142");
    // Null, not the provenance timestamp standing in for it — the panel renders
    // "no completed pass on record", which is all the app can honestly claim.
    expect(data.githubCheckedAt).toBeNull();
  });

  it("ships both clocks, and they move independently", async () => {
    // The live shape of the defect: last change 12:01:55, passes through 12:42.
    await recordChange("VIB-142", "2026-08-06T12:01:55.000Z");
    await recordPass("VIB-142", "2026-08-06T12:07:00.000Z");
    await recordPass("VIB-142", "2026-08-06T12:42:00.000Z");

    const data = await loadTask("VIB-142");
    expect(data.githubReconciledAt).toBe("2026-08-06T12:01:55.000Z");
    expect(data.githubCheckedAt).toBe("2026-08-06T12:42:00.000Z");
  });

  it("scopes the check to this task, in this project", async () => {
    // A LATER pass over a different task, and over the same key in another
    // project — neither may be read as this task's.
    await recordPass("VIB-148", "2026-08-06T13:30:00.000Z");
    await recordPass("VIB-142", "2026-08-06T14:00:00.000Z", "other-project");

    const data = await loadTask("VIB-142");
    expect(data.githubCheckedAt).toBe("2026-08-06T12:42:00.000Z");
  });
});
