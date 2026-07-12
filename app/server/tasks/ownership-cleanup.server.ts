import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { UserRole } from "~/shared/mapping/user.server";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import {
  projectDir,
  taskFilePath,
} from "~/server/files/file-store-root.server";
import {
  readTaskFile,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";

export interface OwnershipCleanupActor extends AuditActor {
  userId: string;
  orgRole?: UserRole;
}

/**
 * Release every canonical task owner binding held by a user who is leaving the
 * project or losing the contributor capability. Packets stay open: authority
 * returns to project supervisors or a future owner instead of erasing the
 * pending decision. The operation is idempotent and scans the file-native
 * store, not the potentially stale SQLite projection.
 */
export async function releaseProjectOwnerships(
  db: Database.Database,
  input: {
    projectSlug: string;
    targetUserId: string;
    targetName: string;
    reason: "member_removed" | "role_demoted" | "org_user_removed";
  },
  actor: OwnershipCleanupActor,
  ctx: { dataRoot?: string } = {},
): Promise<string[]> {
  const tasksRoot = path.join(
    projectDir(input.projectSlug, ctx.dataRoot),
    "tasks",
  );
  if (!existsSync(tasksRoot)) return [];

  const actorName =
    (
      db.prepare(`SELECT name FROM users WHERE id = ?`).get(actor.userId) as
        | { name: string }
        | undefined
    )?.name ?? actor.label;
  const released: string[] = [];
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskKey = entry.name;
    const ref = {
      projectSlug: input.projectSlug,
      taskKey,
      ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
    };
    const file = readTaskFile(ref);
    if (file?.parsed.frontmatter.ownerUserId !== input.targetUserId) continue;

    await updateTaskFile(ref, (parsed) => {
      if (parsed.frontmatter.ownerUserId !== input.targetUserId) return;
      parsed.frontmatter.ownerUserId = null;
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "assign",
        actor: {
          kind: "human",
          userId: actor.userId,
          nameHint: actorName,
        },
        title: null,
        text: `Released **${input.targetName}** from task ownership because their project access changed — the acceptance seat is unassigned.`,
        toAgent: false,
        evidence: null,
      });
    });
    rebuildPath(
      db,
      taskFilePath(input.projectSlug, taskKey, ctx.dataRoot),
      ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {},
    );
    recordAudit(db, {
      action: "task.ownership.admin_released",
      actor,
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug: input.projectSlug,
      taskKey,
      details: {
        previousOwnerUserId: input.targetUserId,
        forced: true,
        reason: input.reason,
      },
    });
    released.push(taskKey);
  }
  return released;
}
