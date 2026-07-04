import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../audit/audit-recorder.server";
import { completeGithubLogin } from "./oauth-github.server";
import { completeGoogleLogin } from "./oauth-google.server";
import {
  generatePkcePair,
  readOAuthStateCookie,
  serializeOAuthStateCookie,
  validateOAuthCallback,
  type FetchLike,
  type OAuthStatePayload,
} from "./oauth-shared.server";
import { findUserById, insertUser } from "./user-store.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const SECRET = "oauth-secret-oauth-secret-oauth-secret-1";

const payload: OAuthStatePayload = {
  provider: "github",
  state: "expected-state-value",
  returnTo: "/projects/x",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("oauth state cookie", () => {
  it("round-trips through the signed cookie", () => {
    const setCookie = serializeOAuthStateCookie(payload, SECRET, false);
    const cookieValue = setCookie.split(";")[0]!;
    const request = new Request("http://x/", {
      headers: { Cookie: cookieValue },
    });
    expect(readOAuthStateCookie(request, SECRET)).toEqual(payload);
  });

  it("rejects tampered cookies", () => {
    const setCookie = serializeOAuthStateCookie(payload, SECRET, false);
    const [name, value] = setCookie.split(";")[0]!.split("=") as [string, string];
    const forged = new Request("http://x/", {
      headers: { Cookie: `${name}=${value.slice(0, -3)}abc` },
    });
    expect(readOAuthStateCookie(forged, SECRET)).toBeNull();
    const wrongSecret = new Request("http://x/", {
      headers: { Cookie: `${name}=${value}` },
    });
    expect(
      readOAuthStateCookie(wrongSecret, "another-secret-another-secret-123"),
    ).toBeNull();
  });
});

describe("validateOAuthCallback", () => {
  const url = (qs: string) => new URL(`http://localhost:5173/auth/github/callback?${qs}`);

  it("accepts a matching state + code", () => {
    expect(
      validateOAuthCallback(url("state=expected-state-value&code=c0de"), payload, "github"),
    ).toEqual({ ok: true, code: "c0de" });
  });

  it("rejects a state mismatch", () => {
    expect(
      validateOAuthCallback(url("state=attacker-state&code=c0de"), payload, "github"),
    ).toEqual({ ok: false, reason: "state_mismatch" });
    expect(
      validateOAuthCallback(url("code=c0de"), payload, "github"),
    ).toEqual({ ok: false, reason: "state_mismatch" });
  });

  it("rejects a missing state cookie / provider mismatch / missing code", () => {
    expect(
      validateOAuthCallback(url("state=expected-state-value&code=c"), null, "github"),
    ).toEqual({ ok: false, reason: "missing_state_cookie" });
    expect(
      validateOAuthCallback(url("state=expected-state-value&code=c"), payload, "google"),
    ).toEqual({ ok: false, reason: "provider_mismatch" });
    expect(
      validateOAuthCallback(url("state=expected-state-value"), payload, "github"),
    ).toEqual({ ok: false, reason: "missing_code" });
  });

  it("surfaces provider errors", () => {
    const result = validateOAuthCallback(
      url("error=access_denied"),
      payload,
      "github",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("provider_error");
  });
});

describe("completeGithubLogin (mock fetch)", () => {
  const githubArgs = {
    code: "c0de",
    clientId: "cid",
    clientSecret: "csecret",
    redirectUri: "http://localhost:5173/auth/github/callback",
  };

  function githubFetch(emails: unknown): FetchLike {
    return async (input) => {
      if (input.includes("login/oauth/access_token")) {
        return jsonResponse({ access_token: "gh-token" });
      }
      if (input.includes("/user/emails")) {
        return jsonResponse(emails);
      }
      throw new Error(`unexpected fetch: ${input}`);
    };
  }

  it("rejects a verified email with no matching account (whitelist)", async () => {
    const db = ctx.makeDb();
    const result = await completeGithubLogin(db, {
      ...githubArgs,
      fetchImpl: githubFetch([
        { email: "stranger@example.com", primary: true, verified: true },
      ]),
    });
    expect(result).toEqual({
      status: "not_whitelisted",
      email: "stranger@example.com",
    });
    const failures = listAuditEvents(db, { action: "auth.oauth.failure" });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.details).toMatchObject({
      provider: "github",
      reason: "not_whitelisted",
    });
  });

  it("rejects a disabled account", async () => {
    const db = ctx.makeDb();
    insertUser(db, {
      id: "u_dis",
      email: "dis@viberr.test",
      name: "Dis",
      role: "member",
    });
    db.prepare(`UPDATE users SET disabled = 1 WHERE id = 'u_dis'`).run();
    const result = await completeGithubLogin(db, {
      ...githubArgs,
      fetchImpl: githubFetch([
        { email: "dis@viberr.test", primary: true, verified: true },
      ]),
    });
    expect(result.status).toBe("not_whitelisted");
  });

  it("requires a VERIFIED email", async () => {
    const db = ctx.makeDb();
    insertUser(db, {
      id: "u_gh",
      email: "gh@viberr.test",
      name: "GH",
      role: "member",
    });
    const result = await completeGithubLogin(db, {
      ...githubArgs,
      fetchImpl: githubFetch([
        { email: "gh@viberr.test", primary: true, verified: false },
      ]),
    });
    expect(result).toEqual({ status: "no_verified_email" });
  });

  it("signs in a whitelisted user and updates idp on first OAuth login", async () => {
    const db = ctx.makeDb();
    insertUser(db, {
      id: "u_gh2",
      email: "gh2@viberr.test",
      name: "GH Two",
      role: "member",
      idp: "local",
    });
    const result = await completeGithubLogin(db, {
      ...githubArgs,
      fetchImpl: githubFetch([
        { email: "other@x.test", primary: false, verified: true },
        { email: "GH2@viberr.test", primary: true, verified: true },
      ]),
    });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.user.id).toBe("u_gh2");
    expect(findUserById(db, "u_gh2")?.idp).toBe("github");
    expect(findUserById(db, "u_gh2")?.lastLoginAt).toBeTruthy();
    expect(listAuditEvents(db, { action: "auth.oauth.login" })).toHaveLength(1);
  });

  it("reports a failed token exchange", async () => {
    const db = ctx.makeDb();
    const result = await completeGithubLogin(db, {
      ...githubArgs,
      fetchImpl: async () => jsonResponse({ error: "bad_verification_code" }),
    });
    expect(result.status).toBe("exchange_failed");
  });
});

describe("completeGoogleLogin (mock fetch)", () => {
  it("signs in via userinfo email_verified and sends the PKCE verifier", async () => {
    const db = ctx.makeDb();
    insertUser(db, {
      id: "u_goog",
      email: "goog@viberr.test",
      name: "Goog",
      role: "member",
    });
    let sawVerifier = false;
    const fetchImpl: FetchLike = async (input, init) => {
      if (input.includes("oauth2.googleapis.com/token")) {
        sawVerifier = String(init?.body ?? "").includes(
          "code_verifier=the-verifier",
        );
        return jsonResponse({ access_token: "goog-token" });
      }
      if (input.includes("openidconnect.googleapis.com/v1/userinfo")) {
        return jsonResponse({
          email: "goog@viberr.test",
          email_verified: true,
        });
      }
      throw new Error(`unexpected fetch: ${input}`);
    };
    const result = await completeGoogleLogin(db, {
      code: "c0de",
      codeVerifier: "the-verifier",
      clientId: "cid",
      clientSecret: "cs",
      redirectUri: "http://localhost:5173/auth/google/callback",
      fetchImpl,
    });
    expect(sawVerifier).toBe(true);
    expect(result.status).toBe("success");
    expect(findUserById(db, "u_goog")?.idp).toBe("google");
  });

  it("rejects unverified Google emails", async () => {
    const db = ctx.makeDb();
    insertUser(db, {
      id: "u_g2",
      email: "g2@viberr.test",
      name: "G2",
      role: "member",
    });
    const fetchImpl: FetchLike = async (input) =>
      input.includes("/token")
        ? jsonResponse({ access_token: "t" })
        : jsonResponse({ email: "g2@viberr.test", email_verified: false });
    const result = await completeGoogleLogin(db, {
      code: "c",
      codeVerifier: "v",
      clientId: "cid",
      clientSecret: "cs",
      redirectUri: "http://x/cb",
      fetchImpl,
    });
    expect(result).toEqual({ status: "no_verified_email" });
  });
});

describe("generatePkcePair", () => {
  it("produces an S256 challenge of the verifier", async () => {
    const { verifier, challenge } = generatePkcePair();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const expected = Buffer.from(digest).toString("base64url");
    expect(challenge).toBe(expected);
  });
});
