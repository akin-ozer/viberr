import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_TEST_PASSWORD,
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
import { DEFAULT_NOTIF_PREFS } from "./notification-prefs";

type ProfileAction = typeof import("~/routes/profile").action;

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
let fake: FakeVendorBinaries;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  murId = findUserByEmail(app.db, "murat@viberr.dev")!.id;
  // Ruling 127: the route resolves its OWN vendor binaries (a form action must
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

/** What React Router hands a loader/action. Both routes here read only
 *  `request`; the rest is the call the framework makes — and with no dynamic
 *  segment in either path, the matched pattern IS the pathname. */
const routeArgs = (request: Request) => {
  const url = new URL(request.url);
  return {
    request,
    url,
    params: {},
    pattern: url.pathname,
    context: new RouterContextProvider(),
  };
};

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
  return loader(routeArgs(app.request("/profile", cookie ? { cookie } : {})));
}

async function postAction(
  userId: string,
  fields: Record<string, string>,
): Promise<ActionOutcome> {
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
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
    const rootResult = await rootLoader(routeArgs(app.request("/", { cookie })));
    // Root wraps its payload in `data()` only when better-auth renewed the
    // session cookie on this request.
    const payload = "data" in rootResult ? rootResult.data : rootResult;
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
    const { data: result } = unwrap(
      await action(
        routeArgs(
          app.request("/profile", {
            method: "POST",
            cookie,
            body,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          }),
        ),
      ),
    );
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
    const { cookie } = await app.cookieFor(ardaId);
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
      ),
    )) as { init?: { status?: number }; data?: { ok: boolean; error: string } };
    expect(result).not.toBeInstanceOf(Response);
    expect(result.init?.status).toBe(403);
    expect(result.data?.ok).toBe(false);
    expect(result.data?.error).toMatch(/expired|security token/i);
  });
});

/**
 * Ruling 127 — Profile → Agent accounts.
 *
 * Every intent is driven through the real route action (session cookie, CSRF,
 * the module's own `resolveBackendBinary`), and the sign-in ones spawn a real
 * child: the fake vendor executables stand in for `claude` and `codex`, so what
 * is asserted is the route wired to the driver, not a stub of it.
 */
describe("/profile agent accounts (ruling 127)", () => {
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
    const { cookie } = await app.cookieFor(userId);
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

    const disconnected = await postAction(murId, {
      intent: "backend-disconnect",
      backend: "claude",
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
    await postAction(ardaId, { intent: "backend-disconnect", backend: "claude" });
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

    const notConnected = await postAction(ardaId, {
      intent: "backend-disconnect",
      backend: "codex",
    });
    expect(notConnected.status).toBe(400);
    expect(notConnected.data.error).toBe("Codex isn't connected.");
  });
});
