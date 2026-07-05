import type Database from "better-sqlite3";
import type { Env } from "../config/env.server";
import { logger } from "../logging/logger.server";
import {
  signInGithubVerifiedIdentity,
  type FetchLike,
  type OAuthLoginResult,
} from "./oauth-shared.server";
import type { SessionMeta } from "./session.server";

/**
 * GitHub OAuth (authorization-code flow). GitHub OAuth apps do not support
 * PKCE — the signed state cookie is the CSRF defense. Scope `read:user
 * user:email` is required because /user/emails is the only reliable way to
 * get the VERIFIED primary email (the public profile email can be absent
 * or unverified).
 */

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const EMAILS_URL = "https://api.github.com/user/emails";
const USER_URL = "https://api.github.com/user";

export function isGithubOAuthEnabled(
  env: Pick<Env, "GITHUB_OAUTH_CLIENT_ID" | "GITHUB_OAUTH_CLIENT_SECRET">,
): boolean {
  return Boolean(env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET);
}

export function githubAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", "read:user user:email");
  url.searchParams.set("state", args.state);
  return url.toString();
}

interface GithubEmailEntry {
  email: string;
  primary: boolean;
  verified: boolean;
}

/**
 * Exchanges the code, fetches the verified primary email, signs the user in
 * (whitelist: their row must already exist). fetchImpl is injectable for
 * tests.
 */
export async function completeGithubLogin(
  db: Database.Database,
  args: {
    code: string;
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
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: args.clientId,
        client_secret: args.clientSecret,
        code: args.code,
        redirect_uri: args.redirectUri,
      }),
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
    logger.warn("github token exchange failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return { status: "exchange_failed", detail: "token exchange threw" };
  }

  let emails: GithubEmailEntry[];
  try {
    const emailsResponse = await fetchImpl(EMAILS_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "viberr",
      },
    });
    if (!emailsResponse.ok) {
      return {
        status: "exchange_failed",
        detail: `emails endpoint returned ${emailsResponse.status}`,
      };
    }
    emails = (await emailsResponse.json()) as GithubEmailEntry[];
  } catch (error) {
    logger.warn("github email lookup failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return { status: "exchange_failed", detail: "email lookup threw" };
  }

  const verified =
    emails.find((entry) => entry.primary && entry.verified) ??
    emails.find((entry) => entry.verified);
  if (!verified) return { status: "no_verified_email" };

  // GitHub login + display name — the handle matches the org-settings
  // placeholder whitelist rows and is persisted to users.github_handle
  // (Phase 10). Best-effort: a profile-lookup failure only degrades the
  // handle capture; the verified email alone still signs existing rows in.
  let handle: string | null = null;
  let displayName: string | null = null;
  try {
    const userResponse = await fetchImpl(USER_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "viberr",
      },
    });
    if (userResponse.ok) {
      const profile = (await userResponse.json()) as {
        login?: string;
        name?: string | null;
      };
      handle = profile.login ?? null;
      displayName = profile.name ?? null;
    }
  } catch (error) {
    logger.warn("github profile lookup failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }

  return signInGithubVerifiedIdentity(
    db,
    { email: verified.email, handle, name: displayName },
    args.meta,
  );
}
