/** Friendly, non-sensitive copy for Better Auth's OAuth error callback. */
export function oauthLoginErrorMessage(code: string | null): string | null {
  if (!code) return null;
  const normalized = code.trim().toLowerCase().replaceAll(" ", "_");

  if (normalized === "access_denied") {
    return "OAuth sign-in was canceled. You can try again or use a local account.";
  }
  if (
    normalized === "unable_to_create_user" ||
    normalized === "user_creation_failed" ||
    normalized === "signup_disabled"
  ) {
    return "This OAuth account isn't whitelisted for Viberr. Ask an admin to grant access, then try again.";
  }
  return "OAuth sign-in couldn't be completed. Try again, or use a local account.";
}

export function oauthLoginErrorCallback(returnTo: string | null): string {
  return returnTo
    ? `/login?returnTo=${encodeURIComponent(returnTo)}`
    : "/login";
}
