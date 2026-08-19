import { describe, expect, it } from "vitest";
import {
  assertCsrfWithSecret,
  assertTrustedOrigin,
  CSRF_FIELD_NAME,
  csrfTokenForSession,
} from "./csrf.server";

const SECRET = "csrf-secret-csrf-secret-csrf-secret-1234";
const SESSION_ID = "abc123sessionhash";

const SAME_ORIGIN = "http://localhost:5173";

function postRequest(options: {
  origin?: string;
  secFetchSite?: string;
  referer?: string;
  token?: string | null;
  headerToken?: string;
  /** Send no origin signal at all — the shape a non-browser caller produces. */
  bare?: boolean;
} = {}) {
  const headers = new Headers();
  // Every app form post is a same-origin browser POST, which always carries at
  // least Origin — so that is the default here, and a case that wants the
  // header-less shape asks for it with `bare`.
  if (options.origin) headers.set("Origin", options.origin);
  else if (!options.bare && !options.secFetchSite && !options.referer) {
    headers.set("Origin", SAME_ORIGIN);
  }
  if (options.secFetchSite) headers.set("Sec-Fetch-Site", options.secFetchSite);
  if (options.referer) headers.set("Referer", options.referer);
  if (options.headerToken) headers.set("X-Csrf-Token", options.headerToken);
  const formData = new FormData();
  if (options.token !== null && options.token !== undefined) {
    formData.set(CSRF_FIELD_NAME, options.token);
  }
  const request = new Request("http://localhost:5173/logout", {
    method: "POST",
    headers,
  });
  return { request, formData };
}

const validToken = () => csrfTokenForSession(SESSION_ID, SECRET);

describe("csrfTokenForSession", () => {
  it("is deterministic per session and differs across sessions/secrets", () => {
    expect(validToken()).toBe(validToken());
    expect(csrfTokenForSession("other", SECRET)).not.toBe(validToken());
    expect(csrfTokenForSession(SESSION_ID, "another-secret-value-here")).not.toBe(
      validToken(),
    );
  });
});

describe("assertTrustedOrigin", () => {
  it("accepts the shapes a same-origin browser form post actually sends", () => {
    // Origin alone (every cross-origin-capable POST carries it), Sec-Fetch-Site
    // alone, a same-origin Referer alone, and all of them together.
    expect(() =>
      assertTrustedOrigin(postRequest({ origin: SAME_ORIGIN }).request),
    ).not.toThrow();
    expect(() =>
      assertTrustedOrigin(postRequest({ secFetchSite: "same-origin" }).request),
    ).not.toThrow();
    expect(() =>
      assertTrustedOrigin(postRequest({ secFetchSite: "none" }).request),
    ).not.toThrow();
    expect(() =>
      assertTrustedOrigin(
        postRequest({ referer: `${SAME_ORIGIN}/projects/viberr-core/board` })
          .request,
      ),
    ).not.toThrow();
    expect(() =>
      assertTrustedOrigin(
        postRequest({
          origin: SAME_ORIGIN,
          secFetchSite: "same-origin",
          referer: `${SAME_ORIGIN}/logout`,
        }).request,
      ),
    ).not.toThrow();
  });

  it("rejects cross-origin and cross-site requests with 403", () => {
    for (const bad of [
      postRequest({ origin: "https://evil.example" }),
      postRequest({ origin: "null" }),
      postRequest({ secFetchSite: "cross-site" }),
      postRequest({ secFetchSite: "same-site" }),
      // A same-origin Origin cannot launder a foreign Referer, and vice versa:
      // every signal the request DOES carry has to agree.
      postRequest({ origin: SAME_ORIGIN, referer: "https://evil.example/x" }),
      postRequest({ secFetchSite: "same-origin", referer: "https://evil.example/x" }),
    ]) {
      let thrown: unknown;
      try {
        assertTrustedOrigin(bad.request);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Response);
      // SAFETY: the assertion above throws unless `thrown` is a Response, so
      // reaching this line means the catch binding is one.
      expect((thrown as Response).status).toBe(403);
    }
  });

  // §7.10 / A7: this used to PASS. A request carrying no Origin, no
  // Sec-Fetch-Site and no Referer proves nothing about where it came from, and
  // the layer whose entire job is that proof was letting it through on the
  // strength of a curl/server-to-server concession the app never uses.
  it("rejects a request that carries NO origin signal at all (fails closed)", () => {
    let thrown: unknown;
    try {
      assertTrustedOrigin(postRequest({ bare: true }).request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    // SAFETY: the assertion above throws unless `thrown` is a Response, so
    // reaching this line means the catch binding is one.
    expect((thrown as Response).status).toBe(403);
  });
});

describe("assertCsrfWithSecret", () => {
  it("passes with a valid form token", async () => {
    const { request, formData } = postRequest({
      origin: "http://localhost:5173",
      token: validToken(),
    });
    await expect(
      assertCsrfWithSecret(request, SESSION_ID, SECRET, formData),
    ).resolves.toBeUndefined();
  });

  it("passes with a valid X-Csrf-Token header", async () => {
    const { request } = postRequest({ headerToken: validToken() });
    await expect(
      assertCsrfWithSecret(request, SESSION_ID, SECRET),
    ).resolves.toBeUndefined();
  });

  it("rejects a missing token", async () => {
    const { request, formData } = postRequest({ token: null });
    await expect(
      assertCsrfWithSecret(request, SESSION_ID, SECRET, formData),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a wrong / other-session token", async () => {
    const wrong = postRequest({ token: "not-the-token" });
    await expect(
      assertCsrfWithSecret(wrong.request, SESSION_ID, SECRET, wrong.formData),
    ).rejects.toMatchObject({ status: 403 });

    const otherSession = postRequest({
      token: csrfTokenForSession("other-session", SECRET),
    });
    await expect(
      assertCsrfWithSecret(
        otherSession.request,
        SESSION_ID,
        SECRET,
        otherSession.formData,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a valid token on a request with no origin signal (the two layers are AND)", async () => {
    const { request, formData } = postRequest({ bare: true, token: validToken() });
    await expect(
      assertCsrfWithSecret(request, SESSION_ID, SECRET, formData),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a valid token when the origin is cross-site", async () => {
    const { request, formData } = postRequest({
      origin: "https://evil.example",
      token: validToken(),
    });
    await expect(
      assertCsrfWithSecret(request, SESSION_ID, SECRET, formData),
    ).rejects.toMatchObject({ status: 403 });
  });
});
