/**
 * Is this loader request a genuine DOCUMENT navigation (a hard load, a
 * refresh, a link opened in a new tab), rather than single fetch's `.data`
 * request for a revalidation or a client-side navigation?
 *
 * Two readers: R19-15's task-view read-marking (F20-11, a background tab's
 * revalidation must not eat notifications) and ruling 454's console shipping
 * (owner decision 2, 2026-09-24: a hard refresh arrives with the shown agent's
 * console filled; a `.data` request carries no console lines).
 */
export function isDocumentNavigation(request: Request): boolean {
  // Single-fetch data requests carry the `.data` suffix; a genuine SSR document
  // load lands on the clean route path. This alone excludes every revalidation.
  if (new URL(request.url).pathname.endsWith(".data")) return false;
  // When the browser sends it, a top-level navigation is `Sec-Fetch-Mode:
  // navigate` (any other same-origin fetch that reached a clean path is not);
  // absent (tests / non-browser SSR) we rely on the `.data` signal above.
  const mode = request.headers.get("Sec-Fetch-Mode");
  return mode === null || mode === "navigate";
}
