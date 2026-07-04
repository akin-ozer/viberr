import type { ActorRender } from "./actor.server";

/**
 * Centralized mapping for per-user `notifications` rows (orchestrator
 * ruling 9). Task/project references are SOFT refs — string keys that may
 * point at other projects; the query layer joins the project name when the
 * project exists locally.
 */

export type NotificationKind =
  | "packet"
  | "approval"
  | "mention"
  | "quality"
  | "policy";

export interface NotificationRow {
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
}

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
}

export function mapNotificationRow(row: NotificationRow): NotificationRecord {
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
  };
}
