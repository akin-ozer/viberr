import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { FileDiagnostic } from "~/schemas/file-diagnostics";
import { isAtAcceptanceBoundary } from "~/shared/mapping/task.server";
import {
  acceptanceBlockedReason,
  activeWorkRevision,
  closedPrBlockedReason,
  conflictingPrBlockedReason,
  unpushedRevisionBlockedReason,
  deliveringEngagement,
  deriveValidation,
  supportingEngagements,
  type TaskFileEvent,
  type TaskFrontmatter,
  type Validation,
  type Waiting,
} from "~/schemas/task-file.schema";
import { verdictGateReason } from "~/server/github/pr-human-approval.server";
import {
  requiredReviewerRefusals,
  resolveRequiredReviewers,
  type RequiredReviewerView,
} from "~/server/tasks/required-reviewers.server";
import { withTransaction } from "~/server/db/transaction.server";
import {
  collectProjectionEvents,
  emitProjectionEvent,
} from "~/server/events/projection-events.server";
import {
  clearProjectionFault,
  recordProjectionFault,
} from "./store-health.server";
import {
  getDataRoot,
  goalFilePath,
  projectFilePath,
  projectsDir,
  storeRelativePath,
  taskFilePath,
} from "~/server/files/file-store-root.server";
import { currentLinkIndex } from "~/schemas/goal-file.schema";
import {
  diagnoseGoalFileContent,
  listGoalIds,
  parseGoalFileContent,
} from "~/server/files/goal-writer.server";
import { recordProvenance } from "~/server/provenance/provenance-recorder.server";
import { parseProjectFileContent } from "~/server/files/project-file.server";
import { sha256Hex } from "~/server/files/content-hash.server";
import { parseTaskFileContent } from "~/server/files/task-file.server";
import {
  referenceDiagnostics,
} from "~/server/interpretation/diagnostics-policy.server";
import { deriveReadiness } from "~/server/interpretation/readiness-policy.server";
import { logger } from "~/server/logging/logger.server";
import { createActorResolver } from "~/shared/mapping/actor.server";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { agentNamesByProfile } from "~/server/runtimes/run-store.server";

/**
 * Projection rebuilder: files → SQLite.
 *
 * - Full rescan (`rebuildAll`) walks ${dataRoot}/projects, projects every
 *   project.md / tasks/<KEY>/task.md, and prunes rows whose files vanished.
 * - Single-file incremental (`rebuildPath`) — driven by the file
 *   watcher and by every mutation ("write file → reproject").
 * - Content-hash short-circuit: an unchanged file is not re-projected
 *   (and records no provenance — nothing was rebuilt).
 * - Every rebuild that acts records provenance (projected/removed/error);
 *   full rescans add one summary `rescan` row.
 * - Emits change events through the in-process projection emitter
 *   (Phase 6 subscribes SSE to it).
 */

export interface RebuildOptions {
  dataRoot?: string;
  /** Bypass the content-hash short-circuit. */
  force?: boolean;
  /**
   * Internal (rebuildAll only): suppress the project→tasks cascade because
   * the caller walks the project's task files itself (with force when the
   * project row changed) — avoids projecting every task twice per rescan.
   */
  skipTaskCascade?: boolean;
}

export type RebuildAction =
  | "projected"
  | "unchanged"
  | "removed"
  | "ignored"
  | "error";

export interface RebuildFileResult {
  action: RebuildAction;
  kind: "project" | "task" | "goal" | "other";
  projectSlug?: string;
  taskKey?: string;
  goalId?: string;
  /**
   * Projects only, on `projected`: whether a field the project's TASK and goal
   * projections derive from changed (see `projectContextForTasks`), i.e.
   * whether they must be re-projected. False for a write that only moved
   * `nextTaskNumber`, a file lease or the description.
   */
  taskFacingChanged?: boolean;
  /**
   * Projects only: the keys of the tasks the cascade could not re-project.
   * The project row landed; they did not, and the row keeps the F28-D3
   * sentinel so the next rebuild of project.md runs the cascade again (ruling
   * 218's retry re-arms on this as on `error`).
   */
  failedTasks?: string[];
}

export interface RescanSummary {
  projects: number;
  tasks: number;
  changed: number;
  unchanged: number;
  removed: number;
  errors: number;
  durationMs: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Ruling 457 (SRV-4): one file's re-projection is ONE transaction. It used to
 * run as N+5 autocommit writes (one WAL sync per timeline event: 305 commits
 * for a 300-event task), and with the project cascade below that multiplied by
 * every task in the project. The projection events the body raises are held
 * until COMMIT, the way `rebuildProjections` already holds its own, so no SSE
 * subscriber revalidates against rows that have not landed (and a body that
 * throws rolls back and announces nothing).
 *
 * A caller that already holds a transaction (the full rebuild, a cascade from
 * the project row) gets the body inline: SQLite does not nest BEGIN, and that
 * caller's own commit is the one that counts. The F28-D3 sentinel hash below
 * stays as defence in depth.
 */
function inOneTransaction<T>(db: DatabaseSync, body: () => T): T {
  if (db.isTransaction) return body();
  const { result, events } = collectProjectionEvents(() => withTransaction(db, body));
  for (const event of events) emitProjectionEvent(event);
  return result;
}

// P13-D-16: the provenance INSERT used to be copied verbatim here and in
// github-reconciler.server.ts. The table now has one owner —
// app/server/provenance/ — which is also where the reads live.

function replaceDiagnostics(
  db: DatabaseSync,
  input: {
    sourcePath: string;
    projectSlug: string | null;
    taskKey: string | null;
    diagnostics: FileDiagnostic[];
  },
): void {
  db.prepare(`DELETE FROM diagnostics WHERE source_path = ?`).run(
    input.sourcePath,
  );
  const insert = db.prepare(
    `INSERT INTO diagnostics
       (project_slug, task_key, source_path, severity, code, path, message, hard_stop, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const at = nowIso();
  for (const diag of input.diagnostics) {
    insert.run(
      input.projectSlug,
      input.taskKey,
      input.sourcePath,
      diag.severity,
      diag.code,
      diag.path ?? null,
      diag.message,
      diag.hardStop ? 1 : 0,
      at,
    );
  }
}

// -------------------------------------------------------------- projects

interface ProjectContextRow {
  slug: string;
  repo: string | null;
  stages_json: string;
  /** Ruling 225 (amended): the stage graph, for the acceptance-boundary test —
   *  the one acceptance gate `acceptanceBlockReason` deliberately leaves out. */
  workflow_json: string;
  required_reviewers_json: string;
}

/** Everything a task's projection reads from its project. */
interface TaskProjectContext {
  row: ProjectContextRow;
  /** Member user ids, for the actor resolver's guest flags. */
  memberIds: Set<string>;
  /** The whole context as one comparable string (member ids sorted). */
  digest: string;
}

/**
 * The ONE reader of the project facts a task projection derives from (stages
 * for reference diagnostics and the terminal stage, the workflow for the
 * acceptance boundary, the resolved required reviewers, the repo, the member
 * ids behind guest flags). `rebuildTaskFile` reads its context here, and
 * `rebuildProjectFile` compares this digest before and after it writes the row
 * to decide whether the tasks must follow (ruling 457, SRV-3), so the cascade
 * test can never drift from what a task actually reads.
 */
function projectContextForTasks(
  db: DatabaseSync,
  slug: string,
): TaskProjectContext | null {
  // SAFETY: the SELECT names exactly ProjectContextRow's five members plus
  // `member_ids`; 0001_baseline declares `slug`, `stages_json`, `workflow_json`
  // and `required_reviewers_json` NOT NULL and `repo` nullable, which is how the
  // row types them, and `json_group_array` over the NOT NULL
  // `project_members.user_id` always yields a JSON array of strings.
  const row = db
    .prepare(
      `SELECT slug, repo, stages_json, workflow_json, required_reviewers_json,
              (SELECT json_group_array(user_id) FROM project_members
                WHERE project_slug = projects.slug) AS member_ids
         FROM projects WHERE slug = ?`,
    )
    .get(slug) as (ProjectContextRow & { member_ids: string }) | undefined;
  if (!row) return null;
  // SAFETY: see above — a JSON array of the member ids.
  const members = (JSON.parse(row.member_ids) as string[]).sort();
  return {
    row: {
      slug: row.slug,
      repo: row.repo,
      stages_json: row.stages_json,
      workflow_json: row.workflow_json,
      required_reviewers_json: row.required_reviewers_json,
    },
    memberIds: new Set(members),
    digest: JSON.stringify([
      row.repo,
      row.stages_json,
      row.workflow_json,
      row.required_reviewers_json,
      members,
    ]),
  };
}

export function rebuildProjectFile(
  db: DatabaseSync,
  slug: string,
  options: RebuildOptions = {},
): RebuildFileResult {
  return inOneTransaction(db, () => rebuildProjectFileNow(db, slug, options));
}

function rebuildProjectFileNow(
  db: DatabaseSync,
  slug: string,
  options: RebuildOptions,
): RebuildFileResult {
  const absPath = projectFilePath(slug, options.dataRoot);
  const sourcePath = storeRelativePath(absPath, options.dataRoot);

  if (!existsSync(absPath)) {
    const existed = db
      .prepare(`SELECT slug FROM projects WHERE slug = ?`)
      .get(slug);
    if (existed) {
      // F28-D3: drop dependents first and the `projects` row (the `existed`
      // probe's target, which cascades project_members) LAST, so an interrupted
      // removal is finished by the next rebuild rather than left half-done.
      db.prepare(`DELETE FROM diagnostics WHERE source_path = ?`).run(sourcePath);
      recordProvenance(db, { sourcePath, contentHash: null, action: "removed" });
      db.prepare(`DELETE FROM projects WHERE slug = ?`).run(slug);
      emitProjectionEvent({
        type: "project.removed",
        projectSlug: slug,
        occurredAt: nowIso(),
      });
      return { action: "removed", kind: "project", projectSlug: slug };
    }
    return { action: "ignored", kind: "project", projectSlug: slug };
  }

  const content = readFileSync(absPath, "utf8");
  const contentHash = sha256Hex(content);
  // SAFETY: `content_hash` is a single NOT NULL column on `projects`; an
  // unprojected slug yields no row, which the union already admits.
  const existing = db
    .prepare(`SELECT content_hash FROM projects WHERE slug = ?`)
    .get(slug) as { content_hash: string } | undefined;

  if (!options.force && existing && existing.content_hash === contentHash) {
    return { action: "unchanged", kind: "project", projectSlug: slug };
  }

  const { parsed, diagnostics } = parseProjectFileContent(content, {
    fallbackSlug: slug,
  });
  const fm = parsed.frontmatter;
  // SRV-3: what the tasks derived from, read BEFORE this write. A row still
  // carrying the F28-D3 sentinel is a rebuild that never finished, so what its
  // tasks were built from is unknown and they re-project.
  const tasksBuiltFrom =
    existing && existing.content_hash !== ""
      ? (projectContextForTasks(db, slug)?.digest ?? null)
      : null;

  db.prepare(
    `INSERT INTO projects
       (slug, name, archived, repo, default_branch, task_prefix, description,
        stages_json, workflow_json, agent_policy_json, credential_policy_json,
        guardrails_json, required_reviewers_json, source_path, content_hash,
        parsed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       name = excluded.name, archived = excluded.archived, repo = excluded.repo,
       default_branch = excluded.default_branch,
       task_prefix = excluded.task_prefix, description = excluded.description,
       stages_json = excluded.stages_json, workflow_json = excluded.workflow_json,
       agent_policy_json = excluded.agent_policy_json,
       credential_policy_json = excluded.credential_policy_json,
       guardrails_json = excluded.guardrails_json,
       required_reviewers_json = excluded.required_reviewers_json,
       source_path = excluded.source_path, content_hash = excluded.content_hash,
       parsed_at = excluded.parsed_at`,
  ).run(
    fm.slug,
    fm.name,
    fm.archived ? 1 : 0,
    fm.repo,
    fm.defaultBranch,
    fm.taskPrefix,
    parsed.description,
    JSON.stringify(fm.stages),
    JSON.stringify(fm.workflow),
    JSON.stringify(fm.agents),
    fm.credentialPolicy ? JSON.stringify(fm.credentialPolicy) : null,
    JSON.stringify(fm.guardrails),
    // Ruling 178: RESOLVED here (stage and agent names) so the task walk below
    // prints the gate's sentence from the row alone. A rule edit changes what
    // tasks derive from, which cascades into every task (below), so the queue
    // refreshes.
    JSON.stringify(resolveRequiredReviewers(fm, options.dataRoot)),
    sourcePath,
    // F28-D3: sentinel hash; the real content_hash is the LAST write below, so a
    // crash between here and the project_members / diagnostics rewrite leaves it
    // unmatched and the next rebuild re-runs instead of skipping "unchanged".
    "",
    nowIso(),
  );

  db.prepare(`DELETE FROM project_members WHERE project_slug = ?`).run(fm.slug);
  const insertMember = db.prepare(
    `INSERT OR REPLACE INTO project_members (project_slug, user_id, role) VALUES (?, ?, ?)`,
  );
  for (const member of fm.members) {
    insertMember.run(fm.slug, member.userId, member.role);
  }

  replaceDiagnostics(db, {
    sourcePath,
    projectSlug: fm.slug,
    taskKey: null,
    diagnostics,
  });
  recordProvenance(db, {
    sourcePath,
    contentHash,
    action: "projected",
    details: { diagnostics: diagnostics.length, members: fm.members.length },
  });
  emitProjectionEvent({
    type: "project.updated",
    projectSlug: fm.slug,
    occurredAt: nowIso(),
  });

  // Project-derived data is baked into task projections (stage-reference
  // diagnostics + readiness floors, effective repo, guest flags) — cascade a
  // forced re-projection of this project's tasks whenever the project row is
  // newly created OR a field tasks derive from changed. Unchanged project files
  // short-circuit above, so the common no-change rescan stays cheap.
  // rebuildAll suppresses the cascade and forces its own task walk instead
  // (see skipTaskCascade), reading `taskFacingChanged` for the same answer.
  //
  // Ruling 457 (SRV-3): "the project file changed" was the test here, and
  // every task creation changes it — `allocateTaskKey` bumps nextTaskNumber —
  // so creating one task re-projected all of them and sent one task.updated per
  // task to every open board and task page (30 tasks: 30 events, 279 commits).
  // A counter, a file lease or the description reaches no task row, so it now
  // costs the project row and one project.updated.
  const taskFacingChanged =
    tasksBuiltFrom === null ||
    tasksBuiltFrom !== (projectContextForTasks(db, slug)?.digest ?? null);
  const failedTasks: string[] = [];
  if (taskFacingChanged && !options.skipTaskCascade) {
    for (const key of listTaskDirs(slug, options.dataRoot)) {
      if (!reprojectCascadedTask(db, slug, key, options)) failedTasks.push(key);
    }
  }

  // F28-D3: commit marker — the true content_hash lands only after the projects
  // row, project_members, diagnostics and every cascaded task have been
  // written. A task the cascade could not re-project leaves the sentinel, and
  // SRV-3 reads a sentinel as "tasks built from an unknown project", so the
  // next rebuild of this file runs the cascade again.
  if (failedTasks.length === 0) {
    db.prepare(`UPDATE projects SET content_hash = ? WHERE slug = ?`).run(
      contentHash,
      fm.slug,
    );
  }

  return {
    action: "projected",
    kind: "project",
    projectSlug: slug,
    taskFacingChanged,
    ...(failedTasks.length > 0 && { failedTasks }),
  };
}

/**
 * Ruling 457: one task of the project cascade, in a SAVEPOINT of the project's
 * transaction. Since the project row became one transaction (SRV-4), a task
 * that threw here rolled back the project row and its members too: an admin's
 * member add never landed, and every later write of project.md (a task-key
 * allocation included) failed the same way while the fault was reported
 * against project.md. The task's own writes roll back to the savepoint, its
 * failure is reported against ITS file (ruling 218: a fault belongs to the file
 * that has it), the events it raised are dropped, and the cascade goes on.
 * Returns whether the task projected.
 */
function reprojectCascadedTask(
  db: DatabaseSync,
  slug: string,
  key: string,
  options: RebuildOptions,
): boolean {
  const rel = storeRelativePath(taskFilePath(slug, key, options.dataRoot), options.dataRoot);
  db.exec("SAVEPOINT cascade_task");
  try {
    const { result, events } = collectProjectionEvents(() =>
      rebuildTaskFile(db, slug, key, { ...options, force: true }),
    );
    db.exec("RELEASE cascade_task");
    // Into the project's own collection: they reach subscribers after COMMIT.
    for (const event of events) emitProjectionEvent(event);
    succeeded(rel, result);
    return true;
  } catch (error) {
    // Some errors (a full disk, an I/O error) make SQLite end the whole
    // transaction: nothing of the project's can land then, and `rebuildPath`
    // reports the original error against project.md.
    if (!db.isTransaction) throw error;
    db.exec("ROLLBACK TO cascade_task");
    db.exec("RELEASE cascade_task");
    reportRebuildFailure(db, rel, error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

// ----------------------------------------------------------------- tasks

function listTaskDirs(slug: string, dataRoot?: string): string[] {
  const dir = path.join(projectsDir(dataRoot), slug, "tasks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() && !e.name.startsWith(".") ? [e.name] : [],
  );
}

/**
 * Why the CURRENT revision cannot be accepted, or null — the acceptance gate as
 * every READ MODEL sees it, projected into `validation_block_reason`.
 *
 * That column is what every acceptance-readiness surface reads: the review
 * queue's "Waiting on your acceptance" panel, `decisionsRequiring`'s acceptance
 * decision, and through it Home's per-project count and the notifications inbox.
 * It carried `acceptanceBlockedReason` ALONE, which only binds once a
 * verdict-capable reviewer is engaged — so a delivered revision with zero
 * engaged reviewers projected as acceptance-ready while the server refused it
 * under R15-1 (proved live: `canAccept: false` with a blockedReason, and the
 * decision listed anyway). An inbox that promises a decision the server declines
 * is the dead end R14-2/P14-LV-06 exist to abolish.
 *
 * Mirrors `acceptanceRefusalReason` (task-actions.server.ts) in the same order,
 * and must move with it. THREE of its gates stay out: `archived`, the STAGE
 * boundary, and the no-change WORK refusal (R20-2/F20-6). The first two are
 * per-reader state — every consumer filters rows on `archived = 0` and on the
 * resolved review stage before it ever looks at this column. The third needs a
 * LIVE async GitHub probe (`acceptanceNoChangeCheck`) this SYNCHRONOUS projection
 * cannot run, so it is structurally absent — but it fails SAFE: for a has-work
 * branch the accept action refuses with the probe's commit-count sentence while
 * this column refuses with `verdictGateReason`'s generic "no PR" sentence (same
 * disposition, different wording), and the empty-branch case is routed away by
 * auto-detect before it reaches either gate. (F27-L1: this note previously read
 * "Only two of its gates stay out", omitting the work refusal.)
 *
 * UX19-3: the OPEN BLOCKED PACKET and CONFLICTING PR gates used to be excluded
 * under that same "per-reader state" heading, and that was false — both are task
 * facts sitting in the very file this projection reads. The consequence was a
 * SPLIT gate: the review queue re-derived them locally (`gateBlockedByKey`),
 * `decisionsRequiring`'s acceptance query re-derived NEITHER, so a review-stage,
 * human-waiting, packet-less task whose PR was `mergeable: "conflicting"` was
 * filed under "Still in review" by the queue and emitted as a `kind:"acceptance"`
 * decision by the inbox — an acceptance the server then refuses. One column, one
 * gate, both readers.
 */
function acceptanceBlockReason(
  fm: TaskFrontmatter,
  ctx: {
    /** The FRESH derivation for this same `fm` — never the stored cache. */
    validation: Validation;
    /** The writers' `blockedPacket` predicate, computed by the caller because
     *  the packet lives in the task file's BODY, not its frontmatter. */
    blockedPacket: boolean;
    /** Ruling 178: the project's resolved rules, from the projected row. */
    requiredReviewers: readonly RequiredReviewerView[];
  },
): string | null {
  return (
    // R16-3 (owner ruling 2026-08-04): a TERMINAL GitHub fact outranks every
    // process gate below it, so it is named FIRST here exactly as it is in
    // `acceptanceRefusalReason`. This gate used to be excluded as "per-reader
    // state the consumers already filter on" — and they do filter the ROW out
    // (review queue `isReady`, `decisionsRequiring`), while still rendering this
    // SENTENCE next to it: a closed-PR task read "…no approving verdict yet — run
    // a review for a verdict, or an admin can force-accept", naming the process
    // gate over the terminal fact and offering the one override the task page
    // withholds once the PR is gone (`acceptanceTerminallyBlocked`). The PR's
    // last-reconciled state is in the very frontmatter this projection is built
    // from, so naming it here fabricates nothing the file does not already say.
    closedPrBlockedReason(fm, fm.key) ??
    // F10-15: every required reviewer must have approved the current revision.
    acceptanceBlockedReason(fm) ??
    // Ruling 178: and every reviewer the PROJECT declares, engaged or not —
    // the same position it holds in `acceptanceRefusalReasons`.
    requiredReviewerRefusals(ctx.requiredReviewers, fm)[0] ??
    verdictGateReason(fm, ctx.validation, fm.key) ??
    // F7-VAL1/F7-PKT1: an operator-raised blocked decision is still open —
    // accepting would bury it. Same sentence the writers refuse with.
    (ctx.blockedPacket
      ? "This task has an open blocked decision. Resolve the operator's packet before accepting it."
      : null) ??
    // Ruling 135: the delivered revision is not on the PR, above the conflict.
    unpushedRevisionBlockedReason(
      fm.pr,
      activeWorkRevision(fm.workRevision)?.headSha ?? null,
      fm.key,
    ) ??
    // P14-LV-07: a PR GitHub cannot merge cannot be accepted.
    conflictingPrBlockedReason(fm, fm.key)
  );
}

export function rebuildTaskFile(
  db: DatabaseSync,
  slug: string,
  key: string,
  options: RebuildOptions = {},
): RebuildFileResult {
  return inOneTransaction(db, () => rebuildTaskFileNow(db, slug, key, options));
}

function rebuildTaskFileNow(
  db: DatabaseSync,
  slug: string,
  key: string,
  options: RebuildOptions,
): RebuildFileResult {
  const absPath = taskFilePath(slug, key, options.dataRoot);
  const sourcePath = storeRelativePath(absPath, options.dataRoot);

  if (!existsSync(absPath)) {
    const existed = db
      .prepare(
        `SELECT task_key FROM task_projections WHERE project_slug = ? AND task_key = ?`,
      )
      .get(slug, key);
    if (existed) {
      // F28-D3: drop the dependent rows FIRST and the `task_projections` row
      // (the `existed` probe's target) LAST. A crash mid-removal then leaves
      // the projection row present, so the next rebuild re-enters this branch
      // and finishes the delete — instead of orphaning `task_events` that no
      // later rebuild revisits (the probe would report the task already gone).
      db.prepare(
        `DELETE FROM task_events WHERE project_slug = ? AND task_key = ?`,
      ).run(slug, key);
      db.prepare(`DELETE FROM diagnostics WHERE source_path = ?`).run(sourcePath);
      recordProvenance(db, { sourcePath, contentHash: null, action: "removed" });
      db.prepare(
        `DELETE FROM task_projections WHERE project_slug = ? AND task_key = ?`,
      ).run(slug, key);
      emitProjectionEvent({
        type: "task.removed",
        projectSlug: slug,
        taskKey: key,
        occurredAt: nowIso(),
      });
      return { action: "removed", kind: "task", projectSlug: slug, taskKey: key };
    }
    return { action: "ignored", kind: "task", projectSlug: slug, taskKey: key };
  }

  const content = readFileSync(absPath, "utf8");
  const contentHash = sha256Hex(content);
  // SAFETY: `content_hash` is a single NOT NULL column on `task_projections`;
  // an unprojected task yields no row.
  const existing = db
    .prepare(
      `SELECT content_hash FROM task_projections WHERE project_slug = ? AND task_key = ?`,
    )
    .get(slug, key) as { content_hash: string } | undefined;

  if (!options.force && existing && existing.content_hash === contentHash) {
    return { action: "unchanged", kind: "task", projectSlug: slug, taskKey: key };
  }

  const { parsed, diagnostics } = parseTaskFileContent(content, {
    fallbackKey: key,
  });
  const fm = parsed.frontmatter;

  // UX19-3: ONE derivation feeds BOTH the `validation` column and the acceptance
  // gate beside it. The column used to carry `fm.validation` — a CACHE the schema
  // itself calls derived and "no longer written as a source of truth" — while the
  // gate one argument away re-derived from the same `fm`. A cache writer that
  // skipped its recompute (or a hand-edited `validation:` line, which files-are-
  // canonical-truth lets through) therefore put "validation healthy" on the review
  // queue card and the task hero pill at the same instant the gate underneath read
  // "no approving verdict yet". A projection row must not contradict itself.
  const derivedValidation = deriveValidation(fm);
  // The writers' `blockedPacket` predicate, verbatim (task-actions.server.ts):
  // the file's STORED readiness plus a packet whose type is `blocked`.
  const blockedPacket = fm.readiness === "blocked" && parsed.packet?.type === "blocked";

  // Project context (already-projected row): stages for reference checks,
  // default repo, member ids for guest flags.
  const projectContext = projectContextForTasks(db, slug);
  const project = projectContext?.row;
  // SAFETY: `stages_json` has ONE writer — rebuildProjectFile above stores
  // `JSON.stringify(fm.stages)`, and every stage the project-file schema parses
  // carries an `id`. Only the ids are read here.
  const stageIds: string[] = project
    ? (JSON.parse(project.stages_json) as { id: string }[]).map((s) => s.id)
    : [];
  // SAFETY: same single writer as `stages_json` — `rebuildProjectFile` stores
  // `JSON.stringify(fm.workflow)`, whose entries the project-file schema
  // guarantees carry `from`/`to`. Only those two are read here.
  const projectWorkflow: { from: string; to: string }[] = project
    ? (JSON.parse(project.workflow_json) as { from: string; to: string }[])
    : [];
  // SAFETY: same single writer — `JSON.stringify(resolveRequiredReviewers(fm))`.
  const requiredReviewers: RequiredReviewerView[] = project
    ? (JSON.parse(project.required_reviewers_json) as RequiredReviewerView[])
    : [];
  const allDiagnostics = [
    ...diagnostics,
    ...referenceDiagnostics({ stage: fm.stage, knownStageIds: stageIds }),
  ];

  // LV-20: a task sitting in the project's TERMINAL stage is closed — there is
  // nothing left for a human (or an agent) to decide, so it must never be
  // counted as pending. A conversational operator turn on an already-Done task
  // leaves `waiting: human` in the file forever (the run start flips it to
  // `agent`, the run end flips it to `human` — see the note below), which made a
  // Done+merged task report "Waiting on: Human decision", inflated the board's
  // "N waiting on a human decision" subtitle, and disagreed with the review
  // queue (which filters on the review boundary and reported 0).
  //
  // Every waiting-sensitive surface — board cards, the board subtitle, the task
  // detail "Waiting on" row, the review queue's `isReady`, `decisionsRequiring`
  // — reads `task_projections`, so normalizing once here fixes all of them
  // consistently. The canonical task file is untouched: move the task back out
  // of the terminal stage and its stored `waiting` applies again.
  // Why the acceptance gate is computed HERE and not inline in the upsert: the
  // waiting derivation below needs to know whether a human could accept this
  // task right now, and the projected column needs the same answer. One call,
  // one answer — two calls could drift.
  const acceptanceRefusal = acceptanceBlockReason(fm, {
    validation: derivedValidation,
    blockedPacket,
    requiredReviewers,
  });

  // Ruling 225 (F37-45): a task resting on a CLOCK is not waiting on a person.
  //
  // `waiting: "human"` in a task file means "no agent is working; a human is
  // next" — it is what `clearWaitingToHuman` writes when the last run ends.
  // Every waiting-sensitive surface renders that as the sentence "waiting on a
  // human", which was true while the only way forward was a person. Ruling 224
  // made it false: a task whose quota window is shut now resolves its packet by
  // writing a `run-operator` schedule and picks ITSELF back up when the window
  // reopens. Live on pass 37 four tasks sat exactly there — packet resolved,
  // schedule pending for 02:28 UTC, nothing asked of anybody — and the board
  // said "waiting on a human" on all four cards while its header counted "5
  // waiting on a human in this project". The packet that put them there had
  // promised, in viberr's own words, "Nothing runs until then and the board
  // says so." It did not.
  //
  // The narrow reading — only quota waits count — would be a second lie the
  // day something else writes a schedule, so the predicate is about the STATE,
  // not its cause: a pending occurrence exists, and nothing else is pending on
  // a person.
  //
  // That last clause is the one that matters. A human-actionable decision
  // OUTRANKS the clock: a task with an open packet, a live recommendation, or
  // a completion a human could accept right now still reads "waiting on you",
  // because the schedule does not take that work off anybody's hands — it only
  // says the task will also move on its own if nobody gets to it. Getting this
  // backwards would not soften a lie, it would HIDE a decision, and
  // `decisionsRequiring` reads this very column.
  //
  // Derived, never stored: like LV-20's terminal-stage `"none"` above and
  // `validation: "bypassed"`, the canonical file keeps saying `human`. Nothing
  // authors `waiting: schedule`, so a file that somehow carries one projects as
  // whatever it has actually earned here.
  /**
   * Ruling 225, amended again — and this one was caught on the live board, not
   * by reading.
   *
   * `acceptanceRefusal === null` is NOT "a human could accept this". The stage
   * gate is the ONE acceptance refusal `acceptanceBlockReason` deliberately
   * leaves out, because it turns on the project's workflow graph rather than on
   * anything in the task file (see that function's own note). So a task sitting
   * at an early stage with nothing delivered has no refusal to report — not
   * because it is acceptable, but because the only thing refusing it was not
   * consulted.
   *
   * Live: SHOP-21 at Build, no revision, no PR, a `run-operator` schedule
   * pending for 07:29, and its card and rail still read "waiting on a human"
   * after this ruling shipped. Nobody can accept a task at Build, and the
   * decisions inbox was not counting it either — the board's own "Waiting on
   * me" tally read zero while the card named a person.
   */
  const couldBeAcceptedNow =
    acceptanceRefusal === null &&
    isAtAcceptanceBoundary(
      fm.stage,
      stageIds.map((id) => ({ id })),
      projectWorkflow,
    );

  const restsOnSchedule =
    // Only the state that actually says the false sentence. `waiting: "none"`
    // renders NO wait tag at all, so it tells nobody anything and needs no
    // correcting; `"agent"` is a run in flight. Narrowing this to the one
    // stored value the ruling is about is what keeps the derivation from
    // inventing a claim where there was none.
    fm.waiting === "human" &&
    !parsed.packet &&
    fm.recommendations.length === 0 &&
    // Ruling 225 (amended): "nothing a human could accept right now" — the
    // stage gate included, which `acceptanceRefusal` alone omits.
    !couldBeAcceptedNow &&
    // Ruling 131(d): a task that waits on other work is HELD, and the schedule
    // runner refuses its occurrence on exactly those grounds — "waits on other
    // work (…) — no operator run was started; Viberr releases the task when
    // every entry is done." A card reading "resumes Sep 14 · 02:28" over an
    // occurrence the runner will refuse is the very lie this ruling removes,
    // reintroduced by it. What holds such a task is the dependency, and the
    // board already says so.
    fm.blockedBy.length === 0 &&
    // And the same again for an archived task. The schedule runner refuses its
    // occurrence with its own outcome (`skipped-archived`, kept distinct from
    // `skipped-done` so the note does not tell an archived task it was
    // "already Done"), so a resume time on that card promises a run that will
    // not happen. The terminal-stage case is already handled above, by LV-20's
    // `none`. R14-3 archiving removes a task from every view but the Archived
    // filter — and that filter still draws the card, and the card still draws
    // this tag, so "a consumer filters it out" is not true here.
    !fm.archived &&
    fm.schedules.some((occurrence) => occurrence.status === "pending");

  const projectedWaiting: Waiting = isTerminalStage(
    fm.stage,
    stageIds.map((id) => ({ id })),
  )
    ? "none"
    : restsOnSchedule
      ? "schedule"
      : fm.waiting === "schedule"
        ? "human"
        : fm.waiting;

  // Stored readiness is NULL when the field was missing/invalid in the file
  // (a readiness-path diagnostic exists in that case).
  const readinessWasInvalid = allDiagnostics.some((d) => d.path === "readiness");
  const storedReadiness = readinessWasInvalid ? null : fm.readiness;
  const derivation = deriveReadiness({
    storedReadiness,
    diagnostics: allDiagnostics,
    // Ruling 131: a task waiting on other work is floored at `blocked`; the
    // list's states are resolved at read time (dependencies.server.ts), so
    // the floor reads only that a list exists.
    dependenciesListed: fm.blockedBy.length > 0,
  });

  const memberIds = projectContext?.memberIds;
  // Agent events render under the agent's OWN name (e.g. "Reviewer"), not the
  // backend/runtime label — resolved from this project's run rows.
  const actorOptions: Parameters<typeof createActorResolver>[1] = {
    agentNames: agentNamesByProfile(db, slug),
  };
  // Only a project that HAS a row has members; without one the resolver must
  // fall back to its no-project-context behaviour, which an explicitly empty
  // set would not give it.
  if (memberIds) actorOptions.projectMemberIds = memberIds;
  const resolveActor = createActorResolver(db, actorOptions);

  const commentCount = parsed.timeline.filter((e) => e.type === "comment").length;

  // D4 (C-CONTINUITY): project runtime-continuity health as a task-level fact.
  // The Continuity Recovery panel (continuity-recovery.tsx) treats the canonical
  // `continuity` timeline event as "the proof that a break happened" — the run
  // markers it also reads only REFINE recovery progress (running/recovered/
  // stalled) and live in the run projection, not the task file this projection
  // reads. So the derivable, file-authoritative state is binary: a break is on
  // the record → `degraded`, else NULL. Projecting it is what carries the state
  // off the panel and onto the board card, the board filter and the review row,
  // so it means the same thing everywhere a supervisor looks.
  const continuity: "degraded" | null = parsed.timeline.some(
    (e) => e.type === "continuity",
  )
    ? "degraded"
    : null;

  db.prepare(
    `INSERT INTO task_projections
       (project_slug, task_key, title, stage, readiness, stored_readiness,
        waiting, urgent, priority, labels_json, due_date, blocked_by_json, archived, validation, validation_block_reason, acceptance, continuity, owner_user_id, specialist_json,
        reviewers_json, operator_json, branch, repo, pr_json, github_json,
        work_revision_sha, goal, packet_json, recommendation_count, recommendation_kinds,
        schedules_json, event_count, comment_count,
        goal_id, goal_link_index,
        diagnostic_count, created_at, updated_at, board_rank, source_path,
        content_hash, parsed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_slug, task_key) DO UPDATE SET
       title = excluded.title, stage = excluded.stage,
       readiness = excluded.readiness, stored_readiness = excluded.stored_readiness,
       waiting = excluded.waiting, urgent = excluded.urgent,
       priority = excluded.priority, labels_json = excluded.labels_json,
       due_date = excluded.due_date,
       blocked_by_json = excluded.blocked_by_json,
       archived = excluded.archived,
       validation = excluded.validation,
       validation_block_reason = excluded.validation_block_reason,
       acceptance = excluded.acceptance,
       continuity = excluded.continuity,
       owner_user_id = excluded.owner_user_id,
       specialist_json = excluded.specialist_json,
       reviewers_json = excluded.reviewers_json,
       operator_json = excluded.operator_json, branch = excluded.branch,
       repo = excluded.repo, pr_json = excluded.pr_json,
       github_json = excluded.github_json,
       work_revision_sha = excluded.work_revision_sha,
       goal = excluded.goal,
       packet_json = excluded.packet_json,
       recommendation_count = excluded.recommendation_count,
       recommendation_kinds = excluded.recommendation_kinds,
       schedules_json = excluded.schedules_json,
       event_count = excluded.event_count,
       comment_count = excluded.comment_count,
       goal_id = excluded.goal_id,
       goal_link_index = excluded.goal_link_index,
       diagnostic_count = excluded.diagnostic_count,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       board_rank = excluded.board_rank,
       source_path = excluded.source_path, content_hash = excluded.content_hash,
       parsed_at = excluded.parsed_at`,
  ).run(
    slug,
    fm.key,
    fm.title,
    fm.stage,
    derivation.readiness,
    storedReadiness,
    projectedWaiting,
    fm.urgent ? 1 : 0,
    fm.priority,
    JSON.stringify(fm.labels),
    fm.dueDate,
    // Ruling 131: the raw list, verbatim (canonical spellings).
    JSON.stringify(fm.blockedBy),
    fm.archived ? 1 : 0,
    derivedValidation,
    acceptanceRefusal,
    // N20-14 (§5c): the durable force-accept fact, projected for the display arm.
    fm.acceptance ?? null,
    // D4: runtime-continuity health, derived from the timeline above.
    continuity,
    fm.ownerUserId,
    // Derived legacy projection shapes (G1): the delivering engagement fills
    // the `specialist` column, the supporting engagements fill `reviewers`.
    // The extra `delivers` key rides along harmlessly in the JSON.
    deliveringEngagement(fm) ? JSON.stringify(deliveringEngagement(fm)) : null,
    JSON.stringify(supportingEngagements(fm)),
    fm.operator ? JSON.stringify(fm.operator) : null,
    fm.branch,
    project?.repo ?? null, // P13-D-5: no task-level repo override
    fm.pr ? JSON.stringify(fm.pr) : null,
    fm.github ? JSON.stringify(fm.github) : null,
    // Ruling 53/88: the delivered revision the board's acceptance ceremony
    // discloses and then echoes back for the server to verify. Written from the
    // SAME expression the server's own `acceptanceDisclosureOf` reads
    // (`fm.workRevision?.headSha ?? "none"`, task-actions.server.ts), so a board
    // echo built from this column can only differ from the live task when the
    // task really moved under the dialog — which is the refusal the echo exists
    // to produce. Ruling 161: a discarded revision projects as none.
    activeWorkRevision(fm.workRevision)?.headSha ?? null,
    parsed.goal,
    parsed.packet ? JSON.stringify(parsed.packet) : null,
    fm.recommendations.length,
    // Sorted + deduped so the SQL below can ask "is this ONLY acceptances?"
    // with a plain equality test rather than a LIKE that would also match
    // `accept_completion,transition`.
    [...new Set(fm.recommendations.map((r) => r.kind))].sort().join(","),
    JSON.stringify(fm.schedules),
    parsed.timeline.length,
    commentCount,
    // Ruling 99: the chained-goal back-reference, for the board chip and the
    // goal-advance hook.
    fm.goalRef?.goalId ?? null,
    fm.goalRef?.linkIndex ?? null,
    allDiagnostics.length,
    fm.createdAt,
    fm.updatedAt,
    fm.boardRank,
    sourcePath,
    // F28-D3: write a sentinel hash first; the REAL content_hash is the LAST
    // write below (a commit marker). `""` is never a real sha256, so a crash
    // between here and the task_events/diagnostics rewrite leaves the hash
    // unmatched and the next rebuild re-runs — instead of short-circuiting
    // "unchanged" on a torn projection whose events never got rewritten.
    "",
    nowIso(),
  );

  syncTaskEvents(
    db,
    slug,
    fm.key,
    parsed.timeline.map((event) => taskEventColumns(event, resolveActor)),
  );

  replaceDiagnostics(db, {
    sourcePath,
    projectSlug: slug,
    taskKey: fm.key,
    diagnostics: allDiagnostics,
  });
  recordProvenance(db, {
    sourcePath,
    contentHash,
    action: "projected",
    details: {
      diagnostics: allDiagnostics.length,
      events: parsed.timeline.length,
      readiness: derivation.readiness,
      downgraded: derivation.downgraded,
    },
  });
  // F28-D3: commit marker — flip the sentinel to the true content_hash only now
  // that the projection row, the task_events rows and the diagnostics have all
  // landed. Everything above runs in one transaction (ruling 457), so this row
  // is consistent by the time the hash lets a later rebuild skip it.
  db.prepare(
    `UPDATE task_projections SET content_hash = ? WHERE project_slug = ? AND task_key = ?`,
  ).run(contentHash, slug, fm.key);
  emitProjectionEvent({
    type: "task.updated",
    projectSlug: slug,
    taskKey: fm.key,
    occurredAt: nowIso(),
  });

  return { action: "projected", kind: "task", projectSlug: slug, taskKey: fm.key };
}

/** One `task_events` row's columns, as the rebuilder writes them. A type alias,
 *  not an interface, so the SELECT-row assertion in `syncTaskEvents` is checked
 *  against SQLite's own output types (see `TaskEventRow`). */
type TaskEventColumns = {
  occurred_at: string;
  type: string;
  actor_kind: "human" | "agent" | "operator" | "controller" | "system";
  actor_ref: string;
  actor_json: string;
  title: string | null;
  text: string;
  to_agent: 0 | 1;
  evidence_json: string | null;
  attachments_json: string | null;
};

/** A stored row: the columns plus its identity and place. */
type StoredTaskEventRow = TaskEventColumns & { id: number; position: number };

function taskEventColumns(
  event: TaskFileEvent,
  resolveActor: ReturnType<typeof createActorResolver>,
): TaskEventColumns {
  // Tolerantly-kept unrecognized authors project as system actors so their
  // events stay visible in feeds (D7 — never dropped over an author).
  const actorKind =
    event.actor.kind === "human"
      ? "human"
      : event.actor.kind === "system" || event.actor.kind === "unknown"
        ? "system"
        : event.actor.kind === "operator"
          ? "operator"
          : event.actor.kind === "controller"
            ? "controller"
            : "agent";
  const actorRef =
    event.actor.kind === "human"
      ? event.actor.userId
      : event.actor.kind === "agent"
        // D32-14 (pass 32): keyed by PROFILE, not by (backend, profile). A
        // fork that ran one leg on Codex and one on Claude is ONE actor to a
        // reader; keying on the backend listed "Docs Writer" twice in the
        // Activity actor filter, each option finding half the events.
        ? `agent/${event.actor.profileId}`
        : event.actor.kind === "system"
          ? event.actor.systemId
          : event.actor.kind === "unknown"
            ? event.actor.raw
            : event.actor.kind === "controller"
              ? "controller"
              : "operator";
  return {
    occurred_at: event.occurredAt,
    type: event.type,
    actor_kind: actorKind,
    actor_ref: actorRef,
    actor_json: JSON.stringify(resolveActor(event.actor)),
    title: event.title,
    text: event.text,
    to_agent: event.toAgent ? 1 : 0,
    evidence_json: event.evidence ? JSON.stringify(event.evidence) : null,
    attachments_json:
      event.attachments && event.attachments.length > 0
        ? JSON.stringify(event.attachments)
        : null,
  };
}

/** Same event: the heading a timeline entry is written under. */
function sameTaskEvent(a: TaskEventColumns, b: TaskEventColumns): boolean {
  return (
    a.occurred_at === b.occurred_at &&
    a.type === b.type &&
    a.actor_kind === b.actor_kind &&
    a.actor_ref === b.actor_ref
  );
}

/** Same content under that heading (the actor snapshot included). */
function sameTaskEventContent(a: TaskEventColumns, b: TaskEventColumns): boolean {
  return (
    a.actor_json === b.actor_json &&
    a.title === b.title &&
    a.text === b.text &&
    a.to_agent === b.to_agent &&
    a.evidence_json === b.evidence_json &&
    a.attachments_json === b.attachments_json
  );
}

/**
 * Ruling 457 (CS-6, CS-1): write a task's timeline rows (`fresh`, newest
 * first, position 0 = newest) without re-issuing the rows that did not change.
 *
 * The rebuilder used to DELETE every row and INSERT them all again, so one
 * comment on a 100-event task cost 102 statements and gave all 100 existing
 * rows new ids. The task page keys its timeline on that id (and the Activity
 * page its stream), so every write remounted every item: each comment
 * re-parsed its Markdown, lost its Show-more state and re-clamped after paint.
 *
 * A timeline grows at its NEWEST end, so the stored rows are aligned with the
 * fresh ones from the OLDEST end: while both carry the same event (same time,
 * type and actor), the stored row is kept and its id with it. Kept rows move
 * by one position shift (one UPDATE for the lot) and take any changed content
 * in place (a rename's actor snapshot, an edited text); the stored rows past
 * the first difference are deleted and the fresh ones inserted. A compaction
 * or a hand edit in the middle simply keeps less. Positions that are not the
 * contiguous 0..n-1 this writer produces are rewritten from scratch.
 */
function syncTaskEvents(
  db: DatabaseSync,
  slug: string,
  key: string,
  fresh: readonly TaskEventColumns[],
): void {
  // SAFETY: the SELECT names exactly `id`, `position` and TaskEventColumns'
  // members, all `task_events` columns with the nullability TaskEventColumns
  // gives them (0001_baseline.sql); `actor_kind` is CHECK-pinned to its union
  // and `to_agent` is written as 0/1 by `taskEventColumns` alone.
  const stored = db
    .prepare(
      `SELECT id, position, occurred_at, type, actor_kind, actor_ref, actor_json,
              title, text, to_agent, evidence_json, attachments_json
         FROM task_events WHERE project_slug = ? AND task_key = ?
        ORDER BY position DESC, id DESC`,
    )
    .all(slug, key) as StoredTaskEventRow[];
  // `stored` is oldest first; fresh[fresh.length - 1 - j] is its j-th oldest.
  const contiguous = stored.every((row, j) => row.position === stored.length - 1 - j);
  let kept = 0;
  while (
    contiguous &&
    kept < stored.length &&
    kept < fresh.length &&
    sameTaskEvent(stored[kept]!, fresh[fresh.length - 1 - kept]!)
  ) {
    kept += 1;
  }

  if (kept === 0) {
    if (stored.length > 0) {
      db.prepare(`DELETE FROM task_events WHERE project_slug = ? AND task_key = ?`).run(
        slug,
        key,
      );
    }
  } else {
    if (kept < stored.length) {
      db.prepare(`DELETE FROM task_events WHERE id IN (SELECT value FROM json_each(?))`).run(
        JSON.stringify(stored.slice(kept).map((row) => row.id)),
      );
    }
    // Kept row j moves from stored.length-1-j to fresh.length-1-j: one shift.
    if (fresh.length !== stored.length) {
      db.prepare(
        `UPDATE task_events SET position = position + ? WHERE project_slug = ? AND task_key = ?`,
      ).run(fresh.length - stored.length, slug, key);
    }
    const update = db.prepare(
      `UPDATE task_events SET actor_json = ?, title = ?, text = ?, to_agent = ?,
              evidence_json = ?, attachments_json = ?
        WHERE id = ?`,
    );
    for (let j = 0; j < kept; j += 1) {
      const row = fresh[fresh.length - 1 - j]!;
      if (sameTaskEventContent(stored[j]!, row)) continue;
      update.run(
        row.actor_json,
        row.title,
        row.text,
        row.to_agent,
        row.evidence_json,
        row.attachments_json,
        stored[j]!.id,
      );
    }
  }

  const insert = db.prepare(
    `INSERT INTO task_events
       (project_slug, task_key, position, occurred_at, type, actor_kind,
        actor_ref, actor_json, title, text, to_agent, evidence_json,
        attachments_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // The new rows are the newest ones, positions 0.. — inserted newest first,
  // as the full rewrite always did.
  for (let position = 0; position < fresh.length - kept; position += 1) {
    const row = fresh[position]!;
    insert.run(
      slug,
      key,
      position,
      row.occurred_at,
      row.type,
      row.actor_kind,
      row.actor_ref,
      row.actor_json,
      row.title,
      row.text,
      row.to_agent,
      row.evidence_json,
      row.attachments_json,
    );
  }
}

// ---------------------------------------------------------------- goals

/**
 * Ruling 99: project one chained-goal file into `goal_projections`.
 *
 * Link statuses are RECONCILED here, not copied: for every link that names a
 * task, the link's effective status derives from the task's projected row
 * (terminal stage → done; archived → failed), with the stored value keeping
 * `skipped` and covering tasks the projection cannot see. The goal-advance
 * machinery writes the canonical statuses; this keeps the READ honest when a
 * task moved out-of-band between advances.
 */
export function rebuildGoalFile(
  db: DatabaseSync,
  slug: string,
  goalId: string,
  options: RebuildOptions = {},
): RebuildFileResult {
  return inOneTransaction(db, () => rebuildGoalFileNow(db, slug, goalId, options));
}

function rebuildGoalFileNow(
  db: DatabaseSync,
  slug: string,
  goalId: string,
  options: RebuildOptions,
): RebuildFileResult {
  const absPath = goalFilePath(slug, goalId, options.dataRoot);
  const sourcePath = storeRelativePath(absPath, options.dataRoot);

  if (!existsSync(absPath)) {
    const existed = db
      .prepare(
        `SELECT goal_id FROM goal_projections WHERE project_slug = ? AND goal_id = ?`,
      )
      .get(slug, goalId);
    if (!existed) return { action: "ignored", kind: "goal" };
    // The third removal branch, which never got what the other two have: the
    // project and task branches both drop `diagnostics` for the source path
    // before the projection row (F28-D3 — dependents first, the probe's own
    // target last, so an interrupted removal finishes on the next rebuild).
    // Without it a deleted BROKEN goal file left its hard-stop rows behind and
    // the store kept reporting a goal that no longer exists as untrusted, with
    // no file left to fix and no later rebuild that would revisit it.
    db.prepare(`DELETE FROM diagnostics WHERE source_path = ?`).run(sourcePath);
    recordProvenance(db, {
      sourcePath,
      contentHash: null,
      action: "removed",
      details: { kind: "goal", projectSlug: slug, goalId },
    });
    db.prepare(
      `DELETE FROM goal_projections WHERE project_slug = ? AND goal_id = ?`,
    ).run(slug, goalId);
    emitProjectionEvent({
      type: "goal.updated",
      projectSlug: slug,
      goalId,
      occurredAt: nowIso(),
    });
    return { action: "removed", kind: "goal", projectSlug: slug, goalId };
  }

  const content = readFileSync(absPath, "utf8");
  const contentHash = sha256Hex(content);
  if (!options.force) {
    // SAFETY: `content_hash` is a single NOT NULL column on `goal_projections`;
    // an absent row yields undefined.
    const row = db
      .prepare(
        `SELECT content_hash FROM goal_projections WHERE project_slug = ? AND goal_id = ?`,
      )
      .get(slug, goalId) as { content_hash: string } | undefined;
    if (row && row.content_hash === contentHash) {
      return { action: "unchanged", kind: "goal", projectSlug: slug, goalId };
    }
  }

  const parsed = parseGoalFileContent(content);
  if (!parsed) {
    // Goal files are app-written; an unparseable one is recorded, and any
    // existing row is left standing (visible-but-stale beats vanished). The
    // diagnostics rows are what make it FINDABLE: `npm run rescan` counts this
    // as an error, and untrustedFileReport is where it learns the file's name.
    replaceDiagnostics(db, {
      sourcePath,
      projectSlug: slug,
      taskKey: null,
      diagnostics: diagnoseGoalFileContent(content),
    });
    recordProvenance(db, {
      sourcePath,
      contentHash,
      action: "error",
      details: { kind: "goal", message: "goal file could not be parsed" },
    });
    return { action: "error", kind: "goal", projectSlug: slug, goalId };
  }
  // Parsed cleanly: clear any diagnostics a previous broken revision left.
  replaceDiagnostics(db, {
    sourcePath,
    projectSlug: slug,
    taskKey: null,
    diagnostics: [],
  });
  const fm = parsed.frontmatter;

  // Reconcile link statuses against the live task rows.
  const stages = projectStagesForGoals(db, slug);
  const links = fm.links.map((link) => {
    if (!link.taskKey) return link;
    // SAFETY: the SELECT names exactly `stage` (TEXT NOT NULL) and `archived`
    // (INTEGER NOT NULL DEFAULT 0) on `task_projections`.
    const task = db
      .prepare(
        `SELECT stage, archived FROM task_projections
         WHERE project_slug = ? AND task_key = ?`,
      )
      .get(slug, link.taskKey) as { stage: string; archived: number } | undefined;
    if (!task) return link;
    if (link.status === "skipped") return link;
    if (task.archived) {
      // Archiving a task that already COMPLETED its link is bookkeeping, not a
      // chain failure. The engine treats `done` as settled and never revisits
      // it, so failing it here would write a status the file can never be
      // brought to agree with — and the Goals panel would offer Retry/Skip
      // buttons the server refuses from the file.
      return link.status === "done" ? link : { ...link, status: "failed" as const };
    }
    if (stages && isTerminalStage(task.stage, stages)) {
      return { ...link, status: "done" as const };
    }
    if (link.status === "done" || link.status === "failed") {
      // The stored status is a CLAIM the advance machinery last wrote, and the
      // live task contradicts it: it was pulled back out of the terminal stage,
      // or restored from the archive. Both are re-openings, and the engine
      // derives the same thing, so the two stay in step.
      return { ...link, status: "active" as const };
    }
    return link;
  });

  const done = links.filter(
    (l) => l.status === "done" || l.status === "skipped",
  ).length;
  db.prepare(
    `INSERT INTO goal_projections
       (project_slug, goal_id, title, status, created_by, created_by_label,
        on_failure, links_json, description, current_index, links_total,
        links_done, created_at, updated_at, source_path, content_hash, parsed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_slug, goal_id) DO UPDATE SET
       title = excluded.title, status = excluded.status,
       created_by = excluded.created_by,
       created_by_label = excluded.created_by_label,
       on_failure = excluded.on_failure, links_json = excluded.links_json,
       description = excluded.description,
       current_index = excluded.current_index,
       links_total = excluded.links_total, links_done = excluded.links_done,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       source_path = excluded.source_path, content_hash = excluded.content_hash,
       parsed_at = excluded.parsed_at`,
  ).run(
    slug,
    fm.id,
    fm.title,
    fm.status,
    fm.createdBy,
    fm.createdByLabel,
    fm.onFailure,
    JSON.stringify(links),
    parsed.description,
    currentLinkIndex(links),
    links.length,
    done,
    fm.createdAt,
    fm.updatedAt,
    sourcePath,
    contentHash,
    nowIso(),
  );
  recordProvenance(db, {
    sourcePath,
    contentHash,
    action: "projected",
    details: { kind: "goal", projectSlug: slug, goalId: fm.id },
  });
  emitProjectionEvent({
    type: "goal.updated",
    projectSlug: slug,
    goalId: fm.id,
    occurredAt: nowIso(),
  });
  return { action: "projected", kind: "goal", projectSlug: slug, goalId: fm.id };
}

/** Decodes the `projects.stages_json` column for the goal reconciler: entries
 *  without a string `id` (and non-array payloads) read as empty, mirroring how
 *  `deployedProfileIdsSchema` tolerates a malformed projection column. */
const goalStageEntriesSchema = z
  .array(z.object({ id: z.string() }).nullable().catch(null))
  .catch([]);

/** The project's stage list for terminal-stage checks; null when the project
 *  row is missing or its stages column does not decode. */
function projectStagesForGoals(
  db: DatabaseSync,
  slug: string,
): { id: string }[] | null {
  // SAFETY: `stages_json` is a single NOT NULL column on `projects` (DEFAULT
  // '[]'); an absent row yields undefined.
  const row = db
    .prepare(`SELECT stages_json FROM projects WHERE slug = ?`)
    .get(slug) as { stages_json: string } | undefined;
  if (!row) return null;
  try {
    const entries = goalStageEntriesSchema.parse(JSON.parse(row.stages_json));
    const ids = entries.flatMap((s) => (s === null ? [] : [{ id: s.id }]));
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ path router

const TASK_PATH_RE = /^projects\/([^/]+)\/tasks\/([^/]+)\/task\.md$/;
const PROJECT_PATH_RE = /^projects\/([^/]+)\/project\.md$/;
const GOAL_PATH_RE = /^projects\/([^/]+)\/goals\/([^/]+)\.md$/;

/**
 * Single-file incremental rebuild for any absolute path under the data
 * root. Non-store paths are ignored. Used by the watcher and mutations.
 */
export function rebuildPath(
  db: DatabaseSync,
  absPath: string,
  options: RebuildOptions = {},
): RebuildFileResult {
  const rel = storeRelativePath(absPath, options.dataRoot);
  try {
    const taskMatch = TASK_PATH_RE.exec(rel);
    if (taskMatch) {
      return succeeded(rel, rebuildTaskFile(db, taskMatch[1]!, taskMatch[2]!, options));
    }
    const projectMatch = PROJECT_PATH_RE.exec(rel);
    if (projectMatch) {
      return succeeded(rel, rebuildProjectFile(db, projectMatch[1]!, options));
    }
    const goalMatch = GOAL_PATH_RE.exec(rel);
    if (goalMatch) {
      return succeeded(rel, rebuildGoalFile(db, goalMatch[1]!, goalMatch[2]!, options));
    }
    return { action: "ignored", kind: "other" };
  } catch (error) {
    reportRebuildFailure(db, rel, error instanceof Error ? error : new Error(String(error)));
    return { action: "error", kind: "other" };
  }
}

/**
 * A rebuild of `rel` threw: say so without raising. Shared by `rebuildPath`
 * and the project cascade's per-task isolation.
 */
function reportRebuildFailure(db: DatabaseSync, rel: string, error: Error): void {
  const message = error.message;
  logger.error("projection rebuild failed", { sourcePath: rel, err: error });
  // Ruling 217 (F37-37): this catch is deliberately quiet so one bad file
  // cannot take the process down — and for the twelve minutes the store was
  // `SQLITE_CORRUPT`, quiet is exactly what it was, while health reported
  // `degraded: []`. The log line stays; the FACT now has somewhere to live.
  recordProjectionFault(rel, message);
  // Ruling 219 (F37-39): the provenance row is a NOTE ABOUT the failure, and
  // it is written to the same store that just failed — so when the store
  // itself is the fault, this threw out of the catch and `rebuildPath` raised
  // after all. Live: `resolvePacket` wrote SHOP-4's file (packet resolved,
  // `waiting: agent`), called `reprojectTask`, and died here — so the operator
  // re-invoke that the resolution owes never ran, and the task sat at
  // "agent working" with nothing running for eleven minutes. The canonical
  // write had already succeeded; only the MIRROR failed, and a mirror must
  // never take down the action that already told the truth.
  try {
    recordProvenance(db, {
      sourcePath: rel,
      contentHash: null,
      action: "error",
      details: { message },
    });
  } catch (provenanceError) {
    logger.warn("could not record the rebuild failure's provenance row either", {
      sourcePath: rel,
      err:
        provenanceError instanceof Error
          ? provenanceError
          : new Error(String(provenanceError)),
    });
  }
}

/** Ruling 217/218: a rebuild that WROTE clears THIS FILE's fault — the mirror
 *  tracks it again. An `ignored` path is not a projection source and says
 *  nothing either way, so it never clears. Nor does a success here speak for
 *  any other file: that was ruling 217's own defect, fixed by 218. */
function succeeded(rel: string, result: RebuildFileResult): RebuildFileResult {
  if (result.action !== "error") clearProjectionFault(rel);
  return result;
}

/** project.md write already happened — reproject it incrementally, through
 *  `rebuildPath` so a failed rebuild is recorded rather than thrown. */
export function reprojectProject(
  db: DatabaseSync,
  ctx: { dataRoot?: string },
  projectSlug: string,
): void {
  rebuildPath(db, projectFilePath(projectSlug, ctx.dataRoot), {
    dataRoot: ctx.dataRoot,
  });
}

// --------------------------------------------------------- scoped rescan

/**
 * Scoped rescan: reproject a SINGLE project's files (project.md + its task
 * files) and prune only THAT project's vanished rows. Same reconciliation as
 * `rebuildAll`, confined to `slug`, so the project-scoped Board "Re-scan"
 * action can't trigger an instance-wide rebuild of projects the caller has no
 * authority over (F20 — the gate is project-scoped, so the effect must be too).
 */
export function rebuildProject(
  db: DatabaseSync,
  slug: string,
  options: RebuildOptions = {},
): RescanSummary {
  const startedAt = Date.now();
  const summary: RescanSummary = {
    projects: 0,
    tasks: 0,
    changed: 0,
    unchanged: 0,
    removed: 0,
    errors: 0,
    durationMs: 0,
  };
  const track = (result: RebuildFileResult) => {
    if (result.action === "projected") summary.changed += 1;
    else if (result.action === "unchanged") summary.unchanged += 1;
    else if (result.action === "removed") summary.removed += 1;
    else if (result.action === "error") summary.errors += 1;
  };

  const seenTasks = new Set<string>();
  const projectExists = existsSync(projectFilePath(slug, options.dataRoot));
  let projectChanged = false;
  if (projectExists) {
    summary.projects += 1;
    // Suppress the in-file cascade — this walk re-projects every task itself
    // (with force when a field tasks derive from changed), matching rebuildAll's
    // pattern.
    const result = rebuildPath(db, projectFilePath(slug, options.dataRoot), {
      ...options,
      skipTaskCascade: true,
    });
    track(result);
    // SRV-3: only a change tasks derive from forces them (see rebuildProjectFile).
    projectChanged = result.action === "projected" && result.taskFacingChanged === true;
  }

  const taskOptions = projectChanged ? { ...options, force: true } : options;
  for (const key of listTaskDirs(slug, options.dataRoot)) {
    if (!existsSync(taskFilePath(slug, key, options.dataRoot))) continue;
    summary.tasks += 1;
    seenTasks.add(key);
    track(rebuildPath(db, taskFilePath(slug, key, options.dataRoot), taskOptions));
  }

  // Ruling 99: goals — AFTER the tasks, so link reconciliation reads fresh
  // task rows. Force alongside a changed project row for the same baked-in
  // reference reason tasks are forced.
  const seenGoals = new Set<string>();
  for (const goalId of listGoalIds(slug, options.dataRoot)) {
    seenGoals.add(goalId);
    track(rebuildGoalFile(db, slug, goalId, taskOptions));
  }
  // SAFETY: `goal_id` is a single NOT NULL column (half the `goal_projections`
  // primary key).
  const goalRows = db
    .prepare(`SELECT goal_id FROM goal_projections WHERE project_slug = ?`)
    .all(slug) as { goal_id: string }[];
  for (const row of goalRows) {
    if (!seenGoals.has(row.goal_id)) {
      track(rebuildGoalFile(db, slug, row.goal_id, options));
    }
  }

  // Prune ONLY this project's task rows whose backing files are gone.
  // SAFETY: `task_key` is a single NOT NULL column (half the primary key).
  const taskRows = db
    .prepare(`SELECT task_key FROM task_projections WHERE project_slug = ?`)
    .all(slug) as { task_key: string }[];
  for (const row of taskRows) {
    if (!seenTasks.has(row.task_key)) {
      track(rebuildTaskFile(db, slug, row.task_key, options));
    }
  }
  // If the project.md itself vanished, prune the project row too.
  if (!projectExists) {
    const existed = db.prepare(`SELECT slug FROM projects WHERE slug = ?`).get(slug);
    if (existed) track(rebuildProjectFile(db, slug, options));
  }

  summary.durationMs = Date.now() - startedAt;
  recordProvenance(db, {
    sourcePath: storeRelativePath(
      path.join(projectsDir(options.dataRoot), slug),
      options.dataRoot,
    ),
    contentHash: null,
    action: "rescan",
    details: { ...summary, slug, scope: "project" },
  });
  emitProjectionEvent({
    type: "projection.rebuilt",
    scope: "project",
    occurredAt: nowIso(),
    changed: summary.changed,
  });
  logger.info("project projection rescan complete", { slug, ...summary });
  return summary;
}

// ------------------------------------------------------------ full rescan

/** Full rescan: project every store file, prune vanished rows. */
export function rebuildAll(
  db: DatabaseSync,
  options: RebuildOptions = {},
): RescanSummary {
  const startedAt = Date.now();
  const root = getDataRoot(options.dataRoot);
  const projRoot = projectsDir(options.dataRoot);
  const summary: RescanSummary = {
    projects: 0,
    tasks: 0,
    changed: 0,
    unchanged: 0,
    removed: 0,
    errors: 0,
    durationMs: 0,
  };

  const seenProjects = new Set<string>();
  const seenTasks = new Set<string>();
  const seenGoals = new Set<string>();

  const slugs = existsSync(projRoot)
    ? readdirSync(projRoot, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() && !e.name.startsWith(".") ? [e.name] : [],
      )
    : [];

  const track = (result: RebuildFileResult) => {
    if (result.action === "projected") summary.changed += 1;
    else if (result.action === "unchanged") summary.unchanged += 1;
    else if (result.action === "removed") summary.removed += 1;
    else if (result.action === "error") summary.errors += 1;
  };

  for (const slug of slugs) {
    // When a field tasks derive from changed, its tasks must be re-projected
    // too — stage-reference diagnostics, effective repo and guest flags are
    // baked into task rows, so the task-side content-hash short-circuit
    // would otherwise keep them stale forever. The cascade inside
    // rebuildProjectFile is suppressed here (skipTaskCascade) because this
    // walk visits every task file itself — with force when needed.
    let projectChanged = false;
    if (existsSync(projectFilePath(slug, options.dataRoot))) {
      summary.projects += 1;
      seenProjects.add(slug);
      const result = rebuildPath(db, projectFilePath(slug, options.dataRoot), {
        ...options,
        skipTaskCascade: true,
      });
      track(result);
      // SRV-3: only a change tasks derive from forces them (see rebuildProjectFile).
      projectChanged = result.action === "projected" && result.taskFacingChanged === true;
    }
    const taskOptions = projectChanged ? { ...options, force: true } : options;
    for (const key of listTaskDirs(slug, options.dataRoot)) {
      if (!existsSync(taskFilePath(slug, key, options.dataRoot))) continue;
      summary.tasks += 1;
      seenTasks.add(`${slug}\u0000${key}`);
      track(
        rebuildPath(db, taskFilePath(slug, key, options.dataRoot), taskOptions),
      );
    }
    // Ruling 99: goals, after this project's tasks (link reconciliation reads
    // the fresh task rows).
    for (const goalId of listGoalIds(slug, options.dataRoot)) {
      seenGoals.add(`${slug}\u0000${goalId}`);
      track(rebuildGoalFile(db, slug, goalId, taskOptions));
    }
  }

  // Prune rows whose backing files are gone.
  // SAFETY: `slug` is the `projects` primary key — a single NOT NULL column.
  const projectRows = db.prepare(`SELECT slug FROM projects`).all() as {
    slug: string;
  }[];
  for (const row of projectRows) {
    if (!seenProjects.has(row.slug)) {
      track(rebuildProjectFile(db, row.slug, options));
    }
  }
  // SAFETY: the two selected columns are the `task_projections` primary key,
  // both NOT NULL.
  const taskRows = db
    .prepare(`SELECT project_slug, task_key FROM task_projections`)
    .all() as { project_slug: string; task_key: string }[];
  for (const row of taskRows) {
    if (!seenTasks.has(`${row.project_slug}\u0000${row.task_key}`)) {
      track(rebuildTaskFile(db, row.project_slug, row.task_key, options));
    }
  }
  // SAFETY: the two selected columns are the `goal_projections` primary key.
  const goalRows = db
    .prepare(`SELECT project_slug, goal_id FROM goal_projections`)
    .all() as { project_slug: string; goal_id: string }[];
  for (const row of goalRows) {
    if (!seenGoals.has(`${row.project_slug}\u0000${row.goal_id}`)) {
      track(rebuildGoalFile(db, row.project_slug, row.goal_id, options));
    }
  }

  summary.durationMs = Date.now() - startedAt;
  recordProvenance(db, {
    sourcePath: storeRelativePath(projRoot, options.dataRoot),
    contentHash: null,
    action: "rescan",
    details: { ...summary, dataRoot: root },
  });
  emitProjectionEvent({
    type: "projection.rebuilt",
    scope: "full",
    occurredAt: nowIso(),
    changed: summary.changed,
  });
  logger.info("projection rescan complete", { ...summary });
  return summary;
}
