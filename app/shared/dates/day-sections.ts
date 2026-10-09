import { formatDayBucket, formatDayBucketUTC, localDayKey, utcDayKey } from "./format";

/**
 * Newest-first rows cut into day sections, in one walk: a section opens
 * whenever the ABSOLUTE day changes. The label carries no year, so grouping on
 * it merged rows a year apart under one "Mar 30" and drew the old row inside
 * the recent block; the key is the day, the label is what the reader sees.
 * `local` false is the hydration first pass (UTC days, absolute labels), so a
 * server render and the hydration agree on every header (`useHydrated`).
 *
 * Its own module, not `format.ts`: only the notifications stream and the epic
 * history group by day, and `format.ts` rides every page's shared chunk
 * (ruling 11).
 */
export function daySections<T>(
  rows: readonly T[],
  isoOf: (row: T) => string,
  local: boolean,
  now: Date = new Date(),
): { key: string; day: string; rows: T[] }[] {
  const sections: { key: string; day: string; rows: T[] }[] = [];
  for (const row of rows) {
    const iso = isoOf(row);
    const key = local ? localDayKey(iso) : utcDayKey(iso);
    const last = sections[sections.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else sections.push({ key, day: local ? formatDayBucket(iso, now) : formatDayBucketUTC(iso), rows: [row] });
  }
  return sections;
}
