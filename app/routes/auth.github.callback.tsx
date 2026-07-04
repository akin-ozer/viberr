import type { Route } from "./+types/auth.github.callback";
import {
  oauthResultRedirect,
  oauthValidationFailureRedirect,
} from "~/features/auth/oauth-callback.server";
import { completeGithubLogin } from "~/server/auth/oauth-github.server";
import {
  readOAuthStateCookie,
  validateOAuthCallback,
} from "~/server/auth/oauth-shared.server";
import { clientIpOf } from "~/server/auth/rate-limit.server";
import { safeReturnTo } from "~/server/auth/require-user.server";
import { getEnv } from "~/server/config/env.server";
import { getDb } from "~/server/db/sqlite.server";

/** GET /auth/github/callback — completes the GitHub flow (whitelist model). */
export async function loader({ request }: Route.LoaderArgs) {
  const env = getEnv();
  const url = new URL(request.url);
  const cookiePayload = readOAuthStateCookie(
    request,
    env.VIBERR_SESSION_SECRET,
  );
  const validation = validateOAuthCallback(url, cookiePayload, "github");
  if (!validation.ok) {
    throw oauthValidationFailureRedirect("github", validation.reason);
  }
  if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) {
    throw oauthValidationFailureRedirect("github", "not_configured");
  }

  const result = await completeGithubLogin(getDb(), {
    code: validation.code,
    clientId: env.GITHUB_OAUTH_CLIENT_ID,
    clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
    redirectUri: `${url.origin}/auth/github/callback`,
    meta: {
      ip: clientIpOf(request),
      userAgent: request.headers.get("User-Agent"),
    },
  });
  throw oauthResultRedirect(
    "github",
    result,
    safeReturnTo(cookiePayload?.returnTo ?? null),
  );
}
