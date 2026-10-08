import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../test-support/test-app";
import { listAuditEvents } from "../../test-support/audit-log";
import { getMaxRunSpendUsd } from "~/server/settings/instance-settings.server";

/**
 * Ruling 175: the org-settings `set-run-spend-cap` intent persists the
 * instance's spending cap per Claude run (owner decision D4: an instance
 * ceiling only, none by default). Blank clears it; zero, a negative, more than
 * two decimals and anything `Number` would invent ("1e3") are refused with the
 * cap unchanged; every change is audited with the value before and after; the
 * action is org-admin gated like the rest of the page.
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

async function setSpendCap(
  userId: string,
  value: string,
): Promise<{ status: number; body: { ok: boolean; toast?: string; error?: string } }> {
  const { action } = await import("~/routes/org.settings");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const fd = new FormData();
  fd.set("intent", "set-run-spend-cap");
  fd.set("maxRunSpendUsd", value);
  fd.set("_csrf", csrf);
  const request = app.request("/org/settings", { method: "POST", body: fd, cookie });
  const result = await action({
    request,
    url: new URL(request.url),
    pattern: "/org/settings",
    params: {},
    context: new RouterContextProvider(),
  });
  const body = "data" in result ? result.data : result;
  const status = "init" in result ? (result.init?.status ?? 200) : 200;
  return { status, body };
}

describe("org-settings set-run-spend-cap (ruling 175)", () => {
  it("has no cap until an admin sets one", () => {
    expect(getMaxRunSpendUsd(app.db)).toBeNull();
  });

  it("an org admin sets the cap; it persists and the change is audited before → after", async () => {
    const { body } = await setSpendCap(ardaId, "2.5");
    expect(body.ok).toBe(true);
    expect(body.toast).toBe("Claude runs now stop when they have spent $2.50.");
    expect(getMaxRunSpendUsd(app.db)).toBe(2.5);

    await setSpendCap(ardaId, "12.34");
    // Newest first.
    const rows = listAuditEvents(app.db, { action: "org.run_spend_cap.changed" });
    expect(rows[0]?.details).toEqual({ before: 2.5, after: 12.34 });
    expect(rows[0]?.actorLabel).toBe("arda@viberr.dev");
  });

  it("blank clears the cap, audited as after: null", async () => {
    await setSpendCap(ardaId, "3");
    const { body } = await setSpendCap(ardaId, "  ");
    expect(body.ok).toBe(true);
    expect(body.toast).toBe("Claude runs no longer have a spending cap.");
    expect(getMaxRunSpendUsd(app.db)).toBeNull();
    const rows = listAuditEvents(app.db, { action: "org.run_spend_cap.changed" });
    expect(rows[0]?.details).toEqual({ before: 3, after: null });
  });

  it("refuses zero, a negative, a third decimal and an exponent, leaving the cap as it was", async () => {
    await setSpendCap(ardaId, "4");
    for (const bad of ["0", "0.00", "-1", "1.234", "1e3", "abc"]) {
      const res = await setSpendCap(ardaId, bad);
      expect(res.body.ok, bad).toBe(false);
      expect(res.status, bad).toBe(400);
      expect(res.body.error).toContain("at most two decimals");
      expect(getMaxRunSpendUsd(app.db), bad).toBe(4);
    }
  });
});
