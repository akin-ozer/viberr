import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { logger } from "~/server/logging/logger.server";
import { createNotification, taskEventLink } from "~/server/projections/notifications.server";
import type { TaskMutationContext } from "~/server/tasks/task-mutation.server";
import type { runOperator } from "./operator-run.server";
import { reapRunProcesses, type ReapRunProcesses, compactionRunId } from "./run-processes.server";
import {
  agentGitLaunchFor,
  agentUidFor,
  launchesAgents,
  prepareAgentPath,
} from "./agent-isolation.server";
import { removeAgentTreeSync } from "./agent-trees.server";
import { patchRun, type AgentRunRow } from "./run-store.server";
import type { RealBackend } from "./runtime-registry.server";
import { getBackendAccount } from "./backend-credentials.server";
import {
  backendAccountHome,
  codexCompactionHomeId,
  codexRunHomeDir,
  finishCodexRunHome,
  userBackendHome,
} from "./user-homes.server";
import type { TaskFileRef } from "~/server/files/task-writer.server";
import { toError } from "~/shared/errors";

/**
 * Crash-loop backstop for the boot recovery re-invoke (F7-BOOT1). A boot that
 * finalizes a real orphan re-fires the operator; if that operator run itself
 * crashes the process, the NEXT boot re-orphans it and re-fires again — a loop
 * that re-runs real, costed operator coordination on every restart. We cap the
 * re-invokes per task inside a rolling window: each actual re-invoke records an
 * audit row, and once `RECOVERY_REINVOKE_CAP` rows exist for a task within
 * `RECOVERY_WINDOW_MS`, further boots still finalize the orphan row but SKIP the
 * operator re-invoke. A restart that lands after the window has elapsed sees a
 * clean count and re-invokes normally (the common single-boot case).
 */
export const RECOVERY_REINVOKE_CAP = 3;
const RECOVERY_WINDOW_MS = 30 * 60 * 1000;
const RECOVERY_REINVOKE_ACTION = "run.recovery.reinvoked";
/** Same crash-loop backstop for the reply-recovery re-invoke path (below). */
const RECOVERY_REPLAY_ACTION = "run.recovery.reply_replayed";
/**
 * The audit fact `executeCodexPlan` writes before it takes up a plan
 * (operator-codex-plan). Its absence on a FINISHED codex operator run is what
 * marks that turn as stranded (P14-RT-08).
 */
const OPERATOR_PLAN_EXECUTED_ACTION = "runtime.operator.plan_executed";
/**
 * How long after a codex operator run finished its plan may still be replayed.
 * The stranding window is seconds (finish → in-process callback); a boot that
 * happens hours later is not recovering a dropped turn, it is re-deciding an old
 * one against state that has moved.
 */
const STRANDED_PLAN_MAX_AGE_MS = 60 * 60 * 1000;

/** What one boot's orphan sweep did. */
export interface OrphanFinalization {
  /** Non-terminal run rows moved to `interrupted` with reason `restart`. */
  finalized: number;
  /** Orphaned tasks for which the operator was re-invoked this boot. */
  reinvoked: number;
  /** Orphaned tasks whose re-invoke was skipped by the crash-loop cap. */
  capped: number;
  /**
   * The re-invokes this sweep LAUNCHED, joinable.
   *
   * A re-invoked operator drive clones `<taskDir>/workspace/<repo>`, and boot's
   * workspace reclaim deletes exactly those directories on the claim that no
   * run of this process holds a working tree — a claim only a caller that can
   * WAIT for these can honour. Already settled when nothing was re-invoked, and
   * it never rejects: each re-invoke is caught per task.
   */
  reinvokes: Promise<void>;
  /**
   * Ruling 174: the sweep of whatever the orphans' processes left alive,
   * joinable for the same reason. A run's Claude CLI leads its own process
   * group, so a server that died without shutting down does not take it along,
   * and a survivor could still be writing the working tree the reclaim
   * deletes. Never rejects.
   */
  reaped: Promise<void>;
  /**
   * Ruling 177 / U36-8 (pass 36): the "Interrupted by a restart" notes, one per
   * orphaned task, joinable so a caller (and a test) can read the task file
   * after they landed. Never rejects: each note is caught per task.
   */
  notes: Promise<void>;
  /**
   * Ruling 215: the tasks this sweep took, `<projectSlug>/<taskKey>` keyed.
   *
   * These tasks HAD a live run when the server stopped, and this pass owns
   * their recovery — including its own re-invoke, which is launched after the
   * later passes run. It flips their runs terminal first, so without this list
   * `settleAbandonedWaits` sees "waiting on an agent, no live run", which is
   * the one thing that was NOT true of them.
   */
  claimedTasks: ReadonlySet<string>;
}

export interface FinalizeOrphanedRunsDeps {
  /** Ruling 177 / U36-8: the data root the restart notes are written under
   *  (the process default when omitted, as boot calls it). */
  dataRoot?: string;
  /** The sweep (default: the real one), injectable so a test can see which
   *  runs it was asked to reap. */
  reapProcesses?: ReapRunProcesses;
  /** The operator re-invoke (default: the real `runOperator`), replaceable the
   *  way every other operator hand-off's is (`ctx.deps.runOperator`). */
  runOperator?: typeof runOperator;
}

/**
 * Boot-time finalization of non-terminal runs.
 *
 * A run row is written `running`/`queued` while its adapter drives it in THIS
 * process. On a fresh boot there is by definition no live handle for any prior
 * run, so a run still in a non-terminal state has no process behind it — a
 * ticking ELAPSED and an "agent working" badge with nothing real running,
 * indistinguishable from live work. Every orphan becomes `interrupted` with
 * `interrupted_reason: 'restart'` (pass 35 U35-7: the state the human-interrupt
 * path already uses, and a reason rather than a pseudo-user in
 * `interrupted_by`, which stays a user id or null), and the operator is
 * re-invoked for each affected task so it can recover instead of stalling
 * forever. The run projection reads the reason as "interrupted by a restart";
 * Insights keeps such a run out of the error count, and a queued one that never
 * executed a turn out of the completion denominator.
 *
 * Idempotent: a second boot finds nothing non-terminal.
 *
 * "No process behind it" is made true rather than assumed (ruling 174): every
 * process an orphan started carries its run id, and the sweep signals what is
 * still alive, so a CLI the dead server left running stops before its row is
 * reported interrupted and its workspace reclaimed.
 */
/**
 * Ruling 198: tell the task's OWNER that the crash-loop guard stopped, so a
 * stranded task is a message rather than a silence. Best-effort by design — a
 * task with no owner has nobody to tell, and a failure here must never take
 * boot recovery down with it.
 */
function notifyCappedTask(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
  /** Ruling 497: the restart note's time, so the row opens on it. */
  noteAt: string,
): void {
  try {
    // SAFETY: `owner_user_id` is a declared column of `task_projections`
    // (0001_baseline); the SELECT names it and nothing else, and `.get`
    // returns undefined when the row is absent.
    const row = db
      .prepare(
        `SELECT owner_user_id FROM task_projections WHERE project_slug = ? AND task_key = ?`,
      )
      .get(projectSlug, taskKey) as { owner_user_id: string | null } | undefined;
    const userId = row?.owner_user_id;
    if (!userId) return;
    createNotification(db, {
      userId,
      kind: "policy",
      title: `${taskKey} is waiting for you after a restart`,
      text:
        "A restart interrupted this task's run, and Viberr did not re-invoke the operator for it: " +
        `it had already done so ${RECOVERY_REINVOKE_CAP} times within 30 minutes, which is its ` +
        "crash-loop guard. Run the operator from the task page when you are ready.",
      projectSlug,
      taskKey,
      href: taskEventLink(projectSlug, taskKey, noteAt),
    });
  } catch (error) {
    logger.warn("capped-recovery notification failed", {
      taskKey,
      err: toError(error),
    });
  }
}

export function finalizeOrphanedRuns(
  db: DatabaseSync,
  deps: FinalizeOrphanedRunsDeps = {},
): OrphanFinalization {
  // SAFETY: every column named here is declared NOT NULL TEXT on `agent_runs`
  // (db/migrations/0001_baseline.sql), so each row carries exactly these four
  // string fields.
  // (`backend` is NOT NULL too; `credential_user_id` and `started_at` are
  // nullable — a row written before ruling 127 carries no credential, and a run
  // that never got a concurrency slot never got a start.)
  const orphans = db
    .prepare(
      `SELECT id, project_slug, task_key, kind, backend, credential_user_id,
              credential_account_id, started_at, agent_profile_id, role
         FROM agent_runs
        WHERE state IN ('running', 'queued')`,
    )
    .all() as {
    id: string;
    project_slug: string;
    task_key: string;
    kind: string;
    backend: string;
    /** Ruling 567: the agent whose saved files the restart must not orphan. */
    agent_profile_id: string | null;
    role: string | null;
    credential_user_id: string | null;
    /** Ruling 507: nullable — a run from before the ruling, or a refused one. */
    credential_account_id: string | null;
    /** Ruling 310(b): null for a run that never got a concurrency slot. */
    started_at: string | null;
  }[];
  if (orphans.length === 0) {
    return {
      finalized: 0,
      reinvoked: 0,
      capped: 0,
      reinvokes: Promise.resolve(),
      reaped: Promise.resolve(),
      notes: Promise.resolve(),
      claimedTasks: new Set<string>(),
    };
  }

  const reapProcesses = deps.reapProcesses ?? reapRunProcesses;
  // Ruling 376: an epilogue interrupted by the restart carries its own marker.
  const reaped = reapProcesses({
    runIds: orphans.flatMap((run) => [run.id, compactionRunId(run.id)]),
  }).then(
    () => {},
    (error) => {
      logger.warn("reaping the orphaned runs' processes failed", {
        err: toError(error),
      });
    },
  );

  const now = new Date().toISOString();
  const realTasks = new Map<string, { projectSlug: string; taskKey: string }>();
  // Ruling 310(b): `started` too. The sweep finalizes QUEUED runs as well as
  // running ones, and the note used to call every one of them "still running
  // when the server stopped" — false for a run that never got a slot.
  const runsByTask = new Map<
    string,
    {
      id: string;
      kind: string;
      started: boolean;
      backend: string;
      profileId: string | null;
      role: string | null;
    }[]
  >();
  for (const run of orphans) {
    // Ruling 181 (pass 36): a Codex run's private CODEX_HOME is finished by the
    // adapter's settle — which a process that died never reached. Live
    // 19:48Z: two restart-orphaned developer runs still owned
    // `codex-home/runs/<runId>/`, each with a copy of the person's sign-in.
    // Finish them here exactly as the settle would: the refreshed `auth.json`
    // written back when its bytes changed, the directory removed.
    if (run.backend === "codex" && run.credential_user_id) {
      const sharedHome = userBackendHome(run.credential_user_id, "codex", deps.dataRoot);
      // Ruling 460: the write-back is the server's file, handed back to the
      // person's uid like the adapter's settle does; ruling 485: the run home
      // their CLI wrote is removed as them.
      const principal = run.credential_user_id;
      const person = launchesAgents()
        ? {
            own: (target: string) => prepareAgentPath(agentUidFor(db, principal), target),
            remove: (target: string) =>
              removeAgentTreeSync(target, agentGitLaunchFor(db, principal, deps.dataRoot)),
          }
        : undefined;
      // Ruling 507: the refreshed sign-in goes back to the account the run
      // billed. A run from before the ruling billed the one account there was,
      // whose sign-in sits in the shared home; an account removed since then
      // gets nothing back (its home is gone, and the write-back refuses to
      // resurrect a sign-in the person removed).
      const account = run.credential_account_id
        ? getBackendAccount(db, principal, run.credential_account_id)
        : null;
      const authHome = !run.credential_account_id
        ? sharedHome
        : account
          ? backendAccountHome(principal, "codex", account, deps.dataRoot)
          : backendAccountHome(
              principal,
              "codex",
              { id: run.credential_account_id, legacyHome: false },
              deps.dataRoot,
            );
      // The run's own home, and its completion compaction's when the restart
      // landed during that epilogue (ruling 376), each finished like a settle.
      for (const id of [run.id, codexCompactionHomeId(run.id)]) {
        const dir = codexRunHomeDir(sharedHome, id);
        if (existsSync(dir)) finishCodexRunHome({ dir, sharedHome, authHome, runId: id }, person);
      }
    }
    patchRun(db, run.id, {
      state: "interrupted",
      finishedAt: now,
      interruptedReason: "restart",
      phase: null,
      step: null,
    });
    // Ruling 99: a controller conversation turn carries no task — there is no
    // operator to re-invoke for it. Its own recovery (an honest "interrupted
    // by a restart" note on the conversation) lives in controller-run.
    if (run.kind === "controller") continue;
    const taskId = `${run.project_slug}/${run.task_key}`;
    realTasks.set(taskId, {
      projectSlug: run.project_slug,
      taskKey: run.task_key,
    });
    runsByTask.set(taskId, [
      ...(runsByTask.get(taskId) ?? []),
      {
        id: run.id,
        kind: run.kind,
        started: run.started_at !== null,
        backend: run.backend,
        profileId: run.agent_profile_id,
        role: run.role,
      },
    ]);
  }
  // Ruling 198 (F37-19): the cap decision is taken BEFORE the restart note is
  // written, because the note used to promise "the operator is re-invoked to
  // decide what to do next" on EVERY orphaned task — including the ones this
  // loop had already decided to skip. A capped task therefore carried a
  // promise Viberr had structurally chosen not to keep, kept `waiting:
  // "agent"` with no agent alive, and nothing ever revisited it: live, SHOP-7
  // sat that way for two hours with the board and the review queue both
  // showing "agent working".
  //
  // The note says what THIS decision was and stops there. It does not say
  // "nothing further happens on its own", which the first draft did and which
  // is not Viberr's to promise: `recoverUnreactedAgentRuns` below runs the
  // completion effects of a finished-but-unreacted run — including an
  // `agent-reply` operator turn — under its own separate cap, so the same boot
  // can still coordinate a task this loop skipped.
  // Re-invoke the operator only for tasks under the crash-loop cap. The gate is resolved
  // synchronously — each pass records its own audit row so the NEXT boot counts
  // it — then the (costly) operator runs fire-and-forget for the survivors.
  const windowStart = new Date(Date.now() - RECOVERY_WINDOW_MS).toISOString();
  const toReinvoke: { projectSlug: string; taskKey: string }[] = [];
  /** Ruling 198: the tasks a turn IS coming for, keyed as `realTasks` keys it. */
  const reinvoking = new Set<string>();
  let capped = 0;
  for (const t of realTasks.values()) {
    // SAFETY: `COUNT(*)` always returns exactly one row holding one integer.
    const priorReinvokes = (
      db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM audit_events
            WHERE action = ?
              AND project_slug = ?
              AND task_key = ?
              AND occurred_at >= ?`,
        )
        .get(
          RECOVERY_REINVOKE_ACTION,
          t.projectSlug,
          t.taskKey,
          windowStart,
        ) as { n: number }
    ).n;
    if (priorReinvokes >= RECOVERY_REINVOKE_CAP) {
      capped += 1;
      logger.warn("recovery re-invoke capped (crash-loop backstop)", {
        taskKey: t.taskKey,
        projectSlug: t.projectSlug,
        priorReinvokes,
        cap: RECOVERY_REINVOKE_CAP,
      });
      continue;
    }
    recordAudit(db, {
      // String literal (not RECOVERY_REINVOKE_ACTION) so the audit-coverage
      // static sweep can parse this call site; the SQL count above still uses
      // the constant. Both must stay in sync with the catalog entry.
      action: "run.recovery.reinvoked",
      actor: SYSTEM_ACTOR,
      subjectKind: "task",
      subjectId: t.taskKey,
      projectSlug: t.projectSlug,
      taskKey: t.taskKey,
      details: { attempt: priorReinvokes + 1 },
    });
    toReinvoke.push(t);
    reinvoking.add(`${t.projectSlug}/${t.taskKey}`);
  }

  // Ruling 177 / U36-8 (pass 36): the task file said NOTHING about a restart
  // cutting its runs — the re-fired operator's directive was the first trace.
  // One policy note per task names every run the restart ended, before the
  // operator is re-invoked below (so the note precedes the turn it explains).
  const notes: Promise<void> = (async () => {
    if (realTasks.size === 0) return;
    const { appendTimelineEvent } = await import("~/server/files/task-writer.server");
    const { rebuildPath } = await import("~/server/projections/rebuilder.server");
    const { resolveTaskFilePath } = await import("~/server/files/task-writer.server");
    for (const [taskId, t] of realTasks) {
      const runs = runsByTask.get(taskId) ?? [];
      const ref = deps.dataRoot ? { ...t, dataRoot: deps.dataRoot } : t;
      // Ruling 662: an agent run by its role. The kind called every
      // supporting agent a "reviewer" (F31-C7: the kind says only whether the
      // run delivers), so the Cloud Solutions Architect read as one.
      const label = (r: { id: string; kind: string; role: string | null }): string =>
        `\`${r.id}\` (${r.kind === "operator" ? "operator" : (r.role ?? "agent")})`;
      // Ruling 310(b): a run that never got a concurrency slot was not running,
      // and saying it was is the same defect as ruling 311's "Started". The
      // controller found this one by joining the timeline against the run
      // records: `run_VlR9mwnxyouc` carried `startedAt: null, turns: 0` and the
      // restart note called it still running. `started_at` is the fact, kept on
      // the row permanently, and this writer had it in hand.
      const ran = runs.filter((r) => r.started);
      const never = runs.filter((r) => !r.started);
      // Ruling 567: an agent run the restart cut off gets the effects a
      // person's Stop would have given it, before the note: its last words and
      // the files it saved are posted under its name, and a deliverer's files
      // are recorded as the delivery. Live on AWSC-7 the Calculator Builder had
      // saved every result file when a deploy cut its run; the files belonged
      // to nobody and `deliveredAt` stayed null, so the required reviewer's
      // gate read "nothing delivered", the move to Review offered acceptance
      // before the Judge had started, and its verdict could bind to nothing.
      for (const r of ran) {
        if ((r.kind !== "primary" && r.kind !== "reviewer") || !r.profileId) continue;
        await replayInterruptedAgentRun(db, deps, t, r);
      }
      const clause = (rs: typeof runs, tail: string): string =>
        `${rs.length === 1 ? "the run" : `${rs.length} runs`} ${rs.map(label).join(", ")} ${
          rs.length === 1 ? "was" : "were"
        } ${tail}`;
      const what = [
        ran.length ? clause(ran, "still running when the server stopped") : "",
        never.length
          ? clause(never, "queued behind the concurrent-run cap and had not started")
          : "",
      ]
        .filter(Boolean)
        .join("; ");
      try {
        const noteAt = new Date().toISOString();
        await appendTimelineEvent(ref, {
          occurredAt: noteAt,
          type: "note",
          actor: { kind: "system", systemId: "policy-engine" },
          title: "Interrupted by a restart",
          text:
            `**Restart:** ${what}; ` +
            `${runs.length === 1 ? "it is" : "they are"} recorded as interrupted by the restart` +
            (reinvoking.has(taskId)
              ? ", and the operator is re-invoked to decide what to do next."
              : // Ruling 198: the honest other half. Say what Viberr decided,
                // why, and what the person can do — the cap is a guard
                // against a crash loop, not a judgement about this task.
                ". Viberr did NOT re-invoke the operator for it: it had already done so " +
                `${RECOVERY_REINVOKE_CAP} times for this task within the last 30 minutes, which is its ` +
                "crash-loop guard. Run the operator from this page when you are ready."),
          toAgent: false,
          evidence: null,
        });
        rebuildPath(db, resolveTaskFilePath(ref), deps.dataRoot ? { dataRoot: deps.dataRoot } : {});
        if (!reinvoking.has(taskId)) {
          // Ruling 198: the note alone would still leave the BOARD claiming an
          // agent is on it. `clearWaitingToHuman` is a no-op unless the flag is
          // `agent`, and with no packet and a live stage it settles to
          // `human` — which is the truth: nobody is coming until a person acts.
          const { clearWaitingToHuman } = await import("~/server/tasks/agent-completion.server");
          await clearWaitingToHuman(
            db,
            deps.dataRoot ? { dataRoot: deps.dataRoot } : {},
            t.projectSlug,
            t.taskKey,
          );
          rebuildPath(db, resolveTaskFilePath(ref), deps.dataRoot ? { dataRoot: deps.dataRoot } : {});
          notifyCappedTask(db, t.projectSlug, t.taskKey, noteAt);
        }
      } catch (error) {
        logger.warn("restart note failed", {
          taskKey: t.taskKey,
          err: toError(error),
        });
      }
    }
  })();
  logger.info("finalized non-terminal runs at boot", {
    total: orphans.length,
  });

  let reinvokes: Promise<void> = Promise.resolve();
  if (toReinvoke.length > 0) {
    reinvokes = (async () => {
      // Ruling 567: after the notes, so the operator reads a delivery the
      // replay above recorded and the note that says why it ran again.
      await notes;
      const reinvoke = deps.runOperator ?? (await import("./operator-run.server")).runOperator;
      for (const t of toReinvoke) {
        try {
          const input: Parameters<typeof reinvoke>[1] = {
            projectSlug: t.projectSlug,
            taskKey: t.taskKey,
            trigger: "manual",
          };
          // The root the notes above were written under (the process default
          // at boot, which passes none).
          if (deps.dataRoot) input.dataRoot = deps.dataRoot;
          await reinvoke(db, input);
        } catch (error) {
          logger.warn("operator re-invoke after orphan finalize failed", {
            taskKey: t.taskKey,
            err: toError(error),
          });
        }
      }
    })().catch(() => {});
  }

  return {
    finalized: orphans.length,
    reinvoked: toReinvoke.length,
    capped,
    reinvokes,
    reaped,
    notes,
    // Ruling 215: EVERY task this sweep took, capped ones included. A capped
    // task is one this pass decided about; it is still not a task that had no
    // run when the server came back.
    claimedTasks: new Set(realTasks.keys()),
  };
}

/**
 * Ruling 567: the completion effects of one agent run a restart cut off, as
 * `state: "interrupted"` (what a person's Stop gets): the reply and the files
 * the run saved, posted under its name. Ruling 601: never as the delivery,
 * which only a run that finished reports. A replay, so no
 * deferred @mention is redelivered (ruling 211(c)); an interrupted run never
 * reacts, so the operator re-invoke below stays the only one. Best-effort: a
 * failure is logged and the restart note still lands.
 */
async function replayInterruptedAgentRun(
  db: DatabaseSync,
  deps: FinalizeOrphanedRunsDeps,
  t: { projectSlug: string; taskKey: string },
  r: { id: string; kind: string; backend: string; profileId: string | null; role: string | null },
): Promise<void> {
  if (!r.profileId) return;
  try {
    const [{ applyAgentCompletionEffects }, { agentMentionHandle }] = await Promise.all([
      import("~/server/tasks/agent-completion.server"),
      import("~/server/tasks/agent-reply.server"),
    ]);
    await applyAgentCompletionEffects(
      db,
      deps.dataRoot ? { dataRoot: deps.dataRoot } : {},
      {
        projectSlug: t.projectSlug,
        taskKey: t.taskKey,
        backend: r.backend === "codex" ? "codex" : "claude",
        profileId: r.profileId,
        role: r.role ?? "",
        delivers: r.kind === "primary",
        workdir: null,
        agentHandle: agentMentionHandle({ profileId: r.profileId }),
        replayed: true,
      },
      { id: r.id, state: "interrupted" },
    );
  } catch (error) {
    logger.warn("replaying a restart-interrupted run's effects failed", {
      runId: r.id,
      taskKey: t.taskKey,
      err: toError(error),
    });
  }
}

/**
 * Boot-time recovery of dropped agent-reply reactions (NFR17, B9).
 *
 * A finished specialist/reviewer run posts its reply and re-invokes the operator
 * through an IN-PROCESS completion callback (run-service `registerRunCompletion`).
 * If the server restarts after a run finished but before its callback fired, the
 * reply is never posted and the operator never reacts — the task stalls at
 * waiting=agent forever with no error. This reconciler runs once at boot and
 * recovers those runs: for each finished specialist/reviewer
 * run whose task is still waiting=agent and which never recorded a
 * `task.agent.replied` audit row, it posts the missing reply and re-invokes the
 * operator to react — exactly what the lost callback would have done.
 *
 * Safe by construction:
 *  - Only a live stall, not old history: the task is `waiting = 'agent'`, OR the
 *    run carries a `run.completion.effects_lost` audit row (ruling 207(a)). That
 *    second arm exists because `noteCompletionEffectsLost` flips the task to
 *    `waiting = "human"` in the SAME write as the note promising this replay —
 *    honest about the board, and self-defeating about the recovery, until the
 *    selection stopped keying on the flag alone.
 *  - Idempotent: `postAgentReplyComment` writes the `task.agent.replied` audit
 *    row, so a recovered run is not reprocessed on the next boot.
 *  - Fire-and-forget per run; one failure never blocks the others or boot.
 *  - Crash-loop backstop (mirrors `finalizeOrphanedRuns`): recovery re-invokes
 *    the operator via `applyAgentCompletionEffects`. If the reply-comment write
 *    keeps failing (so the `task.agent.replied` idempotency audit never lands),
 *    the run is re-selected on EVERY boot and re-fires costed operator
 *    coordination — a tight boot→recover→crash loop if that operator run itself
 *    kills the process. Each replay records a `run.recovery.reply_replayed` audit
 *    row BEFORE running the effects; once `RECOVERY_REINVOKE_CAP` rows exist for a
 *    run within `RECOVERY_WINDOW_MS`, further boots SKIP that run (logged) instead
 *    of re-firing. A restart after the window elapses sees a clean count.
 */
/**
 * Ruling 317(b): what the restart can actually SAY about a task left waiting.
 *
 * The sweep's own SELECT proves one thing — `waiting = 'agent'` and no run in
 * `running` or `queued`. The note asserted three more: that a run existed, that
 * it "finished just before the stop", and that "nothing was lost from the
 * record". None was checked, and the first is often false: a dispatch HELD on
 * quota records the wait without ever starting a run.
 *
 * Live on SHOP-37 the two entries sit fifteen minutes apart. 09:15:13 —
 * "**Held:** Codex is out of quota... **nothing was dispatched** and no
 * decision is needed." 09:30:29 — "the run finished just before the stop". The
 * first says no run was dispatched; the second says a run finished.
 *
 * This is the class ruling 310(b) named, in the neighbouring sweep of the same
 * file, which its own commit message quoted the controller on: "One writer
 * fixed, its neighbour still inventing." This is the neighbour.
 */
function abandonedWaitNote(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): string {
  const head =
    "**Restart:** this task was waiting on an agent, and no run was live when the server came back. ";
  /**
   * Ruling 337(b): the board fact is certain; the re-invoke is an intention.
   *
   * This asserted the re-invoke as done, and it is written BEFORE `runOperator`
   * is called — so a refusal (no operator deployed, a closed task, an open
   * packet) leaves a note claiming a turn that never happened, which is the
   * unconditional promise ruling 198 removed from the sibling orphan sweep. The
   * `!result.runId` branch clears `waiting` but does not correct the sentence.
   */
  const tail =
    " The board has stopped claiming an agent, and Viberr is invoking the operator to decide " +
    "what happens next; if no operator can run, this task is waiting on a person.";
  // SAFETY: `agent_runs` declares `id`, `state` and `kind` TEXT NOT NULL
  // (0001_baseline); `finished_at` and `started_at` are nullable.
  const last = db
    .prepare(
      `SELECT id, state, started_at, finished_at
         FROM agent_runs
        WHERE project_slug = ? AND task_key = ? AND kind <> 'operator'
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(projectSlug, taskKey) as
    | { id: string; state: string; started_at: string | null; finished_at: string | null }
    | undefined;

  if (!last) {
    return (
      `${head}No agent run has ever been started on it, so nothing was interrupted and nothing ` +
      `was lost; the wait was recorded without a dispatch ever reaching a process.${tail}`
    );
  }
  if (last.started_at === null) {
    return (
      `${head}Its most recent run \`${last.id}\` never started: it was ${last.state} and had ` +
      `no process, so there is no work to have lost.${tail}`
    );
  }
  const when = last.finished_at ? ` at ${last.finished_at}` : "";
  return (
    `${head}The run it was waiting for, \`${last.id}\`, ended${when} (${last.state}), and the ` +
    `follow-up that would have moved the task did not run, which is why the wait outlived it. ` +
    `The run's own record is intact; what is missing is the step after it.${tail}`
  );
}

/**
 * Ruling 213: settle a task the restart left waiting on an agent that is not
 * there.
 *
 * Every other boot path keys on a RUN: `finalizeOrphanedRuns` takes the ones
 * still `running`/`queued`, `recoverUnreactedAgentRuns` the finished ones whose
 * reply never landed, `recoverStrandedOperatorPlans` the Codex plans that never
 * executed. None of them covers the window this closes — an operator drive that
 * COMPLETED cleanly and whose settle (the waiting flip, and the stranded-stage
 * backstop that would have nudged it) was still in flight when the process
 * died. The run row is `finished`, its reply is not missing, its plan ran. The
 * only trace is a task whose board says an agent is working and whose runs are
 * all over.
 *
 * Live: SHOP-4's operator moved it Review → Build at 18:57:34 and the container
 * restarted at 18:57:35. Six minutes later the board still said "agent
 * working", nothing was running, and no boot sweep had any reason to look at
 * it.
 *
 * The remedy is the one `finalizeOrphanedRuns` already uses for its own case:
 * say so on the timeline and re-invoke the operator, which re-reads the task
 * and decides. A project with no operator deployed settles the flag instead, so
 * the board stops claiming work that is not happening.
 */
export async function settleAbandonedWaits(
  db: DatabaseSync,
  ctx: TaskMutationContext = {},
  /**
   * Ruling 215: `<projectSlug>/<taskKey>` for every task the orphan sweep took
   * this boot. Those tasks DID have a live run at the stop and that pass owns
   * them; it just flipped their rows terminal, so the SELECT below would see
   * them as abandoned and write a note saying the one thing that was not true.
   */
  claimedByOrphanSweep: ReadonlySet<string> = new Set<string>(),
): Promise<number> {
  // SAFETY: `project_slug` and `task_key` are NOT NULL TEXT on
  // `task_projections` (0001_baseline.sql); the WHERE clause adds no columns.
  const rows = db
    .prepare(
      `SELECT t.project_slug AS slug, t.task_key AS key
         FROM task_projections t
         JOIN projects p ON p.slug = t.project_slug
        WHERE p.archived = 0
          AND t.archived = 0
          AND t.waiting = 'agent'
          AND NOT EXISTS (
            SELECT 1 FROM agent_runs r
             WHERE r.project_slug = t.project_slug
               AND r.task_key = t.task_key
               AND r.state IN ('running', 'queued')
          )`,
    )
    .all() as { slug: string; key: string }[];
  const abandoned = rows.filter(
    (r) => !claimedByOrphanSweep.has(`${r.slug}/${r.key}`),
  );
  if (abandoned.length === 0) return 0;
  logger.info("settling tasks the restart left waiting on an absent agent", {
    tasks: abandoned.length,
    claimedByOrphanSweep: rows.length - abandoned.length,
  });
  const [{ appendTimelineEvent }, { runOperator }, { clearWaitingToHuman }] =
    await Promise.all([
      import("~/server/files/task-writer.server"),
      import("./operator-run.server"),
      import("~/server/tasks/agent-completion.server"),
    ]);
  const { readTaskFile } = await import("~/server/files/task-writer.server");
  /**
   * Ruling 337(c): the count it SETTLED, not the count it looked at.
   *
   * This returned `rows.length` — the raw projection result — so it already
   * over-reported whenever `claimedByOrphanSweep` filtered some but not all
   * (the ruling-215 test passes only because that case filters ALL of them and
   * takes the early return). With the file re-read above, the gap is the normal
   * case: the number a boot log or a test reads has to be the number of tasks
   * this sweep actually spoke on.
   */
  let settled = 0;
  for (const row of abandoned) {
    const ref: TaskFileRef = { projectSlug: row.slug, taskKey: row.key };
    if (ctx.dataRoot) ref.dataRoot = ctx.dataRoot;
    /**
     * Ruling 337: the projection is the index; the FILE is the record, and the
     * file is where the reason for the quiet lives.
     *
     * This sweep selected entirely on `t.waiting = 'agent'` with no live run
     * and never opened the task. So a dispatch viberr ITSELF had parked was
     * swept as an abandoned wait — and unlike the read-only checks above, this
     * one writes a note and spends a paid operator turn.
     *
     * Live on SHOP-37, 2026-09-15, and it overrode a person:
     *   09:15:13.200  Arda: "Decision: Re-run the Integration Verifier on the
     *                 Codex backend."
     *   09:15:13.298  policy-engine, "Dispatch held": Codex is out of quota
     *                 until Sep 19; the run is scheduled for then; "nothing was
     *                 dispatched and no decision is needed."
     *   09:30:29.868  THIS SWEEP: "Left waiting on an absent agent… the run
     *                 finished just before the stop and the follow-up that
     *                 would have moved the task went with the process."
     *   09:32:25.171  the drive it forced: "a fresh-context re-run of your
     *                 pass, on the CLAUDE backend."
     *   09:39:19.846  Arda cancels, by hand, the schedule viberr had promised.
     * Every clause of that note was false on the task's own record, and the
     * consequence was not cosmetic: it reversed the owner's explicit backend
     * decision fifteen minutes after they made it.
     *
     * The guard is borrowed verbatim from `findStrandedTasks` (ruling 330,
     * shipped hours earlier), which re-reads the file for exactly these cases.
     * The older sweep does MORE and checked LESS.
     */
    const file = readTaskFile(ref);
    if (!file) continue;
    const fm = file.parsed.frontmatter;
    // The projection can lag the write that ended the wait.
    if (fm.archived || fm.waiting !== "agent") continue;
    // Each of these is silence the product already explains, and the release
    // engine, the schedule runner or a person owns it.
    if (file.parsed.packet) continue;
    if ((fm.blockedBy ?? []).length > 0) continue;
    if ((fm.queuedQuestions ?? []).length > 0) continue;
    if ((fm.schedules ?? []).some((sc) => sc.status === "pending")) continue;
    try {
      await appendTimelineEvent(ref, {
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: { kind: "system", systemId: "policy-engine" },
        title: "Left waiting on an absent agent",
        text: abandonedWaitNote(db, row.slug, row.key),
        toAgent: false,
        evidence: null,
      });
      const drive: Parameters<typeof runOperator>[1] = {
        projectSlug: row.slug,
        taskKey: row.key,
        trigger: "manual",
      };
      if (ctx.dataRoot) drive.dataRoot = ctx.dataRoot;
      const result = await runOperator(db, drive);
      // The operator may REFUSE rather than throw (none deployed, a closed
      // task, an open packet, the task waiting on other work). Either way no
      // run started, so the board must stop claiming an agent — the whole
      // reason this sweep exists.
      if (!result.runId) {
        await clearWaitingToHuman(db, ctx, row.slug, row.key);
      }
      settled += 1;
    } catch (error) {
      logger.warn("abandoned-wait settle failed", {
        taskKey: row.key,
        err: toError(error),
      });
      // The operator could not run (none deployed, a refusal): the board must
      // still stop claiming an agent is on it.
      await clearWaitingToHuman(db, ctx, row.slug, row.key).catch(() => {});
    }
  }
  return settled;
}

/**
 * The sweep's own "this run's reply never landed" clause, as ONE rule.
 *
 * F37-67: `noteCompletionEffectsLost` writes a note promising "Run recovery
 * replays the effects on the next restart" while this clause was excluding the
 * run permanently — `applyAgentCompletionEffects` records `task.agent.replied`
 * in its step 1 and can still reject in step 2 or step 4, which is the ONLY
 * shape that produces that note. Both readers take the clause from here now, so
 * the promise cannot say one thing while the query does another.
 *
 * `runIdExpr` is the SQL expression naming the run: a column in the sweep
 * (`r.id`), a bound `?` for one run.
 */
function replyNeverLandedSql(runIdExpr: string): string {
  return (
    `NOT EXISTS (
            SELECT 1 FROM audit_events a
             WHERE a.action = 'task.agent.replied'
               AND a.details_json LIKE '%"runId":"' || ${runIdExpr} || '"%'
          )`
  );
}

/**
 * Will the boot sweep replay this run's lost completion effects?
 *
 * Every condition `recoverUnreactedAgentRuns` acts on, for one run — the SELECT
 * above AND the two skips inside its loop, because a run that is selected and
 * then skipped is not replayed, whatever the query said.
 *
 * The `waiting = 'agent' OR effects_lost` arm is the one condition not modelled:
 * the only caller records its own `run.completion.effects_lost` row before
 * asking, which satisfies that arm by construction.
 */
export async function completionReplayWillRun(
  db: DatabaseSync,
  run: Pick<AgentRunRow, "id" | "kind" | "state" | "agent_profile_id" | "task_key">,
): Promise<boolean> {
  if (run.kind !== "primary" && run.kind !== "reviewer") return false;
  if (run.state !== "finished") return false;
  if (!run.agent_profile_id) return false;
  // SAFETY: a bare `SELECT <expr>` with no FROM returns exactly one row, and
  // SQLite renders a NOT EXISTS predicate as the integer 1 or 0.
  const stillOwed = db
    .prepare(`SELECT ${replyNeverLandedSql("?")} AS owed`)
    .get(run.id) as { owed: number } | undefined;
  if (stillOwed?.owed !== 1) return false;
  // The loop's first skip: no readable reply means nothing to replay, and it
  // `continue`s BEFORE recording its attempt — so the run is counted in the
  // "recovering dropped agent-reply reactions" log line and then quietly
  // dropped. A note promising a replay here would be wrong in a way nothing
  // downstream ever corrects.
  const { replyTextForRun } = await import("~/server/tasks/agent-reply.server");
  if (!replyTextForRun(db, run.id)) return false;
  // The crash-loop backstop: at the cap, further boots skip this run entirely.
  // SAFETY: `COUNT(*)` always returns exactly one row holding one integer.
  const priorReplays = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM audit_events
          WHERE action = ?
            AND task_key = ?
            AND details_json LIKE '%"runId":"' || ? || '"%'
            AND occurred_at >= ?`,
      )
      .get(
        RECOVERY_REPLAY_ACTION,
        run.task_key,
        run.id,
        new Date(Date.now() - RECOVERY_WINDOW_MS).toISOString(),
      ) as { n: number }
  ).n;
  return priorReplays < RECOVERY_REINVOKE_CAP;
}

export async function recoverUnreactedAgentRuns(
  db: DatabaseSync,
  ctx: TaskMutationContext = {},
): Promise<{ recovered: number; capped: number }> {
  // SAFETY: every selected column but `outcome_key` and the two `dispatched_by_*`
  // columns is NOT NULL on `agent_runs`, and `backend` carries
  // `CHECK (backend IN ('claude', 'codex'))` — the two members of `RealBackend`
  // (db/migrations/0001_baseline.sql).
  const rows = db
    .prepare(
      `SELECT r.id, r.project_slug, r.task_key, r.backend, r.role, r.kind,
              r.agent_profile_id, r.outcome_key,
              r.dispatched_by_name, r.dispatched_by_user_id
         FROM agent_runs r
         JOIN task_projections t
           ON t.project_slug = r.project_slug AND t.task_key = r.task_key
        WHERE r.kind IN ('primary', 'reviewer')
          AND r.state = 'finished'
          AND r.agent_profile_id IS NOT NULL
          AND (
            t.waiting = 'agent'
            OR EXISTS (
              SELECT 1 FROM audit_events e
               WHERE e.action = 'run.completion.effects_lost'
                 AND e.details_json LIKE '%"runId":"' || r.id || '"%'
            )
          )
          AND ${replyNeverLandedSql("r.id")}`,
    )
    .all() as {
    id: string;
    project_slug: string;
    task_key: string;
    backend: RealBackend;
    role: string;
    kind: string;
    agent_profile_id: string;
    outcome_key: string | null;
    dispatched_by_name: string | null;
    dispatched_by_user_id: string | null;
  }[];

  if (rows.length === 0) return { recovered: 0, capped: 0 };
  logger.info("recovering dropped agent-reply reactions after restart", {
    count: rows.length,
  });

  const [{ applyAgentCompletionEffects }, { agentMentionHandle, replyTextForRun }] =
    await Promise.all([
      import("~/server/tasks/agent-completion.server"),
      import("~/server/tasks/agent-reply.server"),
    ]);

  const windowStart = new Date(Date.now() - RECOVERY_WINDOW_MS).toISOString();
  let recovered = 0;
  let capped = 0;
  for (const row of rows) {
    try {
      const replyText = replyTextForRun(db, row.id);
      if (!replyText) continue;
      // Crash-loop backstop (see docstring): count prior replays for THIS run in
      // the rolling window; once at the cap, skip re-firing costed operator
      // coordination. The count keys on runId (in details_json) so distinct runs
      // on the same task each get their own budget — never a shared task counter.
      // SAFETY: `COUNT(*)` always returns exactly one row holding one integer.
      const priorReplays = (
        db
          .prepare(
            `SELECT COUNT(*) AS n
               FROM audit_events
              WHERE action = ?
                AND task_key = ?
                AND details_json LIKE '%"runId":"' || ? || '"%'
                AND occurred_at >= ?`,
          )
          .get(RECOVERY_REPLAY_ACTION, row.task_key, row.id, windowStart) as {
          n: number;
        }
      ).n;
      if (priorReplays >= RECOVERY_REINVOKE_CAP) {
        capped += 1;
        logger.warn("agent-reply recovery capped (crash-loop backstop)", {
          runId: row.id,
          taskKey: row.task_key,
          priorReplays,
          cap: RECOVERY_REINVOKE_CAP,
        });
        continue;
      }
      // Record the ATTEMPT before running effects so the next boot counts it even
      // if the effects (or the whole process) die mid-flight. String literal (not
      // RECOVERY_REPLAY_ACTION) so the audit-coverage static sweep can parse this
      // call site; the SQL count above uses the constant. Keep both in sync with
      // the catalog entry.
      recordAudit(db, {
        action: "run.recovery.reply_replayed",
        actor: SYSTEM_ACTOR,
        subjectKind: "task",
        subjectId: row.task_key,
        projectSlug: row.project_slug,
        taskKey: row.task_key,
        details: { runId: row.id, attempt: priorReplays + 1 },
      });
      // Run the SAME completion effects the lost in-process callback would have:
      // reply → workspace-delivery reconcile → (reviewer) verdict → operator
      // REACT (trigger `agent-reply`, fresh chain at depth 0) or stuck-packet/
      // waiting flip. A recovered reviewer run therefore records its verdict and
      // captures its branch/PR exactly like a live one.
      const completion: Parameters<typeof applyAgentCompletionEffects>[2] = {
        projectSlug: row.project_slug,
        taskKey: row.task_key,
        backend: row.backend,
        profileId: row.agent_profile_id,
        role: row.role,
        delivers: row.kind === "primary",
        workdir: null,
        // P14-RT-12: the ONE handle derivation every writer shares. The
        // role's first word ("Senior Developer" → `@senior`) resolved to no
        // agent at all, so a recovered run's stuck-packet observation named a
        // handle nobody could reply to.
        agentHandle: agentMentionHandle({ profileId: row.agent_profile_id }),
      };
      // AO-1: re-supply the staging key so the staged report_outcome envelope
      // (persisted in staged_outcomes) is consumed on recovery — a Claude
      // verdict survives a restart instead of falling back to the prose regex.
      // Left ABSENT, not undefined, when the run stored none.
      if (row.outcome_key) completion.outcomeKey = row.outcome_key;
      // C02-R11 (pass 32): the dispatch-completion contract survives the
      // restart too — the dispatcher is re-supplied from the row, so the
      // recovered report still carries its cc line and the operator is
      // re-invoked exactly as the lost in-process callback would have done.
      if (row.dispatched_by_name) {
        completion.dispatchedByName = row.dispatched_by_name;
        if (row.dispatched_by_user_id) {
          completion.dispatchedByUserId = row.dispatched_by_user_id;
        }
      }
      // Ruling 211(c): a replay is not the live completion. The deferred
      // @mention redelivery is a promise the LIVE refusal made, and this hop
      // may be running days later — re-delivering from the old run's window
      // would start a duplicate paid run on an instruction a human has since
      // had answered through a run of its own.
      completion.replayed = true;
      await applyAgentCompletionEffects(db, ctx, completion, {
        id: row.id,
        state: "finished",
      });
      recovered += 1;
    } catch (error) {
      logger.warn("agent-reply recovery failed for a run", {
        runId: row.id,
        taskKey: row.task_key,
        err: toError(error),
      });
    }
  }
  logger.info("agent-reply recovery complete", { recovered, capped });
  return { recovered, capped };
}

/**
 * Boot-time recovery of stranded CODEX operator plans (P14-RT-08).
 *
 * A Codex operator run does its coordination AFTER the provider run finishes:
 * the completion callback parses the structured plan and executes it through the
 * gated operator actions. That callback lives in the process, so a restart in
 * the window between `finished` and the plan running lost the entire turn with
 * no trace — the finished row is outside `finalizeOrphanedRuns` (running/queued
 * only) AND outside `recoverUnreactedAgentRuns` (primary/reviewer only), and the
 * task kept sitting at waiting=agent.
 *
 * Selection mirrors the reply reconciler: a finished codex operator run on a
 * task still waiting on an agent, with no `runtime.operator.plan_executed` audit
 * row. That row is written before the first governed action, so a plan that
 * merely CRASHED mid-execution is never re-run here — re-applying half a plan is
 * worse than leaving it, and the escalation paths inside the executor already
 * cover a plan that fails on its own terms.
 *
 * Bounded by `STRANDED_PLAN_MAX_AGE_MS`, because a plan is a decision ABOUT a
 * state: executing a day-old one against a task that has since moved would
 * duplicate an engagement or transition rather than recover anything. The window
 * this exists for is seconds long. Anything older is reported, never replayed.
 */
export async function recoverStrandedOperatorPlans(
  db: DatabaseSync,
  ctx: TaskMutationContext = {},
): Promise<{ recovered: number; stale: number }> {
  // SAFETY: the three id columns are NOT NULL TEXT on `agent_runs`;
  // `finished_at` is the one nullable column of the four.
  const rows = db
    .prepare(
      `SELECT r.id, r.project_slug, r.task_key, r.finished_at
         FROM agent_runs r
         JOIN task_projections t
           ON t.project_slug = r.project_slug AND t.task_key = r.task_key
        WHERE r.kind = 'operator'
          AND r.backend = 'codex'
          AND r.state = 'finished'
          AND t.waiting = 'agent'
          AND NOT EXISTS (
            SELECT 1 FROM audit_events a
             WHERE a.action = ?
               AND a.subject_id = r.id
          )`,
    )
    .all(OPERATOR_PLAN_EXECUTED_ACTION) as {
    id: string;
    project_slug: string;
    task_key: string;
    finished_at: string | null;
  }[];
  if (rows.length === 0) return { recovered: 0, stale: 0 };

  const cutoff = Date.now() - STRANDED_PLAN_MAX_AGE_MS;
  const fresh = rows.filter((r) => {
    const at = r.finished_at ? Date.parse(r.finished_at) : NaN;
    return Number.isFinite(at) && at >= cutoff;
  });
  const stale = rows.length - fresh.length;
  if (stale > 0) {
    logger.warn("stranded codex operator plans are too old to replay safely", {
      stale,
      maxAgeMs: STRANDED_PLAN_MAX_AGE_MS,
      taskKeys: rows
        .filter((r) => !fresh.includes(r))
        .map((r) => r.task_key),
    });
  }
  if (fresh.length === 0) return { recovered: 0, stale };

  logger.info("recovering stranded codex operator plans after restart", {
    count: fresh.length,
  });
  const { executeStrandedCodexPlan } = await import("./operator-run.server");
  let recovered = 0;
  for (const row of fresh) {
    try {
      const executed = await executeStrandedCodexPlan(db, ctx, {
        projectSlug: row.project_slug,
        taskKey: row.task_key,
        runId: row.id,
      });
      if (executed) recovered += 1;
    } catch (error) {
      logger.warn("codex operator plan recovery failed for a run", {
        runId: row.id,
        taskKey: row.task_key,
        err: toError(error),
      });
    }
  }
  logger.info("codex operator plan recovery complete", { recovered, stale });
  return { recovered, stale };
}
