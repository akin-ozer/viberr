import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  routeArgs,
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { splitNotifications } from "./notifications-page-helpers";

/**
 * Route-level tests for the /notifications page (Phase 9C): per-user rows
 * sorted timestamp DESC and the needs-you/stream split.
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda;
});
afterAll(() => app.cleanup());

/** The producing actor a stream line renders: either absent, or named. The
 *  rows come off SQL joins, so the shape is parsed rather than trusted. */
const producingActorSchema = z.object({ name: z.string() }).nullable();

async function runLoader(cookie?: string) {
  const { loader } = await import("~/routes/notifications");
  return loader(
    routeArgs(app.request("/notifications", cookie ? { cookie } : {}), {}),
  );
}

describe("/notifications", () => {
  it("redirects signed-out users to /login", async () => {
    const thrown = await runLoader().catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    // SAFETY: the assertion above throws unless `thrown` is a Response, so
    // this line only runs on the redirect the signed-out loader threw.
    expect((thrown as Response).status).toBe(302);
  });

  it("lists arda's 10 seeded rows sorted by real timestamp DESC, 6 unread", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const result = await runLoader(cookie);

    expect(result.notifications).toHaveLength(10);
    expect(result.unread).toBe(6);
    const times = result.notifications.map((n) => n.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
    // Producing actors ship for the stream lines.
    expect(
      result.notifications.every(
        (n) => producingActorSchema.safeParse(n.from).success,
      ),
    ).toBe(true);
  });

  it("splits LIVE packets+approvals into the needs-you panel; unread filter applies to both", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const { notifications } = await runLoader(cookie);

    const all = splitNotifications(notifications, "all");
    // F7-NOTIF1: the waiting bucket holds only decisions still pending on the
    // LIVE task record — 3 open packets (VIB-160 / DEP-31 / VIB-142) + BIL-9's
    // pending transition recommendation. The n-145-approval row is seeded
    // STALE (VIB-145 already sits in Review with no pending recommendation),
    // so it belongs to the stream, not "Waiting on you".
    expect(all.needs.map((n) => n.id).sort()).toEqual([
      "n-142-packet",
      "n-160-packet",
      "n-bil-9",
      "n-dep-31",
    ]);
    expect(
      all.needs.every((n) => n.kind === "packet" || n.kind === "approval"),
    ).toBe(true);
    expect(all.rest).toHaveLength(6); // mentions / quality / policy + stale approval
    expect(all.rest.map((n) => n.id)).toContain("n-145-approval");

    const unread = splitNotifications(notifications, "unread");
    expect(unread.needs.every((n) => n.unread)).toBe(true);
    expect(unread.rest.every((n) => n.unread)).toBe(true);
    expect(unread.needs.length + unread.rest.length).toBe(6);
  });
});
