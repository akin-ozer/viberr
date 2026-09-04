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
 *
 * The `*UTC` siblings are the hydration FIRST PASS (app/ui/local-time.tsx):
 * they depend on the timestamp alone — no `now`, no host zone — so a server
 * render and a client hydration agree byte-for-byte whatever the two clocks
 * and zones are; an effect then swaps in the local form above. That is why
 * they take no `now` parameter at all: a "Today" that samples the clock is a
 * mismatch waiting for a request that straddles UTC midnight (pass 34, C6).
 */

const shortDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
/**
 * Host-zone BY CONSTRUCTION (no `timeZone`): on the client the host is the
 * viewer, and the viewer's own calendar day is the point of a calendar date.
 * Do not pin this to UTC to make it hydrate — that would silently re-word every
 * rendered date instead; surfaces render it through `LocalCalendarDate`
 * (app/ui/local-time.tsx), whose first pass is the UTC day key.
 */
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

/**
 * The absolute calendar day as `YYYY-MM-DD`, for GROUPING — never displayed.
 *
 * `formatDayBucket`'s label carries no year, so two rows a year apart both read
 * "Mar 30". Grouping on that label merges them into one section and interleaves
 * them, and the rows' own stamps are time-only, so nothing tells the reader
 * they are a year apart. Group on this; show the bucket.
 */
export function localDayKey(iso: string): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** {@link localDayKey} in UTC — the basis the hydration first pass groups on,
 *  matching `formatDayBucketUTC`. */
export function utcDayKey(iso: string): string {
  const d = toDate(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
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
 * `formatDayDotTime`'s hydration first pass: the absolute UTC day and the UTC
 * clock for EVERY timestamp ("Jul 3 · 23:59") — deliberately never the bare
 * "09:41" of today or "Yesterday · …", which depend on when "now" is sampled.
 * This used to take a `now` and branch on it, while documenting itself as
 * "the deterministic first pass": a server at 23:59:59Z and a viewer at
 * 00:00:01Z then disagreed on every timestamp at once (pass 34, C6). There is
 * no `now` parameter on purpose, so no caller can reintroduce the dependency;
 * the effect in `LocalDayDotTime` swaps in the viewer-local form.
 */
export function formatDayDotTimeUTC(iso: string): string {
  const day = formatDayBucketUTC(iso);
  if (!day) return "";
  return `${day} · ${formatClockUTC(iso)}`;
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
