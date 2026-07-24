import type { ActorRender } from "./actor.server";

/**
 * Centralized mapping for `task_events` projection rows → the timeline
 * render shape (contracts §1.3). Actor identity is a denormalized snapshot
 * taken at projection time (events survive member removal).
 */

export interface TaskEventRow {
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
  evidence: { label: string; add: string; del: string }[] | null;
}

export function mapTaskEventRow(row: TaskEventRow): TimelineEventRender {
  return {
    id: row.id,
    type: row.type,
    occurredAt: row.occurred_at,
    actor: JSON.parse(row.actor_json) as ActorRender,
    title: row.title,
    text: row.text,
    toAgent: row.to_agent === 1,
    evidence: row.evidence_json
      ? (JSON.parse(row.evidence_json) as {
          label: string;
          add: string;
          del: string;
        }[])
      : null,
  };
}
