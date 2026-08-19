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
  actor_kind: "human" | "agent" | "operator" | "system";
  actor_ref: string;
  actor_json: string;
  title: string | null;
  text: string;
  to_agent: 0 | 1;
  evidence_json: string | null;
};

/** The evidence rows a completion/verdict event carries, as stored. */
export interface EvidenceRowRender {
  label: string;
  add: string;
  del: string;
}

export interface TimelineEventRender {
  id: number;
  /** One of the 9 contract types, or an unknown string (renderer falls
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
  /** Outcome events (completion / verdict / an agent's report — P13-D-26);
   *  add/del are short signed display strings ("+14", "−4") and may be empty. */
  evidence: EvidenceRowRender[] | null;
}

export function mapTaskEventRow(row: TaskEventRow): TimelineEventRender {
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
  };
}
