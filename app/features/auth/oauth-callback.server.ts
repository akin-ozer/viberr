import { redirect } from "react-router";
import { serializeLoginFlash } from "~/server/auth/login-flash.server";
import {
  clearOAuthStateCookie,
  type OAuthLoginResult,
  type OAuthProvider,
} from "~/server/auth/oauth-shared.server";
import { sessionCookieHeader } from "~/server/auth/session-cookie.server";
import { getEnv } from "~/server/config/env.server";
import { logger } from "~/server/logging/logger.server";
import { serializeThemePreference } from "~/server/theme/theme-cookie.server";

/**
 * Shared glue for /auth/<provider>/callback: turns validation failures and
 * OAuthLoginResult into redirects with the right cookies + flash messages.
 */

const PROVIDER_LABEL: Record<OAuthProvider, string> = {
  github: "GitHub",
  google: "Google",
};

function secure(): boolean {
  return getEnv().NODE_ENV === "production";
}

/** Redirect to /login with a flash, clearing the OAuth state cookie. */
export function oauthFailureRedirect(
  provider: OAuthProvider,
  message: string,
): Response {
  const headers = new Headers();
  headers.append("Set-Cookie", clearOAuthStateCookie(secure()));
  headers.append(
    "Set-Cookie",
    serializeLoginFlash({ kind: "error", message }),
  );
  return redirect("/login", { headers });
}

export function oauthValidationFailureRedirect(
  provider: OAuthProvider,
  reason: string,
): Response {
  logger.warn("oauth callback rejected", { provider, reason });
  return oauthFailureRedirect(
    provider,
    `${PROVIDER_LABEL[provider]} sign-in failed — please try again.`,
  );
}

/** Maps a completed provider login to the final redirect. */
export function oauthResultRedirect(
  provider: OAuthProvider,
  result: OAuthLoginResult,
  returnTo: string | null,
): Response {
  const label = PROVIDER_LABEL[provider];
  switch (result.status) {
    case "success": {
      const headers = new Headers();
      headers.append("Set-Cookie", clearOAuthStateCookie(secure()));
      headers.append("Set-Cookie", sessionCookieHeader(result.session.token));
      headers.append(
        "Set-Cookie",
        serializeThemePreference(result.user.theme),
      );
      if (result.mustResetPassword) {
        // Forced-reset gate applies to OAuth logins too.
        const target = returnTo
          ? `/login?returnTo=${encodeURIComponent(returnTo)}`
          : "/login";
        return redirect(target, { headers });
      }
      return redirect(returnTo ?? "/", { headers });
    }
    case "not_whitelisted":
      return oauthFailureRedirect(
        provider,
        `No Viberr account for ${result.email} — ask an admin to add you.`,
      );
    case "no_verified_email":
      return oauthFailureRedirect(
        provider,
        `Your ${label} account has no verified email — verify it with ${label} first, or use a local account.`,
      );
    case "exchange_failed":
      logger.warn("oauth exchange failed", {
        provider,
        detail: result.detail,
      });
      return oauthFailureRedirect(
        provider,
        `${label} sign-in failed — please try again.`,
      );
  }
}
