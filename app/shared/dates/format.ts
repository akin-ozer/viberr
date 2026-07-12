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
 * Pure, client-safe (no .server suffix); pass `now` and `timeZone` in tests.
 *
 * The optional IANA time zone is also the SSR contract: callers that render
 * on both server and client must supply the same zone for the hydration pass.
 * `useViewerTimeZone()` provides UTC for SSR/initial hydration, then switches
 * to the viewer's IANA zone after hydration.
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function toDate(iso: string): Date {
  return new Date(iso);
}

interface CalendarParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedParts(d: Date, timeZone?: string): CalendarParts {
  if (!timeZone) {
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
    };
  }

  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  const values = Object.fromEntries(
    formatter
      .formatToParts(d)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    // Some Intl builds report midnight as 24 even with h23. It is still the
    // same calendar day and should display as the product's "0:xx" form.
    hour: values.hour! % 24,
    minute: values.minute!,
  };
}

function calendarOrdinal(parts: CalendarParts): number {
  return Math.floor(
    Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000,
  );
}

function calendarDayDiff(
  later: Date,
  earlier: Date,
  timeZone?: string,
): number {
  return (
    calendarOrdinal(zonedParts(later, timeZone)) -
    calendarOrdinal(zonedParts(earlier, timeZone))
  );
}

/** "9:41" / "16:04" — 24h clock, minutes zero-padded, hours as-is. */
export function formatClock(iso: string, timeZone?: string): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = zonedParts(d, timeZone);
  return `${parts.hour}:${String(parts.minute).padStart(2, "0")}`;
}

/** "Today" | "Yesterday" | "Mar 30" in the selected calendar zone. */
export function formatDayBucket(
  iso: string,
  now: Date = new Date(),
  timeZone?: string,
): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  const dayDiff = calendarDayDiff(now, d, timeZone);
  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  const parts = zonedParts(d, timeZone);
  return `${MONTHS[parts.month - 1]} ${parts.day}`;
}

/** Notification meta form: today → "9:41", else "{day} {t}" (trimmed). */
export function formatDayTime(
  iso: string,
  now: Date = new Date(),
  timeZone?: string,
): string {
  const bucket = formatDayBucket(iso, now, timeZone);
  const clock = formatClock(iso, timeZone);
  if (bucket === "Today") return clock;
  return `${bucket} ${clock}`.trim();
}

/** Timeline form: today → "9:41", else "{day} · {t}". */
export function formatDayDotTime(
  iso: string,
  now: Date = new Date(),
  timeZone?: string,
): string {
  const bucket = formatDayBucket(iso, now, timeZone);
  const clock = formatClock(iso, timeZone);
  if (bucket === "Today") return clock;
  return `${bucket} · ${clock}`;
}

/** Relative form for home cards / store strip ("updated 2m ago"). */
export function formatRelative(
  iso: string,
  now: Date = new Date(),
  timeZone?: string,
): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const dayDiff = calendarDayDiff(now, d, timeZone);
  if (hours < 24 && dayDiff === 0) return `${hours}h ago`;
  if (dayDiff === 1) return "yesterday";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDayBucket(iso, now, timeZone);
}
