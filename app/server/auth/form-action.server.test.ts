import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { AppError } from "../errors/app-error.server";
import { appErrorResponse, requireFormAction } from "./form-action.server";
import { insertUser } from "./user-store.server";

/**
 * `requireFormAction` is the preamble EVERY route action runs — auth → db →
 * formData → CSRF → { auth, db, formData, actor, intent }. Ten route modules
 * call it and nothing else stands between a POST and a mutation, so it is the
 * single chokepoint where the CSRF contract in docs/domain/auth-and-rbac.md
 * §"CSRF for app routes" is actually enforced.
 *
 * Until pass 33 nothing in the suite imported it: `assertCsrf` could have been
 * deleted from the preamble and every gate would have stayed green while every
 * action in the app became forgeable. Ruling 65 — "an owner ruling whose guard
 * cannot go red is a ruling that gets reverted in silence" — is exactly this
 * shape, so these cases drive the real function with real better-auth session
 * cookies and real request headers rather than re-stating its body.
 *
 * The token layer's own unit coverage lives in `csrf.server.test.ts`; what is
 * pinned HERE is that the preamble wires both layers in, in the right order,
 * and hands the action an actor it can audit.
 */

const SAME_ORIGIN = "http://localhost:5173";

/**
 * The wire name is spelled out rather than imported from `csrf.server`: it is a
 * contract between `<CsrfInput />` (app/ui/csrf-input.tsx renders literally
 * `name="_csrf"`) and the server. Importing the constant would let both ends
 * rename in lockstep and keep the test green while every deployed form broke.
 */
const CSRF_FIELD = "_csrf";

interface FormPostOptions {
  /** Session cookie header value; omitted entirely when absent (signed out). */
  cookie?: string;
  /** Form fields other than `_csrf`. */
  fields?: Record<string, string>;
  /** `_csrf` form value. `null` omits the field; `""` sends it empty. */
  token?: string | null;
  /** `X-Csrf-Token` header — the fetcher/JSON path. */
  headerToken?: string;
  /** `Origin` header. `null` sends none — used for the fail-closed case. */
  origin?: string | null;
  secFetchSite?: string;
  referer?: string;
}

/**
 * A POST the way a browser form submits one. Deliberately NOT `app.request()`:
 * the harness always stamps a same-origin `Origin` header, which would make the
 * "no origin signal at all" case untestable.
 */
function formPost(options: FormPostOptions = {}): Request {
  const body = new FormData();
  for (const [name, value] of Object.entries(options.fields ?? {})) {
    body.set(name, value);
  }
  if (options.token !== null && options.token !== undefined) {
    body.set(CSRF_FIELD, options.token);
  }
  const headers = new Headers();
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.origin !== null) {
    headers.set("Origin", options.origin ?? SAME_ORIGIN);
  }
  if (options.secFetchSite) headers.set("Sec-Fetch-Site", options.secFetchSite);
  if (options.referer) headers.set("Referer", options.referer);
  if (options.headerToken) headers.set("X-Csrf-Token", options.headerToken);
  return new Request(`${SAME_ORIGIN}/projects/acme/board`, {
    method: "POST",
    headers,
    body,
  });
}

/**
 * How the preamble refused: the status, and where a redirect points. A signed
 * out post is THROWN (the /login redirect); a failed CSRF check is ANSWERED,
 * as the `refused` result the action returns (ruling 454, RV-1). A request
 * that is ACCEPTED must fail the case loudly — an assertion that merely never
 * ran is how a dead guard passes for green.
 */
async function refusalFor(
  request: Request,
): Promise<{ status: number | undefined; location: string | null }> {
  try {
    const { refused } = await requireFormAction(request);
    if (refused) return { status: refused.init?.status, location: null };
  } catch (thrown) {
    if (thrown instanceof Response) {
      return { status: thrown.status, location: thrown.headers.get("Location") };
    }
    throw thrown;
  }
  throw new Error(
    "requireFormAction ACCEPTED a request that the CSRF contract must refuse",
  );
}

/** The preamble's answer to a post it must ACCEPT. */
async function accepted(request: Request) {
  const answer = await requireFormAction(request);
  if (answer.refused) {
    throw new Error("requireFormAction REFUSED a post the CSRF contract accepts");
  }
  return answer;
}

/** A seeded user plus the session material a form post needs to speak as them. */
interface SignedInPerson {
  id: string;
  email: string;
  cookie: string;
  sessionId: string;
}

let app: AppTestContext;
/** The signed-in person the well-formed posts come from. */
let victim: SignedInPerson;
/** A second signed-in person — the "I have a valid token of my own" attacker. */
let attacker: SignedInPerson;

beforeAll(async () => {
  app = await setupAppTest();
  const victimRow = insertUser(app.db, {
    id: "u_form_victim",
    email: "victim@viberr.test",
    name: "Vic Tim",
    role: "member",
  });
  const attackerRow = insertUser(app.db, {
    id: "u_form_attacker",
    email: "attacker@viberr.test",
    name: "Mal Ory",
    role: "member",
  });
  const victimSession = await app.cookieFor(victimRow.id);
  const attackerSession = await app.cookieFor(attackerRow.id);
  victim = {
    id: victimRow.id,
    email: victimRow.email,
    cookie: victimSession.cookie,
    sessionId: victimSession.sessionId,
  };
  attacker = {
    id: attackerRow.id,
    email: attackerRow.email,
    cookie: attackerSession.cookie,
    sessionId: attackerSession.sessionId,
  };
});
afterAll(() => app?.cleanup());

describe("requireFormAction — what a route action is handed", () => {
  /**
   * The happy path, and the only test in the file that asserts the RETURN
   * value, because that value is the whole reason ten route modules call this
   * instead of the four guards by hand.
   *
   * `actor.label` is the EMAIL. That is not cosmetic: every audit row and every
   * activity line renders the label, and a pass-30-era regression that swapped
   * it for `user.name` is invisible in a diff and permanent in the audit log
   * (audit rows are append-only facts, so a wrong label cannot be corrected
   * after the fact).
   *
   * This case also silently pins that the body is read EXACTLY once. The
   * preamble parses `formData` itself and passes it into `assertCsrf`; drop
   * that argument and `assertCsrf` falls back to `request.clone().formData()`
   * on a body that has already been consumed, which throws "Body is unusable"
   * rather than returning anything at all.
   */
  it("returns the actor, the intent and the parsed form for a well-formed post", async () => {
    const request = formPost({
      cookie: victim.cookie,
      token: await app.csrfFor(victim.sessionId),
      fields: { intent: "move_task", taskId: "VIB-7", to: "in_review" },
    });

    const result = await accepted(request);

    expect(result.refused).toBeNull();
    expect(result.actor).toEqual({
      userId: victim.id,
      label: victim.email,
    });
    expect(result.intent).toBe("move_task");
    expect(result.formData.get("taskId")).toBe("VIB-7");
    expect(result.formData.get("to")).toBe("in_review");
    expect(result.auth.sessionId).toBe(victim.sessionId);
    expect(result.auth.user.id).toBe(victim.id);
    // The PROCESS-wide handle, not a fresh connection. One app process per data
    // root is a standing rule here (the docker-data dual-writer hazard); a
    // second connection opened per action would also read stale under WAL.
    expect(result.db).toBe(app.db);
  });

  /**
   * Actions dispatch on `intent` with a `switch` whose `default` refuses. A
   * post with no intent field must arrive as the empty string — falsy, so the
   * handful of routes that guard with `if (!intent)` refuse it — and never as
   * the string "null", which `String(formData.get("intent"))` produces the
   * moment someone trims the `?? ""`.
   */
  it("defaults a missing intent to the empty string, not to \"null\"", async () => {
    const request = formPost({
      cookie: victim.cookie,
      token: await app.csrfFor(victim.sessionId),
      fields: { taskId: "VIB-7" },
    });

    const { intent } = await accepted(request);

    expect(intent).toBe("");
  });
});

describe("requireFormAction — refusals", () => {
  /**
   * Auth runs BEFORE the CSRF layer, and the ordering is the behaviour. A
   * signed-out POST is a session that expired mid-form, not an attack: the
   * person must be redirected to /login (with returnTo) so they can finish
   * their work. Reorder the preamble and they get an opaque 403 error boundary
   * instead — a dead end with their typed input lost.
   *
   * The request here would ALSO fail both CSRF layers, so a 403 answer proves
   * the reorder rather than merely hinting at it.
   */
  it("redirects a signed-out post to /login instead of answering 403", async () => {
    const refusal = await refusalFor(
      formPost({ origin: "https://evil.example", token: null }),
    );

    expect(refusal.status).toBe(302);
    expect(refusal.location).toMatch(/^\/login/);
  });

  /**
   * Ruling 454 (RV-1): the person signed in again in another tab, so the
   * session has a new id and this tab's token (root's csrf, from the old one)
   * is stale. The refusal used to be a THROWN 403: React Router rendered the
   * route's error boundary in place of the page, which unmounted the composer
   * and lost the comment typed into it, and root, which no longer re-runs on a
   * navigation or a live event, never read the new token, so every later
   * action in the tab failed the same way. Answered as a 403 result, the page
   * stays up with the draft and an inline error, and the 403 re-runs root
   * (`revalidation-policy.ts`), so trying again works.
   */
  it("answers a stale token (the session changed in another tab) with a 403 result, not a throw", async () => {
    const signedInAgain = await app.cookieFor(victim.id);
    const request = formPost({
      cookie: signedInAgain.cookie,
      token: await app.csrfFor(victim.sessionId),
      fields: { intent: "comment", text: "a comment worth keeping" },
    });

    // CANARY: throw the refusal again and this call rejects.
    const { refused } = await requireFormAction(request);

    expect(refused?.init?.status).toBe(403);
    expect(refused?.data).toEqual({ ok: false, error: expect.stringMatching(/expired/) });
  });

  /**
   * The textbook CSRF: evil.example auto-submits a form to us and the browser
   * attaches the victim's cookie. The token is the RIGHT one here — assume it
   * leaked — so the only thing standing between the attacker and a mutation is
   * the origin proof. Both layers are AND, never OR.
   */
  it("refuses a cross-origin post even with the victim's own valid token", async () => {
    const refusal = await refusalFor(
      formPost({
        cookie: victim.cookie,
        token: await app.csrfFor(victim.sessionId),
        origin: "https://evil.example",
        fields: { intent: "archive_task" },
      }),
    );

    expect(refusal.status).toBe(403);
  });

  /**
   * §7.10 / A7, the fail-closed clause, and the case most worth having: a
   * request carrying NO `Origin`, NO `Sec-Fetch-Site` and NO `Referer` proves
   * nothing about where it came from, and used to PASS the origin layer on a
   * curl / server-to-server concession the app never uses. That turned a
   * defense-in-depth layer into a header any attacker can simply OMIT.
   *
   * The token is valid here too, so this fails only if the origin layer itself
   * fails closed.
   */
  it("refuses a post with no origin signal at all (fails closed, §7.10 / A7)", async () => {
    const refusal = await refusalFor(
      formPost({
        cookie: victim.cookie,
        token: await app.csrfFor(victim.sessionId),
        origin: null,
        fields: { intent: "archive_task" },
      }),
    );

    expect(refusal.status).toBe(403);
  });

  /**
   * A same-origin `Origin` cannot launder a foreign `Referer`: every signal the
   * request DOES carry has to agree. This is the shape a redirect chain through
   * an attacker page produces.
   */
  it("refuses a post whose Referer contradicts its Origin", async () => {
    const refusal = await refusalFor(
      formPost({
        cookie: victim.cookie,
        token: await app.csrfFor(victim.sessionId),
        origin: SAME_ORIGIN,
        referer: "https://evil.example/pwn",
      }),
    );

    expect(refusal.status).toBe(403);
  });

  /**
   * The double-submit half. Three ways to send no usable token — the field
   * absent, the field empty (the shape a form renders when the root loader
   * handed `<CsrfInput />` an empty string for a signed-out tree), and a token
   * that is simply wrong. All three are refusals, not "treat as no check".
   */
  it("refuses a missing, empty or garbage _csrf token", async () => {
    for (const token of [null, "", "not-the-token"]) {
      const refusal = await refusalFor(
        formPost({
          cookie: victim.cookie,
          token,
          fields: { intent: "archive_task" },
        }),
      );
      expect(refusal.status).toBe(403);
    }
  });

  /**
   * The token is HMAC(secret, "viberr-csrf:" + sessionId) — bound to ONE
   * session. A signed-in attacker knows their own token by reading their own
   * DOM, so a check that only asked "is this a well-formed token under our
   * secret?" would authorize replaying it onto a request that rides the
   * victim's cookie. The comparison must be against the session the request
   * authenticated AS.
   */
  it("refuses another signed-in user's perfectly valid token", async () => {
    const refusal = await refusalFor(
      formPost({
        cookie: victim.cookie,
        token: await app.csrfFor(attacker.sessionId),
        fields: { intent: "archive_task" },
      }),
    );

    expect(refusal.status).toBe(403);
    // And the same token IS accepted on its owner's own session, so the case
    // above failed for the binding and not because the token was malformed.
    const own = await accepted(
      formPost({
        cookie: attacker.cookie,
        token: await app.csrfFor(attacker.sessionId),
        fields: { intent: "archive_task" },
      }),
    );
    expect(own.actor.userId).toBe(attacker.id);
  });

  /**
   * Programmatic `fetcher.submit` calls and the JSON-ish surfaces send the
   * token as a header instead of a field. It is an alternative CARRIER, not an
   * alternative check.
   */
  it("accepts the token in the X-Csrf-Token header with no _csrf field", async () => {
    const result = await accepted(
      formPost({
        cookie: victim.cookie,
        token: null,
        headerToken: await app.csrfFor(victim.sessionId),
        fields: { intent: "toggle_pin" },
      }),
    );

    expect(result.intent).toBe("toggle_pin");
    expect(result.actor.userId).toBe(victim.id);
  });

  /**
   * The header WINS when present — it is read first and the form is not
   * consulted. So a wrong header must refuse outright rather than quietly
   * falling back to a correct `_csrf` field: a fallback would let anything that
   * can influence a request header downgrade the check to whichever carrier
   * happens to be right.
   */
  it("refuses a wrong X-Csrf-Token even when the form field is correct", async () => {
    const refusal = await refusalFor(
      formPost({
        cookie: victim.cookie,
        token: await app.csrfFor(victim.sessionId),
        headerToken: "not-the-token",
        fields: { intent: "archive_task" },
      }),
    );

    expect(refusal.status).toBe(403);
  });
});

/**
 * `appErrorResponse` is the other half of the preamble: actions wrap their body
 * in try/catch and hand the caught throwable here. Its contract is the
 * re-throw, not the render.
 */
describe("appErrorResponse", () => {
  it("renders an AppError as the action's { ok: false, error } payload", () => {
    const rendered = appErrorResponse(
      AppError.validation("Pick a column first."),
    );

    expect(rendered.data).toEqual({ ok: false, error: "Pick a column first." });
    expect(rendered.init?.status).toBe(400);
    // The user-facing string, never the internal `message`.
    expect(rendered.data.error).not.toContain("VALIDATION");
  });

  /**
   * The refusal path, and the reason the function exists in this file rather
   * than as a bare `catch`: anything that is NOT one of ours must come back out
   * untouched.
   *
   * A thrown Response is the common case — `requireFormAction` itself throws
   * the /login redirect and the 403 through the SAME try/catch the action wraps
   * its body in. Swallow it and the redirect is flattened into a 200-shaped
   * `{ ok: false, error: undefined }` (a non-AppError has no `.userMessage` and
   * no `.status`, and `data()` defaults to 200), so a CSRF refusal would render
   * as a successful-looking response and a genuine TypeError would never reach
   * the error boundary.
   */
  it("re-throws a non-AppError untouched, same object", () => {
    for (const probe of [
      new Response("nope", { status: 403 }),
      new TypeError("Body is unusable"),
      "a bare string nobody should be throwing",
    ]) {
      let rethrown: unknown;
      let returned: unknown;
      try {
        returned = appErrorResponse(probe);
      } catch (error) {
        rethrown = error;
      }
      expect(returned).toBeUndefined();
      expect(rethrown).toBe(probe);
    }
  });
});
