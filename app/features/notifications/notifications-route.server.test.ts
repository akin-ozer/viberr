import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";
import { z } from "zod";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { splitNotifications } from "./notifications-page-helpers";

/**
 * Route-level tests for the /notifications page (Phase 9C): per-user rows
 * sorted timestamp DESC, the needs-you/stream split, cross-project soft
 * refs resolving to the seeded stub projects, packet resolution
 * auto-marking (phase-3/5 behavior — verified, not rebuilt), and the ONE
 * shared read action route.
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  // Ruling 121: resolving VIB-142's packet re-queues its operator, and that
  // drive bills the TASK OWNER (arda). With the backend unconnected the drive
  // is refused and escalates a NEW blocked packet onto the very task this file
  // just resolved one on — which is a true behaviour, but not the one under
  // test here. Connecting arda keeps this file about notification rows.
  const { connectFakeBackends } = await import(
    "../../../test-support/backend-credentials"
  );
  await connectFakeBackends(app.db, ardaId);
});
afterAll(() => app.cleanup());

/**
 * A server loader/action is handed the request, the match pattern, the dynamic
 * params and a middleware context. Building the whole envelope rather than a
 * partial stand-in is what keeps the direct calls below type-checked against
 * the real route signatures. Neither route here takes path params.
 */
function routeArgs(request: Request, pattern: string) {
  return {
    request,
    url: new URL(request.url),
    params: {},
    pattern,
    context: new RouterContextProvider(),
  };
}

/** The producing actor a stream line renders: either absent, or named. The
 *  rows come off SQL joins, so the shape is parsed rather than trusted. */
const producingActorSchema = z.object({ name: z.string() }).nullable();

async function runLoader(cookie?: string) {
  const { loader } = await import("~/routes/notifications");
  return loader(
    routeArgs(
      app.request("/notifications", cookie ? { cookie } : {}),
      "/notifications",
    ),
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

  it("cross-project rows are real soft refs into the seeded stub projects", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const { notifications } = await runLoader(cookie);

    const dep = notifications.find((n) => n.taskKey === "DEP-31")!;
    expect(dep.projectSlug).toBe("deploy-pipeline");
    expect(dep.projectName).toBe("Deploy Pipeline");
    const bil = notifications.find((n) => n.taskKey === "BIL-9")!;
    expect(bil.projectSlug).toBe("billing-service");
    expect(bil.projectName).toBe("Billing Service");
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

  it("packet resolution auto-marks that task's packet/approval rows read (phase-5 contract)", async () => {
    const before = await runLoader((await app.cookieFor(ardaId)).cookie);
    expect(
      before.notifications.find((n) => n.id === "n-142-packet")?.unread,
    ).toBe(true);

    const { resolvePacket } = await import(
      "~/server/tasks/task-actions.server"
    );
    // "Request one edit" — resolves the packet without the merge path.
    await resolvePacket(
      app.db,
      { projectSlug: "viberr-core", taskKey: "VIB-142", optionIndex: 1 },
      { userId: ardaId, label: "arda@viberr.dev" },
    );

    const after = await runLoader((await app.cookieFor(ardaId)).cookie);
    expect(
      after.notifications.find((n) => n.id === "n-142-packet")?.unread,
    ).toBe(false);
    // F7-NOTIF1: the resolved packet's row also leaves the waiting bucket —
    // reconciled against the live task record at read time, not deleted.
    const resolved = after.notifications.find((n) => n.id === "n-142-packet")!;
    expect(resolved.waitingOnYou).toBe(false);
    expect(
      splitNotifications(after.notifications, "all").rest.map((n) => n.id),
    ).toContain("n-142-packet");
  });

  it("mark-all-read via the ONE shared read action drops unread to zero", async () => {
    const { cookie, sessionId } = await app.cookieFor(ardaId);
    const csrf = await app.csrfFor(sessionId);
    const { action } = await import("~/routes/notifications.read");

    const body = new URLSearchParams({ _csrf: csrf, intent: "read-all" });
    const result = await action(
      routeArgs(
        app.request("/notifications/read", {
          method: "POST",
          cookie,
          body,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }),
        "/notifications/read",
      ),
    );
    // The read-all branch answers with a bare object; the CSRF-failure branch
    // answers with a `data()` envelope carrying no `ok`, so the member is read
    // through that narrowing rather than asserted into existence.
    expect("ok" in result && result.ok).toBe(true);

    const after = await runLoader(cookie);
    expect(after.unread).toBe(0);
    expect(after.notifications.every((n) => !n.unread)).toBe(true);
  });
});
