import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_TEST_PASSWORD,
  routeArgs,
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import {
  FAKE_CLAUDE_URL,
  resetFakeVendorEnv,
  setFakeVendorMode,
  writeFakeVendorBinaries,
  type FakeVendorBinaries,
} from "../../../test-support/fake-vendor-binary";
import { listAuditEvents } from "../../../test-support/audit-log";
import { mergeNotifPrefs } from "./notification-prefs";

type ProfileAction = typeof import("~/routes/profile").action;

/**
 * Route-level tests for /profile (Phase 9C): loader shape (session user is
 * the single source of `me` — ruling 26(a); role from membership by id, never
 * hardcoded), prefs writes into user_prefs (the phase-5 tlDefault key
 * included), password change via the phase-2 machinery, and the GitHub
 * identity guards.
 */

let app: AppTestContext;
let ardaId: string;
let murId: string;
let fake: FakeVendorBinaries;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda;
  murId = userIds.murat;
  // Ruling 137: the route resolves its OWN vendor binaries (a form action must
  // not take an executable path from its caller), so the only way to exercise
  // the sign-in intents without spawning the real `claude auth login` is the
  // resolver's named test seam.
  fake = writeFakeVendorBinaries();
  const { setBackendBinariesForTests } = await import(
    "~/server/runtimes/backend-login.server"
  );
  setBackendBinariesForTests(fake.binaries);
});
afterAll(async () => {
  const { resetBackendLoginsForTests, setBackendBinariesForTests } =
    await import("~/server/runtimes/backend-login.server");
  resetBackendLoginsForTests();
  setBackendBinariesForTests(null);
  resetFakeVendorEnv();
  fake.cleanup();
  app.cleanup();
});

type ActionOutcome = {
  status: number;
  data: { ok: boolean; toast?: string; error?: string };
};

/** Route actions return plain objects on success, `data()` wrappers on error. */
function unwrap(result: Awaited<ReturnType<ProfileAction>>): ActionOutcome {
  return "init" in result
    ? { status: result.init?.status ?? 200, data: result.data }
    : { status: 200, data: result };
}

async function runLoader(cookie?: string) {
  const { loader } = await import("~/routes/profile");
  return loader(routeArgs(app.request("/profile", cookie ? { cookie } : {}), {}));
}

async function postAction(
  userId: string,
  fields: Record<string, string>,
): Promise<ActionOutcome> {
  const { cookie, csrf } = await app.sessionFor(userId);
  const { action } = await import("~/routes/profile");
  const body = new URLSearchParams({ _csrf: csrf, ...fields });
  return unwrap(
    await action(
      routeArgs(
        app.request("/profile", {
          method: "POST",
          cookie,
          body,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }),
        {},
      ),
    ),
  );
}

describe("/profile loader", () => {
  it("redirects signed-out users to /login", async () => {
    const thrown: unknown = await runLoader().catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    // SAFETY: the assertion above fails the test unless `thrown` IS a Response,
    // so this line only runs on one.
    expect((thrown as Response).status).toBe(302);
  });

  it("widens the session user: memberships by id, derived role, prefs defaults", async () => {
    const { cookie } = await app.sessionFor(ardaId);
    const { profile } = await runLoader(cookie);

    expect(profile.user.id).toBe(ardaId);
    expect(profile.user.email).toBe("arda@viberr.dev");
    expect(profile.user.hasPassword).toBe(true);
    expect(profile.user.githubConnected).toBe(false); // derived from idp
    // NEVER ship the hash.
    expect("passwordHash" in profile.user).toBe(false);

    // Arda belongs to all three seeded projects; most-active first.
    expect(profile.memberships.map((m) => m.slug)).toEqual([
      "viberr-core",
      "billing-service",
      "deploy-pipeline",
    ]);
    expect(profile.accessRole).toBe("admin");

    // Pref defaults (nothing stored yet).
    expect(profile.prefs.notifs).toEqual(mergeNotifPrefs(null));
    expect(profile.prefs.tlDefault).toBe("all");
    // Ruling 30: there is no motion preference any more.
    expect("motion" in profile.prefs).toBe(false);
  });

  it("membership role comes from the projection, per user (never hardcoded)", async () => {
    const { cookie } = await app.sessionFor(murId);
    const { profile } = await runLoader(cookie);
    expect(profile.memberships).toEqual([
      { slug: "viberr-core", name: "Viberr Core", role: "maintainer" },
    ]);
    expect(profile.accessRole).toBe("maintainer");
  });
});

describe("/profile action", () => {
  it("identity: trims + persists name/title with the membership-aware toast", async () => {
    const { data } = await postAction(murId, {
      intent: "identity",
      name: "  Murat Yıldız  ",
      title: "Staff engineer",
    });
    expect(data.ok).toBe(true);
    expect(data.toast).toBe("Profile saved. Visible to Viberr Core members");
    const { findUserById } = await import("~/server/auth/user-store.server");
    const user = findUserById(app.db, murId)!;
    expect(user.name).toBe("Murat Yıldız");
    expect(user.title).toBe("Staff engineer");
  });

  it("identity: rejects an empty display name", async () => {
    const { status, data } = await postAction(murId, {
      intent: "identity",
      name: "   ",
      title: "",
    });
    expect(status).toBe(400);
    expect(data.error).toBe("Display name can't be empty.");
  });

  it("set-notif flips one category's app channel in user_prefs", async () => {
    const { data } = await postAction(ardaId, {
      intent: "set-notif",
      category: "packets",
      on: "0",
    });
    expect(data.ok).toBe(true);
    const { cookie } = await app.sessionFor(ardaId);
    const { profile } = await runLoader(cookie);
    expect(profile.prefs.notifs.packets.app).toBe(false);
    expect(profile.prefs.notifs.approvals.app).toBe(true);
  });

  it("ruling 30: set-motion is not an intent any more", async () => {
    const { data } = await postAction(ardaId, {
      intent: "set-motion",
      motion: "reduce",
    });
    expect(data.ok).toBe(false);
    const { getPref } = await import("~/server/prefs/user-prefs.server");
    expect(getPref(app.db, ardaId, "motion")).toBeNull();
  });

  it("set-tl-default writes the phase-5 tlDefault key", async () => {
    const { data } = await postAction(ardaId, {
      intent: "set-tl-default",
      tlDefault: "typed",
    });
    expect(data.ok).toBe(true);
    const { getPref } = await import("~/server/prefs/user-prefs.server");
    expect(getPref(app.db, ardaId, "tlDefault")).toBe("typed");
  });

  it("change-password: rejects a wrong current password and a short/mismatched new one", async () => {
    const wrong = await postAction(ardaId, {
      intent: "change-password",
      current: "not-the-password",
      next: "a-long-enough-pw",
      confirm: "a-long-enough-pw",
    });
    expect(wrong.status).toBe(400);
    expect(wrong.data.error).toBe("Current password is incorrect.");

    const short = await postAction(ardaId, {
      intent: "change-password",
      current: APP_TEST_PASSWORD,
      next: "short",
      confirm: "short",
    });
    expect(short.status).toBe(400);
    expect(short.data.error).toBe("New password needs at least 8 characters.");

    const mismatch = await postAction(ardaId, {
      intent: "change-password",
      current: APP_TEST_PASSWORD,
      next: "a-long-enough-pw",
      confirm: "a-different-pw!!",
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.data.error).toBe("Passwords don't match.");
  });

  it("change-password: phase-2 machinery — new hash verifies, other sessions die", async () => {
    // A second session that should be revoked by the change.
    const other = await app.cookieFor(murId);
    const { cookie, sessionId } = await app.cookieFor(murId);
    const csrf = await app.csrfFor(sessionId);
    const { action } = await import("~/routes/profile");
    const body = new URLSearchParams({
      _csrf: csrf,
      intent: "change-password",
      current: APP_TEST_PASSWORD,
      next: "murat-new-pw-9999",
      confirm: "murat-new-pw-9999",
    });
    const { data: result } = unwrap(
      await action(
        routeArgs(
          app.request("/profile", {
            method: "POST",
            cookie,
            body,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          }),
          {},
        ),
      ),
    );
    // The file's cached session for Murat is one of the other sessions.
    app.forgetSession(murId);
    expect(result.ok).toBe(true);
    expect(result.toast).toBe("Password updated. Other sessions were signed out");

    const { loginWithCredentials } = await import(
      "~/server/auth/login.server"
    );
    const { getAuth } = await import("~/lib/auth.server");
    const auth = getAuth();
    // changeOwnPassword writes the new hash to the better-auth credential, so
    // the new password verifies through sign-in and the old one no longer does.
    expect(
      (
        await loginWithCredentials(app.db, auth, {
          email: "murat@viberr.dev",
          password: "murat-new-pw-9999",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await loginWithCredentials(app.db, auth, {
          email: "murat@viberr.dev",
          password: APP_TEST_PASSWORD,
        })
      ).ok,
    ).toBe(false);

    // The acting session survives; the other one is gone.
    // SAFETY: `session.id` is `text not null primary key` (0001_baseline.sql),
    // so every row of this projection carries a string id — node:sqlite types
    // every column as the open `SQLOutputValue` union regardless.
    const sessions = app.db
      .prepare(`SELECT id FROM session WHERE userId = ?`)
      .all(murId) as { id: string }[];
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain(sessionId);
    expect(ids).not.toContain(other.sessionId);
  });

  it("github-disconnect guards: not connected on a local account", async () => {
    const { status, data } = await postAction(ardaId, {
      intent: "github-disconnect",
    });
    expect(status).toBe(400);
    expect(data.error).toBe("GitHub isn't connected on this account.");
  });

  it("github-disconnect flips idp back to local for a github-linked account with a password", async () => {
    const { updateUserFields } = await import(
      "~/server/auth/user-store.server"
    );
    updateUserFields(app.db, ardaId, { idp: "github" });
    const { data } = await postAction(ardaId, { intent: "github-disconnect" });
    expect(data.ok).toBe(true);
    expect(data.toast).toBe(
      "GitHub disconnected. Audit falls back to your workspace identity",
    );
    const { findUserById } = await import("~/server/auth/user-store.server");
    expect(findUserById(app.db, ardaId)!.idp).toBe("local");
  });

  // UI-32: REWRITTEN — this test enshrined the bug. `assertCsrf` THREW a raw
  // Response from outside the action's try, and a thrown response from a
  // fetcher renders the nearest boundary, so a stale token replaced the whole
  // UI with root's "403 Forbidden" page and the action's own
  // `{ok:false,error}` toast path was unreachable. The rejection is now a
  // 403 RESULT the client's existing error handlers surface as a toast.
  it("rejects a forged CSRF token as a 403 result (not a thrown boundary)", async () => {
    const { cookie } = await app.sessionFor(ardaId);
    const { action } = await import("~/routes/profile");
    const body = new URLSearchParams({ _csrf: "forged", intent: "identity" });
    // SAFETY: every branch of this action returns either a plain `{ ok }`
    // object or a `data()` wrapper, so reading `init`/`data` as OPTIONAL is
    // true of both — a plain result leaves them undefined and fails the
    // assertions below rather than passing on a shape that was never there.
    const result = (await action(
      routeArgs(
        app.request("/profile", {
          method: "POST",
          cookie,
          body,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }),
        {},
      ),
    )) as { init?: { status?: number }; data?: { ok: boolean; error: string } };
    expect(result).not.toBeInstanceOf(Response);
    expect(result.init?.status).toBe(403);
    expect(result.data?.ok).toBe(false);
    expect(result.data?.error).toMatch(/expired|security token/i);
  });
});

/**
 * Ruling 137 — Profile → Agent accounts.
 *
 * Every intent is driven through the real route action (session cookie, CSRF,
 * the module's own `resolveBackendBinary`), and the sign-in ones spawn a real
 * child: the fake vendor executables stand in for `claude` and `codex`, so what
 * is asserted is the route wired to the driver, not a stub of it.
 */
describe("/profile agent accounts (ruling 137)", () => {
  /** The driver's own read path, polled until the session settles. */
  async function waitForLogin(
    userId: string,
    backend: "claude" | "codex",
    predicate: (view: { state: string; needsCode: boolean }) => boolean,
    what: string,
  ): Promise<void> {
    const { getBackendLogin } = await import(
      "~/server/runtimes/backend-login.server"
    );
    const deadline = Date.now() + 10_000;
    for (;;) {
      const view = getBackendLogin(userId, backend);
      if (view && predicate(view)) return;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${what}; last state: ${view?.state ?? "none"}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function backendsOf(userId: string) {
    const { cookie } = await app.sessionFor(userId);
    const { profile } = await runLoader(cookie);
    return profile.backends;
  }

  async function reset(): Promise<void> {
    const { resetBackendLoginsForTests } = await import(
      "~/server/runtimes/backend-login.server"
    );
    resetBackendLoginsForTests();
    resetFakeVendorEnv();
  }

  it("ruling 160(a): the loader attaches the viewer's OWN last refusal and never another person's", async () => {
    // Live (F34-1): every run on an account was refused with a 403 while the
    // card said "connected · verified". Canary: drop the
    // `credentialUserId === userId` filter in `ownRefusal` and Murat's card
    // shows Arda's refusal.
    //
    // The instants are RELATIVE (validation, 2026-09-07): an exhaustion whose
    // reset has passed is dropped by `latestBackendRateLimits`, so a fixture
    // pinned to a wall-clock instant asserts a fact with a shelf life — this
    // test passed until 11:50Z on the day its literals named and failed after.
    const observedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const refusedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const resetsAtSeconds = Math.floor((Date.now() + 60 * 60_000) / 1000);
    const quota = await import("~/server/runtimes/backend-quota.server");
    quota.recordBackendCredentialRefusal(app.db, "claude", {
      credentialUserId: ardaId,
      credentialLabel: "Arda Test",
      providerText: "The account's organization does not allow Claude Code (oauth_org_not_allowed).",
      runId: "run_refused",
      observedAt: refusedAt,
    });
    quota.recordBackendQuotaExhaustion(app.db, "codex", {
      credentialUserId: ardaId,
      credentialLabel: "Arda Test",
      resetsAt: resetsAtSeconds,
      resetsAtPrecision: "exact",
      providerText: "You've hit your usage limit.",
      runId: "run_spent",
      observedAt,
    });
    try {
      const arda = await backendsOf(ardaId);
      expect(arda[0]!.lastRefusal).toEqual({
        kind: "credential",
        providerText: "The account's organization does not allow Claude Code (oauth_org_not_allowed).",
        observedAt: refusedAt,
        runId: "run_refused",
        resetsAt: null,
        resetsAtPrecision: null,
      });
      expect(arda[1]!.lastRefusal).toEqual({
        kind: "quota",
        providerText: "You've hit your usage limit.",
        observedAt,
        runId: "run_spent",
        resetsAt: new Date(resetsAtSeconds * 1000).toISOString(),
        resetsAtPrecision: "exact",
      });
      const murat = await backendsOf(murId);
      expect(murat.map((b) => b.lastRefusal)).toEqual([null, null]);
    } finally {
      quota.clearBackendCredentialRefusal(app.db, "claude");
      quota.clearBackendQuotaExhaustion(app.db, "codex");
    }
  });

  /**
   * Ruling 161 (pass 37, F37-129): the usage reading on this card is the
   * VIEWER's own or it is absent.
   *
   * The store keeps ONE reading per backend for the whole instance, stamped
   * with whichever run reported it. /insights renders that unscoped on purpose
   * and is org-admin gated (`requireRole(request, "admin")`); this card is the
   * first NON-admin surface to carry a utilization figure at all, so an
   * unscoped field here would not duplicate an existing disclosure, it would
   * put one member's account consumption in front of every member under their
   * own name. Ruling 161 settled the principle in the owner's words: the
   * readings belong "per person on Insights ... and on Profile".
   */
  it("ruling 161: a reading billed to somebody else never reaches this card", async () => {
    const quota = await import("~/server/runtimes/backend-quota.server");
    quota.recordBackendRateLimit(app.db, "claude", {
      credentialUserId: murId,
      credentialLabel: "Murat",
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.91,
      resetsAt: Math.floor((Date.now() + 60 * 60_000) / 1000),
      isUsingOverage: false,
      observedAt: new Date().toISOString(),
    });
    try {
      // CANARY: drop the `credentialUserId !== userId` guard in `ownReading`
      // and Arda's card reports Murat's 91% as Arda's own.
      const arda = await backendsOf(ardaId);
      expect(arda.map((b) => b.usage ?? null)).toEqual([null, null]);
    } finally {
      quota.retireBackendRecordsFor(app.db, "claude", murId);
    }
  });

  /**
   * Ruling 161(c) (F40-50): the viewer's own reading whose window reset
   * before this load is marked, from the one home Insights reads too, so the
   * card says "That window reset" instead of "The window resets".
   *
   * Canary: return `false` from `readingWindowReset`, or drop the field in
   * `ownReading`, and `windowReset` reads false.
   */
  it("ruling 161: the viewer's reading whose window already reset is marked as such", async () => {
    const quota = await import("~/server/runtimes/backend-quota.server");
    quota.recordBackendRateLimit(app.db, "claude", {
      credentialUserId: ardaId,
      credentialLabel: "Arda Test",
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 0.92,
      // The window closed an hour ago; the reading was taken before it did.
      resetsAt: Math.floor((Date.now() - 60 * 60_000) / 1000),
      isUsingOverage: false,
      observedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
    });
    try {
      const arda = await backendsOf(ardaId);
      const claude = arda.find((b) => b.backend === "claude")!;
      expect(claude.usage).toMatchObject({ rateLimitType: "five_hour", windowReset: true });
    } finally {
      quota.retireBackendRecordsFor(app.db, "claude", ardaId);
    }
  });

  it("ruling 161: a reading older than the connection describes the account it replaced", async () => {
    // The second gate, and the moment it matters: the panel revalidates the
    // loader the instant a sign-in SUCCEEDS, which is exactly when a surviving
    // reading from the account just replaced would be re-rendered as the new
    // one's. The principal check cannot catch it, because the same person owns
    // both accounts. CANARY: drop the `connectedAt` comparison in `ownReading`.
    const quota = await import("~/server/runtimes/backend-quota.server");
    const { recordBackendLogin, loginTargetFor } = await import(
      "~/server/runtimes/backend-credentials.server"
    );
    // ORDER MATTERS, and it is the whole reason this test exists apart from
    // the store's own retirement tests (backend-credentials.server.test.ts).
    // Connecting FIRST means `retireBackendRecordsFor` has already run and has
    // nothing to delete, so the reading recorded after it survives in the store
    // and only the `connectedAt` comparison can suppress it. Recording the
    // reading first would be deleted by the connect and the test would pass
    // with the gate removed.
    recordBackendLogin(
      app.db,
      { userId: ardaId, label: "arda@viberr.dev" },
      "claude",
      "claudeai",
      { email: "the-new-account@example.com" },
      loginTargetFor(app.db, ardaId, "claude"),
    );
    quota.recordBackendRateLimit(app.db, "claude", {
      credentialUserId: ardaId,
      credentialLabel: "Arda Test",
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.95,
      resetsAt: Math.floor((Date.now() + 60 * 60_000) / 1000),
      isUsingOverage: false,
      // Observed an hour BEFORE the connection above: this figure is about the
      // account that one replaced.
      observedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    try {
      const arda = await backendsOf(ardaId);
      const claude = arda.find((b) => b.backend === "claude")!;
      expect(claude.usage ?? null).toBeNull();
    } finally {
      quota.retireBackendRecordsFor(app.db, "claude", ardaId);
      // The connect left an account on Arda's Claude card, and the ruling 138
      // cases below count her accounts.
      app.db
        .prepare(
          `DELETE FROM user_backend_credentials WHERE user_id = ? AND backend = 'claude'`,
        )
        .run(ardaId);
      await reset();
    }
  });

  it("ships both backends unconnected, with no secret and no box in the payload", async () => {
    const backends = await backendsOf(murId);
    expect(backends.map((b) => b.backend)).toEqual(["claude", "codex"]);
    const claude = backends[0]!;
    expect(claude.login).toBeNull();
    expect(claude.health.available).toBe(false);
    expect(claude.health.detail).toBe(
      "Claude isn't connected. Connect it on your Profile → Agent accounts.",
    );
    // The vendors' asymmetry is stated by the loader, not hardcoded in the UI.
    expect(claude.methods).toEqual({
      signIn: ["claudeai", "console"],
      paste: ["api_key"],
    });
    expect(backends[1]!.methods).toEqual({
      signIn: ["device"],
      paste: ["api_key", "access_token"],
    });
    const wire = JSON.stringify(backends);
    expect(wire).not.toContain("secret_box");
    expect(wire).not.toContain("secretBox");
  });

  it("backend-login-start spawns the vendor flow; the loader then shows its URL", async () => {
    setFakeVendorMode("hang");
    const { data } = await postAction(murId, {
      intent: "backend-login-start",
      backend: "claude",
      method: "claudeai",
    });
    expect(data.ok).toBe(true);
    // Starting is NOT a connection, so the action deliberately carries no toast.
    expect(data.toast).toBeUndefined();
    await waitForLogin(murId, "claude", (v) => v.state !== "starting", "the URL");

    const claude = (await backendsOf(murId))[0]!;
    expect(claude.login?.url).toBe(FAKE_CLAUDE_URL);
    expect(claude.login?.method).toBe("claudeai");
    expect(claude.health.available).toBe(false);
    // One person's sign-in is invisible to everyone else.
    expect((await backendsOf(ardaId))[0]!.login).toBeNull();
    expect(
      listAuditEvents(app.db, { action: "profile.backend.login_started" }).length,
    ).toBeGreaterThan(0);
    await reset();
  });

  it("backend-login-cancel ends a running sign-in, and refuses when none is", async () => {
    setFakeVendorMode("hang");
    await postAction(murId, {
      intent: "backend-login-start",
      backend: "codex",
      method: "device",
    });
    await waitForLogin(murId, "codex", (v) => v.state !== "starting", "the URL");

    const cancelled = await postAction(murId, {
      intent: "backend-login-cancel",
      backend: "codex",
    });
    expect(cancelled.data.ok).toBe(true);
    expect(cancelled.data.toast).toBe("Codex sign-in cancelled");
    expect(
      listAuditEvents(app.db, { action: "profile.backend.login_cancelled" }),
    ).toHaveLength(1);

    await reset();
    const again = await postAction(murId, {
      intent: "backend-login-cancel",
      backend: "codex",
    });
    expect(again.status).toBe(400);
    expect(again.data.error).toBe("No Codex sign-in is running.");
  });

  it("backend-login-code hands the code over and the vendor's own status records the row", async () => {
    setFakeVendorMode("success");
    await postAction(murId, {
      intent: "backend-login-start",
      backend: "claude",
      method: "console",
    });
    await waitForLogin(murId, "claude", (v) => v.needsCode, "the code prompt");

    const submitted = await postAction(murId, {
      intent: "backend-login-code",
      backend: "claude",
      code: "anthropic-shown-code",
    });
    expect(submitted.data.ok).toBe(true);
    await waitForLogin(
      murId,
      "claude",
      (v) => v.state === "succeeded" || v.state === "failed",
      "the sign-in to finish",
    );

    const claude = (await backendsOf(murId))[0]!;
    expect(claude.login?.state).toBe("succeeded");
    expect(claude.health.available).toBe(true);
    expect(claude.health.kind).toBe("login");
    expect(claude.health.method).toBe("console");
    // A login row carries no secret at all: the vendor's client owns the file.
    expect(claude.health.secretSuffix).toBeNull();

    // Ruling 138: a disconnect names the account it removes.
    const disconnected = await postAction(murId, {
      intent: "backend-disconnect",
      backend: "claude",
      account: claude.accounts![0]!.id,
    });
    expect(disconnected.data.toast).toBe("Claude disconnected");
    expect((await backendsOf(murId))[0]!.health.available).toBe(false);
    await reset();
  });

  it("backend-set-key stores a workspace token unverified and says so", async () => {
    const { data } = await postAction(ardaId, {
      intent: "backend-set-key",
      backend: "codex",
      kind: "access_token",
      secret: "chatgpt-workspace-token-abcd",
    });
    expect(data.ok).toBe(true);
    expect(data.toast).toBe(
      "Codex connected · access token ending in abcd, stored unverified",
    );
    const codex = (await backendsOf(ardaId))[1]!;
    expect(codex.health.kind).toBe("access_token");
    expect(codex.health.verifiedAt).toBeNull();
    expect(codex.health.secretSuffix).toBe("abcd");
    // Only the last four characters ever reach the loader.
    expect(JSON.stringify(codex)).not.toContain("chatgpt-workspace-token-abcd");

    const gone = await postAction(ardaId, {
      intent: "backend-disconnect",
      backend: "codex",
      account: codex.accounts![0]!.id,
    });
    expect(gone.data.toast).toBe("Codex disconnected");
  });

  it("backend-set-key verifies a pasted API key with the provider before saving", async () => {
    const realFetch = globalThis.fetch;
    const probes: string[] = [];
    // SAFETY: the store's probe calls `fetch(url, init)` and reads only
    // `response.ok` and `response.status`, so a one-argument function returning
    // a real Response satisfies every use — the assertion only widens it to the
    // full `fetch` signature the global slot is typed with.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      probes.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const { data } = await postAction(ardaId, {
        intent: "backend-set-key",
        backend: "claude",
        kind: "api_key",
        secret: "sk-ant-api03-route-test-key-wxyz",
      });
      expect(data.ok).toBe(true);
      expect(data.toast).toBe("Claude connected · key ending in wxyz");
      expect(probes).toEqual(["https://api.anthropic.com/v1/models"]);
    } finally {
      globalThis.fetch = realFetch;
    }
    const claude = (await backendsOf(ardaId))[0]!;
    expect(claude.health.kind).toBe("api_key");
    expect(claude.health.verifiedAt).not.toBeNull();
    const gone = await postAction(ardaId, {
      intent: "backend-disconnect",
      backend: "claude",
      account: claude.accounts![0]!.id,
    });
    expect(gone.data.ok).toBe(true);
  });

  it("ruling 138: a second account, a switch with no sign-in, a name, and the disconnect of the one in use", async () => {
    const realFetch = globalThis.fetch;
    // SAFETY: as above — the probe reads only `ok` and `status`.
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    try {
      for (const secret of ["sk-ant-api03-route-first-1111", "sk-ant-api03-route-second-2222"]) {
        const connected = await postAction(ardaId, {
          intent: "backend-set-key",
          backend: "claude",
          kind: "api_key",
          secret,
        });
        expect(connected.data.ok).toBe(true);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    // Two accounts, the newer one in use; the loader lists both, active first.
    let claude = (await backendsOf(ardaId))[0]!;
    expect(claude.accounts!.map((a) => [a.name, a.active])).toEqual([
      ["API key ending in 2222", true],
      ["API key ending in 1111", false],
    ]);
    expect(claude.health.secretSuffix).toBe("2222");
    expect(claude.limits).toEqual({ maxAccounts: 10, maxLabelLength: 60 });
    const first = claude.accounts![1]!.id;
    const second = claude.accounts![0]!.id;

    // Switch back to the first: no sign-in, one request, and the toast says
    // which account runs use now.
    const switched = await postAction(ardaId, {
      intent: "backend-account-switch",
      backend: "claude",
      account: first,
    });
    expect(switched.data).toMatchObject({ ok: true, toast: "Claude runs now use API key ending in 1111" });
    claude = (await backendsOf(ardaId))[0]!;
    expect(claude.accounts![0]!.id).toBe(first);
    expect(claude.health.secretSuffix).toBe("1111");

    const again = await postAction(ardaId, {
      intent: "backend-account-switch",
      backend: "claude",
      account: first,
    });
    expect(again.status).toBe(400);
    expect(again.data.error).toBe("API key ending in 1111 is already the Claude account in use.");

    const renamed = await postAction(ardaId, {
      intent: "backend-account-rename",
      backend: "claude",
      account: first,
      name: "Work",
    });
    expect(renamed.data).toMatchObject({ ok: true, toast: "Claude account renamed Work" });
    expect((await backendsOf(ardaId))[0]!.accounts![0]!.name).toBe("Work");

    // Disconnecting the one in use hands runs to the one used before it.
    const gone = await postAction(ardaId, {
      intent: "backend-disconnect",
      backend: "claude",
      account: first,
    });
    expect(gone.data.toast).toBe("Work disconnected · Claude runs now use API key ending in 2222");
    claude = (await backendsOf(ardaId))[0]!;
    expect(claude.accounts!.map((a) => a.id)).toEqual([second]);
    const last = await postAction(ardaId, {
      intent: "backend-disconnect",
      backend: "claude",
      account: second,
    });
    expect(last.data.toast).toBe("Claude disconnected");
    expect((await backendsOf(ardaId))[0]!.accounts).toEqual([]);
  });

  it("ruling 138: one person's account id is refused to another person", async () => {
    const realFetch = globalThis.fetch;
    // SAFETY: as above — the probe reads only `ok` and `status`.
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    try {
      await postAction(ardaId, {
        intent: "backend-set-key",
        backend: "codex",
        kind: "api_key",
        secret: "sk-proj-route-owned-by-arda",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    const ardasAccount = (await backendsOf(ardaId))[1]!.accounts![0]!.id;
    for (const intent of ["backend-account-switch", "backend-account-rename", "backend-disconnect"]) {
      const refused = await postAction(murId, { intent, backend: "codex", account: ardasAccount, name: "Mine" });
      expect(refused.status, intent).toBe(400);
      expect(refused.data.error, intent).toBe("That account isn't connected any more.");
    }
    // Arda's account is exactly as it was.
    const codex = (await backendsOf(ardaId))[1]!;
    expect(codex.accounts!.map((a) => [a.id, a.label])).toEqual([[ardasAccount, null]]);
    await postAction(ardaId, { intent: "backend-disconnect", backend: "codex", account: ardasAccount });
  });

  it("maps every AppError to a {ok:false,error} result, never a thrown boundary", async () => {
    const badKey = await postAction(ardaId, {
      intent: "backend-set-key",
      backend: "claude",
      kind: "api_key",
      secret: "not-an-anthropic-key",
    });
    expect(badKey.status).toBe(400);
    expect(badKey.data.error).toBe(
      "An Anthropic Console API key starts with `sk-ant-`.",
    );

    const badBackend = await postAction(ardaId, {
      intent: "backend-login-start",
      backend: "gemini",
      method: "claudeai",
    });
    expect(badBackend.status).toBe(400);
    expect(badBackend.data.error).toBe("Unknown agent backend.");

    const badMethod = await postAction(ardaId, {
      intent: "backend-login-start",
      backend: "claude",
      method: "setup-token",
    });
    expect(badMethod.status).toBe(400);
    expect(badMethod.data.error).toBe("Unknown sign-in method.");

    const badKind = await postAction(ardaId, {
      intent: "backend-set-key",
      backend: "codex",
      kind: "oauth",
      secret: "whatever",
    });
    expect(badKind.status).toBe(400);
    expect(badKind.data.error).toBe("Unknown credential kind.");

    // Ruling 138: an account id is required, shaped like one, and the
    // person's own — a malformed one is refused by name before any lookup, a
    // well-formed one that is not theirs as not connected.
    const noAccount = await postAction(ardaId, {
      intent: "backend-disconnect",
      backend: "codex",
    });
    expect(noAccount.status).toBe(400);
    expect(noAccount.data.error).toBe("Unknown account.");

    const notConnected = await postAction(ardaId, {
      intent: "backend-disconnect",
      backend: "codex",
      account: "ubc_nobodys0000",
    });
    expect(notConnected.status).toBe(400);
    expect(notConnected.data.error).toBe("That account isn't connected any more.");

    const badSwitch = await postAction(ardaId, {
      intent: "backend-account-switch",
      backend: "codex",
      account: "../../etc",
    });
    expect(badSwitch.status).toBe(400);
    expect(badSwitch.data.error).toBe("Unknown account.");
  });
});
