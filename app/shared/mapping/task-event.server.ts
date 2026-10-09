import type { EvidenceStatus } from "~/schemas/task-file.schema";
import { GATES_SYSTEM_ID, gateNoteView, type GateNoteView } from "~/shared/project-gates";
import { verdictNoteView, type VerdictNoteView } from "~/shared/verdict-note";
import type { ActorRender } from "./actor.server";

/**
 * Centralized mapping for `task_events` projection rows → the timeline
 * render shape (contracts §1.3). Actor identity is a denormalized snapshot
 * taken at projection time (events survive member removal).
 */

/** A type alias, not an interface, so a `SELECT`-row assertion is checked
 *  against SQLite's own output types instead of being laundered through
 *  `unknown` first (only a type alias gets the implicit index signature). */
export type TaskEventRow = {
  id: number;
  project_slug: string;
  task_key: string;
  position: number;
  occurred_at: string;
  type: string;
  actor_kind: "human" | "agent" | "operator" | "controller" | "system";
  actor_ref: string;
  actor_json: string;
  title: string | null;
  text: string;
  to_agent: 0 | 1;
  evidence_json: string | null;
  attachments_json: string | null;
};

/** The evidence rows a completion/verdict event carries, as stored: what was
 *  checked, how it came out and whether it passed (ruling 16). */
export interface EvidenceRowRender {
  label: string;
  /** Empty when the label says it all. */
  result: string;
  status: EvidenceStatus;
}

export interface TimelineEventRender {
  id: number;
  /** One of `TIMELINE_EVENT_TYPES`, or an unknown string (renderer falls
   * back to comment meta — keep tolerant). */
  type: string;
  occurredAt: string;
  actor: ActorRender;
  /** Completion events only. */
  title: string | null;
  /** RichText micro-format (**bold**, `code`, @mention). */
  text: string;
  /** Comments only — renders the `comment-card toagent` tint. */
  toAgent: boolean;
  /** Outcome events (completion / verdict / an agent's report — P13-D-26). */
  evidence: EvidenceRowRender[] | null;
  /** Files the event's run saved into the task's attachments/ dir — names
   *  only, rendered as chips linking to the serving route. */
  attachments: string[] | null;
  /** Ruling 313: a gate run's note read back into its rows (`gateNoteView`),
   *  absent on every other event. The rows carry the logs, so such an event's
   *  `evidence` is null and `attachments` keeps only a file no row links. */
  gates?: GateNoteView;
  /** Ruling 313: a reviewer's verdict read back into its result, revision and
   *  whatever its sentence adds (`verdictNoteView`), absent on every other
   *  event. */
  verdict?: VerdictNoteView;
}

export function mapTaskEventRow(row: TaskEventRow): TimelineEventRender {
  const event = mapEventRow(row);
  if (row.type === "quality") {
    const verdict = verdictNoteView(event);
    return verdict ? { ...event, verdict } : event;
  }
  // Written by the gates' system actor (ruling 17); the projection keys a
  // system actor by its bare id (`rebuilder.server.ts`).
  if (row.type !== "note" || row.actor_kind !== "system" || row.actor_ref !== GATES_SYSTEM_ID) {
    return event;
  }
  const gates = gateNoteView(event);
  if (!gates) return event;
  const linked = new Set(gates.rows.map((r) => r.log));
  const rest = event.attachments?.filter((name) => !linked.has(name)) ?? [];
  return { ...event, gates, evidence: null, attachments: rest.length > 0 ? rest : null };
}

function mapEventRow(row: TaskEventRow): TimelineEventRender {
  // SAFETY: both JSON columns have ONE writer — `rebuilder.server.ts` inserts
  // `JSON.stringify(resolveActor(event.actor))` and
  // `JSON.stringify(event.evidence)`, whose sources are an `ActorRender` and a
  // parsed evidence-row list by construction. The projection is rebuilt from
  // the task files, never hand-edited, so no other shape can reach these two
  // columns. (Same invariant `activity-feed.server.ts` reads `actor_json` on.)
  return {
    id: row.id,
    type: row.type,
    occurredAt: row.occurred_at,
    actor: JSON.parse(row.actor_json) as ActorRender,
    title: row.title,
    text: row.text,
    toAgent: row.to_agent === 1,
    evidence: row.evidence_json
      ? (JSON.parse(row.evidence_json) as EvidenceRowRender[])
      : null,
    // SAFETY: same single-writer invariant as the two columns above —
    // `rebuilder.server.ts` inserts `JSON.stringify(event.attachments)`, whose
    // source is the parsed event's `string[]` by construction.
    attachments: row.attachments_json
      ? (JSON.parse(row.attachments_json) as string[])
      : null,
  };
}
