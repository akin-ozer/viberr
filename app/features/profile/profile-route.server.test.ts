import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_TEST_PASSWORD,
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import type { ProfileView } from "./profile-query.server";
import { DEFAULT_NOTIF_PREFS } from "./notification-prefs";

/**
 * Route-level tests for /profile (Phase 9C): loader shape (session user is
 * the single source of `me` — ruling 6; role from membership by id, never
 * hardcoded), prefs writes into user_prefs (the phase-5 tlDefault key
 * included), password change via the phase-2 machinery, and the GitHub
 * identity guards.
 */

let app: AppTestContext;
let ardaId: string;
let murId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  murId = findUserByEmail(app.db, "murat@viberr.dev")!.id;
});
afterAll(() => app.cleanup());

async function runLoader(cookie?: string) {
  const { loader } = await import("~/routes/profile");
  return loader({
    request: app.request("/profile", cookie ? { cookie } : {}),
    params: {},
    context: {},
  } as never) as Promise<{ profile: ProfileView }>;
}

async function postAction(
  userId: string,
  fields: Record<string, string>,
): Promise<{ status: number; data: { ok: boolean; toast?: string; error?: string } }> {
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const { action } = await import("~/routes/profile");
  const body = new URLSearchParams({ _csrf: csrf, ...fields });
  const result = await action({
    request: app.request("/profile", {
      method: "POST",
      cookie,
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    params: {},
    context: {},
  } as never);
  // Route actions return plain objects on success, data() wrappers on error.
  const wrapped = result as { data?: unknown; init?: { status?: number } };
  if (wrapped && typeof wrapped === "object" && "data" in wrapped && wrapped.init) {
    return {
      status: wrapped.init?.status ?? 200,
      data: wrapped.data as { ok: boolean; toast?: string; error?: string },
    };
  }
  return { status: 200, data: result as { ok: boolean; toast?: string } };
}

describe("/profile loader", () => {
  it("redirects signed-out users to /login", async () => {
    const thrown = await runLoader().catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
  });

  it("widens the session user: memberships by id, derived role, prefs defaults", async () => {
    const { cookie } = await app.cookieFor(ardaId);
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
    expect(profile.prefs.notifs).toEqual(DEFAULT_NOTIF_PREFS);
    expect(profile.prefs.motion).toBe("full");
    expect(profile.prefs.tlDefault).toBe("all");
  });

  it("membership role comes from the projection, per user (never hardcoded)", async () => {
    const { cookie } = await app.cookieFor(murId);
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
    expect(data.toast).toBe("Profile saved — visible to Viberr Core members");
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
    const { cookie } = await app.cookieFor(ardaId);
    const { profile } = await runLoader(cookie);
    expect(profile.prefs.notifs.packets.app).toBe(false);
    expect(profile.prefs.notifs.approvals.app).toBe(true);
  });

  it("set-motion persists to user_prefs and the root loader serves it", async () => {
    const { data } = await postAction(ardaId, {
      intent: "set-motion",
      motion: "reduce",
    });
    expect(data.ok).toBe(true);
    const { getPref } = await import("~/server/prefs/user-prefs.server");
    expect(getPref(app.db, ardaId, "motion")).toBe("reduce");

    // Root loader (SSR <html data-motion>) reads the same pref.
    const { cookie } = await app.cookieFor(ardaId);
    const { loader: rootLoader } = await import("~/root");
    const rootResult = (await rootLoader({
      request: app.request("/", { cookie }),
      params: {},
      context: {},
    } as never)) as { motion?: string } | { data: { motion?: string } };
    const payload =
      "data" in rootResult ? (rootResult.data as { motion?: string }) : rootResult;
    expect(payload.motion).toBe("reduce");

    await postAction(ardaId, { intent: "set-motion", motion: "full" });
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
    const result = (await action({
      request: app.request("/profile", {
        method: "POST",
        cookie,
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
      params: {},
      context: {},
    } as never)) as { ok: boolean; toast?: string };
    expect(result.ok).toBe(true);
    expect(result.toast).toBe("Password updated — other sessions were signed out");

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
      "GitHub disconnected — audit falls back to your workspace identity",
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
    const { cookie } = await app.cookieFor(ardaId);
    const { action } = await import("~/routes/profile");
    const body = new URLSearchParams({ _csrf: "forged", intent: "identity" });
    const result = (await action({
      request: app.request("/profile", {
        method: "POST",
        cookie,
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
      params: {},
      context: {},
    } as never)) as { init?: { status?: number }; data?: { ok: boolean; error: string } };
    expect(result).not.toBeInstanceOf(Response);
    expect(result.init?.status).toBe(403);
    expect(result.data?.ok).toBe(false);
    expect(result.data?.error).toMatch(/expired|security token/i);
  });
});
