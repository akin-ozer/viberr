import { redirect } from "react-router";
import type { Route } from "./+types/auth.github";
import { serializeLoginFlash } from "~/server/auth/login-flash.server";
import {
  githubAuthorizeUrl,
  isGithubOAuthEnabled,
} from "~/server/auth/oauth-github.server";
import {
  generateOAuthState,
  serializeOAuthStateCookie,
} from "~/server/auth/oauth-shared.server";
import { safeReturnTo } from "~/server/auth/require-user.server";
import { getEnv } from "~/server/config/env.server";

/** GET /auth/github — starts the GitHub authorization-code flow. */
export function loader({ request }: Route.LoaderArgs) {
  const env = getEnv();
  if (!isGithubOAuthEnabled(env)) {
    throw redirect("/login", {
      headers: {
        "Set-Cookie": serializeLoginFlash({
          kind: "info",
          message:
            "GitHub OAuth isn't configured on this deployment — use a local account, or ask an admin to set it up.",
        }),
      },
    });
  }

  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const state = generateOAuthState();
  const authorizeUrl = githubAuthorizeUrl({
    clientId: env.GITHUB_OAUTH_CLIENT_ID!,
    redirectUri: `${url.origin}/auth/github/callback`,
    state,
  });
  throw redirect(authorizeUrl, {
    headers: {
      "Set-Cookie": serializeOAuthStateCookie(
        { provider: "github", state, ...(returnTo ? { returnTo } : {}) },
        env.VIBERR_SESSION_SECRET,
        env.NODE_ENV === "production",
      ),
    },
  });
}
