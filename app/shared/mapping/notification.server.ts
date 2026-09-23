import { isTerminalStage } from "~/shared/workflow/stage-roles";
import type { ActorRender } from "./actor.server";

/**
 * Centralized mapping for per-user `notifications` rows (orchestrator
 * ruling 9). Task/project references are SOFT refs — string keys that may
 * point at other projects; the query layer joins the project name when the
 * project exists locally.
 */

/**
 * The notification kinds — the SINGLE source (P11-54). The `notifications.kind`
 * CHECK in db/migrations/0001_baseline.sql must list exactly these; a test
 * (notification.server.test.ts) pins the two together so adding a kind here
 * without the migration (or vice-versa) fails CI instead of at INSERT time.
 */
export const NOTIFICATION_KINDS = [
  "packet",
  "approval",
  "mention",
  "quality",
  "policy",
  // Ruling 99: chained-goal progress addressed to the goal's creator. A
  // conversation reply is never a row: it reaches its open surfaces through
  // the owner-routed `controller.updated` revalidation.
  "controller",
  // Ruling 131 (pass 34): the work a task waited on reached Done and the task
  // was released, or a dependency can never complete (its task was archived).
  "dependency",
  // Ruling 140 (pass 34): the reader's owner seat on a task changed hands — a
  // hand-off to them, a creation that named them, a takeover of their seat, or
  // an admin release. Under ruling 127 the seat is the credential principal
  // and the acceptance authority, so it is never a silent write.
  "ownership",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** A type alias, not an interface, so a `SELECT`-row assertion is checked
 *  against SQLite's own output types instead of being laundered through
 *  `unknown` first (only a type alias gets the implicit index signature). */
export type NotificationRow = {
  id: string;
  user_id: string;
  kind: NotificationKind;
  ptype: "input" | "blocked" | null;
  title: string | null;
  text: string;
  actor_json: string | null;
  project_slug: string | null;
  task_key: string | null;
  occurred_at: string;
  read_at: string | null;
  created_at: string;
  /** Joined from projects when resolvable (soft ref otherwise). */
  project_name?: string | null;
  /** Joined from projects — stage list JSON for the terminal-stage check. */
  project_stages_json?: string | null;
  /** Joined from task_projections (F7-NOTIF1 live state) — all null when the
   * task row doesn't resolve locally. */
  task_stage?: string | null;
  /** 1 when the task has an open packet, else 0/null (SQL boolean). */
  task_has_packet?: number | null;
  task_recommendation_count?: number | null;
};

export interface NotificationRecord {
  id: string;
  userId: string;
  kind: NotificationKind;
  /** Packet kind only: input | blocked. */
  ptype: "input" | "blocked" | null;
  /** Packet + approval kinds only. */
  title: string | null;
  text: string;
  from: ActorRender | null;
  projectSlug: string | null;
  /** Display name — joined when the project exists, else the slug. */
  projectName: string | null;
  taskKey: string | null;
  occurredAt: string;
  unread: boolean;
  readAt: string | null;
  /** F7-NOTIF1: this packet/approval notification's decision is STILL pending
   * on the live task record — the only state that belongs in "Waiting on you".
   * Always false for non-decision kinds; recomputed at read time (a resolved
   * packet / applied recommendation / Done task drops out with no row write). */
  waitingOnYou: boolean;
}

/**
 * Live "waiting on you" reconciliation (F7-NOTIF1): a decision notification
 * waits only while the projected task still carries that KIND of pending
 * decision (packet → open packet; approval → any pending recommendation) AND
 * the task is not in its terminal stage. A task that doesn't resolve locally
 * (deleted, or a foreign soft ref) has no live decision to wait on.
 */
/** The one field the terminal-stage check reads out of a stored stage list. */
interface StageIdOnly {
  id: string;
}

function liveWaitingOnYou(row: NotificationRow): boolean {
  if (row.kind !== "packet" && row.kind !== "approval") return false;
  if (row.task_stage == null) return false; // no local task row → nothing pending
  // SAFETY: `projects.stages_json` has ONE writer — the projection rebuilder
  // stores the project file's parsed `stages` list — and `isTerminalStage` only
  // reads each entry's `id`, so this names the one field it consumes.
  const stages = row.project_stages_json
    ? (JSON.parse(row.project_stages_json) as StageIdOnly[])
    : [];
  if (isTerminalStage(row.task_stage, stages)) return false; // Done → resolved
  return row.kind === "packet"
    ? row.task_has_packet === 1
    : (row.task_recommendation_count ?? 0) > 0;
}

export function mapNotificationRow(row: NotificationRow): NotificationRecord {
  // SAFETY: `notifications.actor_json` has ONE writer — `createNotification`
  // stores `JSON.stringify(input.from)`, and `CreateNotificationInput.from` is
  // an `ActorRender` by construction.
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    ptype: row.ptype,
    title: row.title,
    text: row.text,
    from: row.actor_json ? (JSON.parse(row.actor_json) as ActorRender) : null,
    projectSlug: row.project_slug,
    projectName: row.project_name ?? row.project_slug,
    taskKey: row.task_key,
    occurredAt: row.occurred_at,
    unread: row.read_at === null,
    readAt: row.read_at,
    waitingOnYou: liveWaitingOnYou(row),
  };
}
