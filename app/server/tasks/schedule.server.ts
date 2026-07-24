import type { DatabaseSync } from "node:sqlite";
import {
  recordAudit,
  SYSTEM_ACTOR,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { logger } from "~/server/logging/logger.server";
import { newId } from "~/shared/ids/new-id.server";
import { AppError } from "~/server/errors/app-error.server";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
  type TaskFileRef,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { getProject } from "~/server/projections/board-query.server";
import type { TaskMutationContext } from "./task-actions.server";
import type { TaskFileEvent, TaskSchedule } from "~/schemas/task-file.schema";

/**
 * Governed SCHEDULED task actions (O-3). A maintainer schedules a future
 * operator re-run on a not-yet-Done task ("re-check this in 24h"); a server-side
 * runner fires due entries by calling the existing `runOperator` — which is
 * backend-agnostic, so this works identically for Claude and Codex with NO
 * per-backend agent tool (the parity-correct form, vs the Claude-only Cron
 * tool). The schedule lives in the task FILE (canonical, survives rebuild); the
 * `schedules_json` projection column lets the runner find due entries without
 * reading every file.
 *
 * Idempotency / crash-safety: a fired entry is flipped `pending → fired` in the
 * file BEFORE `runOperator` is invoked, so a crash mid-run can't re-fire it, and
 * a fired entry stays fired across restarts (the file is canonical).
 */

const SCHEDULE_TICK_MS = 60_000;

function taskFileRef(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): TaskFileRef {
  return {
    projectSlug,
    taskKey,
    dataRoot: ctx.dataRoot,
  };
}

function reproject(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): void {
  rebuildPath(db, resolveTaskFilePath(taskFileRef(ctx, projectSlug, taskKey)), {
    dataRoot: ctx.dataRoot,
  });
}

function scheduleEvent(
  actor: TaskFileEvent["actor"],
  text: string,
): TaskFileEvent {
  return {
    occurredAt: new Date().toISOString(),
    // Scheduling notes are neutral lifecycle events (P13-LV-03).
    type: "note",
    actor,
    title: null,
    text,
    toAgent: false,
    evidence: null,
  };
}

/** The project's final (terminal/Done) stage id, or null. */
function terminalStageId(db: DatabaseSync, projectSlug: string): string | null {
  const stages = getProject(db, projectSlug)?.stages ?? [];
  return stages[stages.length - 1]?.id ?? null;
}

// ------------------------------------------------------------------ create

export interface ScheduleInput {
  projectSlug: string;
  taskKey: string;
  /** ISO timestamp the action becomes due (must be in the future). */
  dueAt: string;
  backend: "claude" | "codex";
  autonomy: "supervised" | "full";
  note?: string;
}

/**
 * Schedule an operator re-run on a task. RBAC is enforced by the caller
 * (`run-agents`, maintainer+ — scheduling triggers agent work). Rejects a
 * past `dueAt` and a task that is already in its terminal stage.
 */
export async function scheduleTaskAction(
  db: DatabaseSync,
  input: ScheduleInput,
  actor: AuditActor,
  ctx: TaskMutationContext = {},
): Promise<TaskSchedule> {
  const dueMs = Date.parse(input.dueAt);
  if (!Number.isFinite(dueMs)) throw AppError.validation("Invalid schedule time.");
  if (dueMs <= Date.now()) throw AppError.validation("Schedule a time in the future.");

  const ref = taskFileRef(ctx, input.projectSlug, input.taskKey);
  const existing = readTaskFile(ref);
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const terminal = terminalStageId(db, input.projectSlug);
  if (terminal && existing.parsed.frontmatter.stage === terminal) {
    throw AppError.validation("That task is already Done — nothing to schedule.");
  }

  const schedule: TaskSchedule = {
    id: newId("sch"),
    action: "run-operator",
    dueAt: new Date(dueMs).toISOString(),
    backend: input.backend,
    autonomy: input.autonomy,
    note: input.note?.trim() ? input.note.trim() : "",
    createdBy: actor.userId ?? "system",
    createdByLabel: actor.label,
    createdAt: new Date().toISOString(),
    status: "pending",
    firedAt: null,
    claimedAt: null,
    retries: 0,
  };

  await updateTaskFile(ref, (parsed) => {
    parsed.frontmatter.schedules.push(schedule);
    parsed.timeline.unshift(
      scheduleEvent(
        { kind: "human", userId: actor.userId ?? "system", nameHint: actor.label },
        `**Scheduled:** an operator re-run for **${input.taskKey}** at ${schedule.dueAt} (${input.autonomy} · ${input.backend === "claude" ? "Claude Code" : "Codex"})${schedule.note ? ` — ${schedule.note}` : ""}.`,
      ),
    );
  });
  reproject(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.schedule.created",
    actor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { scheduleId: schedule.id, dueAt: schedule.dueAt, backend: schedule.backend, autonomy: schedule.autonomy },
  });
  return schedule;
}

// ------------------------------------------------------------------ cancel

export async function cancelScheduledAction(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string; scheduleId: string },
  actor: AuditActor,
  ctx: TaskMutationContext = {},
): Promise<{ cancelled: boolean }> {
  let cancelled = false;
  await updateTaskFile(taskFileRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    const target = parsed.frontmatter.schedules.find((s) => s.id === input.scheduleId);
    if (!target || target.status !== "pending") return; // gone or already resolved
    target.status = "cancelled";
    // P11-75: a cancelled schedule was never fired — leave firedAt null rather
    // than stamping cancel time into a field that means "when the run fired".
    cancelled = true;
    parsed.timeline.unshift(
      scheduleEvent(
        { kind: "human", userId: actor.userId ?? "system", nameHint: actor.label },
        `**Schedule cancelled:** the pending operator re-run for ${input.taskKey} was cancelled.`,
      ),
    );
  });
  if (!cancelled) return { cancelled: false };
  reproject(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.schedule.cancelled",
    actor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { scheduleId: input.scheduleId },
  });
  return { cancelled: true };
}

// ------------------------------------------------------------------ runner

interface DueRow {
  project_slug: string;
  task_key: string;
  stage: string;
  schedules_json: string;
}

/** F10-16: a claim older than this is treated as crashed and re-driven. Longer
 *  than any real operator run start; shorter than "lost forever". */
const CLAIM_LEASE_MS = 5 * 60_000;
/** F10-16: bounded retry — after this many failed enqueue/run attempts the
 *  occurrence becomes terminal `failed` (visible) instead of retrying forever. */
const MAX_SCHEDULE_RETRIES = 3;

/**
 * Fire every pending schedule whose `dueAt` has passed. A schedule on a task
 * that reached its terminal stage is retired (`fired`, outcome `skipped-done`)
 * WITHOUT running the operator — the re-check is moot once Done. Fire-and-forget
 * per operator run; one failure never blocks the others.
 */
export async function fireDueSchedules(
  db: DatabaseSync,
  ctx: TaskMutationContext = {},
): Promise<{ fired: number; skipped: number }> {
  const nowMs = Date.now();
  const rows = db
    .prepare(
      `SELECT project_slug, task_key, stage, schedules_json
         FROM task_projections
        WHERE schedules_json LIKE '%"status":"pending"%'
           OR schedules_json LIKE '%"status":"claimed"%'`,
    )
    .all() as unknown as DueRow[];
  if (rows.length === 0) return { fired: 0, skipped: 0 };

  const terminalCache = new Map<string, string | null>();
  const terminalFor = (slug: string): string | null => {
    if (!terminalCache.has(slug)) terminalCache.set(slug, terminalStageId(db, slug));
    return terminalCache.get(slug) ?? null;
  };

  /** A stale claim = claimed but its lease expired (the enqueuing tick crashed
   *  before finalizing). Re-driven so the action is never lost (F10-16). */
  const isStaleClaim = (s: TaskSchedule): boolean => {
    if (s.status !== "claimed") return false;
    const claimedMs = s.claimedAt ? Date.parse(s.claimedAt) : NaN;
    return !Number.isFinite(claimedMs) || nowMs - claimedMs >= CLAIM_LEASE_MS;
  };

  let fired = 0;
  let skipped = 0;
  const toRun: {
    projectSlug: string;
    taskKey: string;
    backend: "claude" | "codex";
    autonomy: "supervised" | "full";
    scheduleId: string;
  }[] = [];

  for (const row of rows) {
    let scheds: TaskSchedule[];
    try {
      scheds = JSON.parse(row.schedules_json) as TaskSchedule[];
    } catch {
      continue;
    }
    const due = scheds.filter((s) => {
      const dueMs = Date.parse(s.dueAt);
      if (!Number.isFinite(dueMs) || dueMs > nowMs) return false;
      return s.status === "pending" || isStaleClaim(s);
    });
    if (due.length === 0) continue;
    const isDone = terminalFor(row.project_slug) !== null && row.stage === terminalFor(row.project_slug);

    for (const s of due) {
      try {
        // CLAIM the occurrence in the FILE first (crash-safe). A moot Done task
        // is retired straight to `fired`; otherwise we reserve it as `claimed`
        // and only after the detached operator enqueue COMPLETES do we finalize
        // it to `fired`. A crash between claim and finalize leaves a `claimed`
        // row that a later tick re-drives once its lease expires — the action is
        // never lost (the old pending→fired-before-enqueue flow lost it).
        let claimed = false;
        const staleClaim = isStaleClaim(s);
        await updateTaskFile(taskFileRef(ctx, row.project_slug, row.task_key), (parsed) => {
          const target = parsed.frontmatter.schedules.find((x) => x.id === s.id);
          if (!target) return;
          if (target.status !== "pending" && !isStaleClaim(target)) return;
          if (isDone) {
            target.status = "fired";
            target.firedAt = new Date().toISOString();
            parsed.timeline.unshift(
              scheduleEvent(
                { kind: "system", systemId: "schedule-runner" },
                `**Scheduled action skipped:** ${row.task_key} is already Done — the scheduled operator re-run is moot.`,
              ),
            );
          } else {
            target.status = "claimed";
            target.claimedAt = new Date().toISOString();
            parsed.timeline.unshift(
              scheduleEvent(
                { kind: "system", systemId: "schedule-runner" },
                `**Scheduled action starting:** ${staleClaim ? "recovering a stalled claim and re-" : ""}running the scheduled operator re-run for ${row.task_key}${s.note ? ` — ${s.note}` : ""}.`,
              ),
            );
          }
          claimed = true;
        });
        if (!claimed) continue; // another tick/restart already handled it
        reproject(db, ctx, row.project_slug, row.task_key);
        recordAudit(db, {
          action: "task.schedule.fired",
          actor: SYSTEM_ACTOR,
          subjectKind: "task",
          subjectId: row.task_key,
          projectSlug: row.project_slug,
          taskKey: row.task_key,
          details: { scheduleId: s.id, outcome: isDone ? "skipped-done" : "claimed" },
        });
        if (isDone) {
          skipped += 1;
        } else {
          toRun.push({
            projectSlug: row.project_slug,
            taskKey: row.task_key,
            backend: s.backend,
            autonomy: s.autonomy,
            scheduleId: s.id,
          });
          fired += 1;
        }
      } catch (error) {
        logger.warn("scheduled action claim failed", {
          taskKey: row.task_key,
          projectSlug: row.project_slug,
          err: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }

  if (toRun.length > 0) {
    void (async () => {
      const { runOperator } = await import("~/server/runtimes/operator-run.server");
      for (const t of toRun) {
        let ok = false;
        try {
          await runOperator(db, {
            projectSlug: t.projectSlug,
            taskKey: t.taskKey,
            backend: t.backend,
            autonomy: t.autonomy,
            trigger: "manual",
            dataRoot: ctx.dataRoot,
          });
          ok = true;
        } catch (error) {
          logger.warn("scheduled operator re-run failed", {
            taskKey: t.taskKey,
            err: error instanceof Error ? error : new Error(String(error)),
          });
        }
        // Finalize the claimed occurrence — never leave it stuck in `claimed`.
        // Success → fired. Failure → bounded retry (back to pending) or terminal
        // `failed` once the retry cap is hit (F10-16).
        try {
          await updateTaskFile(
            taskFileRef(ctx, t.projectSlug, t.taskKey),
            (parsed) => {
              const target = parsed.frontmatter.schedules.find(
                (x) => x.id === t.scheduleId,
              );
              if (!target || target.status !== "claimed") return;
              if (ok) {
                target.status = "fired";
                target.firedAt = new Date().toISOString();
                target.claimedAt = null;
                return;
              }
              const retries = (target.retries ?? 0) + 1;
              target.retries = retries;
              target.claimedAt = null;
              if (retries >= MAX_SCHEDULE_RETRIES) {
                target.status = "failed";
                target.firedAt = new Date().toISOString();
                parsed.timeline.unshift(
                  scheduleEvent(
                    { kind: "system", systemId: "schedule-runner" },
                    `**Scheduled action failed:** the scheduled operator re-run for ${t.taskKey} did not complete after ${retries} attempts.`,
                  ),
                );
              } else {
                target.status = "pending"; // retry on a later tick
              }
            },
          );
          reproject(db, ctx, t.projectSlug, t.taskKey);
        } catch (error) {
          logger.warn("schedule finalize failed", {
            taskKey: t.taskKey,
            err: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    })().catch(() => {});
  }

  if (fired > 0 || skipped > 0) {
    logger.info("scheduled actions fired", { fired, skipped });
  }
  return { fired, skipped };
}

// The single interval handle — module-scoped so a repeat start() is a no-op.
let runnerHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the server-side schedule runner: fire once at boot (catches schedules
 * that came due while the process was down), then on an interval. Non-
 * overlapping (a slow tick can't stack). Idempotent — a second call is a no-op.
 */
export function startScheduleRunner(db: DatabaseSync): void {
  void fireDueSchedules(db).catch(() => {});
  if (runnerHandle) return;
  let running = false;
  runnerHandle = setInterval(() => {
    if (running) return;
    running = true;
    void fireDueSchedules(db)
      .catch((error) => {
        logger.warn("schedule runner tick failed", {
          err: error instanceof Error ? error : new Error(String(error)),
        });
      })
      .finally(() => {
        running = false;
      });
  }, SCHEDULE_TICK_MS);
  // Don't keep the process alive for the timer (tests, graceful shutdown).
  if (typeof runnerHandle.unref === "function") runnerHandle.unref();
}
