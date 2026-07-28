/**
 * F15-08 — one timezone story on the task page.
 *
 * A console line's `t` is baked server-side as a UTC wall clock
 * (`wire-format.server.ts` → `clockOf`, i.e. `iso.slice(11, 19)`), while every
 * other timestamp on the task page renders in the viewer's zone through
 * `shared/dates/format.ts`. The timeline and the agent log therefore described
 * the same moment hours apart, on one screen.
 *
 * The line carries no ISO of its own, so the UTC wall clock is re-anchored to
 * the run's own day and reprojected locally. `anchorIso` is the run's
 * `startedAt`; a run that crosses UTC midnight is handled by picking the
 * calendar day that puts the line NEAREST its anchor.
 */

const UTC_CLOCK = /^(\d{2}):(\d{2}):(\d{2})$/;

const HALF_DAY_MS = 12 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "17:46:46" (UTC) → "20:46:46" for a UTC+3 viewer. Values that are not a UTC
 * wall clock — the synthetic run-boundary row's empty string, or any future
 * shape — are returned untouched rather than mangled.
 */
export function localLogClock(
  t: string,
  anchorIso: string | null | undefined,
  now: Date = new Date(),
): string {
  const parts = UTC_CLOCK.exec(t);
  if (!parts) return t;
  const anchor = anchorIso ? new Date(anchorIso) : now;
  const base = Number.isNaN(anchor.getTime()) ? now : anchor;
  let stamp = Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate(),
    Number(parts[1]),
    Number(parts[2]),
    Number(parts[3]),
  );
  // The clock has no date, so a run started at 23:50 UTC logging 00:05 must
  // land on the NEXT day, not 24h earlier. Snap to whichever calendar day puts
  // the line within half a day of the anchor.
  if (stamp - base.getTime() > HALF_DAY_MS) stamp -= DAY_MS;
  else if (base.getTime() - stamp > HALF_DAY_MS) stamp += DAY_MS;
  const local = new Date(stamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
}
