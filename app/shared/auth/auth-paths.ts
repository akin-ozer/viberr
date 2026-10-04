/**
 * The auth handler's mount point and the OAuth callback it serves — the ONE
 * spelling, shared by client and server.
 *
 * It lived in `lib/auth.server` alongside the better-auth instance, which made
 * it unreachable from any client component: importing it into a route pulls a
 * server-only module into the browser bundle (React Router's `dot-server`
 * plugin refuses the build). The Sign-in & SSO card has to render this exact
 * URL for an admin to register on the provider, so the constant belongs
 * somewhere both sides can read, and the server reads it from here too.
 */

export const AUTH_BASE_PATH = "/api/auth";

/** Where a provider sends the browser back — must match the OAuth app's entry. */
function oauthCallbackPath(provider: string): string {
  return `${AUTH_BASE_PATH}/callback/${provider}`;
}

/** The absolute callback for a given deployment origin. */
export function oauthCallbackUrl(origin: string, provider: string): string {
  return `${origin}${oauthCallbackPath(provider)}`;
}
