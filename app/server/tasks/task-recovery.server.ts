import type Database from "better-sqlite3";
import { newId } from "~/shared/ids/new-id.server";
import type {
  PacketObservation,
  PacketOption,
  TaskPacket,
} from "~/schemas/task-file.schema";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import type { NotificationKind } from "~/shared/mapping/notification.server";

const SYSTEM_RECOVERY_ACTOR = {
  userId: null,
  label: "system:runtime-recovery",
} as const;

let afterCanonicalWriteHookForTests: (() => void | Promise<void>) | null = null;

/** Crash seam used to prove a recovery occurrence converges its projection,
 * audit fact, and notification fan-out after the canonical file write. */
export function configureSystemRecoveryAfterCanonicalWriteHookForTests(
  hook: (() => void | Promise<void>) | null,
): void {
  afterCanonicalWriteHookForTests = hook;
}

export interface SystemRecoveryInput {
  projectSlug: string;
  taskKey: string;
  /** Stable machine-readable dedupe key, e.g. checkout_failed. */
  code: string;
  /** One concrete occurrence (normally the run/attempt id). Replaying the same
   * callback is idempotent; a later retry with the same code is a new incident. */
  occurrenceId?: string;
  title: string;
  body: string;
  observations?: PacketObservation[];
  options?: PacketOption[];
  notificationKind?: NotificationKind;
  notificationText?: string;
}

export interface SystemRecoveryResult {
  recorded: boolean;
  packetCreated: boolean;
  notifiedUserIds: string[];
}

function ref(
  input: SystemRecoveryInput,
  dataRoot?: string,
  expectedTaskIncarnation?: string,
) {
  return {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    ...(dataRoot !== undefined ? { dataRoot } : {}),
    ...(expectedTaskIncarnation !== undefined
      ? { expectedTaskIncarnation }
      : {}),
  };
}

function defaultOptions(): PacketOption[] {
  return [
    {
      kind: "redirect",
      t: "Retry after fixing the runtime dependency",
      d: "Correct the credential, repository access, backend, or runtime tool and start the specialist again.",
      rec: true,
    },
    {
      kind: "request_edit",
      t: "Redirect the task",
      d: "Change the repository or specialist plan before another attempt.",
      rec: false,
    },
    {
      kind: "hold_runtime_debug",
      t: "Hold for runtime debugging",
      d: "Keep the task blocked while an administrator inspects the runtime.",
      rec: false,
    },
  ];
}

/**
 * System-owned, fail-safe recovery path. It intentionally has no operator
 * authority/capability argument: infrastructure and provider failures must
 * remain durable even when `generate-packets` is denied. Existing human
 * packets are never overwritten; the blocked fact is still appended and
 * notified exactly once per recovery occurrence.
 */
export async function openSystemRecovery(
  db: Database.Database,
  input: SystemRecoveryInput,
  ctx: { dataRoot?: string; expectedTaskIncarnation?: string } = {},
): Promise<SystemRecoveryResult> {
  const taskRef = ref(
    input,
    ctx.dataRoot,
    ctx.expectedTaskIncarnation,
  );
  const existing = readTaskFile(taskRef);
  if (!existing) {
    return { recorded: false, packetCreated: false, notifiedUserIds: [] };
  }
  const codeSlug = input.code
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const occurrenceSlug = (input.occurrenceId ?? newId("incident"))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const systemId = `runtime-recovery-${codeSlug || "unknown"}-${occurrenceSlug || "occurrence"}`;
  const alreadyRecorded = existing.parsed.timeline.some(
    (event) =>
      event.type === "blocked" &&
      event.actor.kind === "system" &&
      event.actor.systemId === systemId,
  );
  const packet: TaskPacket = {
    type: "blocked",
    kind: "Runtime recovery",
    from: "system:runtime-recovery",
    title: input.title.trim(),
    body: input.body.trim(),
    observations: input.observations ?? [],
    options: input.options?.length ? input.options : defaultOptions(),
  };

  const outcome = {
    recorded: false,
    packetCreated: false,
    canonicalRecorded: alreadyRecorded,
  };
  if (!alreadyRecorded) {
    await updateTaskFile(taskRef, (parsed) => {
      const recordedInsideLock = parsed.timeline.some(
        (event) =>
          event.type === "blocked" &&
          event.actor.kind === "system" &&
          event.actor.systemId === systemId,
      );
      if (recordedInsideLock) {
        outcome.canonicalRecorded = true;
        return;
      }
      outcome.recorded = true;
      outcome.canonicalRecorded = true;
      outcome.packetCreated = parsed.packet === null;
      if (!parsed.packet) parsed.packet = packet;
      parsed.frontmatter.waiting = "human";
      parsed.frontmatter.readiness = "blocked";
      parsed.frontmatter.validation = "failing";
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "blocked",
        actor: { kind: "system", systemId },
        title: input.title.trim(),
        text: `**Runtime recovery required:** ${input.body.trim()}`,
        toAgent: false,
        evidence: null,
      });
    });
  }
  if (!outcome.canonicalRecorded) {
    return { recorded: false, packetCreated: false, notifiedUserIds: [] };
  }
  if (outcome.recorded) {
    await afterCanonicalWriteHookForTests?.();
  }
  rebuildPath(db, resolveTaskFilePath(taskRef), {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  const existingAudit = db
    .prepare(
      `SELECT details_json
         FROM audit_events
        WHERE action = 'task.recovery.opened'
          AND project_slug = ?
          AND task_key = ?
          AND json_extract(details_json, '$.code') = ?
          AND json_extract(details_json, '$.occurrenceId') = ?
        LIMIT 1`,
    )
    .get(
      input.projectSlug,
      input.taskKey,
      input.code,
      occurrenceSlug,
    ) as { details_json: string | null } | undefined;
  if (!existingAudit) {
    recordAudit(db, {
      action: "task.recovery.opened",
      actor: SYSTEM_RECOVERY_ACTOR,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: {
        code: input.code,
        occurrenceId: occurrenceSlug,
        systemId,
        // A replay after a crash knows the canonical incident exists but
        // cannot reconstruct whether this occurrence originally filled an
        // empty packet slot; keep that audit detail honest instead of
        // fabricating `false`.
        packetCreated: outcome.recorded ? outcome.packetCreated : null,
      },
    });
  }

  const { notifyTaskWatchers } = await import("./task-actions.server");
  const notifiedUserIds = notifyTaskWatchers(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      kind: input.notificationKind ?? "packet",
      ptype: "blocked",
      title: `Blocked — ${input.title.trim()}`,
      text: input.notificationText?.trim() || input.body.trim(),
      from: { kind: "system", name: "Runtime recovery" },
      dedupeKey: `recovery:${input.projectSlug}:${input.taskKey}:${systemId}`,
    },
    ctx,
  );
  return {
    recorded: outcome.recorded,
    packetCreated: outcome.packetCreated,
    notifiedUserIds: outcome.recorded ? notifiedUserIds : [],
  };
}
