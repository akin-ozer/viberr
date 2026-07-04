import type { Route } from "./+types/auth.google.callback";
import {
  oauthResultRedirect,
  oauthValidationFailureRedirect,
} from "~/features/auth/oauth-callback.server";
import { completeGoogleLogin } from "~/server/auth/oauth-google.server";
import {
  readOAuthStateCookie,
  validateOAuthCallback,
} from "~/server/auth/oauth-shared.server";
import { clientIpOf } from "~/server/auth/rate-limit.server";
import { safeReturnTo } from "~/server/auth/require-user.server";
import { getEnv } from "~/server/config/env.server";
import { getDb } from "~/server/db/sqlite.server";

/** GET /auth/google/callback — completes the Google flow (whitelist model). */
export async function loader({ request }: Route.LoaderArgs) {
  const env = getEnv();
  const url = new URL(request.url);
  const cookiePayload = readOAuthStateCookie(
    request,
    env.VIBERR_SESSION_SECRET,
  );
  const validation = validateOAuthCallback(url, cookiePayload, "google");
  if (!validation.ok) {
    throw oauthValidationFailureRedirect("google", validation.reason);
  }
  if (!cookiePayload?.codeVerifier) {
    throw oauthValidationFailureRedirect("google", "missing_code_verifier");
  }
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw oauthValidationFailureRedirect("google", "not_configured");
  }

  const result = await completeGoogleLogin(getDb(), {
    code: validation.code,
    codeVerifier: cookiePayload.codeVerifier,
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: `${url.origin}/auth/google/callback`,
    meta: {
      ip: clientIpOf(request),
      userAgent: request.headers.get("User-Agent"),
    },
  });
  throw oauthResultRedirect(
    "google",
    result,
    safeReturnTo(cookiePayload?.returnTo ?? null),
  );
}
