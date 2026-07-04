import { describe, expect, it } from "vitest";
import {
  assertCsrfWithSecret,
  assertTrustedOrigin,
  CSRF_FIELD_NAME,
  csrfTokenForSession,
} from "./csrf.server";

const SECRET = "csrf-secret-csrf-secret-csrf-secret-1234";
const SESSION_ID = "abc123sessionhash";

function postRequest(options: {
  origin?: string;
  secFetchSite?: string;
  token?: string | null;
  headerToken?: string;
} = {}): { request: Request; formData: FormData } {
  const headers = new Headers();
  if (options.origin) headers.set("Origin", options.origin);
  if (options.secFetchSite) headers.set("Sec-Fetch-Site", options.secFetchSite);
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
  it("accepts same-origin and header-less (curl) requests", () => {
    expect(() =>
      assertTrustedOrigin(postRequest({ origin: "http://localhost:5173" }).request),
    ).not.toThrow();
    expect(() => assertTrustedOrigin(postRequest({}).request)).not.toThrow();
    expect(() =>
      assertTrustedOrigin(postRequest({ secFetchSite: "same-origin" }).request),
    ).not.toThrow();
    expect(() =>
      assertTrustedOrigin(postRequest({ secFetchSite: "none" }).request),
    ).not.toThrow();
  });

  it("rejects cross-origin and cross-site requests with 403", () => {
    for (const bad of [
      postRequest({ origin: "https://evil.example" }),
      postRequest({ origin: "null" }),
      postRequest({ secFetchSite: "cross-site" }),
      postRequest({ secFetchSite: "same-site" }),
    ]) {
      let thrown: unknown;
      try {
        assertTrustedOrigin(bad.request);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(403);
    }
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
