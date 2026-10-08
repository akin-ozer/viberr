import { TIMELINE_EVENT_TYPES } from "~/schemas/task-file.schema";
import { formatClock, formatDayBucket } from "~/shared/dates/format";
import type { IconName } from "~/ui/icon";

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

/**
 * Stream event type → icon (mock ACT_ICON; an unknown string still → dot).
 *
 * P14-UI-62: pass 13 added the neutral `note` type and moved every benign
 * governance event onto it (a goal edit, a divergence note, a scheduled re-run)
 * so they stop rendering as "Policy violation" — and this map never learned the
 * word. `note` took the unknown-type `dot` fallback and emitted an `act-note`
 * tint class that `app.css` did not define, so the de-alarmed events rendered
 * typeless and untinted in the one cross-task feed members triage. Keying the
 * map on TIMELINE_EVENT_TYPES makes the next added type a COMPILE error here
 * instead of a silent dot.
 */
const ACT_ICON = {
  comment: "message",
  completion: "check",
  github: "github",
  policy: "shield",
  note: "message",
  quality: "flag",
  continuity: "refresh",
  proposal: "edit",
  kb_correction: "edit",
  transition: "arrow",
  blocked: "alert",
  agent: "agents",
  assign: "user",
} as const satisfies Record<(typeof TIMELINE_EVENT_TYPES)[number], IconName>;

/** Whether a projected stream type is one of the contract's own. */
function isStreamEventType(
  type: string,
): type is (typeof TIMELINE_EVENT_TYPES)[number] {
  return TIMELINE_EVENT_TYPES.some((known) => known === type);
}

/** The row icon for a stream type. The projection keeps unknown strings as-is
 *  (tolerant-parsing contract), so a type outside the vocabulary still falls
 *  back to the neutral dot rather than throwing. */
export function actIcon(type: string): IconName {
  return isStreamEventType(type) ? ACT_ICON[type] : "dot";
}

/* ------------------------------------------ R19-7: audit-column compaction */

/**
 * R19-7 — consecutive runtime-session-open rows compact into one expandable
 * row.
 *
 * Live on a 1440px viewport, 8 of the 9 rows this column had room for read
 * "operator opened the <role> runtime session — recorded per audit policy on
 * VC-4". One piece of routine agent bookkeeping, repeated, pushed the events
 * the column exists for — a credential assigned, scopes re-checked, a role
 * changed, the project created — below the fold. That is the "calm over
 * chatter / human attention is scarce" principles inverted: the noisiest event
 * won the most space.
 *
 * The event stays RECORDED (audit policy requires it) and stays REACHABLE (one
 * click, with its real per-row timestamp). It just stops being repeated at the
 * reader.
 *
 * Shape borrowed from the timeline's anti-noise compaction
 * (`app/server/tasks/timeline-compaction.server.ts`): a pure function over a
 * newest-first list that walks it once, collects each RUN of consecutive
 * routine events, and replaces a run with a single marker carrying the count —
 * including its "a run too short to be worth a marker stays verbatim" rule.
 * The one deliberate difference is what a marker holds: the server's rewrites
 * canonical `task.md` and keeps only a count, so the events are gone; this one
 * keeps its entries and hands them back on expand, because nothing here is
 * being deleted — only folded.
 */

/**
 * A `runtime.run.started` row, recognised by the sentence its projection
 * writes: `${actor} opened the ${role} runtime session. Recorded per audit
 * policy on` (`app/server/projections/activity-feed.server.ts`, the
 * `runtime.run.started` case). `AuditLogEntryView` carries no action name —
 * only the display kind and the rendered text — and threading one through
 * would mean editing the projection, its row type and the loader for a purely
 * visual fold. The route test (activity-route.server.test.ts) pins this pattern
 * to the sentence the projection actually renders, so rewording that sentence
 * fails the test rather than silently un-compacting the column.
 *
 * The pattern matches the projection's WHOLE trailing sentence, anchored at the
 * end, and that anchoring is load-bearing rather than tidiness. `entry.text`
 * OPENS with the actor's display name, which any member sets for themselves on
 * the profile page — a member named `Mallory (opened the dev runtime session)`
 * satisfied the earlier unanchored `\bopened the .+ runtime session\b` on every
 * row they authored, which included their own `task.acceptance.forced` and
 * `project.org_admin.override` rows: the two overrides this column exists to
 * make visible would fold behind a "2 runtime sessions opened" summary. Nothing
 * was deleted — expand still gave them back — but a fold the actor picks is a
 * fold that hides the row from the reader who never expands it.
 *
 * A display name cannot reach the end of the string: every audit template puts
 * fixed words after `${actor}`, and no other one ends in `runtime session.
 * Recorded per audit policy on` (`runtime.run.interrupted` ends `agent run.
 * …`, `github.reconcile.project` `GitHub. …`, `task.ownership.admin_released`
 * `task owner. …`, `task.acceptance.forced` and the overrides elsewhere
 * entirely). The trailing ` on` is the task-chip dangler, which every run row
 * keeps: `startRun` always audits with a `taskKey`, so `finishText` never
 * rewrites it to `.`.
 */
const RUNTIME_SESSION_OPENED =
  /\bopened the .+ runtime session\. Recorded per audit policy on$/;

export function isRuntimeSessionOpen(entry: AuditLogEntryView): boolean {
  return entry.kind === "audit" && RUNTIME_SESSION_OPENED.test(entry.text);
}

/** A run shorter than this renders verbatim: one row replaced by one summary
 *  row is no saving — the timeline compaction's own `folded.length <= 1` rule,
 *  and it keeps the FIRST session of a quiet project fully legible. */
const AUDIT_COMPACT_MIN = 2;

export type AuditFeedRow =
  | { compacted: false; entry: AuditLogEntryView }
  | { compacted: true; key: string; entries: AuditLogEntryView[] };

/**
 * The audit column's render list: every entry in order, with each run of
 * consecutive runtime-session opens replaced by one compacted row holding that
 * run. Never reorders, never drops an entry, and never folds anything else —
 * a credential assignment sitting between two sessions splits the run, exactly
 * as it splits the reader's attention.
 */
export function compactAuditEntries(
  entries: AuditLogEntryView[],
): AuditFeedRow[] {
  const rows: AuditFeedRow[] = [];
  let run: AuditLogEntryView[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (run.length < AUDIT_COMPACT_MIN) {
      for (const entry of run) rows.push({ compacted: false, entry });
    } else {
      rows.push({ compacted: true, key: `sessions:${run[0]!.id}`, entries: run });
    }
    run = [];
  };
  for (const entry of entries) {
    if (isRuntimeSessionOpen(entry)) {
      run.push(entry);
      continue;
    }
    flush();
    rows.push({ compacted: false, entry });
  }
  flush();
  return rows;
}
