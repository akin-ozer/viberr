/**
 * THE shared timestamp formatter (orchestrator ruling 4).
 *
 * Boundaries carry UTC ISO strings; display reproduces the mock's exact
 * forms in the viewer's local timezone (the seed back-dates events to local
 * wall-clock times so rendering matches the mock):
 *
 *   - clock:     "09:41", "16:04"           (24h, both fields zero-padded)
 *   - dayBucket: "Today" | "Yesterday" | "Mar 30"
 *   - dayTime:   today → "09:41", else "Yesterday 16:04" / "Mar 30 14:00"
 *                (the bell-popover / notification meta form)
 *   - dayDotTime:today → "09:41", else "{day} · {t}" (timeline/run form)
 *   - relative:  "just now" | "2m ago" | "3h ago" | "yesterday" | "3d ago"
 *                | "Mar 30" (home cards / store strip)
 *
 * Pure, client-safe (no .server suffix); pass `now` in tests.
 */

const shortDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const calendarDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

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

/**
 * "09:41" / "16:04" — a 24h clock, both fields zero-padded.
 *
 * F19: the hour used to be printed as-is because the design mock's sample
 * times were all mid-morning, so the 0 hour never appeared in it. In the
 * running app it does, and an audit row stamped `today 0:18` reads as a
 * fragment, not a time — a 24h clock is padded in every convention that has
 * one. The mock's own "9:41" becomes "09:41"; nothing else about the forms
 * built on top of this changes.
 */
export function formatClock(iso: string): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  return clock(d.getHours(), d.getMinutes());
}

/** The one place hour:minute is assembled — local and UTC share it so the two
 *  passes of a hydration swap can never drift apart on padding. */
function clock(hours: number, minutes: number): string {
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** "Today" | "Yesterday" | "Mar 30" (local days). */
export function formatDayBucket(iso: string, now: Date = new Date()): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (sameLocalDay(d, now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameLocalDay(d, yesterday)) return "Yesterday";
  return shortDay.format(d);
}

/** "Jul 3, 2027"; null for missing or invalid values. */
export function formatCalendarDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = toDate(iso);
  return Number.isNaN(d.getTime()) ? null : calendarDate.format(d);
}

/** Notification meta form: today → "09:41", else "{day} {t}" (trimmed). */
export function formatDayTime(iso: string, now: Date = new Date()): string {
  const bucket = formatDayBucket(iso, now);
  const clock = formatClock(iso);
  if (bucket === "Today") return clock;
  return `${bucket} ${clock}`.trim();
}

/** Timeline form: today → "09:41", else "{day} · {t}". */
export function formatDayDotTime(iso: string, now: Date = new Date()): string {
  const bucket = formatDayBucket(iso, now);
  const clock = formatClock(iso);
  if (bucket === "Today") return clock;
  return `${bucket} · ${clock}`;
}

const shortDayUtc = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function sameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * `formatDayBucket`'s hydration first pass: the absolute UTC calendar day
 * ("Mar 30") for EVERY row — deliberately never Today/Yesterday. Those depend
 * on when "now" is sampled, and the activity page uses this value as its
 * GROUPING key, where an SSR/hydration render straddling UTC midnight would
 * mismatch every header at once. Absolute days depend only on the timestamp.
 */
export function formatDayBucketUTC(iso: string): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  return shortDayUtc.format(d);
}

/**
 * `formatDayDotTime` rendered in UTC regardless of the host timezone — the
 * deterministic first pass that SSR and hydration agree on byte-for-byte;
 * an effect then swaps in the viewer-local form (app/ui/local-time.tsx).
 */
export function formatDayDotTimeUTC(iso: string, now: Date = new Date()): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  const t = clock(d.getUTCHours(), d.getUTCMinutes());
  if (sameUtcDay(d, now)) return t;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (sameUtcDay(d, yesterday)) return `Yesterday · ${t}`;
  return `${shortDayUtc.format(d)} · ${t}`;
}

/** `formatClock` in UTC — the timezone-deterministic hydration first pass. */
export function formatClockUTC(iso: string): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  return clock(d.getUTCHours(), d.getUTCMinutes());
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
