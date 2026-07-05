import type Database from "better-sqlite3";
import type { Env } from "../config/env.server";
import { logger } from "../logging/logger.server";
import {
  signInGoogleVerifiedEmail,
  type FetchLike,
  type OAuthLoginResult,
} from "./oauth-shared.server";
import type { SessionMeta } from "./session.server";

/**
 * Google OAuth (authorization-code flow + PKCE S256, scopes
 * `openid email profile`). Instead of verifying the id_token signature
 * against Google's JWKS ourselves, we call the OpenID userinfo endpoint
 * over HTTPS with the freshly-issued access token — the TLS channel to
 * Google is the trust anchor, and the endpoint returns the canonical
 * `email` + `email_verified` claims.
 */

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export function isGoogleOAuthEnabled(
  env: Pick<Env, "GOOGLE_OAUTH_CLIENT_ID" | "GOOGLE_OAUTH_CLIENT_SECRET">,
): boolean {
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function googleAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function completeGoogleLogin(
  db: Database.Database,
  args: {
    code: string;
    codeVerifier: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    meta?: SessionMeta;
    fetchImpl?: FetchLike;
  },
): Promise<OAuthLoginResult> {
  const fetchImpl = args.fetchImpl ?? fetch;

  let accessToken: string;
  try {
    const tokenResponse = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: args.code,
        client_id: args.clientId,
        client_secret: args.clientSecret,
        redirect_uri: args.redirectUri,
        grant_type: "authorization_code",
        code_verifier: args.codeVerifier,
      }).toString(),
    });
    if (!tokenResponse.ok) {
      return {
        status: "exchange_failed",
        detail: `token endpoint returned ${tokenResponse.status}`,
      };
    }
    const tokenBody = (await tokenResponse.json()) as {
      access_token?: string;
      error?: string;
    };
    if (!tokenBody.access_token) {
      return {
        status: "exchange_failed",
        detail: tokenBody.error ?? "no access_token in response",
      };
    }
    accessToken = tokenBody.access_token;
  } catch (error) {
    logger.warn("google token exchange failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return { status: "exchange_failed", detail: "token exchange threw" };
  }

  let claims: { email?: string; email_verified?: boolean; name?: string };
  try {
    const userinfoResponse = await fetchImpl(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userinfoResponse.ok) {
      return {
        status: "exchange_failed",
        detail: `userinfo endpoint returned ${userinfoResponse.status}`,
      };
    }
    claims = (await userinfoResponse.json()) as typeof claims;
  } catch (error) {
    logger.warn("google userinfo lookup failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return { status: "exchange_failed", detail: "userinfo lookup threw" };
  }

  if (!claims.email || claims.email_verified !== true) {
    return { status: "no_verified_email" };
  }

  // Account-existence whitelist first; else the 9B domain allowlist
  // provisions the account on first sign-in (Phase 10 wiring).
  return signInGoogleVerifiedEmail(
    db,
    { email: claims.email, name: claims.name ?? null },
    args.meta,
  );
}
