import {
  formatClock,
  formatDayBucket,
  formatDayBucketUTC,
} from "~/shared/dates/format";

export interface ActivityStreamRowView {
  id: number;
  taskKey: string;
  type: string;
  actor: { kind: string; name: string } | null;
  occurredAt: string;
  text: string;
}

export interface AuditLogEntryView {
  id: string;
  kind: "violation" | "blockedact" | "change" | "audit";
  text: string;
  taskKey: string | null;
  occurredAt: string;
  status: "open" | "resolved" | null;
  /** Violations only — resolve context surfaced on the pill (Phase 10). */
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export type ActorFilter = "all" | "human" | "agent" | "system";

export function matchesActorFilter(
  row: ActivityStreamRowView,
  filter: ActorFilter,
): boolean {
  return filter === "all" || (row.actor !== null && row.actor.kind === filter);
}

function groupByDay(
  rows: ActivityStreamRowView[],
  dayOf: (iso: string) => string,
): { day: string; rows: ActivityStreamRowView[] }[] {
  const groups: { day: string; rows: ActivityStreamRowView[] }[] = [];
  for (const row of rows) {
    const day = dayOf(row.occurredAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }
  return groups;
}

/** Day-bucket grouping: rows arrive occurred_at DESC, buckets keep that
 * order (Today first, then Yesterday, then dated days). */
export function groupStreamByDay(
  rows: ActivityStreamRowView[],
  now: Date = new Date(),
): { day: string; rows: ActivityStreamRowView[] }[] {
  return groupByDay(rows, (iso) => formatDayBucket(iso, now));
}

/**
 * The grouping's hydration first pass: absolute UTC days ("Aug 3"), never the
 * now-relative buckets. The server renders in ITS zone (a UTC container in
 * production) while the viewer hydrates in theirs, so local-day bucketing
 * disagrees on the header text AND on which rows share a group — a React #418
 * that regenerates the whole page. ActivityPage regroups with the local
 * bucketer after hydration (the app/ui/local-time.tsx pattern).
 */
export function groupStreamByDayUTC(
  rows: ActivityStreamRowView[],
): { day: string; rows: ActivityStreamRowView[] }[] {
  return groupByDay(rows, formatDayBucketUTC);
}

/** Audit panel time form (mock freeform strings, generated from real
 * timestamps): "today 9:38" / "yesterday 16:04" / "Mar 30". */
export function auditTimeLabel(iso: string, now: Date = new Date()): string {
  const bucket = formatDayBucket(iso, now);
  if (bucket === "Today") return "today " + formatClock(iso);
  if (bucket === "Yesterday") return "yesterday " + formatClock(iso);
  return bucket;
}
