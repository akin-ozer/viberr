import type { Route } from "./+types/api.auth.$";
import {
  canonicalLoopbackRedirectUrl,
  getAuth,
} from "~/lib/auth.server";
import { getEnv } from "~/server/config/env.server";

/**
 * better-auth request handler, mounted at /api/auth/* (AUTH_BASE_PATH).
 * Both GET (sign-in callbacks, .well-known metadata, getSession) and POST
 * (sign-in/out, social start) forward the raw Request to better-auth, which
 * returns a Response (Set-Cookie included). No CSRF token here — better-auth
 * enforces its own Origin / trustedOrigins check.
 */
function requireCanonicalAuthOrigin(request: Request): Response | null {
  const canonicalUrl = canonicalLoopbackRedirectUrl(
    request.url,
    getEnv().BETTER_AUTH_URL,
  );
  if (!canonicalUrl) return null;
  // Resource routes bypass the root loader. Refuse an alias-host auth request
  // before Better Auth can set a host-only OAuth state cookie paired with a
  // callback on the canonical host. The Location header gives clients and
  // diagnostics the exact reload target without replaying a cross-origin POST.
  return Response.json(
    {
      error: {
        code: "CANONICAL_ORIGIN_REQUIRED",
        message: "Reload Viberr on its canonical local address before signing in.",
      },
    },
    { status: 409, headers: { Location: canonicalUrl } },
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  const canonical = requireCanonicalAuthOrigin(request);
  if (canonical) return canonical;
  return getAuth().handler(request);
}

export async function action({ request }: Route.ActionArgs) {
  const canonical = requireCanonicalAuthOrigin(request);
  if (canonical) return canonical;
  return getAuth().handler(request);
}
