/**
 * A dollar figure and a span of time as a person reads them, in one place:
 * the Insights page prints its totals with these, and what a task took
 * (ruling 316, `what-it-took.server.ts`) builds its card line with them on
 * the server. Client-safe.
 *
 * `formatUsd` (`shared/run-failure.ts`, ruling 159) is a different print: a
 * spending cap beside the spend that crossed it, to four decimals below a
 * dollar. This one is a total, to the cent.
 */

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Ruling 316: from two days up a span reads in days and hours ("2d 4h"), so
 *  a task that waited a week on a person does not print as "168h 0m". */
const DAYS_FROM_HOURS = 48;

export function formatDuration(ms: number | null): string {
  if (ms === null) return "n/a";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h >= DAYS_FROM_HOURS) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m % 60}m`;
}
