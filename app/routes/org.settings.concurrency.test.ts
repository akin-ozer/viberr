import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  routeArgs,
  setupAppTest,
  type AppTestContext,
} from "../../test-support/test-app";
import { listAuditEvents } from "../../test-support/audit-log";
import { getMaxConcurrentRuns } from "~/server/settings/instance-settings.server";

/**
 * The org-settings `set-concurrency` intent persists the instance run
 * concurrency cap. The action is uniformly org-admin gated (requireRoleAuth);
 * this pins the happy path, the input validation, and ruling 31's audit: the
 * cap is instance policy, so every change is recorded as
 * `org.run_concurrency_cap.changed` with the value before and after.
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda; // org admin
});
afterAll(() => app.cleanup());

async function setCap(
  userId: string,
  value: string,
): Promise<{ status: number; body: { ok: boolean; toast?: string; error?: string } }> {
  const { action } = await import("~/routes/org.settings");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const fd = new FormData();
  fd.set("intent", "set-concurrency");
  fd.set("maxConcurrentRuns", value);
  fd.set("_csrf", csrf);
  const request = app.request("/org/settings", {
    method: "POST",
    body: fd,
    cookie,
  });
  const result = await action(routeArgs(request, {}, "/org/settings"));
  const body = "data" in result ? result.data : result;
  const status = "init" in result ? (result.init?.status ?? 200) : 200;
  return { status, body };
}

describe("org-settings set-concurrency", () => {
  it("an org admin sets the cap and it persists", async () => {
    const { body } = await setCap(ardaId, "3");
    expect(body.ok).toBe(true);
    expect(body.toast).toMatch(/capped at 3/);
    expect(getMaxConcurrentRuns(app.db)).toBe(3);
  });

  it("0 lifts the cap back to unlimited", async () => {
    await setCap(ardaId, "5");
    const { body } = await setCap(ardaId, "0");
    expect(body.ok).toBe(true);
    expect(body.toast).toMatch(/unlimited/);
    expect(getMaxConcurrentRuns(app.db)).toBe(0);
  });

  it("rejects a negative / non-numeric value without changing the cap", async () => {
    await setCap(ardaId, "4");
    const audited = listAuditEvents(app.db, { action: "org.run_concurrency_cap.changed" }).length;
    const bad = await setCap(ardaId, "-1");
    expect(bad.body.ok).toBe(false);
    expect(getMaxConcurrentRuns(app.db)).toBe(4);
    // A refused value changed nothing, so it records nothing.
    expect(listAuditEvents(app.db, { action: "org.run_concurrency_cap.changed" })).toHaveLength(audited);
  });

  // Ruling 31 and the Conventions' audit rule: changing how many runs the
  // instance admits is a policy change, audited like the spending cap beside it.
  // CANARY: drop the `recordAudit` call from `setMaxConcurrentRuns`, or record
  // the typed value instead of the clamped one, and this goes red.
  it("audits every change with the stored value before and after and the acting admin", async () => {
    await setCap(ardaId, "2");
    await setCap(ardaId, "999");
    // Newest first; the ceiling clamps 999, and the row records what was stored.
    const [row] = listAuditEvents(app.db, { action: "org.run_concurrency_cap.changed" });
    expect(row?.details).toEqual({ before: 2, after: 64 });
    expect(row?.actorUserId).toBe(ardaId);
    expect(row?.actorLabel).toBe("arda@viberr.dev");
    expect(row?.subjectKind).toBe("instance_setting");
    expect(row?.subjectId).toBe("maxConcurrentRuns");
  });
});
