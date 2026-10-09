import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { SeedUserIds } from "../../test-support/demo-data";
import { routeArgs, setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * Ruling 304: the Review queue's decision dialog reads one task's open
 * decision, as real requests against the route: a 401 rather than a login
 * redirect because a fetcher loads it, the task page's membership gate, and
 * the contract the route exists for — the decision the task page's own loader
 * reads, so the dialog cannot show it another way. How the dialog draws it and
 * where it posts are `features/review/review-page.test.tsx`'s.
 */

let app: AppTestContext;
let ids: SeedUserIds;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  ids = (await runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;
});
afterAll(() => app.cleanup());

/** What a loader throws: React Router's `data()` envelope. */
const thrownEnvelope = z.object({ init: z.object({ status: z.number() }) });

async function readDecision(key: string, userId: string | null) {
  const { loader } = await import("~/routes/task-decision");
  const cookie = userId ? (await app.cookieFor(userId)).cookie : undefined;
  const request = app.request(
    `/projects/viberr-core/tasks/${key}/decision`,
    cookie ? { cookie } : {},
  );
  return loader(routeArgs(request, { slug: "viberr-core", key }, "/projects/:slug/tasks/:key/decision"));
}

async function readTaskPage(key: string, userId: string) {
  const { loader } = await import("~/routes/project.task");
  const { cookie } = await app.cookieFor(userId);
  const request = app.request(`/projects/viberr-core/tasks/${key}`, { cookie });
  return loader(routeArgs(request, { slug: "viberr-core", key }, "/projects/:slug/tasks/:key"));
}

async function refusedStatus(read: Promise<unknown>): Promise<number | null> {
  try {
    await read;
    return null;
  } catch (error) {
    return thrownEnvelope.parse(error).init.status;
  }
}

describe("ruling 304: the decision dialog's read", () => {
  it("answers a signed-out fetch 401, and a non-member or an unknown task the page's 404", async () => {
    // CANARY: gate on `requireUser` and the signed-out fetch is redirected to
    // /login, which a fetcher follows as a navigation away from the queue.
    expect(await refusedStatus(readDecision("VIB-142", null))).toBe(401);
    expect(await refusedStatus(readDecision("VIB-142", ids.deniz))).toBe(404);
    expect(await refusedStatus(readDecision("VIB-999", ids.arda))).toBe(404);
  });

  it("reads the decision the task page reads, for the viewer who answers it", async () => {
    const view = await readDecision("VIB-142", ids.arda);
    if (!view.ok) throw new Error("the decision read failed");
    const page = await readTaskPage("VIB-142", ids.arda);

    // The seeded VIB-142's completion packet, offering the acceptance.
    expect(view.task.packet?.options.map((o) => o.kind)).toEqual([
      "accept_completion",
      "request_edit",
      "block_on_policy",
    ]);
    // CANARY: read any of these another way in `readTaskDecision` and the
    // dialog and the task page disagree about one decision.
    const decided = (d: typeof view | typeof page) => ({
      packet: d.task.packet,
      completion: d.completion,
      whatItTook: d.whatItTook,
      packetAlsoAnswers: d.packetAlsoAnswers,
      packetCreateTaskEchoes: d.packetCreateTaskEchoes,
      acceptance: d.acceptance,
      recommendations: d.recommendations,
      archived: d.archived,
      workRevisionSha: d.workRevisionSha,
      noChanges: d.noChanges,
      filesDeliveredAt: d.filesDeliveredAt,
      defaultBranch: d.defaultBranch,
      mergeCollisions: d.mergeCollisions,
      baseBehindBy: d.baseBehindBy,
      githubHost: d.githubHost,
      // What the composer the dialog opens for "Ask operator" names and bills.
      mentionables: d.mentionables,
      runPrincipal: d.runPrincipal,
    });
    expect(decided(view)).toEqual(decided(page));
    // Whose tiers the dialog states: the task page's layout role.
    expect(view.viewer).toEqual({ userId: ids.arda, role: "admin" });
    // No timeline: the dialog shows the decision, and the page keeps the record.
    expect(view.task.timeline).toEqual([]);
  });
});
