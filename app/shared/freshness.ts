/**
 * THE staleness thresholds (P13-D-32).
 *
 * `architecture.md` prescribes a projection-freshness policy under
 * `server/interpretation/` and forbids duplicating interpretation logic in UI
 * components — yet two live "older than an hour reads as stale" rules had
 * grown their own private 1-hour constants, one of them inside a React
 * component (`org-settings/resources-panel.tsx`).
 *
 * The values live HERE rather than in `freshness-policy.server.ts` for one
 * hard reason: the MCP-health rule is evaluated in a client component, and a
 * `.server.ts` module cannot be imported into the client bundle. `app/shared/`
 * is the repo's home for code both halves need (see `shared/dates/format`).
 * `server/interpretation/freshness-policy.server.ts` is the server-side door
 * onto these same predicates, so the server layer the document names is still
 * where server modules import from — but there is exactly ONE definition of
 * each threshold, and it is this file.
 */

/** Cached observations older than this stop being presentable as current. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

/** Never observed, unparseable, or older than `maxAgeMs`. `now` is injectable
 *  for tests; production passes nothing. */
export function isStale(
  observedAt: string | null | undefined,
  maxAgeMs: number = STALE_AFTER_MS,
  now: number = Date.now(),
): boolean {
  if (!observedAt) return true;
  const ms = Date.parse(observedAt);
  if (!Number.isFinite(ms)) return true;
  return now - ms > maxAgeMs;
}

/**
 * GitHub reconcile freshness (F10-28). Stale = never reconciled, or older than
 * an hour. With the 5-minute poller (P11-14) healthy this only trips when
 * GitHub or the credential has been broken for an hour — surfaced honestly by
 * the freshness chip rather than a lie.
 */
export function isReconcileStale(
  observedAt: string | null | undefined,
  now?: number,
): boolean {
  return isStale(observedAt, STALE_AFTER_MS, now ?? Date.now());
}

/**
 * MCP health-check freshness. A green "up" dot for an hours-old check
 * over-implies "healthy now" — stdio MCP servers are only re-checked on
 * save/test, never on page load — so an old check renders amber + "stale".
 *
 * Deviation from {@link isStale}: a server that was NEVER checked is not
 * stale, it is unknown, and the panel renders that separately.
 */
export function isMcpHealthStale(
  checkedAt: string | null | undefined,
  now?: number,
): boolean {
  return !!checkedAt && isStale(checkedAt, STALE_AFTER_MS, now ?? Date.now());
}

/** Is `iso` strictly newer than `thanIso`? False when either is missing or
 *  unparseable — an unreadable stamp never displaces a recorded claim. /insights
 *  (`insights-page.tsx`) and the profile page (`profile-query.server.ts`) both
 *  ask it, so the two surfaces cannot disagree about which of two provider
 *  claims is the fresher one. */
export function observedAfter(iso: string | undefined, thanIso: string): boolean {
  if (!iso) return false;
  const a = Date.parse(iso);
  const b = Date.parse(thanIso);
  return Number.isFinite(a) && Number.isFinite(b) && a > b;
}
