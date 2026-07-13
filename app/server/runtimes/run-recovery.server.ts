import type Database from "better-sqlite3";
import { logger } from "~/server/logging/logger.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import type {
  AgentCompletionEffectsInput,
  TaskMutationContext,
} from "~/server/tasks/task-actions.server";
import { resumeWorkdir } from "~/server/tasks/agent-reply.server";
import { openSystemRecovery } from "~/server/tasks/task-recovery.server";
import type { SpecialistRunPurpose } from "~/features/runtime/runtime-types";
import type { RealBackend } from "./runtime-registry.server";
import { patchRun } from "./run-store.server";
import { stopRunForLifecycle } from "./run-service.server";
import {
  advanceRunCompletionPhase,
  readRunCompletionContext,
  runMatchesTaskIncarnation,
  RUN_COMPLETION_PHASE,
  withProjectCompletionEffect,
} from "./run-completion-state.server";

interface RecoverableSpecialistRow {
  id: string;
  project_slug: string;
  task_key: string;
  backend: string;
  role: string;
  kind: "primary" | "reviewer";
  agent_profile_id: string | null;
  run_purpose: SpecialistRunPurpose | null;
  review_evidence_fingerprint: string | null;
  review_head_sha: string | null;
  state: "finished" | "error" | "interrupted";
  simulated: number;
}

function roleHandle(role: string): string {
  return (
    role
      .trim()
      .split(/[\s/&]+/)[0]
      ?.toLowerCase() || "agent"
  );
}

function repositoryFor(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): string | null {
  const task = readTaskFile({
    projectSlug,
    taskKey,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  const project = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  return (
    task?.parsed.frontmatter.repo ?? project?.parsed.frontmatter.repo ?? null
  );
}

function runOwnsTask(
  db: Database.Database,
  ctx: TaskMutationContext,
  runId: string,
  projectSlug: string,
  taskKey: string,
): boolean {
  const project = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  if (!project || project.parsed.frontmatter.archived) return false;
  const task = readTaskFile({
    projectSlug,
    taskKey,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  return runMatchesTaskIncarnation(
    db,
    runId,
    task?.parsed.frontmatter.createdAt ?? null,
  );
}

function completionInput(
  db: Database.Database,
  ctx: TaskMutationContext,
  row: RecoverableSpecialistRow,
): AgentCompletionEffectsInput {
  const persisted = readRunCompletionContext(db, row.id);
  const repo = repositoryFor(ctx, row.project_slug, row.task_key);
  const workspaceKey =
    row.kind === "reviewer" && row.agent_profile_id
      ? `reviewer-${row.agent_profile_id}`
      : undefined;
  const workdir =
    persisted?.workdir ??
    resumeWorkdir(
      row.project_slug,
      row.task_key,
      repo,
      ctx.dataRoot,
      workspaceKey,
    );
  // Never re-resolve current profile grants for an old run. If the live path
  // crashed before persisting its exact authority snapshot, recovery fails
  // closed to local reconciliation; a later admin grant cannot escalate it.
  const delivery = persisted?.delivery ?? undefined;
  return {
    projectSlug: row.project_slug,
    taskKey: row.task_key,
    backend: row.backend as RealBackend,
    role: row.role,
    kind: row.kind,
    purpose: row.run_purpose ?? "conversation",
    ...(row.agent_profile_id ? { profileId: row.agent_profile_id } : {}),
    workdir,
    ...(delivery ? { delivery } : {}),
    reviewEvidenceFingerprint: row.review_evidence_fingerprint,
    reviewHeadSha: row.review_head_sha,
    agentHandle: persisted?.agentHandle ?? roleHandle(row.role),
    ...(persisted?.launchAuthorization
      ? { launchAuthorization: persisted.launchAuthorization }
      : {}),
    ...(persisted?.operatorRun ? { operatorRun: persisted.operatorRun } : {}),
  };
}

async function recoverOrphanedSpecialists(
  db: Database.Database,
  ctx: TaskMutationContext,
  openRecovery: typeof openSystemRecovery,
): Promise<number> {
  const rows = db
    .prepare(
      `SELECT id, project_slug, task_key, role, kind, backend, state,
              task_incarnation
         FROM agent_runs
        WHERE kind IN ('primary', 'reviewer')
          AND (
            state IN ('queued', 'running')
            OR (state = 'interrupted' AND step = 'orphan-recovery')
          )
          AND id NOT LIKE 'run_seed_%'`,
    )
    .all() as {
    id: string;
    project_slug: string;
    task_key: string;
    role: string;
    kind: "primary" | "reviewer";
    backend: string;
    state: "queued" | "running" | "interrupted";
    task_incarnation: string | null;
  }[];
  let orphaned = 0;
  for (const row of rows) {
    try {
      await withProjectCompletionEffect(db, row.project_slug, async () => {
        if (row.state === "queued" || row.state === "running") {
          // Terminal state + durable retry marker are one SQL update. A crash
          // may happen immediately afterward, but the next boot will still
          // select this interrupted row for its human recovery packet.
          stopRunForLifecycle(db, row.id, {
            recoveryStep: "orphan-recovery",
          });
        }
        // Re-read canonical ownership only after admission. Archive/delete
        // revoke this same registry before waiting, so an effect that has not
        // entered yet cannot mutate a project after its lifecycle drain.
        if (
          !row.task_incarnation ||
          !runOwnsTask(db, ctx, row.id, row.project_slug, row.task_key)
        ) {
          advanceRunCompletionPhase(db, row.id, RUN_COMPLETION_PHASE.complete);
          patchRun(db, row.id, { step: null });
          orphaned += 1;
          return;
        }
        await openRecovery(
          db,
          {
            projectSlug: row.project_slug,
            taskKey: row.task_key,
            code: "orphaned_specialist_run",
            occurrenceId: row.id,
            title: `${row.role} run lost its runtime`,
            body: "The server restarted while this specialist run was queued or running. Its provider process cannot be resumed safely, so the row was interrupted and the task needs an explicit retry or redirect.",
            observations: [
              { k: "Run", v: row.id, code: true },
              { k: "Backend", v: row.backend, code: false },
            ],
            notificationKind: "quality",
            notificationText: `${row.role} stopped during a server restart and needs recovery.`,
          },
          {
            ...ctx,
            expectedTaskIncarnation: row.task_incarnation,
          },
        );
        advanceRunCompletionPhase(db, row.id, RUN_COMPLETION_PHASE.complete);
        patchRun(db, row.id, { step: null });
        orphaned += 1;
      });
    } catch (error) {
      logger.warn("orphaned specialist boot recovery failed", {
        runId: row.id,
        taskKey: row.task_key,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return orphaned;
}

/**
 * Reconcile every specialist completion whose monotonic effect phase is not
 * complete. Unlike the former reply-audit query this resumes after any phase,
 * includes terminal errors and no-text runs, and independently terminalizes
 * process-owned rows that cannot survive a restart.
 */
export async function recoverUnreactedAgentRuns(
  db: Database.Database,
  ctx: TaskMutationContext = {},
  options: AgentRunRecoveryOptions = {},
): Promise<{ recovered: number; orphaned: number }> {
  // Boot resolves operator reservations/effects before invoking this replay.
  // Keeping that ordering in boot avoids two recovery owners drifting apart.
  const orphaned = await recoverOrphanedSpecialists(
    db,
    ctx,
    options.openRecovery ?? openSystemRecovery,
  );
  const rows = db
    .prepare(
      `SELECT id, project_slug, task_key, backend, role, kind,
              agent_profile_id, run_purpose,
              review_evidence_fingerprint, review_head_sha, state, simulated
         FROM agent_runs
        WHERE kind IN ('primary', 'reviewer')
          AND state IN ('finished', 'error', 'interrupted')
          AND (
            state <> 'interrupted'
            OR COALESCE(step, '') <> 'orphan-recovery'
          )
          AND id NOT LIKE 'run_seed_%'
          AND completion_phase < ?
        ORDER BY rowid ASC`,
    )
    .all(RUN_COMPLETION_PHASE.complete) as RecoverableSpecialistRow[];

  if (rows.length > 0) {
    logger.info("recovering incomplete specialist completion effects", {
      count: rows.length,
    });
  }
  const { applyAgentCompletionEffects } =
    await import("~/server/tasks/task-actions.server");
  let recovered = 0;
  for (const row of rows) {
    try {
      // Archived/deleted ownership is intentionally inert. Completing the
      // checkpoint prevents a later restore or same-slug project from
      // inheriting effects from the old lifecycle.
      if (!runOwnsTask(db, ctx, row.id, row.project_slug, row.task_key)) {
        advanceRunCompletionPhase(db, row.id, RUN_COMPLETION_PHASE.complete);
        recovered += 1;
        continue;
      }
      await applyAgentCompletionEffects(
        db,
        ctx,
        completionInput(db, ctx, row),
        { id: row.id, state: row.state, simulated: row.simulated === 1 },
      );
      recovered += 1;
    } catch (error) {
      logger.warn("specialist completion boot recovery failed", {
        runId: row.id,
        taskKey: row.task_key,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  logger.info("specialist completion boot recovery complete", {
    recovered,
    orphaned,
  });
  return { recovered, orphaned };
}

export interface AgentRunRecoveryOptions {
  openRecovery?: typeof openSystemRecovery;
}
