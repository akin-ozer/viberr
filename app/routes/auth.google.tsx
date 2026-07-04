import { redirect } from "react-router";
import type { Route } from "./+types/auth.google";
import { serializeLoginFlash } from "~/server/auth/login-flash.server";
import {
  googleAuthorizeUrl,
  isGoogleOAuthEnabled,
} from "~/server/auth/oauth-google.server";
import {
  generateOAuthState,
  generatePkcePair,
  serializeOAuthStateCookie,
} from "~/server/auth/oauth-shared.server";
import { safeReturnTo } from "~/server/auth/require-user.server";
import { getEnv } from "~/server/config/env.server";

/** GET /auth/google — starts the Google authorization-code + PKCE flow. */
export function loader({ request }: Route.LoaderArgs) {
  const env = getEnv();
  if (!isGoogleOAuthEnabled(env)) {
    throw redirect("/login", {
      headers: {
        "Set-Cookie": serializeLoginFlash({
          kind: "info",
          message:
            "Google OAuth isn't configured on this deployment — use a local account, or ask an admin to set it up.",
        }),
      },
    });
  }

  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const state = generateOAuthState();
  const pkce = generatePkcePair();
  const authorizeUrl = googleAuthorizeUrl({
    clientId: env.GOOGLE_OAUTH_CLIENT_ID!,
    redirectUri: `${url.origin}/auth/google/callback`,
    state,
    codeChallenge: pkce.challenge,
  });
  throw redirect(authorizeUrl, {
    headers: {
      "Set-Cookie": serializeOAuthStateCookie(
        {
          provider: "google",
          state,
          codeVerifier: pkce.verifier,
          ...(returnTo ? { returnTo } : {}),
        },
        env.VIBERR_SESSION_SECRET,
        env.NODE_ENV === "production",
      ),
    },
  });
}
