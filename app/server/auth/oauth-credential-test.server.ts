import { z } from "zod";

/**
 * R19-16 — prove an OAuth client id/secret pair against the PROVIDER, before
 * the deployment offers a sign-in button that depends on it.
 *
 * Neither provider has a "validate my app credentials" endpoint, so each test
 * makes a real call the pair must be accepted for, with a deliberately invalid
 * grant. The credential verdict and the grant verdict come back as DIFFERENT
 * statuses, which is what makes this a test rather than a guess:
 *
 *  - GitHub `POST /applications/{client_id}/token` authenticates the APP with
 *    HTTP Basic (client_id:client_secret) and checks a user token. A bad app
 *    credential is `401 Bad credentials`; a good one with a nonsense token is
 *    `404`/`422` — the app was authenticated, only the token was rejected.
 *  - Google `POST /token` with `grant_type=authorization_code` and a nonsense
 *    code answers `401 invalid_client` when the pair is wrong, and `400
 *    invalid_grant` when the pair is right and only the code is bad.
 *
 * WHAT THIS DOES NOT PROVE: that the redirect/callback URI is registered on the
 * app, or that the app is allowed for the org. Those first fail at a real
 * sign-in, so the UI states the limit next to the result instead of implying a
 * green check means sign-in works.
 */

/** The only part of Google's token error body this test reads. A body that is
 *  not JSON, or carries something other than a string `error`, decodes to "no
 *  error code" — the same NEGATIVE verdict an unrecognised code gets. */
const googleTokenErrorSchema = z
  .object({ error: z.string().optional() })
  .catch({});

export type OAuthProvider = "github" | "google";

export type OAuthCredentialTest =
  | { ok: true; detail: string }
  | { ok: false; reason: string };

/** Bounded so a hanging provider surfaces instead of holding the request. */
export const OAUTH_TEST_TIMEOUT_MS = 10_000;

/** Nonsense grant material — never a real token/code, and never logged. */
const PROBE_TOKEN = "viberr_probe_invalid_token";
const PROBE_CODE = "viberr_probe_invalid_code";

interface TestOptions {
  fetchImpl?: typeof fetch;
  /** The callback the deployment will actually use (Google echoes it back). */
  redirectUri?: string;
}

async function testGithub(
  clientId: string,
  clientSecret: string,
  options: TestOptions,
): Promise<OAuthCredentialTest> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetchImpl(
    `https://api.github.com/applications/${encodeURIComponent(clientId)}/token`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Basic ${basic}`,
        "content-type": "application/json",
        "user-agent": "viberr",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: PROBE_TOKEN }),
      signal: AbortSignal.timeout(OAUTH_TEST_TIMEOUT_MS),
    },
  );
  if (res.status === 401) {
    return {
      ok: false,
      reason:
        "GitHub rejected the client ID / secret pair (401 Bad credentials) — check both values on the OAuth app.",
    };
  }
  // 404/422 = the APP authenticated and only the probe token was refused, which
  // is the pass. 200 would mean the probe token somehow existed — still proof
  // the pair authenticated.
  if (res.status === 404 || res.status === 422 || res.ok) {
    return {
      ok: true,
      detail: `GitHub accepted the client ID and secret (HTTP ${res.status} on the app-authenticated probe).`,
    };
  }
  return {
    ok: false,
    reason: `GitHub answered HTTP ${res.status} — the credential pair could not be proved.`,
  };
}

async function testGoogle(
  clientId: string,
  clientSecret: string,
  options: TestOptions,
): Promise<OAuthCredentialTest> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code: PROBE_CODE,
    redirect_uri: options.redirectUri ?? "http://localhost/callback",
  });
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(OAUTH_TEST_TIMEOUT_MS),
  });
  const data = googleTokenErrorSchema.parse(
    await res.json().catch(() => null),
  );
  if (data.error === "invalid_grant") {
    return {
      ok: true,
      detail:
        "Google accepted the client ID and secret (it rejected only the probe code, invalid_grant).",
    };
  }
  if (data.error === "invalid_client" || res.status === 401) {
    return {
      ok: false,
      reason:
        "Google rejected the client ID / secret pair (invalid_client) — check both values on the OAuth client.",
    };
  }
  return {
    ok: false,
    reason: `Google answered ${data.error ?? `HTTP ${res.status}`} — the credential pair could not be proved.`,
  };
}

/**
 * Ask the provider whether it recognises this app credential. Network failures
 * come back as a NEGATIVE result rather than a throw: "could not prove it" is
 * the honest state, and the caller must not enable a provider on it.
 */
export async function testOAuthCredentials(
  provider: OAuthProvider,
  clientId: string,
  clientSecret: string,
  options: TestOptions = {},
): Promise<OAuthCredentialTest> {
  try {
    return provider === "github"
      ? await testGithub(clientId, clientSecret, options)
      : await testGoogle(clientId, clientSecret, options);
  } catch {
    // Never echo the error: a fetch failure can carry the request, and the
    // request carries the secret.
    return {
      ok: false,
      reason: `Could not reach ${provider === "github" ? "GitHub" : "Google"} to prove the credentials — nothing was changed.`,
    };
  }
}
