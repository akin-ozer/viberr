import type Database from "better-sqlite3";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { logger } from "~/server/logging/logger.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { newId } from "~/shared/ids/new-id.server";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import { reviewEvidenceFingerprint } from "./review-evidence.server";

export interface TaskCompletionIntent {
  id: string;
  projectSlug: string;
  taskKey: string;
  taskIncarnation: string;
  evidenceFingerprint: string;
  actorUserId: string | null;
  actorLabel: string;
  authoritySource:
    | "project_role"
    | "task_owner"
    | "org_admin_override"
    | "operator_full_autonomy";
  phase: "accepting_merge" | "merge_pending" | "done";
  doneStageId: string;
  mergedPr: boolean;
  repo: string | null;
  defaultBranch: string | null;
  prNumber: number | null;
  headSha: string | null;
  createdAt: string;
}

interface TaskCompletionIntentRow {
  id: string;
  project_slug: string;
  task_key: string;
  task_incarnation: string;
  evidence_fingerprint: string;
  actor_user_id: string | null;
  actor_label: string;
  authority_source:
    | "project_role"
    | "task_owner"
    | "org_admin_override"
    | "operator_full_autonomy";
  phase: "accepting_merge" | "merge_pending" | "done";
  done_stage_id: string;
  merged_pr: number;
  repo: string | null;
  default_branch: string | null;
  pr_number: number | null;
  head_sha: string | null;
  created_at: string;
}

function mapIntent(row: TaskCompletionIntentRow): TaskCompletionIntent {
  return {
    id: row.id,
    projectSlug: row.project_slug,
    taskKey: row.task_key,
    taskIncarnation: row.task_incarnation,
    evidenceFingerprint: row.evidence_fingerprint,
    actorUserId: row.actor_user_id,
    actorLabel: row.actor_label,
    authoritySource: row.authority_source,
    phase: row.phase,
    doneStageId: row.done_stage_id,
    mergedPr: row.merged_pr === 1,
    repo: row.repo,
    defaultBranch: row.default_branch,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    createdAt: row.created_at,
  };
}

export function getTaskCompletionIntent(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    taskIncarnation: string;
    evidenceFingerprint?: string;
  },
): TaskCompletionIntent | null {
  const row = db
    .prepare(
      `SELECT id, project_slug, task_key, task_incarnation,
              evidence_fingerprint, actor_user_id, actor_label,
              authority_source, phase, done_stage_id, merged_pr,
              repo, default_branch, pr_number, head_sha, created_at
         FROM task_completion_intents
        WHERE project_slug = ? AND task_key = ? AND task_incarnation = ?
          ${input.evidenceFingerprint ? "AND evidence_fingerprint = ?" : ""}
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    )
    .get(
      input.projectSlug,
      input.taskKey,
      input.taskIncarnation,
      ...(input.evidenceFingerprint ? [input.evidenceFingerprint] : []),
    ) as TaskCompletionIntentRow | undefined;
  return row ? mapIntent(row) : null;
}

/** Persist acceptance attribution before the canonical Review → Done write.
 * A pre-commit crash is replaceable by the next authorized accepter; after
 * Done, the row becomes immutable recovery evidence until audit convergence. */
export function stageTaskCompletionIntent(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    taskIncarnation: string;
    evidenceFingerprint: string;
    actorUserId: string | null;
    actorLabel: string;
    authoritySource:
      | "project_role"
      | "task_owner"
      | "org_admin_override"
      | "operator_full_autonomy";
    doneStageId: string;
    mergedPr: boolean;
    phase?: "accepting_merge" | "merge_pending" | "done";
    repo?: string | null;
    defaultBranch?: string | null;
    prNumber?: number | null;
    headSha?: string | null;
  },
): TaskCompletionIntent {
  const id = newId("completion_intent");
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO task_completion_intents
       (id, project_slug, task_key, task_incarnation, evidence_fingerprint,
        actor_user_id, actor_label, authority_source, phase, done_stage_id,
        merged_pr, repo, default_branch, pr_number, head_sha, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_slug, task_key, task_incarnation, evidence_fingerprint)
     DO UPDATE SET
       actor_user_id = excluded.actor_user_id,
       actor_label = excluded.actor_label,
       authority_source = excluded.authority_source,
       phase = excluded.phase,
       done_stage_id = excluded.done_stage_id,
       merged_pr = excluded.merged_pr,
       repo = excluded.repo,
       default_branch = excluded.default_branch,
       pr_number = excluded.pr_number,
       head_sha = excluded.head_sha,
       created_at = excluded.created_at`,
  ).run(
    id,
    input.projectSlug,
    input.taskKey,
    input.taskIncarnation,
    input.evidenceFingerprint,
    input.actorUserId,
    input.actorLabel,
    input.authoritySource,
    input.phase ?? "done",
    input.doneStageId,
    input.mergedPr ? 1 : 0,
    input.repo ?? null,
    input.defaultBranch ?? null,
    input.prNumber ?? null,
    input.headSha ?? null,
    createdAt,
  );
  const intent = getTaskCompletionIntent(db, input);
  if (!intent)
    throw new Error("Task completion intent could not be persisted.");
  return intent;
}

/** Persist the human acceptance decision before a repository merge can cross
 * the remote boundary. Unlike a pre-Done journal row, this actor is immutable:
 * a retry may finish the work, but may never take credit for the original
 * acceptance or for an ambiguous merge request. */
export function stageTaskMergeAcceptanceIntent(
  db: Database.Database,
  input: {
    projectSlug: string;
    taskKey: string;
    taskIncarnation: string;
    evidenceFingerprint: string;
    actorUserId: string;
    actorLabel: string;
    authoritySource: "project_role" | "task_owner" | "org_admin_override";
    doneStageId: string;
    repo: string;
    defaultBranch: string;
    prNumber: number;
    headSha: string;
  },
): TaskCompletionIntent {
  const id = newId("completion_intent");
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO task_completion_intents
       (id, project_slug, task_key, task_incarnation, evidence_fingerprint,
        actor_user_id, actor_label, authority_source, phase, done_stage_id,
        merged_pr, repo, default_branch, pr_number, head_sha, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepting_merge', ?, 0, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectSlug,
    input.taskKey,
    input.taskIncarnation,
    input.evidenceFingerprint,
    input.actorUserId,
    input.actorLabel,
    input.authoritySource,
    input.doneStageId,
    input.repo.trim().toLowerCase(),
    input.defaultBranch,
    input.prNumber,
    input.headSha,
    createdAt,
  );
  const intent = getTaskCompletionIntent(db, input);
  if (!intent)
    throw new Error("Task acceptance intent could not be persisted.");
  if (
    intent.repo?.toLowerCase() !== input.repo.trim().toLowerCase() ||
    intent.defaultBranch !== input.defaultBranch ||
    intent.prNumber !== input.prNumber ||
    intent.headSha !== input.headSha
  ) {
    throw new Error(
      "A different immutable delivery target already owns this acceptance.",
    );
  }
  return intent;
}

export function setTaskCompletionIntentPhase(
  db: Database.Database,
  intent: TaskCompletionIntent,
  phase: "accepting_merge" | "merge_pending" | "done",
  mergedPr = intent.mergedPr,
): TaskCompletionIntent {
  db.prepare(
    `UPDATE task_completion_intents
        SET phase = ?, merged_pr = ?
      WHERE id = ?`,
  ).run(phase, mergedPr ? 1 : 0, intent.id);
  return { ...intent, phase, mergedPr };
}

export function setTaskCompletionIntentAuthority(
  db: Database.Database,
  intent: TaskCompletionIntent,
  authoritySource: TaskCompletionIntent["authoritySource"],
): TaskCompletionIntent {
  db.prepare(
    `UPDATE task_completion_intents SET authority_source = ? WHERE id = ?`,
  ).run(authoritySource, intent.id);
  return { ...intent, authoritySource };
}

function acceptanceSnapshot(intent: TaskCompletionIntent, dataRoot?: string) {
  const project = readProjectFile({
    projectSlug: intent.projectSlug,
    ...(dataRoot !== undefined ? { dataRoot } : {}),
  });
  const task = readTaskFile({
    projectSlug: intent.projectSlug,
    taskKey: intent.taskKey,
    ...(dataRoot !== undefined ? { dataRoot } : {}),
  });
  if (!project || !task) return null;
  const projectFm = project.parsed.frontmatter;
  const taskFm = task.parsed.frontmatter;
  const roles = resolveStageRoles(projectFm.stages, projectFm.workflow);
  const effectiveRepo = taskFm.repo ?? projectFm.repo;
  const exact =
    taskFm.createdAt === intent.taskIncarnation &&
    taskFm.stage === roles.reviewId &&
    taskFm.validation === "healthy" &&
    reviewEvidenceFingerprint(task.parsed, projectFm.repo) ===
      intent.evidenceFingerprint &&
    effectiveRepo?.trim().toLowerCase() === intent.repo?.toLowerCase() &&
    projectFm.defaultBranch === intent.defaultBranch &&
    taskFm.pr?.number === intent.prNumber &&
    taskFm.pr?.headSha === intent.headSha;
  return { project, task, reviewStageId: roles.reviewId, exact };
}

function canonicalProjectAcceptsRecovery(
  projectSlug: string,
  dataRoot?: string,
): boolean {
  const project = readProjectFile({
    projectSlug,
    ...(dataRoot !== undefined ? { dataRoot } : {}),
  });
  return !!project && !project.parsed.frontmatter.archived;
}

/** Converge the durable, human-approved "merge pending" state. The intent is
 * deliberately retained: it is also the bridge from a later exact remote
 * merge to Done and preserves the original accepter across restarts/retries. */
export async function convergeTaskMergePendingIntent(
  db: Database.Database,
  intent: TaskCompletionIntent,
  options: { dataRoot?: string } = {},
): Promise<boolean> {
  if (!canonicalProjectAcceptsRecovery(intent.projectSlug, options.dataRoot)) {
    return false;
  }
  const actorUserId = intent.actorUserId;
  if (!actorUserId || intent.authoritySource === "operator_full_autonomy") {
    return false;
  }
  const initial = acceptanceSnapshot(intent, options.dataRoot);
  if (
    !initial?.exact ||
    initial.task.parsed.frontmatter.pr?.state === "merged"
  ) {
    return false;
  }
  let changed = false;
  await updateTaskFile(
    {
      projectSlug: intent.projectSlug,
      taskKey: intent.taskKey,
      ...(options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
    },
    (parsed) => {
      const projectFm = initial.project.parsed.frontmatter;
      const effectiveRepo = parsed.frontmatter.repo ?? projectFm.repo;
      if (
        parsed.frontmatter.createdAt !== intent.taskIncarnation ||
        parsed.frontmatter.stage !== initial.reviewStageId ||
        parsed.frontmatter.validation !== "healthy" ||
        reviewEvidenceFingerprint(parsed, projectFm.repo) !==
          intent.evidenceFingerprint ||
        effectiveRepo?.trim().toLowerCase() !== intent.repo?.toLowerCase() ||
        projectFm.defaultBranch !== intent.defaultBranch ||
        parsed.frontmatter.pr?.number !== intent.prNumber ||
        parsed.frontmatter.pr?.headSha !== intent.headSha ||
        parsed.frontmatter.pr.state === "merged"
      ) {
        return;
      }
      parsed.frontmatter.pr = {
        ...parsed.frontmatter.pr,
        state: "accepted",
      };
      parsed.frontmatter.readiness = "ready";
      parsed.frontmatter.waiting = "human";
      parsed.frontmatter.recommendations =
        parsed.frontmatter.recommendations.filter(
          (recommendation) => recommendation.kind !== "accept_completion",
        );
      parsed.packet = null;
      if (
        !parsed.timeline.some(
          (event) =>
            event.occurredAt === intent.createdAt &&
            event.title === "Completion accepted · merge pending",
        )
      ) {
        parsed.timeline.unshift({
          occurredAt: intent.createdAt,
          type: "completion",
          actor: {
            kind: "human",
            userId: actorUserId,
            nameHint: null,
          },
          title: "Completion accepted · merge pending",
          text: `Acceptance is approved, but ${intent.taskKey} remains in **Review** until its linked pull request is actually merged.`,
          toAgent: false,
          evidence: null,
        });
      }
      changed = true;
    },
  );
  if (!changed) return false;
  rebuildPath(
    db,
    resolveTaskFilePath({
      projectSlug: intent.projectSlug,
      taskKey: intent.taskKey,
      ...(options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
    }),
    options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {},
  );
  db.prepare(
    `INSERT OR IGNORE INTO audit_events
       (id, occurred_at, actor_user_id, actor_label, action, subject_kind,
        subject_id, project_slug, task_key, details_json)
     VALUES (?, ?, ?, ?, 'task.completion.accepted_merge_pending', 'task',
             ?, ?, ?, ?)`,
  ).run(
    `evt_accept_${intent.id}`,
    intent.createdAt,
    intent.actorUserId,
    intent.actorLabel,
    intent.taskKey,
    intent.projectSlug,
    intent.taskKey,
    JSON.stringify({
      authoritySource: intent.authoritySource,
      evidenceFingerprint: intent.evidenceFingerprint,
      repo: intent.repo,
      defaultBranch: intent.defaultBranch,
      prNumber: intent.prNumber,
      headSha: intent.headSha,
    }),
  );
  setTaskCompletionIntentPhase(db, intent, "merge_pending", false);
  return true;
}

/** Apply Done from a previously authorized acceptance only when the exact
 * immutable evidence is still current and its PR is canonically confirmed
 * merged. Current actor roles are intentionally irrelevant here: the durable
 * intent is the already-committed human decision. */
export async function finalizeTaskAcceptanceIntent(
  db: Database.Database,
  intent: TaskCompletionIntent,
  options: {
    dataRoot?: string;
    /** Crash seam after the exact remote-merge decision is durable but before
     * Review -> Done reaches task.md. A thrown error deliberately leaves the
     * `done` intent intact so boot must finish, never repeat, the merge. */
    phaseCommittedHookForTests?: (intent: TaskCompletionIntent) => void;
  } = {},
): Promise<boolean> {
  if (!canonicalProjectAcceptsRecovery(intent.projectSlug, options.dataRoot)) {
    return false;
  }
  const actorUserId = intent.actorUserId;
  if (
    intent.authoritySource === "operator_full_autonomy" ||
    !actorUserId ||
    !intent.repo
  ) {
    return false;
  }
  const ref = {
    projectSlug: intent.projectSlug,
    taskKey: intent.taskKey,
    ...(options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
  };
  const existing = readTaskFile(ref);
  if (
    !existing ||
    existing.parsed.frontmatter.createdAt !== intent.taskIncarnation
  ) {
    return false;
  }
  if (existing.parsed.frontmatter.stage === intent.doneStageId) {
    const doneIntent = setTaskCompletionIntentPhase(db, intent, "done", true);
    return convergeTaskCompletionIntent(db, doneIntent, options);
  }
  const snapshot = acceptanceSnapshot(intent, options.dataRoot);
  if (
    !snapshot?.exact ||
    snapshot.task.parsed.frontmatter.pr?.state !== "merged"
  ) {
    return false;
  }
  const doneIntent = setTaskCompletionIntentPhase(db, intent, "done", true);
  options.phaseCommittedHookForTests?.(doneIntent);
  let changed = false;
  try {
    await updateTaskFile(ref, (parsed) => {
      const projectFm = snapshot.project.parsed.frontmatter;
      const effectiveRepo = parsed.frontmatter.repo ?? projectFm.repo;
      if (
        parsed.frontmatter.createdAt !== intent.taskIncarnation ||
        parsed.frontmatter.stage !== snapshot.reviewStageId ||
        parsed.frontmatter.validation !== "healthy" ||
        reviewEvidenceFingerprint(parsed, projectFm.repo) !==
          intent.evidenceFingerprint ||
        effectiveRepo?.trim().toLowerCase() !== intent.repo?.toLowerCase() ||
        projectFm.defaultBranch !== intent.defaultBranch ||
        parsed.frontmatter.pr?.number !== intent.prNumber ||
        parsed.frontmatter.pr?.headSha !== intent.headSha ||
        parsed.frontmatter.pr.state !== "merged"
      ) {
        return;
      }
      parsed.frontmatter.stage = intent.doneStageId;
      parsed.frontmatter.readiness = "ready";
      parsed.frontmatter.waiting = "none";
      parsed.frontmatter.recommendations =
        parsed.frontmatter.recommendations.filter(
          (recommendation) =>
            recommendation.kind !== "transition" &&
            recommendation.kind !== "accept_completion",
        );
      parsed.packet = null;
      if (
        !parsed.timeline.some(
          (event) =>
            event.occurredAt === intent.createdAt &&
            event.title === "Completion accepted",
        )
      ) {
        parsed.timeline.unshift({
          occurredAt: intent.createdAt,
          type: "completion",
          actor: {
            kind: "human",
            userId: actorUserId,
            nameHint: null,
          },
          title: "Completion accepted",
          text: `Human acceptance recorded. ${intent.taskKey} transitioned to **Done** after its review PR was merged.`,
          toAgent: false,
          evidence: null,
        });
      }
      changed = true;
    });
  } catch (error) {
    setTaskCompletionIntentPhase(db, doneIntent, intent.phase, intent.mergedPr);
    throw error;
  }
  if (!changed) {
    // The file did not cross the boundary; keep the row recoverable in its
    // prior phase rather than presenting it as a committed Done intent.
    setTaskCompletionIntentPhase(db, doneIntent, intent.phase, intent.mergedPr);
    return false;
  }
  return convergeTaskCompletionIntent(db, doneIntent, options);
}

export function cancelTaskAcceptanceIntent(
  db: Database.Database,
  intent: TaskCompletionIntent,
  reason: string,
): void {
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO audit_events
         (id, occurred_at, actor_user_id, actor_label, action, subject_kind,
          subject_id, project_slug, task_key, details_json)
       VALUES (?, ?, NULL, 'Viberr system',
               'task.completion.acceptance_cancelled', 'task', ?, ?, ?, ?)`,
    ).run(
      `evt_cancel_${intent.id}`,
      new Date().toISOString(),
      intent.taskKey,
      intent.projectSlug,
      intent.taskKey,
      JSON.stringify({
        reason,
        acceptanceIntentId: intent.id,
        originalActorUserId: intent.actorUserId,
        authoritySource: intent.authoritySource,
        evidenceFingerprint: intent.evidenceFingerprint,
        repo: intent.repo,
        defaultBranch: intent.defaultBranch,
        prNumber: intent.prNumber,
        headSha: intent.headSha,
      }),
    );
    db.prepare(`DELETE FROM task_completion_intents WHERE id = ?`).run(
      intent.id,
    );
  })();
}

export interface TaskAcceptanceRecoverySummary {
  completed: number;
  pending: number;
  cancelled: number;
  retained: number;
  errors: number;
}

/** Recover the umbrella acceptance only after the narrower GitHub merge
 * journal has had a chance to converge. A committed `done` intent is itself
 * the durable exact-merge decision and is finished locally without GitHub.
 * A live open PR commits the already
 * authorized merge-pending decision without issuing a merge; a live exact
 * merged PR is first passed through mergeTaskPr's fact reconciler and only
 * then may cross to Done. */
export async function recoverTaskAcceptanceIntents(
  db: Database.Database,
  dataRoot?: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<TaskAcceptanceRecoverySummary> {
  const rows = db
    .prepare(
      `SELECT id, project_slug, task_key, task_incarnation,
              evidence_fingerprint, actor_user_id, actor_label,
              authority_source, phase, done_stage_id, merged_pr,
              repo, default_branch, pr_number, head_sha, created_at
         FROM task_completion_intents
        WHERE repo IS NOT NULL
        ORDER BY created_at, id`,
    )
    .all() as TaskCompletionIntentRow[];
  const summary: TaskAcceptanceRecoverySummary = {
    completed: 0,
    pending: 0,
    cancelled: 0,
    retained: 0,
    errors: 0,
  };
  const { mergeTaskPr, observeLivePullRequest } =
    await import("~/server/github/github-reconciler.server");

  for (const row of rows) {
    const intent = mapIntent(row);
    try {
      if (!canonicalProjectAcceptsRecovery(intent.projectSlug, dataRoot)) {
        summary.retained += 1;
        continue;
      }
      if (
        !intent.actorUserId ||
        intent.authoritySource === "operator_full_autonomy"
      ) {
        cancelTaskAcceptanceIntent(
          db,
          intent,
          "invalid_human_acceptance_actor",
        );
        summary.cancelled += 1;
        continue;
      }
      if (
        !intent.repo ||
        !intent.defaultBranch ||
        intent.prNumber === null ||
        !intent.headSha
      ) {
        cancelTaskAcceptanceIntent(db, intent, "missing_immutable_target");
        summary.cancelled += 1;
        continue;
      }
      const snapshot = acceptanceSnapshot(intent, dataRoot);
      if (!snapshot?.exact) {
        cancelTaskAcceptanceIntent(db, intent, "canonical_evidence_changed");
        summary.cancelled += 1;
        continue;
      }

      // `finalizeTaskAcceptanceIntent` records this phase only after the exact
      // merge fact has converged. A crash may happen one instruction later,
      // before task.md reaches Done. Finish from the immutable local journal;
      // do not perform even a GET, much less repeat the merge PUT.
      if (
        intent.phase === "done" &&
        intent.mergedPr &&
        snapshot.task.parsed.frontmatter.pr?.state === "merged"
      ) {
        if (
          await finalizeTaskAcceptanceIntent(db, intent, {
            ...(dataRoot !== undefined ? { dataRoot } : {}),
          })
        ) {
          summary.completed += 1;
        } else {
          summary.retained += 1;
        }
        continue;
      }

      // A prior merge-intent replay may already have established the exact
      // immutable fact. This remains sufficient even if credentials were
      // removed after the merge.
      const hasMergeAudit = !!db
        .prepare(
          `SELECT 1 FROM audit_events
            WHERE action = 'github.pr.merged'
              AND project_slug = ? AND task_key = ?
              AND lower(json_extract(details_json, '$.repo')) = lower(?)
              AND json_extract(details_json, '$.prNumber') = ?
              AND json_extract(details_json, '$.headSha') = ?
              AND json_extract(details_json, '$.taskIncarnation') = ?
            LIMIT 1`,
        )
        .get(
          intent.projectSlug,
          intent.taskKey,
          intent.repo,
          intent.prNumber,
          intent.headSha,
          intent.taskIncarnation,
        );
      if (
        snapshot.task.parsed.frontmatter.pr?.state === "merged" &&
        hasMergeAudit
      ) {
        if (
          await finalizeTaskAcceptanceIntent(db, intent, {
            ...(dataRoot !== undefined ? { dataRoot } : {}),
          })
        ) {
          summary.completed += 1;
        } else {
          summary.retained += 1;
        }
        continue;
      }

      const live = await observeLivePullRequest(
        db,
        {
          projectSlug: intent.projectSlug,
          repo: intent.repo,
          prNumber: intent.prNumber,
        },
        options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
      );
      if (live.status !== "ok") {
        if (live.status === "pr_not_found") {
          cancelTaskAcceptanceIntent(db, intent, "pull_request_not_found");
          summary.cancelled += 1;
        } else {
          summary.retained += 1;
        }
        continue;
      }
      const exactLiveTarget =
        live.headSha === intent.headSha &&
        live.baseRef === intent.defaultBranch &&
        live.baseRepo?.trim().toLowerCase() === intent.repo.toLowerCase();
      if (!exactLiveTarget) {
        cancelTaskAcceptanceIntent(db, intent, "remote_target_changed");
        summary.cancelled += 1;
        continue;
      }
      if (!live.merged) {
        if (snapshot.task.parsed.frontmatter.pr?.state === "merged") {
          // Let the reconciler revoke a false cache without issuing PUT: its
          // live preflight sees the exact target is still open first.
          await mergeTaskPr(
            db,
            {
              projectSlug: intent.projectSlug,
              taskKey: intent.taskKey,
              expectedHeadSha: intent.headSha,
              expectedRepo: intent.repo,
              expectedDefaultBranch: intent.defaultBranch,
              expectedPrNumber: intent.prNumber,
              authoritySource: intent.authoritySource,
            },
            { userId: intent.actorUserId, label: intent.actorLabel },
            {
              ...(dataRoot !== undefined ? { dataRoot } : {}),
              ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            },
          );
          cancelTaskAcceptanceIntent(db, intent, "false_merged_cache");
          summary.cancelled += 1;
          continue;
        }
        if (
          await convergeTaskMergePendingIntent(db, intent, {
            ...(dataRoot !== undefined ? { dataRoot } : {}),
          })
        ) {
          summary.pending += 1;
        } else {
          summary.retained += 1;
        }
        continue;
      }

      const merged = await mergeTaskPr(
        db,
        {
          projectSlug: intent.projectSlug,
          taskKey: intent.taskKey,
          expectedHeadSha: intent.headSha,
          expectedRepo: intent.repo,
          expectedDefaultBranch: intent.defaultBranch,
          expectedPrNumber: intent.prNumber,
          authoritySource: intent.authoritySource,
        },
        { userId: intent.actorUserId, label: intent.actorLabel },
        {
          ...(dataRoot !== undefined ? { dataRoot } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        },
      );
      if (
        merged.status === "merged" &&
        (await finalizeTaskAcceptanceIntent(db, intent, {
          ...(dataRoot !== undefined ? { dataRoot } : {}),
        }))
      ) {
        summary.completed += 1;
      } else {
        summary.retained += 1;
      }
    } catch (error) {
      summary.errors += 1;
      logger.error("task acceptance recovery failed", {
        projectSlug: intent.projectSlug,
        taskKey: intent.taskKey,
        intentId: intent.id,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return summary;
}

export function cancelTaskCompletionIntent(
  db: Database.Database,
  intent: TaskCompletionIntent,
): void {
  db.prepare(`DELETE FROM task_completion_intents WHERE id = ?`).run(intent.id);
}

/** Reproject and record the stable transition audit for a canonical Done task,
 * then clear the recovery row in the same transaction as the audit insert. */
export function convergeTaskCompletionIntent(
  db: Database.Database,
  intent: TaskCompletionIntent,
  options: { dataRoot?: string; reproject?: boolean } = {},
): boolean {
  if (!canonicalProjectAcceptsRecovery(intent.projectSlug, options.dataRoot)) {
    return false;
  }
  const ref = {
    projectSlug: intent.projectSlug,
    taskKey: intent.taskKey,
    ...(options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
  };
  const task = readTaskFile(ref);
  if (
    intent.phase !== "done" ||
    !task ||
    task.parsed.frontmatter.createdAt !== intent.taskIncarnation ||
    task.parsed.frontmatter.stage !== intent.doneStageId ||
    (intent.mergedPr && task.parsed.frontmatter.pr?.state !== "merged")
  ) {
    return false;
  }
  if (options.reproject !== false) {
    rebuildPath(db, resolveTaskFilePath(ref), {
      ...(options.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
    });
  }
  db.transaction(() => {
    const operatorAcceptance =
      intent.authoritySource === "operator_full_autonomy";
    if (operatorAcceptance) {
      db.prepare(
        `INSERT OR IGNORE INTO audit_events
           (id, occurred_at, actor_user_id, actor_label, action, subject_kind,
            subject_id, project_slug, task_key, details_json)
         VALUES (?, ?, NULL, ?, 'task.operator.accepted_completion', 'task', ?, ?, ?, ?)`,
      ).run(
        `evt_${intent.id}`,
        intent.createdAt,
        intent.actorLabel,
        intent.taskKey,
        intent.projectSlug,
        intent.taskKey,
        JSON.stringify({
          autonomy: "full",
          toStage: intent.doneStageId,
          via: "accept_completion",
          evidenceFingerprint: intent.evidenceFingerprint,
        }),
      );
    } else {
      db.prepare(
        `INSERT OR IGNORE INTO audit_events
           (id, occurred_at, actor_user_id, actor_label, action, subject_kind,
            subject_id, project_slug, task_key, details_json)
         VALUES (?, ?, ?, ?, 'task.transition', 'task', ?, ?, ?, ?)`,
      ).run(
        `evt_${intent.id}`,
        intent.createdAt,
        intent.actorUserId,
        intent.actorLabel,
        intent.taskKey,
        intent.projectSlug,
        intent.taskKey,
        JSON.stringify({
          to: intent.doneStageId,
          boundary: "human",
          via: "accept_completion",
          authoritySource: intent.authoritySource,
          mergedPr: intent.mergedPr,
          evidenceFingerprint: intent.evidenceFingerprint,
        }),
      );
    }
    db.prepare(`DELETE FROM task_completion_intents WHERE id = ?`).run(
      intent.id,
    );
  })();
  return true;
}

/** Boot reconciliation: a Done canonical file commits the acceptance and its
 * effects are replayed; a repo-less non-Done row never crossed the file commit
 * and is safely cancelled. A repository `done` decision with task.md still in
 * Review is retained for the async exact-acceptance recovery; it must not be
 * mistaken for an abandoned pre-file intent. */
export function recoverTaskCompletionIntents(
  db: Database.Database,
  dataRoot?: string,
): { completed: number; cancelled: number; retained: number; errors: number } {
  const rows = db
    .prepare(
      `SELECT id, project_slug, task_key, task_incarnation,
              evidence_fingerprint, actor_user_id, actor_label,
              authority_source, phase, done_stage_id, merged_pr,
              repo, default_branch, pr_number, head_sha, created_at
         FROM task_completion_intents
        ORDER BY created_at, id`,
    )
    .all() as TaskCompletionIntentRow[];
  const summary = { completed: 0, cancelled: 0, retained: 0, errors: 0 };
  for (const row of rows) {
    const intent = mapIntent(row);
    try {
      if (!canonicalProjectAcceptsRecovery(intent.projectSlug, dataRoot)) {
        summary.retained += 1;
        continue;
      }
      // Repository acceptance is recovered only after GitHub intent recovery
      // has observed the exact remote target. Keep it durable here rather than
      // treating a not-yet-Done task as an abandoned pre-commit write.
      if (intent.phase !== "done") continue;
      if (
        convergeTaskCompletionIntent(db, intent, {
          ...(dataRoot !== undefined ? { dataRoot } : {}),
        })
      ) {
        summary.completed += 1;
      } else if (intent.repo && intent.mergedPr) {
        summary.retained += 1;
      } else {
        cancelTaskCompletionIntent(db, intent);
        summary.cancelled += 1;
      }
    } catch (error) {
      summary.errors += 1;
      logger.error("task completion recovery failed", {
        projectSlug: intent.projectSlug,
        taskKey: intent.taskKey,
        intentId: intent.id,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return summary;
}
