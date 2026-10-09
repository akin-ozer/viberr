import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { routeArgs, setupAppTest, type AppTestContext } from "../../test-support/test-app";
import { ERROR_CODES } from "~/server/errors/error-codes";

/**
 * GET /resources/search — the ⌘K palette's query (R15-5). What it answers a
 * signed-in viewer is `searchWorkspace`'s, tested in its own suite; this is
 * what the route adds in front of it.
 */

let app: AppTestContext;
let userId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { insertUser } = await import("~/server/auth/user-store.server");
  userId = insertUser(app.db, {
    id: "u_palette",
    email: "palette@viberr.test",
    name: "Palette",
    role: "member",
  }).id;
});
afterAll(() => app.cleanup());

/** One query, signed in with `cookie` or with no session at all. */
async function search(q: string, cookie?: string) {
  const { loader } = await import("./resources.search");
  const request = app.request(
    `/resources/search?q=${encodeURIComponent(q)}`,
    cookie ? { cookie } : {},
  );
  const response = await loader(routeArgs(request, {}, "/resources/search"));
  return { status: response.status, body: await response.json() };
}

describe("GET /resources/search", () => {
  /**
   * Ruling 11, test audit L14-29. The palette loads this through a fetcher
   * as the person types, and `requireUser` answered a missing session with a
   * login redirect naming THIS route and the query as the returnTo: a fetcher
   * follows a redirect as a navigation, so typing in a stale tab went to
   * /login and, once signed in, to a page of raw JSON. No session, or a forced
   * password reset pending, answers 401 in the conventions' JSON error shape.
   */
  it("answers a signed-out query 401 in the conventions' error shape, never a login redirect", async () => {
    const { cookie } = await app.cookieFor(userId);
    const { updateUserFields } = await import("~/server/auth/user-store.server");
    updateUserFields(app.db, userId, { pwresetRequired: true });
    try {
      // CANARY: guard with `requireUser` again and both queries reject with its
      // 302 to /login?returnTo=%2Fresources%2Fsearch%3Fq%3Ddeploy.
      for (const answer of [await search("deploy"), await search("deploy", cookie)]) {
        expect(answer).toEqual({
          status: 401,
          body: { error: { code: ERROR_CODES.UNAUTHORIZED, message: "Sign in to search." } },
        });
      }
    } finally {
      updateUserFields(app.db, userId, { pwresetRequired: false });
    }
  });
});
