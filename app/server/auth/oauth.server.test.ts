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

// ---------------------------------------------------------------- Phase 10
// OAuth ↔ 9B org-data wiring: google domain allowlist provisioning and
// github placeholder-row claiming (+ handle persistence).

describe("google domain-allowlist provisioning (Phase 10)", () => {
  const googleArgs = {
    code: "c0de",
    codeVerifier: "v",
    clientId: "cid",
    clientSecret: "cs",
    redirectUri: "http://localhost:5173/auth/google/callback",
  };

  function googleFetch(claims: unknown): FetchLike {
    return async (input) => {
      if (input.includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "goog-token" });
      }
      if (input.includes("openidconnect.googleapis.com/v1/userinfo")) {
        return jsonResponse(claims);
      }
      throw new Error(`unexpected fetch: ${input}`);
    };
  }

  function allowDomain(db: ReturnType<typeof ctx.makeDb>, domain: string, role: string) {
    db.prepare(
      `INSERT INTO google_domain_allowlist (id, domain, role, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(`dom_${domain.slice(1)}`, domain, role, new Date().toISOString());
  }

  it("provisions a first-login user from an allowlisted domain with the mapped role", async () => {
    const db = ctx.makeDb();
    allowDomain(db, "@hepapi.com", "member");
    const result = await completeGoogleLogin(db, {
      ...googleArgs,
      fetchImpl: googleFetch({
        email: "Codex@hepapi.com",
        email_verified: true,
        name: "Codex Ozer",
      }),
    });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.user.email).toBe("codex@hepapi.com");
    expect(result.user.name).toBe("Codex Ozer");
    expect(result.user.role).toBe("member");
    expect(result.user.idp).toBe("google");
    // Passwordless — the row IS the whitelist; OAuth-only sign-in.
    expect(result.user.passwordHash).toBeNull();
    expect(result.mustResetPassword).toBe(false);
    expect(result.session.token.length).toBeGreaterThan(0);
    expect(
      listAuditEvents(db, { action: "auth.oauth.user_provisioned" }),
    ).toHaveLength(1);
    expect(listAuditEvents(db, { action: "auth.oauth.login" })).toHaveLength(1);
  });

  it("maps an admin domain role onto the provisioned account", async () => {
    const db = ctx.makeDb();
    allowDomain(db, "@ops.example", "admin");
    const result = await completeGoogleLogin(db, {
      ...googleArgs,
      fetchImpl: googleFetch({ email: "root@ops.example", email_verified: true }),
    });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.user.role).toBe("admin");
    expect(result.user.name).toBe("root"); // local-part fallback, no name claim
  });

  it("still rejects a verified email whose domain is NOT allowlisted", async () => {
    const db = ctx.makeDb();
    allowDomain(db, "@hepapi.com", "member");
    const result = await completeGoogleLogin(db, {
      ...googleArgs,
      fetchImpl: googleFetch({ email: "x@other.dev", email_verified: true }),
    });
    expect(result).toEqual({ status: "not_whitelisted", email: "x@other.dev" });
    expect(listAuditEvents(db, { action: "auth.oauth.failure" })).toHaveLength(1);
  });

  it("existing accounts keep the exact pre-Phase-10 path (no reprovisioning)", async () => {
    const db = ctx.makeDb();
    allowDomain(db, "@hepapi.com", "admin"); // must NOT touch the row's role
    insertUser(db, {
      id: "u_prior",
      email: "prior@hepapi.com",
      name: "Prior",
      role: "member",
    });
    const result = await completeGoogleLogin(db, {
      ...googleArgs,
      fetchImpl: googleFetch({ email: "prior@hepapi.com", email_verified: true }),
    });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.user.id).toBe("u_prior");
    expect(result.user.role).toBe("member"); // unchanged
    expect(
      listAuditEvents(db, { action: "auth.oauth.user_provisioned" }),
    ).toHaveLength(0);
  });
});

describe("github placeholder claim + handle persistence (Phase 10)", () => {
  const githubArgs = {
    code: "c0de",
    clientId: "cid",
    clientSecret: "csecret",
    redirectUri: "http://localhost:5173/auth/github/callback",
  };

  function githubFetch(options: {
    emails: unknown;
    profile?: unknown;
    profileStatus?: number;
  }): FetchLike {
    return async (input) => {
      if (input.includes("login/oauth/access_token")) {
        return jsonResponse({ access_token: "gh-token" });
      }
      if (input.includes("/user/emails")) {
        return jsonResponse(options.emails);
      }
      if (input.endsWith("/user")) {
        return jsonResponse(
          options.profile ?? { login: "akin-ozer", name: "Akin Ozer" },
          options.profileStatus ?? 200,
        );
      }
      throw new Error(`unexpected fetch: ${input}`);
    };
  }

  it("claims a whitelisted placeholder row at first sign-in", async () => {
    const db = ctx.makeDb();
    // The 9B org-settings convention: name "@handle", email "github.com/handle".
    insertUser(db, {
      id: "u_ph",
      email: "github.com/akin-ozer",
      name: "@akin-ozer",
      role: "member",
      idp: "github",
    });
    const result = await completeGithubLogin(db, {
      ...githubArgs,
      fetchImpl: githubFetch({
        emails: [{ email: "akin@hepapi.com", primary: true, verified: true }],
      }),
    });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.user.id).toBe("u_ph");
    const claimed = findUserById(db, "u_ph")!;
    expect(claimed.email).toBe("akin@hepapi.com"); // placeholder replaced
    expect(claimed.name).toBe("Akin Ozer");
    expect(claimed.githubHandle).toBe("akin-ozer");
    expect(claimed.lastLoginAt).toBeTruthy();
    expect(
      listAuditEvents(db, { action: "auth.oauth.placeholder_claimed" }),
    ).toHaveLength(1);
    expect(listAuditEvents(db, { action: "auth.oauth.login" })).toHaveLength(1);
  });

  it("persists the handle on an existing email-whitelisted account", async () => {
    const db = ctx.makeDb();
    insertUser(db, {
      id: "u_mail",
      email: "mail@viberr.test",
      name: "Mail",
      role: "member",
    });
    const result = await completeGithubLogin(db, {
      ...githubArgs,
      fetchImpl: githubFetch({
        emails: [{ email: "mail@viberr.test", primary: true, verified: true }],
        profile: { login: "mailer", name: null },
      }),
    });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.user.id).toBe("u_mail");
    expect(findUserById(db, "u_mail")?.githubHandle).toBe("mailer");
    expect(result.user.githubHandle).toBe("mailer");
  });

  it("email match wins over a placeholder; no claim happens", async () => {
    const db = ctx.makeDb();
    insertUser(db, {
      id: "u_real",
      email: "dev@viberr.test",
      name: "Dev",
      role: "member",
    });
    insertUser(db, {
      id: "u_ph2",
      email: "github.com/devhandle",
      name: "@devhandle",
      role: "admin",
      idp: "github",
    });
    const result = await completeGithubLogin(db, {
      ...githubArgs,
      fetchImpl: githubFetch({
        emails: [{ email: "dev@viberr.test", primary: true, verified: true }],
        profile: { login: "devhandle", name: "Dev H" },
      }),
    });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.user.id).toBe("u_real");
    // The placeholder row is untouched (still claimable / removable).
    expect(findUserById(db, "u_ph2")?.email).toBe("github.com/devhandle");
    expect(
      listAuditEvents(db, { action: "auth.oauth.placeholder_claimed" }),
    ).toHaveLength(0);
  });

  it("no account, no placeholder → still not_whitelisted", async () => {
    const db = ctx.makeDb();
    const result = await completeGithubLogin(db, {
      ...githubArgs,
      fetchImpl: githubFetch({
        emails: [{ email: "ghost@x.test", primary: true, verified: true }],
        profile: { login: "ghosthandle" },
      }),
    });
    expect(result).toEqual({ status: "not_whitelisted", email: "ghost@x.test" });
  });

  it("a failed /user profile lookup degrades gracefully (email path intact)", async () => {
    const db = ctx.makeDb();
    insertUser(db, {
      id: "u_deg",
      email: "deg@viberr.test",
      name: "Deg",
      role: "member",
    });
    const result = await completeGithubLogin(db, {
      ...githubArgs,
      fetchImpl: githubFetch({
        emails: [{ email: "deg@viberr.test", primary: true, verified: true }],
        profileStatus: 500,
      }),
    });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.user.id).toBe("u_deg");
    expect(findUserById(db, "u_deg")?.githubHandle).toBeNull();
  });
});
