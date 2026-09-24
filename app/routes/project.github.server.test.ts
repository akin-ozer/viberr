import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEventInput } from "~/server/audit/audit-recorder.server";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * F19-22 — the GitHub page's freshness chip needs TWO facts and the loader only
 * ever shipped one.
 *
 * `view.reconcile` is `MAX(observed_at)` over `github.reconcile` provenance, and
 * DG-3 skips that row when a poller tick finds nothing new (proven against the
 * real reconciler in `server/audit/audit-query.server.test.ts`), so it is the
 * last pass that CHANGED something. `reconcileCheck` is the last pass that RAN,
 * off the per-tick `github.reconcile.task` audit row. These pin that the loader
 * ships both, keeps them independent, and reports the check honestly when there
 * is none.
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda;
});
afterAll(() => app.cleanup());

async function loadGithubPage() {
  const { loader } = await import("~/routes/project.github");
  const { cookie } = await app.cookieFor(ardaId);
  const request = app.request("/projects/viberr-core/github", { cookie });
  return await loader({
    request,
    url: new URL(request.url),
    params: { slug: "viberr-core" },
    pattern: "/projects/:slug/github",
    context: new RouterContextProvider(),
  });
}

/** Write one completed-pass audit row at a chosen age, the way a poller tick
 *  does (per-task, system actor, no project-summary row). */
async function recordPass(
  minutesAgo: number,
  over: Partial<AuditEventInput> = {},
) {
  const { recordAudit } = await import("~/server/audit/audit-recorder.server");
  const occurredAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  // recordAudit stamps `new Date()`; the row is re-dated in place so the test
  // controls the age without freezing the clock the loader reads.
  recordAudit(app.db, {
    action: "github.reconcile.task",
    actor: { userId: null, label: "system" },
    projectSlug: "viberr-core",
    taskKey: "VIB-1",
    ...over,
  });
  app.db
    .prepare(
      `UPDATE audit_events SET occurred_at = ?
        WHERE id = (SELECT id FROM audit_events
                     WHERE action LIKE 'github.reconcile%'
                     ORDER BY rowid DESC LIMIT 1)`,
    )
    .run(occurredAt);
  return occurredAt;
}

function clearPasses() {
  app.db
    .prepare(`DELETE FROM audit_events WHERE action LIKE 'github.reconcile%'`)
    .run();
}

describe("F19-22: the GitHub loader ships the last CHECK beside the last change", () => {
  it("reports no check on record when no pass has been audited", async () => {
    clearPasses();
    const data = await loadGithubPage();
    // Null, not a borrowed provenance timestamp — the view renders the neutral
    // change-only cue from this (ruling 46/R17-5: nothing here is wrong).
    expect(data.reconcileCheck).toEqual({ at: null, label: null, stale: true });
  });

  it("reports a completed pass with a server-rendered label and a fresh tone", async () => {
    clearPasses();
    const at = await recordPass(2);
    const data = await loadGithubPage();
    expect(data.reconcileCheck.at).toBe(at);
    // Server-side label: both halves of the chip must come from ONE payload or
    // SSR and hydration straddle a minute boundary and disagree.
    expect(data.reconcileCheck.label).toBe("2m ago");
    expect(data.reconcileCheck.stale).toBe(false);
  });

  it("goes stale on the CHECK — the case a dead poller produces", async () => {
    clearPasses();
    await recordPass(180);
    const data = await loadGithubPage();
    expect(data.reconcileCheck.stale).toBe(true);
    // …and it is genuinely independent of the change clock: the seeded project
    // has no reconcile provenance at all, so the old single-number chip had
    // nothing to warn with here.
    expect(data.view.reconcile.at).toBeNull();
  });

  it("takes the NEWEST pass, unioning per-task ticks with a human sweep", async () => {
    clearPasses();
    await recordPass(90);
    const sweep = await recordPass(6, {
      action: "github.reconcile.project",
      taskKey: undefined,
    });
    const data = await loadGithubPage();
    expect(data.reconcileCheck.at).toBe(sweep);
    expect(data.reconcileCheck.stale).toBe(false);
  });

  it("ignores another project's passes", async () => {
    clearPasses();
    await recordPass(3, { projectSlug: "some-other-project" });
    const data = await loadGithubPage();
    expect(data.reconcileCheck.at).toBeNull();
  });
});
