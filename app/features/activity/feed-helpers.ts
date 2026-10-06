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
  /** Ruling 681: where the knowledge-base document this row wrote opens, set
   *  only for a viewer who may open it (an org admin). */
  docHref?: string;
}

export type ActorFilter = "all" | "human" | "agent" | "system";

export function matchesActorFilter(
  row: ActivityStreamRowView,
  filter: ActorFilter,
): boolean {
  return filter === "all" || (row.actor !== null && row.actor.kind === filter);
}

/** Audit panel time form (mock freeform strings, generated from real
 * timestamps): "today 9:38" / "yesterday 16:04" / "Mar 30". */
export function auditTimeLabel(iso: string, now: Date = new Date()): string {
  const bucket = formatDayBucket(iso, now);
  if (bucket === "Today") return "today " + formatClock(iso);
  if (bucket === "Yesterday") return "yesterday " + formatClock(iso);
  return bucket;
}
