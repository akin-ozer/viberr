/**
 * THE shared timestamp formatter (orchestrator ruling 4).
 *
 * Boundaries carry UTC ISO strings; display reproduces the mock's exact
 * forms in the viewer's local timezone (the seed back-dates events to local
 * wall-clock times so rendering matches the mock):
 *
 *   - clock:     "9:41", "16:04"            (24h, no leading zero on hours)
 *   - dayBucket: "Today" | "Yesterday" | "Mar 30"
 *   - dayTime:   today → "9:41", else "Yesterday 16:04" / "Mar 30 14:00"
 *                (the bell-popover / notification meta form)
 *   - dayDotTime:today → "9:41", else "{day} · {t}" (timeline/run form)
 *   - relative:  "just now" | "2m ago" | "3h ago" | "yesterday" | "3d ago"
 *                | "Mar 30" (home cards / store strip)
 *
 * Pure, client-safe (no .server suffix); pass `now` in tests.
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function toDate(iso: string): Date {
  return new Date(iso);
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "9:41" / "16:04" — 24h clock, minutes zero-padded, hours as-is. */
export function formatClock(iso: string): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "Today" | "Yesterday" | "Mar 30" (local days). */
export function formatDayBucket(iso: string, now: Date = new Date()): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (sameLocalDay(d, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameLocalDay(d, yesterday)) return "Yesterday";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Notification meta form: today → "9:41", else "{day} {t}" (trimmed). */
export function formatDayTime(iso: string, now: Date = new Date()): string {
  const bucket = formatDayBucket(iso, now);
  const clock = formatClock(iso);
  if (bucket === "Today") return clock;
  return `${bucket} ${clock}`.trim();
}

/** Timeline form: today → "9:41", else "{day} · {t}". */
export function formatDayDotTime(iso: string, now: Date = new Date()): string {
  const bucket = formatDayBucket(iso, now);
  const clock = formatClock(iso);
  if (bucket === "Today") return clock;
  return `${bucket} · ${clock}`;
}

/** Relative form for home cards / store strip ("updated 2m ago"). */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24 && sameLocalDay(d, now)) return `${hours}h ago`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameLocalDay(d, yesterday)) return "yesterday";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDayBucket(iso, now);
}
