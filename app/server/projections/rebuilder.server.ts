import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { FileDiagnostic } from "~/schemas/file-diagnostics";
import {
  acceptanceBlockedReason,
  closedPrBlockedReason,
  conflictingPrBlockedReason,
  deliveringEngagement,
  deriveValidation,
  supportingEngagements,
  type TaskFrontmatter,
  type Validation,
} from "~/schemas/task-file.schema";
import { verdictGateReason } from "~/server/github/pr-human-approval.server";
import { emitProjectionEvent } from "~/server/events/projection-events.server";
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
  listGoalIds,
  parseGoalFileContent,
} from "~/server/files/goal-writer.server";
import { recordProvenance } from "~/server/provenance/provenance-recorder.server";
import { parseProjectFileContent } from "~/server/files/project-file.server";
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

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
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
}

function getMemberIds(db: DatabaseSync, slug: string): Set<string> {
  // SAFETY: the statement selects the single `user_id` column, which
  // 0001_baseline declares NOT NULL on `project_members`.
  const rows = db
    .prepare(`SELECT user_id FROM project_members WHERE project_slug = ?`)
    .all(slug) as { user_id: string }[];
  return new Set(rows.map((r) => r.user_id));
}

export function rebuildProjectFile(
  db: DatabaseSync,
  slug: string,
  options: RebuildOptions = {},
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
  const contentHash = sha256(content);
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

  db.prepare(
    `INSERT INTO projects
       (slug, name, archived, repo, default_branch, task_prefix, description,
        stages_json, workflow_json, agent_policy_json, credential_policy_json,
        guardrails_json, source_path, content_hash, parsed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       name = excluded.name, archived = excluded.archived, repo = excluded.repo,
       default_branch = excluded.default_branch,
       task_prefix = excluded.task_prefix, description = excluded.description,
       stages_json = excluded.stages_json, workflow_json = excluded.workflow_json,
       agent_policy_json = excluded.agent_policy_json,
       credential_policy_json = excluded.credential_policy_json,
       guardrails_json = excluded.guardrails_json,
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
  // F28-D3: commit marker — the true content_hash lands only after the projects
  // row, project_members and diagnostics have all been written.
  db.prepare(`UPDATE projects SET content_hash = ? WHERE slug = ?`).run(
    contentHash,
    fm.slug,
  );
  emitProjectionEvent({
    type: "project.updated",
    projectSlug: fm.slug,
    occurredAt: nowIso(),
  });

  // Project-derived data is baked into task projections (stage-reference
  // diagnostics + readiness floors, effective repo, guest flags) — cascade a
  // forced re-projection of this project's tasks whenever the project row is
  // newly created OR its content actually changed (stages, members, repo,
  // anything). Unchanged project files short-circuit above, so the common
  // no-change rescan stays cheap. rebuildAll suppresses the cascade and
  // forces its own task walk instead (see skipTaskCascade).
  const cascade =
    !options.skipTaskCascade &&
    (existing === undefined || existing.content_hash !== contentHash);
  if (cascade) {
    for (const key of listTaskDirs(slug, options.dataRoot)) {
      rebuildTaskFile(db, slug, key, { ...options, force: true });
    }
  }

  return { action: "projected", kind: "project", projectSlug: slug };
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
    verdictGateReason(fm, ctx.validation, fm.key) ??
    // F7-VAL1/F7-PKT1: an operator-raised blocked decision is still open —
    // accepting would bury it. Same sentence the writers refuse with.
    (ctx.blockedPacket
      ? "This task has an open blocked decision. Resolve the operator's packet before accepting it."
      : null) ??
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
  const contentHash = sha256(content);
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
  // SAFETY: the SELECT names exactly ProjectContextRow's three members;
  // 0001_baseline declares `slug` and `stages_json` NOT NULL and `repo`
  // nullable, which is how the row types them.
  const project = db
    .prepare(`SELECT slug, repo, stages_json FROM projects WHERE slug = ?`)
    .get(slug) as ProjectContextRow | undefined;
  // SAFETY: `stages_json` has ONE writer — rebuildProjectFile above stores
  // `JSON.stringify(fm.stages)`, and every stage the project-file schema parses
  // carries an `id`. Only the ids are read here.
  const stageIds: string[] = project
    ? (JSON.parse(project.stages_json) as { id: string }[]).map((s) => s.id)
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
  const projectedWaiting = isTerminalStage(
    fm.stage,
    stageIds.map((id) => ({ id })),
  )
    ? "none"
    : fm.waiting;

  // Stored readiness is NULL when the field was missing/invalid in the file
  // (a readiness-path diagnostic exists in that case).
  const readinessWasInvalid = allDiagnostics.some((d) => d.path === "readiness");
  const storedReadiness = readinessWasInvalid ? null : fm.readiness;
  const derivation = deriveReadiness({
    storedReadiness,
    diagnostics: allDiagnostics,
  });

  const memberIds = project ? getMemberIds(db, slug) : undefined;
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
        waiting, urgent, priority, labels_json, due_date, archived, validation, validation_block_reason, acceptance, continuity, owner_user_id, specialist_json,
        reviewers_json, operator_json, branch, repo, pr_json, github_json,
        work_revision_sha, goal, packet_json, recommendation_count,
        schedules_json, event_count, comment_count,
        goal_id, goal_link_index,
        diagnostic_count, created_at, updated_at, board_rank, source_path,
        content_hash, parsed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_slug, task_key) DO UPDATE SET
       title = excluded.title, stage = excluded.stage,
       readiness = excluded.readiness, stored_readiness = excluded.stored_readiness,
       waiting = excluded.waiting, urgent = excluded.urgent,
       priority = excluded.priority, labels_json = excluded.labels_json,
       due_date = excluded.due_date,
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
    fm.archived ? 1 : 0,
    derivedValidation,
    acceptanceBlockReason(fm, {
      validation: derivedValidation,
      blockedPacket,
    }),
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
    // to produce.
    fm.workRevision?.headSha ?? null,
    parsed.goal,
    parsed.packet ? JSON.stringify(parsed.packet) : null,
    fm.recommendations.length,
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

  db.prepare(
    `DELETE FROM task_events WHERE project_slug = ? AND task_key = ?`,
  ).run(slug, fm.key);
  const insertEvent = db.prepare(
    `INSERT INTO task_events
       (project_slug, task_key, position, occurred_at, type, actor_kind,
        actor_ref, actor_json, title, text, to_agent, evidence_json,
        attachments_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  parsed.timeline.forEach((event, position) => {
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
          ? `${event.actor.backend}/${event.actor.profileId}`
          : event.actor.kind === "system"
            ? event.actor.systemId
            : event.actor.kind === "unknown"
              ? event.actor.raw
              : event.actor.kind === "controller"
                ? "controller"
                : "operator";
    insertEvent.run(
      slug,
      fm.key,
      position,
      event.occurredAt,
      event.type,
      actorKind,
      actorRef,
      JSON.stringify(resolveActor(event.actor)),
      event.title,
      event.text,
      event.toAgent ? 1 : 0,
      event.evidence ? JSON.stringify(event.evidence) : null,
      event.attachments && event.attachments.length > 0
        ? JSON.stringify(event.attachments)
        : null,
    );
  });

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
  // that the projection row, the task_events rewrite and the diagnostics have
  // all landed. Everything above is a single synchronous statement sequence, so
  // this row is consistent by the time the hash lets a later rebuild skip it.
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
  const absPath = goalFilePath(slug, goalId, options.dataRoot);
  const sourcePath = storeRelativePath(absPath, options.dataRoot);

  if (!existsSync(absPath)) {
    const existed = db
      .prepare(
        `SELECT goal_id FROM goal_projections WHERE project_slug = ? AND goal_id = ?`,
      )
      .get(slug, goalId);
    if (!existed) return { action: "ignored", kind: "goal" };
    db.prepare(
      `DELETE FROM goal_projections WHERE project_slug = ? AND goal_id = ?`,
    ).run(slug, goalId);
    recordProvenance(db, {
      sourcePath,
      contentHash: null,
      action: "removed",
      details: { kind: "goal", projectSlug: slug, goalId },
    });
    emitProjectionEvent({
      type: "goal.updated",
      projectSlug: slug,
      goalId,
      occurredAt: nowIso(),
    });
    return { action: "removed", kind: "goal", projectSlug: slug, goalId };
  }

  const content = readFileSync(absPath, "utf8");
  const contentHash = sha256(content);
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
    // existing row is left standing (visible-but-stale beats vanished).
    recordProvenance(db, {
      sourcePath,
      contentHash,
      action: "error",
      details: { kind: "goal", message: "goal file could not be parsed" },
    });
    return { action: "error", kind: "goal", projectSlug: slug, goalId };
  }
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
    if (task.archived) return { ...link, status: "failed" as const };
    if (stages && isTerminalStage(task.stage, stages)) {
      return { ...link, status: "done" as const };
    }
    if (link.status === "done") {
      // The task LEFT the terminal stage since the advance recorded done —
      // surface the truth; the reconciler run will requeue it.
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
      return rebuildTaskFile(db, taskMatch[1]!, taskMatch[2]!, options);
    }
    const projectMatch = PROJECT_PATH_RE.exec(rel);
    if (projectMatch) {
      return rebuildProjectFile(db, projectMatch[1]!, options);
    }
    const goalMatch = GOAL_PATH_RE.exec(rel);
    if (goalMatch) {
      return rebuildGoalFile(db, goalMatch[1]!, goalMatch[2]!, options);
    }
    return { action: "ignored", kind: "other" };
  } catch (error) {
    logger.error("projection rebuild failed", {
      sourcePath: rel,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    recordProvenance(db, {
      sourcePath: rel,
      contentHash: null,
      action: "error",
      details: { message: error instanceof Error ? error.message : String(error) },
    });
    return { action: "error", kind: "other" };
  }
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
    // (with force when the project row changed), matching rebuildAll's pattern.
    const result = rebuildPath(db, projectFilePath(slug, options.dataRoot), {
      ...options,
      skipTaskCascade: true,
    });
    track(result);
    projectChanged = result.action === "projected";
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
    // When the project row is (re)projected, its tasks must be re-projected
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
      projectChanged = result.action === "projected";
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
