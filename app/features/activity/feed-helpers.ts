import { formatClock, formatDayBucket } from "~/shared/dates/format";

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

/** Day-bucket grouping: rows arrive occurred_at DESC, buckets keep that
 * order (Today first, then Yesterday, then dated days). */
export function groupStreamByDay(
  rows: ActivityStreamRowView[],
  now: Date = new Date(),
): { day: string; rows: ActivityStreamRowView[] }[] {
  const groups: { day: string; rows: ActivityStreamRowView[] }[] = [];
  for (const row of rows) {
    const day = formatDayBucket(row.occurredAt, now);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }
  return groups;
}

/** Audit panel time form (mock freeform strings, generated from real
 * timestamps): "today 9:38" / "yesterday 16:04" / "Mar 30". */
export function auditTimeLabel(iso: string, now: Date = new Date()): string {
  const bucket = formatDayBucket(iso, now);
  if (bucket === "Today") return "today " + formatClock(iso);
  if (bucket === "Yesterday") return "yesterday " + formatClock(iso);
  return bucket;
}
