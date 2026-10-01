import { cookieValues } from "~/server/http/cookies.server";

/**
 * Ruling 618: the setup checklist's close hides it for the session that
 * pressed it, and the card is back once that session ends. The cookie carries
 * the sign-in's session id and no expiry, so the browser drops it when its own
 * session ends, and the next sign-in (the same person again, or the account
 * the checklist asked them to make) no longer matches it. HttpOnly: nothing on
 * the page reads it, and the loader leaves the card out before the page
 * renders, so it never flashes back on a reload.
 */
const SETUP_HIDDEN_COOKIE = "viberr_setup_hidden";

/** Did this sign-in close the checklist? */
export function isSetupHidden(request: Request, sessionId: string): boolean {
  return cookieValues(request, SETUP_HIDDEN_COOKIE).includes(sessionId);
}

/** The Set-Cookie value that closes the checklist for `sessionId`. */
export function serializeSetupHidden(sessionId: string): string {
  return `${SETUP_HIDDEN_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax`;
}
