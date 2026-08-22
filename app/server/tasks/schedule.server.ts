import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
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
import { CLONE_TIMEOUT_MS } from "~/server/tasks/git-clone-auth.server";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import type { RunOperatorInput } from "~/server/runtimes/operator-run.server";
import type { TaskMutationContext } from "./task-actions.server";
import {
  scheduleSchema,
  type TaskFileEvent,
  type TaskSchedule,
} from "~/schemas/task-file.schema";

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
 * Idempotency / crash-safety: an occurrence is CLAIMED in the file
 * (`pending → claimed`) before `runOperator` is invoked and finalized to
 * `fired` only once the enqueue returned, so a crash mid-run can neither
 * re-fire it nor lose it — a claim whose lease expired is re-driven by a later
 * tick, and every terminal state stays across restarts (the file is canonical).
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

/**
 * The project's terminal (Done) stage id, or null. Resolved STRUCTURALLY
 * (B-WF4) — the last-position fallback only covers a project with no declared
 * workflow, so this can never disagree with the acceptance writers on a board
 * whose column order diverges from its transition chain.
 */
function terminalStageId(db: DatabaseSync, projectSlug: string): string | null {
  const project = getProject(db, projectSlug);
  if (!project) return null;
  return (
    resolveStageRoles(project.stages, project.workflow ?? []).terminalId ??
    project.stages[project.stages.length - 1]?.id ??
    null
  );
}

// FR39 asked at DRIVE time is now enforced inside `runOperator` itself, which
// returns `refused: "terminal-stage"` for a scheduled turn on a task that has
// reached its terminal stage (the belt to this claim-time brace). B's standalone
// `scheduledRunIsMoot` drive probe was retired with that guard (RECONCILE §1.2).

// ------------------------------------------------------------------ create

export interface ScheduleInput {
  projectSlug: string;
  taskKey: string;
  /** ISO timestamp the action becomes due (must be in the future). */
  dueAt: string;
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

  // R22: the entry pins no backend/autonomy — the fired run resolves the LIVE
  // deployed operator profile (`runOperator` fills both from the deployment when
  // omitted). No SCHEDULE-time clamp is needed because nothing is stored to
  // clamp; the run resolves and clamps against whatever is deployed at fire time.
  const schedule: TaskSchedule = {
    id: newId("sch"),
    action: "run-operator",
    dueAt: new Date(dueMs).toISOString(),
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
        `**Scheduled:** an operator re-run for **${input.taskKey}** at ${schedule.dueAt}${schedule.note ? ` — ${schedule.note}` : ""}. It runs on the operator profile deployed when it fires.`,
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
    details: { scheduleId: schedule.id, dueAt: schedule.dueAt },
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

/** Every column this query selects is NOT NULL in `task_projections`. */
const dueRowSchema = z.object({
  project_slug: z.string(),
  task_key: z.string(),
  stage: z.string(),
  /** R14-3 projection column; 1 = archived (P14-RV-03). */
  archived: z.number(),
  schedules_json: z.string(),
});
export type DueRow = z.infer<typeof dueRowSchema>;

/**
 * Tasks holding an UNRESOLVED schedule occurrence (`pending` or `claimed`) —
 * the candidate set each tick then filters by due time in JS.
 *
 * B-WF5: ask SQLite about the JSON as JSON. This used to be
 * `schedules_json LIKE '%"status":"pending"%'`, a substring match over
 * serialized bytes: it depended on key order and spacing the writer never
 * promised, and any schedule NOTE quoting that text made an unrelated task a
 * candidate. `json_each` reads the array element-wise, so an element's own
 * `status` is what selects the row.
 */
export function tasksWithUnresolvedSchedules(db: DatabaseSync): DueRow[] {
  return z.array(dueRowSchema).parse(
    db
      .prepare(
        `SELECT project_slug, task_key, stage, archived, schedules_json
           FROM task_projections
          WHERE json_valid(schedules_json)
            AND EXISTS (
                  SELECT 1 FROM json_each(task_projections.schedules_json)
                   WHERE json_extract(value, '$.status') IN ('pending', 'claimed')
                )`,
      )
      .all(),
  );
}

/** The projection's `schedules_json`, decoded. Tolerance is per ELEMENT on
 *  purpose: one unreadable occurrence must not hide the readable due ones on
 *  the same task from this tick. */
const scheduleListSchema = z
  .array(scheduleSchema.nullable().catch(null))
  .transform((all) => all.filter((s) => s !== null));

/**
 * F10-16: a claim older than this is treated as crashed and re-driven. Longer
 * than any real operator run start; shorter than "lost forever".
 *
 * The floor is the slowest LEGITIMATE start, and R19-1 moved it: `runOperator`
 * now provisions the operator's read-only repository checkout before the drive
 * begins, so a healthy drive can sit inside `runOperator` for up to
 * `CLONE_TIMEOUT_MS` (15 minutes by default) on a big — or unreachable —
 * repository. The old flat 5 minutes therefore declared a LIVE drive crashed
 * halfway through its own clone: the next tick re-drove the same occurrence,
 * that second trigger queued behind the first drive's lease, and the drain
 * started a SECOND unwatched operator turn for one scheduled occurrence. FR39
 * is the one capability that acts with no human present; it must not double.
 *
 * Derived rather than re-guessed, so the invariant survives someone raising
 * `VIBERR_GIT_CLONE_TIMEOUT_MS`. Exported so a test can pin the relationship
 * rather than a magic number.
 */
export const CLAIM_LEASE_MS = CLONE_TIMEOUT_MS + 5 * 60_000;
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
  const rows = tasksWithUnresolvedSchedules(db);
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
    scheduleId: string;
    /** The scheduler's stated reason — the operator's turn instruction quotes
     *  it, so a scheduled re-run knows WHY it exists (B-WF3). */
    note: string;
  }[] = [];

  for (const row of rows) {
    let scheds: TaskSchedule[];
    try {
      scheds = scheduleListSchema.parse(JSON.parse(row.schedules_json));
    } catch {
      continue;
    }
    const due = scheds.filter((s) => {
      const dueMs = Date.parse(s.dueAt);
      if (!Number.isFinite(dueMs) || dueMs > nowMs) return false;
      return s.status === "pending" || isStaleClaim(s);
    });
    if (due.length === 0) continue;
    // F19-20: the projection row FINDS candidates; it no longer DECIDES.
    // `row.stage` is a snapshot taken at the top of the tick, so an acceptance
    // that lands between the SELECT and this row's claim leaves it reading the
    // pre-accept stage — and the occurrence is then claimed and a real,
    // unwatched operator turn is enqueued on a task that is Done and merged.
    // FR39 says a scheduled run never fires on a terminal task, so the decision
    // moves into the claim below, which already holds the canonical frontmatter
    // under the file lock.
    //
    // (P14-RV-03's ARCHIVED case survived this only because `setTaskArchived`
    // ALSO cancels the schedules in the file, so the existing
    // `status !== "pending"` re-check caught it. Done had no such second layer.
    // Both dimensions are now decided from the same locked read, and that
    // belt-and-braces stays belt-and-braces.)
    const terminal = terminalFor(row.project_slug);

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
        const claimedFile = await updateTaskFile(
          taskFileRef(ctx, row.project_slug, row.task_key),
          (parsed) => {
            const target = parsed.frontmatter.schedules.find((x) => x.id === s.id);
            if (!target) return;
            if (target.status !== "pending" && !isStaleClaim(target)) return;
            // FR39, decided HERE: the canonical stage/archived flag, read under
            // the same lock that claims the occurrence (F19-20). The projection
            // row only FOUND the candidate; an acceptance (or archive) landing
            // between the SELECT and this locked read never rides a stale
            // snapshot into a real, unwatched operator turn.
            const mootNow =
              parsed.frontmatter.archived === true ||
              (terminal !== null && parsed.frontmatter.stage === terminal);
            if (mootNow) {
              target.status = "fired";
              target.firedAt = new Date().toISOString();
              parsed.timeline.unshift(
                scheduleEvent(
                  { kind: "system", systemId: "schedule-runner" },
                  // Name the REAL reason — the audit row distinguishes
                  // `skipped-archived` from `skipped-done`, and the note a human
                  // reads must not tell an archived task it was "already Done".
                  parsed.frontmatter.archived === true
                    ? `**Scheduled action skipped:** ${row.task_key} has been archived — the scheduled operator re-run is moot.`
                    : `**Scheduled action skipped:** ${row.task_key} is already Done — the scheduled operator re-run is moot.`,
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
          },
        );
        if (!claimed) continue; // another tick/restart already handled it
        // Read the verdict back off the file that was WRITTEN rather than out of
        // a closure variable: `updateTaskFile` returns the resulting parse, and
        // a `let` assigned inside the callback is narrowed to its initializer at
        // every read site out here.
        const wasMoot =
          claimedFile.frontmatter.schedules.find((x) => x.id === s.id)?.status ===
          "fired";
        reproject(db, ctx, row.project_slug, row.task_key);
        recordAudit(db, {
          action: "task.schedule.fired",
          actor: SYSTEM_ACTOR,
          subjectKind: "task",
          subjectId: row.task_key,
          projectSlug: row.project_slug,
          taskKey: row.task_key,
          details: {
            scheduleId: s.id,
            // The outcome names what the FILE said at claim time, so the audit
            // row and the retirement can never disagree (F19-20).
            outcome: wasMoot
              ? claimedFile.frontmatter.archived === true
                ? "skipped-archived"
                : "skipped-done"
              : "claimed",
          },
        });
        if (wasMoot) {
          skipped += 1;
        } else {
          toRun.push({
            projectSlug: row.project_slug,
            taskKey: row.task_key,
            scheduleId: s.id,
            note: s.note ?? "",
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
        /** F19-20: the run was refused at FIRE time (the task reached its
         *  terminal stage after this occurrence was claimed). Not a failure —
         *  nothing to retry — but the timeline already announced the start, so
         *  the retirement has to say what actually happened. */
        let refusedTerminal = false;
        try {
          const runInput: RunOperatorInput = {
            projectSlug: t.projectSlug,
            taskKey: t.taskKey,
            // R22: no pinned backend/autonomy — `runOperator` resolves the LIVE
            // deployed operator profile at fire time (see resolveOperatorAuthority).
            // B-WF3: a scheduled re-run is not a human pressing "Run operator".
            // It used to arrive as a bare `manual` trigger, so the reason the
            // human scheduled it never reached the turn — the operator re-read
            // the task with no idea what it was asked to re-check.
            trigger: "scheduled",
            dataRoot: ctx.dataRoot,
          };
          // Only a real note rides along; an empty one would present itself to
          // the turn instruction as a stated reason.
          if (t.note) runInput.scheduleNote = t.note;
          const result = await runOperator(db, runInput);
          refusedTerminal = result.refused === "terminal-stage";
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
                if (refusedTerminal) {
                  // The claim note said "Scheduled action starting"; nothing
                  // started. Say so on the task rather than leaving a `fired`
                  // occurrence whose only trace claims a run happened.
                  parsed.timeline.unshift(
                    scheduleEvent(
                      { kind: "system", systemId: "schedule-runner" },
                      `**Scheduled action skipped:** ${t.taskKey} reached Done before its scheduled operator re-run started — no run was started.`,
                    ),
                  );
                }
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
          if (refusedTerminal) {
            // The claim-time row for this occurrence says `outcome: "claimed"`
            // — true when it was written, and a lie by the time the drive
            // refused. The audit trail and the retirement note must not
            // disagree about whether an agent turn happened (F19-20), so the
            // occurrence's FINAL disposition is recorded too, with the same
            // outcome the claim-time path uses when it catches this earlier.
            recordAudit(db, {
              action: "task.schedule.fired",
              actor: SYSTEM_ACTOR,
              subjectKind: "task",
              subjectId: t.taskKey,
              projectSlug: t.projectSlug,
              taskKey: t.taskKey,
              details: {
                scheduleId: t.scheduleId,
                outcome: "skipped-done",
                refusedAtStart: true,
              },
            });
          }
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

// C10 (pass 23): HMR-safe singleton, the same convention the reconcile poller
// documents (reconcile-poller.server.ts). A module-scoped handle RESETS to null
// when a dev reload re-evaluates this module, so a repeat startScheduleRunner
// then set a SECOND interval next to the orphaned first, double-firing every due
// schedule (duplicate operator runs). Behind a process-global registry symbol,
// a repeat start() is a true no-op — no duplicate interval, no re-fired boot pass.
const RUNNER_KEY = Symbol.for("viberr.scheduleRunner");
interface RunnerHost {
  [RUNNER_KEY]?: ReturnType<typeof setInterval>;
}
function runnerCache(): RunnerHost {
  // SAFETY: a viberr-namespaced registry symbol only this function reads/writes,
  // so the slot holds either the interval handle put there or nothing at all.
  return globalThis as RunnerHost;
}

/**
 * Start the server-side schedule runner: fire once at boot (catches schedules
 * that came due while the process was down), then on an interval. Non-
 * overlapping (a slow tick can't stack). Idempotent — a second call is a no-op.
 */
export function startScheduleRunner(db: DatabaseSync): void {
  const cache = runnerCache();
  if (cache[RUNNER_KEY]) return;
  // C10: the boot catch-up used to swallow every failure with an EMPTY catch, so
  // a boot-time schedule failure (e.g. a bad task file) was invisible. Log it
  // like the interval tick does.
  void fireDueSchedules(db).catch((error) => {
    logger.warn("schedule runner boot pass failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  });
  let running = false;
  const handle = setInterval(() => {
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
  handle.unref?.();
  cache[RUNNER_KEY] = handle;
}
