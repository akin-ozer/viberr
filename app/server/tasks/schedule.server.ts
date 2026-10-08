import type { DatabaseSync } from "node:sqlite";
import { sweepStrandedTasks } from "./stranded-sweep.server";
import { closureRefusal, taskClosure } from "./task-closure.server";
import { z } from "zod";
import {
  recordAudit,
  SYSTEM_ACTOR,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { logger } from "~/server/logging/logger.server";
import { holdEntriesSentence } from "~/shared/dependencies";
import { resolveDependencies } from "~/server/projections/dependencies.server";
import { newId } from "~/shared/ids/new-id.server";
import { AppError } from "~/server/errors/app-error.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { getProject } from "~/server/projections/board-query.server";
import { listRunsForTaskRows } from "~/server/runtimes/run-store.server";
import { cloneTimeoutMs } from "~/server/tasks/git-clone-auth.server";
import { resolveStageRoles, stageName } from "~/shared/workflow/stage-roles";
import type { RunOperatorInput } from "~/server/runtimes/operator-run.server";
import { reprojectTask, taskRef, type TaskMutationContext } from "./task-mutation.server";
import {
  scheduleSchema,
  type ScheduleAction,
  type TaskFileEvent,
  type TaskSchedule,
} from "~/schemas/task-file.schema";
import { toError } from "~/shared/errors";
import { endSentence, indefiniteArticle } from "~/shared/text/sentence";

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
// returns `refused: "closed"` for any turn on a closed task, archived or at its
// terminal stage (ruling 177; the belt to this claim-time brace). B's standalone
// `scheduledRunIsMoot` drive probe was retired with that guard (RECONCILE §1.2).

// ------------------------------------------------------------------ bounds

/** The ceiling every schedule door applies, in minutes (28 days). A schedule
 *  further out than the retention story is a note, not a plan. */
export const SCHEDULE_MAX_MINUTES = 40_320;

/** The one sentence every schedule door refuses an out-of-range time with. */
export const SCHEDULE_BOUNDS_SENTENCE = "Schedule between 1 minute and 28 days out.";

/**
 * Ruling 153, shared by ruling 487: the instant a door's `delayMinutes` or ISO
 * `dueAt` names, under the task page's bounds and sentences. A crafted delay
 * once overflowed Date, so both forms are clamped here rather than trusted.
 * Throws a validation `AppError`.
 */
export function scheduleDueMs(
  when: { delayMinutes?: number | undefined; dueAt?: string | undefined },
  nowMs: number = Date.now(),
): number {
  if (when.delayMinutes !== undefined) {
    const minutes = when.delayMinutes;
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > SCHEDULE_MAX_MINUTES) {
      throw AppError.validation(SCHEDULE_BOUNDS_SENTENCE);
    }
    return nowMs + Math.round(minutes) * 60_000;
  }
  if (when.dueAt !== undefined) {
    const dueMs = Date.parse(when.dueAt);
    if (!Number.isFinite(dueMs)) throw AppError.validation("Invalid schedule time.");
    const minutes = (dueMs - nowMs) / 60_000;
    if (minutes < 1 || minutes > SCHEDULE_MAX_MINUTES) {
      throw AppError.validation(SCHEDULE_BOUNDS_SENTENCE);
    }
    return dueMs;
  }
  throw AppError.validation(SCHEDULE_BOUNDS_SENTENCE);
}

/**
 * Ruling 487: the `createdBy` of an entry the OPERATOR made, through its own
 * `schedule_task_action` or a dispatch of its that was held (ruling 152(c)).
 * The fire path reads it: an operator's run carries no human's name, so it
 * must not be started as a person's directive or tag one when it reports.
 */
export const OPERATOR_SCHEDULER_ID = "operator";

/** The timeline actor a schedule note is written as (ruling 487: the operator
 *  when the write runs under its authority, the person otherwise). */
function schedulerEventActor(
  actor: AuditActor,
  ctx: TaskMutationContext,
): TaskFileEvent["actor"] {
  return ctx.operatorAuthorized
    ? { kind: "operator" }
    : { kind: "human", userId: actor.userId ?? "system", nameHint: actor.label };
}

// ------------------------------------------------------------------ create

export interface ScheduleInput {
  projectSlug: string;
  taskKey: string;
  /** ISO timestamp the action becomes due (must be in the future). */
  dueAt: string;
  /** What fires: an operator re-run (default) or a specific agent's run. */
  action?: ScheduleAction;
  /** `run-agent` only: the deployed agent to dispatch at fire time. */
  profileId?: string;
  /** The run's instruction — the operator steer or the agent's directive. */
  prompt?: string;
}

/**
 * Schedule a future run on a task — the operator, or a chosen deployed agent
 * (dynamic-dispatch rework 2026-08-29). RBAC is enforced by the caller
 * (`run-agents`, maintainer+ — scheduling triggers agent work). Rejects a
 * past `dueAt` and a task that is already in its terminal stage.
 *
 * Ruling 487: the operator's door (`operatorScheduleRun`) writes through here
 * too, under `ctx.operatorAuthorized` and gated like its immediate dispatch;
 * the entry, its note and its audit row then name the operator.
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
  const action: ScheduleAction = input.action ?? "run-operator";
  let what = "an operator re-run";
  if (action === "run-agent") {
    if (!input.profileId) {
      throw AppError.validation("Pick which agent the scheduled run should start.");
    }
    // The profile must be deployed NOW so the picker can't schedule a phantom;
    // the fire-time dispatch re-resolves the LIVE deployment (R22's rule) and
    // skips visibly if it was undeployed in the meantime.
    const { listDeployedSpecialists } = await import("./specialist-roster.server");
    const view = listDeployedSpecialists(input.projectSlug, ctx).find(
      (s) => s.id === input.profileId,
    );
    if (!view) {
      throw AppError.validation(
        `"${input.profileId}" is not deployed on this project.`,
      );
    }
    what = `${indefiniteArticle(view.name)} **${view.name}** run`;
  }

  const ref = taskRef(ctx, input.projectSlug, input.taskKey);
  const existing = readTaskFile(ref);
  if (!existing) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  // Ruling 177 (pass 36): a closed task — archived, or at the board's terminal
  // stage whatever it is named — refuses the schedule with the one closure
  // sentence every door uses. Live (U36-9, 19:37Z): "That task is already
  // Done — nothing to schedule." on a board whose last stage is Shipped.
  const stages = getProject(db, input.projectSlug)?.stages ?? [];
  const closure = taskClosure(existing.parsed.frontmatter, stages);
  if (closure.closed) {
    throw AppError.validation(
      closureRefusal(input.taskKey, closure, stages, "scheduling a run on it"),
    );
  }

  // R22: the entry pins no backend/autonomy — the fired run resolves the LIVE
  // deployed profile (operator or agent) at fire time. The agent arm pins only
  // the profile ID: identity is the decision being scheduled; backend, model
  // and capabilities follow whatever is deployed when it fires.
  const schedule: TaskSchedule = {
    id: newId("sch"),
    action,
    dueAt: new Date(dueMs).toISOString(),
    profileId: action === "run-agent" ? (input.profileId ?? null) : null,
    prompt: input.prompt?.trim() ? input.prompt.trim() : "",
    // Ruling 487: an entry written under the operator's authority says so,
    // which is what the fire path and the operator's own cancel read.
    createdBy: ctx.operatorAuthorized ? OPERATOR_SCHEDULER_ID : (actor.userId ?? "system"),
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
        schedulerEventActor(actor, ctx),
        // A prompt that already ends its sentence keeps one period, not two
        // (live on AWSC-65: "hours passed.. It runs").
        `**Scheduled:** ${what} for **${input.taskKey}** at ${schedule.dueAt}${schedule.prompt ? `: ${endSentence(schedule.prompt)}` : "."} It runs on the profile deployed when it fires.`,
      ),
    );
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.schedule.created",
    actor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      scheduleId: schedule.id,
      dueAt: schedule.dueAt,
      action,
      profileId: schedule.profileId,
    },
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
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    const target = parsed.frontmatter.schedules.find((s) => s.id === input.scheduleId);
    if (!target || target.status !== "pending") return; // gone or already resolved
    target.status = "cancelled";
    // P11-75: a cancelled schedule was never fired — leave firedAt null rather
    // than stamping cancel time into a field that means "when the run fired".
    cancelled = true;
    parsed.timeline.unshift(
      scheduleEvent(
        schedulerEventActor(actor, ctx),
        `**Schedule cancelled:** the pending scheduled run for ${input.taskKey} was cancelled.`,
      ),
    );
  });
  if (!cancelled) return { cancelled: false };
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
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
 * `cloneTimeoutMs()` (15 minutes by default) on a big — or unreachable —
 * repository. The old flat 5 minutes therefore declared a LIVE drive crashed
 * halfway through its own clone: the next tick re-drove the same occurrence,
 * that second trigger queued behind the first drive's lease, and the drain
 * started a SECOND unwatched operator turn for one scheduled occurrence. FR39
 * is the one capability that acts with no human present; it must not double.
 *
 * Derived rather than re-guessed, so the invariant survives someone raising
 * `VIBERR_GIT_CLONE_TIMEOUT_MS`. A function (V19): the clone ceiling is now a
 * lazy env read, so this follows it call-by-call.
 */
function claimLeaseMs(): number {
  return cloneTimeoutMs() + 5 * 60_000;
}
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
  // U36-9 (pass 36): the note names the terminal stage as the board calls it.
  const terminalNameFor = (slug: string): string => {
    const id = terminalFor(slug);
    const stages = getProject(db, slug)?.stages ?? [];
    return id === null ? "Done" : stageName(stages, id);
  };
  // Hunt 2026-08-29: the fire path runs under `operatorAuthorized`, which
  // skips the route-layer requireRunAgents and with it the F17/R6-3
  // ARCHIVED-PROJECT freeze — so a pending schedule kept engaging profiles and
  // launching unattended runs on a project every interactive door refuses as
  // read-only. Decide it here, beside the task-level mootness.
  const projectArchivedCache = new Map<string, boolean>();
  const projectArchivedFor = (slug: string): boolean => {
    if (!projectArchivedCache.has(slug)) {
      projectArchivedCache.set(slug, getProject(db, slug)?.archived === true);
    }
    return projectArchivedCache.get(slug) ?? false;
  };

  /** A stale claim = claimed but its lease expired (the enqueuing tick crashed
   *  before finalizing). Re-driven so the action is never lost (F10-16). */
  const isStaleClaim = (s: TaskSchedule): boolean => {
    if (s.status !== "claimed") return false;
    const claimedMs = s.claimedAt ? Date.parse(s.claimedAt) : NaN;
    return !Number.isFinite(claimedMs) || nowMs - claimedMs >= claimLeaseMs();
  };

  let fired = 0;
  let skipped = 0;
  const toRun: {
    projectSlug: string;
    taskKey: string;
    scheduleId: string;
    action: ScheduleAction;
    /** `run-agent`: the pinned profile identity (live-resolved at fire time). */
    profileId: string | null;
    /** The scheduler's instruction — the operator turn quotes it (B-WF3); an
     *  agent run takes it as its directive. */
    prompt: string;
    /** Who scheduled it — the dispatch-completion contract's triggerer. */
    createdByLabel: string;
    /** The scheduler's user id (the cc-append verifies against it). */
    createdBy: string;
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
    const projectFrozen = projectArchivedFor(row.project_slug);

    for (const s of due) {
      // Hunt 2026-08-29: a run-agent occurrence whose profile ALREADY has a
      // live run on the task would only bounce off the single-flight 409 at
      // fire time — and each bounce writes a "starting" note and burns a
      // bounded retry. Leave it pending this tick, silently; the next tick
      // re-checks. (A race that slips past this is still caught at dispatch
      // and deferred below, without spending a retry.)
      if (s.action === "run-agent" && s.profileId) {
        const liveSameProfile = listRunsForTaskRows(
          db,
          row.project_slug,
          row.task_key,
        ).some(
          (r) =>
            r.agent_profile_id === s.profileId &&
            (r.state === "running" || r.state === "queued"),
        );
        if (liveSameProfile && !isStaleClaim(s)) continue;
      }
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
          taskRef(ctx, row.project_slug, row.task_key),
          (parsed) => {
            const target = parsed.frontmatter.schedules.find((x) => x.id === s.id);
            if (!target) return;
            if (target.status !== "pending" && !isStaleClaim(target)) return;
            // FR39, decided HERE: the canonical stage/archived flag, read under
            // the same lock that claims the occurrence (F19-20). The projection
            // row only FOUND the candidate; an acceptance (or archive) landing
            // between the SELECT and this locked read never rides a stale
            // snapshot into a real, unwatched operator turn.
            // Ruling 177 (pass 36): the one closed-task predicate.
            const closure = taskClosure(
              parsed.frontmatter,
              terminal !== null ? [{ id: terminal }] : [],
            );
            const mootNow = projectFrozen || closure.closed;
            if (mootNow) {
              target.status = "fired";
              target.firedAt = new Date().toISOString();
              parsed.timeline.unshift(
                scheduleEvent(
                  { kind: "system", systemId: "schedule-runner" },
                  // Name the REAL reason — the audit row distinguishes
                  // `skipped-archived` from `skipped-done`, and the note a human
                  // reads must not tell an archived task it was "already Done".
                  projectFrozen
                    ? `**Scheduled action skipped:** the project has been archived (read-only); the scheduled run is moot.`
                    : parsed.frontmatter.archived === true
                      ? `**Scheduled action skipped:** ${row.task_key} has been archived; the scheduled run is moot.`
                      : `**Scheduled action skipped:** ${row.task_key} is already ${terminalNameFor(row.project_slug)}; the scheduled run is moot.`,
                ),
              );
            } else {
              target.status = "claimed";
              target.claimedAt = new Date().toISOString();
              parsed.timeline.unshift(
                scheduleEvent(
                  { kind: "system", systemId: "schedule-runner" },
                  `**Scheduled action starting:** ${staleClaim ? "recovering a stalled claim and re-" : ""}running the scheduled ${s.action === "run-agent" ? "agent run" : "operator re-run"} for ${row.task_key}${s.prompt ? `: ${s.prompt}` : ""}.`,
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
        reprojectTask(db, ctx, row.project_slug, row.task_key);
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
              ? projectFrozen || claimedFile.frontmatter.archived === true
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
            action: s.action,
            profileId: s.profileId ?? null,
            prompt: s.prompt ?? "",
            createdByLabel: s.createdByLabel ?? "",
            createdBy: s.createdBy ?? "",
          });
          fired += 1;
        }
      } catch (error) {
        logger.warn("scheduled action claim failed", {
          taskKey: row.task_key,
          projectSlug: row.project_slug,
          err: toError(error),
        });
      }
    }
  }

  if (toRun.length > 0) {
    void (async () => {
      const { runOperator } = await import("~/server/runtimes/operator-run.server");
      const { isDispatchHeld, startAgentRun } = await import("./specialist-run.server");
      for (const t of toRun) {
        let ok = false;
        /** F19-20: the run was refused at FIRE time (the task reached its
         *  terminal stage after this occurrence was claimed). Not a failure —
         *  nothing to retry — but the timeline already announced the start, so
         *  the retirement has to say what actually happened. */
        let refusedTerminal = false;
        /** Ruling 131(d): the task waits on other work; the operator trigger
         *  was refused at fire time. Retired `fired` with a note, outcome
         *  `skipped-held`. A human-scheduled AGENT run is not refused: the
         *  ruling refuses operator triggers only, so the run-agent arm stands. */
        let refusedHeld = false;
        /** Ruling 141: a decision packet is open; the scheduled operator re-run
         *  is the same paid no-op ruling 76 refuses for a person, so it was
         *  refused at fire time. Retired `fired` with a note, outcome
         *  `skipped-packet`, no retry. */
        let refusedPacket = false;
        /** Ruling 141: the run was queued behind a live drive; the occurrence is
         *  retired here and its identity travels with the trigger, so a refusal
         *  at the front of the queue writes the final row itself. */
        let queuedBehindDrive = false;
        /** run-agent only: the dispatch refused for a reason a retry can never
         *  cure (profile undeployed, stage-ineligible, no repo-write for an
         *  explicit delivery ask). Terminal `failed` with the reason on the
         *  timeline — never a silent three-strike retry loop. */
        let refusedValidation: string | null = null;
        /** Hunt 2026-08-29: a same-profile single-flight conflict at fire time
         *  is a WAIT, not a strike — defer the occurrence back to pending with
         *  no retry spent; the next tick's claim pre-check holds it until the
         *  live run ends. */
        let deferredConflict = false;
        /** Ruling 152(c) (pass 35, G35-4): the dispatch was HELD because the
         *  backend is known to be out of quota for the account it bills. The
         *  dispatcher already put the retry on the schedule and said so on
         *  the timeline, so this occurrence retires `fired` with outcome
         *  `held-quota` and spends no retry; a 409 would have deferred it to
         *  the next tick and minted a fresh hold and a fresh schedule row
         *  every minute. */
        let heldQuota: { rescheduledAs: string | null } | null = null;
        // Re-stamp the lease as THIS occurrence's drive begins. `claimedAt` is
        // written when the tick claims the batch, but this drain is sequential
        // and one drive can legitimately sit inside `runOperator` for
        // cloneTimeoutMs(). With several occurrences due at once, a later one's
        // WAIT alone can outlast claimLeaseMs(), so the next tick reads its
        // claim as crashed and re-drives it — the FR39 double-drive the lease
        // exists to prevent. Stamped here, the lease measures what the
        // staleness check means: time since this occurrence started running.
        try {
          await updateTaskFile(
            taskRef(ctx, t.projectSlug, t.taskKey),
            (parsed) => {
              const target = parsed.frontmatter.schedules.find(
                (x) => x.id === t.scheduleId,
              );
              if (!target || target.status !== "claimed") return;
              target.claimedAt = new Date().toISOString();
            },
          );
        } catch (error) {
          // A lease we could not re-stamp is no reason to skip the drive: the
          // worst case is exactly the behaviour that existed before.
          logger.warn("schedule claim lease refresh failed", {
            taskKey: t.taskKey,
            projectSlug: t.projectSlug,
            err: toError(error),
          });
        }
        try {
          if (t.action === "run-agent" && !t.profileId) {
            // A run-agent entry with no profile (hand-edited file, or a
            // pre-validation write) can never dispatch — terminal, visibly,
            // rather than falling through to a surprise operator turn.
            refusedValidation = "the entry names no agent to run";
            ok = true;
          } else if (t.action === "run-agent" && t.profileId) {
            // Dynamic-dispatch rework: the scheduled agent run. Resolves the
            // LIVE deployment at fire time (R22's rule — the profile ID is the
            // pin, nothing else). The scheduler is the dispatch-completion
            // contract's triggerer: the run's report tags them + @operator and
            // the completion re-invokes the operator.
            const dispatch: Parameters<typeof startAgentRun>[1] = {
              projectSlug: t.projectSlug,
              taskKey: t.taskKey,
              profileId: t.profileId,
            };
            // Ruling 487: the operator's own entry starts the run the way its
            // immediate `run_agent` would. Its directive is not a person's
            // words ("A human (operator) asked you"), and there is no person
            // to tag: the completion re-invokes the operator as any of its
            // dispatches does.
            const byOperator = t.createdBy === OPERATOR_SCHEDULER_ID;
            if (t.prompt) {
              dispatch.directive = t.prompt;
              if (t.createdByLabel && !byOperator) dispatch.directiveFrom = t.createdByLabel;
            }
            if (!byOperator) {
              if (t.createdByLabel) dispatch.triggeredByName = t.createdByLabel;
              if (t.createdBy) dispatch.triggeredByUserId = t.createdBy;
            }
            await startAgentRun(
              db,
              dispatch,
              { userId: "system", label: "schedule runner" },
              { dataRoot: ctx.dataRoot, operatorAuthorized: true },
            );
            ok = true;
          } else {
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
              // Ruling 141: the occurrence's identity travels with the trigger.
              scheduleId: t.scheduleId,
            };
            // Only a real note rides along; an empty one would present itself to
            // the turn instruction as a stated reason.
            if (t.prompt) runInput.scheduleNote = t.prompt;
            // Ruling 487: the turn says whose re-check this is. "A human set
            // it" is false for the operator's own.
            if (t.createdBy === OPERATOR_SCHEDULER_ID) runInput.scheduledByOperator = true;
            const result = await runOperator(db, runInput);
            refusedTerminal = result.refused === "closed";
            refusedHeld = result.refused === "blocked-by";
            refusedPacket = result.refused === "open-packet";
            queuedBehindDrive = result.queued;
            ok = true;
          }
        } catch (error) {
          if (t.action === "run-agent" && isDispatchHeld(error)) {
            heldQuota = { rescheduledAs: error.hold.scheduleId };
            ok = true; // retired below; the retry is the schedule the hold made
          } else if (
            t.action === "run-agent" &&
            error instanceof AppError &&
            error.status === 400
          ) {
            refusedValidation =
              error.userMessage || "the dispatch was refused as invalid";
            ok = true; // terminal disposition, finalized below — not a retry
          } else if (
            t.action === "run-agent" &&
            error instanceof AppError &&
            error.status === 409
          ) {
            deferredConflict = true; // wait for the live run; no retry spent
          } else {
            logger.warn("scheduled run failed", {
              taskKey: t.taskKey,
              action: t.action,
              err: toError(error),
            });
          }
        }
        // Finalize the claimed occurrence — never leave it stuck in `claimed`.
        // Success → fired. Failure → bounded retry (back to pending) or terminal
        // `failed` once the retry cap is hit (F10-16).
        try {
          await updateTaskFile(
            taskRef(ctx, t.projectSlug, t.taskKey),
            (parsed) => {
              const target = parsed.frontmatter.schedules.find(
                (x) => x.id === t.scheduleId,
              );
              if (!target || target.status !== "claimed") return;
              if (deferredConflict) {
                // Back to pending, retries untouched: the agent is simply
                // still busy, and three 60s ticks must not spend the whole
                // retry budget on an agent run that legitimately takes longer.
                target.status = "pending";
                target.claimedAt = null;
                return;
              }
              if (refusedValidation) {
                // The dispatch can never succeed as scheduled (undeployed
                // profile, ineligible stage) — terminal, with the reason where
                // a human reads it.
                target.status = "failed";
                target.firedAt = new Date().toISOString();
                target.claimedAt = null;
                parsed.timeline.unshift(
                  scheduleEvent(
                    { kind: "system", systemId: "schedule-runner" },
                    `**Scheduled action failed:** the scheduled agent run for ${t.taskKey} was refused: ${refusedValidation}`,
                  ),
                );
                return;
              }
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
                      `**Scheduled action skipped:** ${t.taskKey} reached Done before its scheduled run started; no run was started.`,
                    ),
                  );
                } else if (refusedHeld) {
                  parsed.timeline.unshift(
                    scheduleEvent(
                      { kind: "system", systemId: "schedule-runner" },
                      `**Scheduled action skipped:** ${t.taskKey} waits on other work (${holdEntriesSentence(resolveDependencies(db, t.projectSlug, parsed.frontmatter.blockedBy))}). No operator run was started; Viberr releases the task when every entry is done.`,
                    ),
                  );
                } else if (refusedPacket) {
                  parsed.timeline.unshift(
                    scheduleEvent(
                      { kind: "system", systemId: "schedule-runner" },
                      `**Scheduled action skipped:** a decision packet is open on ${t.taskKey}${parsed.packet ? ` ("${parsed.packet.title}")` : ""} and coordination is paused until it is resolved; no operator run was started, and the occurrence spends no retry.`,
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
                    `**Scheduled action failed:** the scheduled run for ${t.taskKey} did not complete after ${retries} attempts.`,
                  ),
                );
              } else {
                target.status = "pending"; // retry on a later tick
              }
            },
          );
          reprojectTask(db, ctx, t.projectSlug, t.taskKey);
          if (heldQuota) {
            recordAudit(db, {
              action: "task.schedule.fired",
              actor: SYSTEM_ACTOR,
              subjectKind: "task",
              subjectId: t.taskKey,
              projectSlug: t.projectSlug,
              taskKey: t.taskKey,
              details: {
                scheduleId: t.scheduleId,
                outcome: "held-quota",
                rescheduledAs: heldQuota.rescheduledAs,
              },
            });
          } else if (refusedTerminal || refusedHeld || refusedPacket) {
            recordAudit(db, {
              action: "task.schedule.fired",
              actor: SYSTEM_ACTOR,
              subjectKind: "task",
              subjectId: t.taskKey,
              projectSlug: t.projectSlug,
              taskKey: t.taskKey,
              details: {
                scheduleId: t.scheduleId,
                outcome: refusedPacket
                  ? "skipped-packet"
                  : refusedHeld
                    ? "skipped-held"
                    : "skipped-done",
                refusedAtStart: true,
              },
            });
          } else if (queuedBehindDrive) {
            // Ruling 141: the run did not start here — it waits behind a live
            // drive. The final row is written when the trigger reaches the
            // front of the queue (a refusal there says so on the task).
            recordAudit(db, {
              action: "task.schedule.fired",
              actor: SYSTEM_ACTOR,
              subjectKind: "task",
              subjectId: t.taskKey,
              projectSlug: t.projectSlug,
              taskKey: t.taskKey,
              details: { scheduleId: t.scheduleId, outcome: "queued-behind-drive" },
            });
          }
        } catch (error) {
          logger.warn("schedule finalize failed", {
            taskKey: t.taskKey,
            err: toError(error),
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
      err: toError(error),
    });
  });
  let running = false;
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    void fireDueSchedules(db)
      .catch((error) => {
        logger.warn("schedule runner tick failed", {
          err: toError(error),
        });
      })
      // Ruling 330: the stranded sweep rides this tick rather than standing up a
      // second interval. It is the same shape of work — "is anything due?" — and
      // a task that has stopped is due in exactly the sense a schedule is. It
      // runs AFTER the schedules so a dispatch that just fired is already a
      // queued run and the sweep does not count the task as stopped.
      .then(() => sweepStrandedTasks(db))
      .catch((error) => {
        logger.warn("stranded sweep tick failed", {
          err: toError(error),
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
