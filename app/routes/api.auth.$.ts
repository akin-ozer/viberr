import type { Route } from "./+types/api.auth.$";
import { getAuth } from "~/lib/auth.server";

/**
 * better-auth request handler, mounted at /api/auth/* (AUTH_BASE_PATH).
 * Both GET (sign-in callbacks, .well-known metadata, getSession) and POST
 * (sign-in/out, social start) forward the raw Request to better-auth, which
 * returns a Response (Set-Cookie included). No CSRF token here — better-auth
 * enforces its own Origin / trustedOrigins check.
 */
export async function loader({ request }: Route.LoaderArgs) {
  return getAuth().handler(request);
}

export async function action({ request }: Route.ActionArgs) {
  return getAuth().handler(request);
}
