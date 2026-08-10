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
 * co-located home for the two facts the freshness cue is built from — plus
 * the R19-15 view side-effect, which only a real loader GET can prove.
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

describe("R19-15: GETting the task route auto-reads the viewer's notifications", () => {
  it("clears this viewer's unread rows for the task; another user's stay unread", async () => {
    const { createNotification } = await import(
      "~/server/projections/notifications.server"
    );
    const { findUserByEmail } = await import("~/server/auth/user-store.server");
    const elifId = findUserByEmail(app.db, "elif@viberr.dev")!.id;
    // Fresh rows (the seed's arda rows may already be read by earlier loads):
    // two kinds for the viewer on the viewed task, one for ANOTHER user on the
    // same task, one for the viewer on a DIFFERENT task.
    createNotification(app.db, { id: "r19v_mine_m", userId: ardaId, kind: "mention", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });
    createNotification(app.db, { id: "r19v_mine_p", userId: ardaId, kind: "policy", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });
    createNotification(app.db, { id: "r19v_theirs", userId: elifId, kind: "mention", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });
    createNotification(app.db, { id: "r19v_other_task", userId: ardaId, kind: "mention", text: "t", projectSlug: "viberr-core", taskKey: "VIB-148" });

    await loadTask("VIB-142");

    const rows = app.db
      .prepare(`SELECT id, read_at FROM notifications WHERE id LIKE 'r19v%'`)
      .all() as { id: string; read_at: string | null }[];
    const readAt = (id: string) => rows.find((r) => r.id === id)?.read_at;
    expect(readAt("r19v_mine_m")).not.toBeNull();
    expect(readAt("r19v_mine_p")).not.toBeNull();
    // Viewing proves only that THE VIEWER has seen — and only THIS task.
    expect(readAt("r19v_theirs")).toBeNull();
    expect(readAt("r19v_other_task")).toBeNull();
  });

  it("a non-member probe 404s byte-identically and marks NOTHING (R15-4 purity)", async () => {
    // The read-marking write must sit BEHIND requireVisibleProject. The
    // structural scan in project-authority-routes.server.test.ts only proves
    // the gate is PRESENT in the loader body — a gate placed after the write
    // would still throw the same 404 after leaking the mutation, and every
    // status assertion would stay green. This pins the ORDER: the refused
    // path changes no state.
    const { createNotification } = await import(
      "~/server/projections/notifications.server"
    );
    const { findUserByEmail } = await import("~/server/auth/user-store.server");
    const denizId = findUserByEmail(app.db, "deniz@viberr.dev")!.id;
    // A stale row a FORMER member could plausibly still hold.
    createNotification(app.db, { id: "r19v_probe", userId: denizId, kind: "mention", text: "t", projectSlug: "viberr-core", taskKey: "VIB-142" });

    const { loader } = await import("~/routes/project.task");
    const { cookie } = await app.cookieFor(denizId);
    const thrown = (await loader({
      request: app.request("/projects/viberr-core/tasks/VIB-142", { cookie }),
      params: { slug: "viberr-core", key: "VIB-142" },
      context: {},
    } as never).then(
      () => null,
      (e: unknown) => e,
    )) as { data?: unknown; init?: { status?: number } } | null;

    expect(thrown?.init?.status).toBe(404);
    // The layout 404's byte-twin — the reply must not confirm the project exists.
    expect(String(thrown?.data)).toBe("No project at projects/viberr-core.");
    const row = app.db
      .prepare(`SELECT read_at FROM notifications WHERE id = 'r19v_probe'`)
      .get() as { read_at: string | null };
    expect(row.read_at).toBeNull();
  });
});
