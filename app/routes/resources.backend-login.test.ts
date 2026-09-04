import { RouterContextProvider } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../test-support/test-app";
import {
  FAKE_CODEX_URL,
  resetFakeVendorEnv,
  setFakeVendorMode,
  writeFakeVendorBinaries,
  type FakeVendorBinaries,
} from "../../test-support/fake-vendor-binary";
import { connectFakeBackend } from "../../test-support/backend-credentials";
import { ERROR_CODES } from "~/server/errors/error-codes";
import type { BackendLoginPollData } from "./resources.backend-login";

/**
 * GET /resources/backend-login (ruling 127).
 *
 * The Profile card polls this while a vendor sign-in runs on the server, so the
 * two things it must never get wrong are WHOSE session it answers with (the
 * caller's, always) and what it is allowed to carry (no secret, ever). Both are
 * asserted here against a real signed-in request and a real spawned sign-in.
 */

let app: AppTestContext;
let ardaId: string;
let muratId: string;
let fake: FakeVendorBinaries;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id;
  muratId = findUserByEmail(app.db, "murat@viberr.dev")!.id;
  fake = writeFakeVendorBinaries();
});

afterEach(async () => {
  const { resetBackendLoginsForTests } = await import(
    "~/server/runtimes/backend-login.server"
  );
  resetBackendLoginsForTests();
  resetFakeVendorEnv();
});

afterAll(() => {
  fake.cleanup();
  app.cleanup();
});

async function poll(
  query: string,
  cookie?: string,
): Promise<{ status: number; body: BackendLoginPollData }> {
  const { loader } = await import("./resources.backend-login");
  const request = app.request(
    `/resources/backend-login${query}`,
    cookie ? { cookie } : {},
  );
  const response = await loader({
    request,
    url: new URL(request.url),
    params: {},
    pattern: "/resources/backend-login",
    context: new RouterContextProvider(),
  });
  return { status: response.status, body: await response.json() };
}

/**
 * Poll until the spawned sign-in has actually printed its device URL, or give
 * up and answer with whatever the route last said (so a real regression fails
 * the assertion rather than this loop).
 *
 * `startBackendLogin` publishes the session synchronously but the URL only
 * exists once the child has written it to stdout, so a poll fired in the same
 * tick legitimately sees a session with no URL yet. Asserting straight after
 * the spawn made this a race that lost on a busy machine.
 */
async function pollUntilSignInUrl(cookie: string): Promise<BackendLoginPollData> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const { body } = await poll("?backend=codex", cookie);
    if (body.login?.url || Date.now() > deadline) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Start a real (hung) sign-in for one person, so the route has a live session
 *  to answer with. `hang` keeps the child alive until the reset kills it. */
async function startHungSignIn(userId: string, label: string): Promise<void> {
  setFakeVendorMode("hang");
  const { startBackendLogin } = await import(
    "~/server/runtimes/backend-login.server"
  );
  startBackendLogin(
    app.db,
    { userId, label },
    "codex",
    "device",
    { binaries: fake.binaries, dataRoot: app.dataRoot },
  );
}

describe("GET /resources/backend-login", () => {
  it("redirects a signed-out caller to /login", async () => {
    const thrown: unknown = await poll("?backend=claude").catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    // SAFETY: the assertion above fails the test unless `thrown` IS a Response,
    // so this line only runs on one.
    expect((thrown as Response).status).toBe(302);
  });

  it("refuses an unknown backend with 400 instead of guessing one", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const unknown = await poll("?backend=gemini", cookie);
    expect(unknown.status).toBe(400);
    // The conventions' JSON error shape, with a code from the catalog: a client
    // switching on `error.code` here reads the same thing it reads from
    // /resources/run-log, not a bare string.
    expect(unknown.body).toEqual({
      error: { code: ERROR_CODES.VALIDATION_FAILED, message: "Unknown backend." },
    });
    expect((await poll("", cookie)).status).toBe(400);
  });

  it("answers null and the not-connected health for a person with nothing", async () => {
    const { cookie } = await app.cookieFor(ardaId);
    const { status, body } = await poll("?backend=claude", cookie);
    expect(status).toBe(200);
    expect(body.login).toBeNull();
    expect(body.health.available).toBe(false);
    expect(body.health.kind).toBeNull();
    expect(body.health.detail).toBe(
      "Claude isn't connected. Connect it on your Profile → Agent accounts.",
    );
  });

  it("reports the caller's own live sign-in, and never another person's", async () => {
    await startHungSignIn(ardaId, "arda@viberr.dev");
    const arda = await app.cookieFor(ardaId);
    const seen = await pollUntilSignInUrl(arda.cookie);
    expect(seen.login?.backend).toBe("codex");
    expect(seen.login?.method).toBe("device");
    expect(seen.login?.url).toBe(FAKE_CODEX_URL);
    // A session is one person's. The route takes no user parameter, so this is
    // the only way it could ever have leaked one.
    const murat = await app.cookieFor(muratId);
    expect((await poll("?backend=codex", murat.cookie)).body.login).toBeNull();
  });

  it("ships the key's last four characters and never the key", async () => {
    await connectFakeBackend(app.db, muratId, "claude");
    const { cookie } = await app.cookieFor(muratId);
    const { body } = await poll("?backend=claude", cookie);
    expect(body.health.available).toBe(true);
    expect(body.health.kind).toBe("api_key");
    expect(body.health.detail).toBeNull();
    expect(body.health.secretSuffix).toHaveLength(4);
    const { fakeBackendSecret } = await import(
      "../../test-support/backend-credentials"
    );
    const wire = JSON.stringify(body);
    expect(wire).not.toContain(fakeBackendSecret("claude"));
    expect(wire).not.toContain("secret_box");
    expect(wire).not.toContain("secretBox");
  });
});
