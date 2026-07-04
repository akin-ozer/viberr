import { describe, expect, it } from "vitest";
import {
  clearSessionCookieHeaderWithSecure,
  readSessionTokenWithSecret,
  SESSION_COOKIE_NAME,
  sessionCookieHeaderWithSecret,
  signSessionValue,
  verifySessionValue,
} from "./session-cookie.server";

const SECRET = "test-secret-test-secret-test-secret-1234";

function requestWithCookie(cookie: string): Request {
  return new Request("http://localhost:5173/", {
    headers: { Cookie: cookie },
  });
}

describe("session cookie signing", () => {
  it("signs and verifies a token", () => {
    const value = signSessionValue("token-abc", SECRET);
    expect(verifySessionValue(value, SECRET)).toBe("token-abc");
  });

  it("rejects a tampered token", () => {
    const value = signSessionValue("token-abc", SECRET);
    const tampered = "token-abd" + value.slice("token-abc".length);
    expect(verifySessionValue(tampered, SECRET)).toBeNull();
  });

  it("rejects a tampered signature and wrong secret", () => {
    const value = signSessionValue("token-abc", SECRET);
    expect(verifySessionValue(value.slice(0, -2) + "xx", SECRET)).toBeNull();
    expect(verifySessionValue(value, SECRET + "-other")).toBeNull();
    expect(verifySessionValue("no-dot-here", SECRET)).toBeNull();
    expect(verifySessionValue("", SECRET)).toBeNull();
  });

  it("reads the token from a request Cookie header", () => {
    const header = `${SESSION_COOKIE_NAME}=${signSessionValue("tok", SECRET)}; viberr_theme=dark`;
    expect(readSessionTokenWithSecret(requestWithCookie(header), SECRET)).toBe(
      "tok",
    );
  });

  it("returns null without a cookie or with a forged value", () => {
    expect(
      readSessionTokenWithSecret(new Request("http://x/"), SECRET),
    ).toBeNull();
    expect(
      readSessionTokenWithSecret(
        requestWithCookie(`${SESSION_COOKIE_NAME}=forged.value`),
        SECRET,
      ),
    ).toBeNull();
  });

  it("sets the documented cookie attributes", () => {
    const dev = sessionCookieHeaderWithSecret("tok", SECRET, false);
    expect(dev).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(dev).toContain("HttpOnly");
    expect(dev).toContain("SameSite=Lax");
    expect(dev).toContain("Path=/");
    expect(dev).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    expect(dev).not.toContain("Secure");
    expect(sessionCookieHeaderWithSecret("tok", SECRET, true)).toContain(
      "; Secure",
    );
    expect(clearSessionCookieHeaderWithSecure(false)).toContain("Max-Age=0");
  });
});
