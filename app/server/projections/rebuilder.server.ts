import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { FileDiagnostic } from "~/schemas/file-diagnostics";
import { emitProjectionEvent } from "~/server/events/projection-events.server";
import {
  getDataRoot,
  projectFilePath,
  projectsDir,
  storeRelativePath,
  taskFilePath,
} from "~/server/files/file-store-root.server";
import { parseProjectFileContent } from "~/server/files/project-file.server";
import { parseTaskFileContent } from "~/server/files/task-file.server";
import { readCoherentTaskContent } from "~/server/files/task-writer.server";
import {
  referenceDiagnostics,
} from "~/server/interpretation/diagnostics-policy.server";
import { deriveReadiness } from "~/server/interpretation/readiness-policy.server";
import { logger } from "~/server/logging/logger.server";
import { createActorResolver } from "~/shared/mapping/actor.server";

/**
 * Projection rebuilder: files → SQLite.
 *
 * - Full rescan (`rebuildAll`) walks ${dataRoot}/projects, projects every
 *   project.md / tasks/<KEY>/task.md, and prunes rows whose files vanished.
 * - Single-file incremental (`rebuildPath`) — driven by the chokidar
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
  kind: "project" | "task" | "other";
  projectSlug?: string;
  taskKey?: string;
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

// ------------------------------------------------------------ provenance

function recordProvenance(
  db: Database.Database,
  input: {
    sourcePath: string;
    contentHash: string | null;
    action: string;
    details?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO provenance (source_path, content_hash, observed_at, action, details_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.sourcePath,
    input.contentHash,
    nowIso(),
    input.action,
    input.details ? JSON.stringify(input.details) : null,
  );
}

function replaceDiagnostics(
  db: Database.Database,
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

function getMemberIds(db: Database.Database, slug: string): Set<string> {
  const rows = db
    .prepare(`SELECT user_id FROM project_members WHERE project_slug = ?`)
    .all(slug) as { user_id: string }[];
  return new Set(rows.map((r) => r.user_id));
}

export function rebuildProjectFile(
  db: Database.Database,
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
      db.prepare(`DELETE FROM projects WHERE slug = ?`).run(slug);
      db.prepare(`DELETE FROM diagnostics WHERE source_path = ?`).run(sourcePath);
      recordProvenance(db, { sourcePath, contentHash: null, action: "removed" });
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
    contentHash,
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

export function rebuildTaskFile(
  db: Database.Database,
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
      db.prepare(
        `DELETE FROM task_projections WHERE project_slug = ? AND task_key = ?`,
      ).run(slug, key);
      db.prepare(
        `DELETE FROM task_events WHERE project_slug = ? AND task_key = ?`,
      ).run(slug, key);
      db.prepare(`DELETE FROM diagnostics WHERE source_path = ?`).run(sourcePath);
      recordProvenance(db, { sourcePath, contentHash: null, action: "removed" });
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

  // Coherent read (read-your-own-writes): on the docker VirtioFS mount a raw
  // read right after a write can be stale, so a reproject fired by the write
  // could publish a task_events timeline MISSING the just-written comment (the
  // reviewer-comment loss). This trusts our own recent write when disk lags.
  const content = readCoherentTaskContent(absPath) ?? readFileSync(absPath, "utf8");
  const contentHash = sha256(content);
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

  // Project context (already-projected row): stages for reference checks,
  // default repo, member ids for guest flags.
  const project = db
    .prepare(`SELECT slug, repo, stages_json FROM projects WHERE slug = ?`)
    .get(slug) as ProjectContextRow | undefined;
  const stageIds: string[] = project
    ? (JSON.parse(project.stages_json) as { id: string }[]).map((s) => s.id)
    : [];
  const allDiagnostics = [
    ...diagnostics,
    ...referenceDiagnostics({ stage: fm.stage, knownStageIds: stageIds }),
  ];

  // Stored readiness is NULL when the field was missing/invalid in the file
  // (a readiness-path diagnostic exists in that case).
  const readinessWasInvalid = allDiagnostics.some((d) => d.path === "readiness");
  const storedReadiness = readinessWasInvalid ? null : fm.readiness;
  const derivation = deriveReadiness({
    storedReadiness,
    diagnostics: allDiagnostics,
  });

  const memberIds = project ? getMemberIds(db, slug) : undefined;
  const resolveActor = createActorResolver(db, {
    ...(memberIds ? { projectMemberIds: memberIds } : {}),
  });

  const commentCount = parsed.timeline.filter((e) => e.type === "comment").length;

  db.prepare(
    `INSERT INTO task_projections
       (project_slug, task_key, title, stage, readiness, stored_readiness,
        waiting, urgent, validation, owner_user_id, specialist_json,
        reviewers_json, operator_json, branch, repo, pr_json, github_json,
        goal, packet_json, recommendation_count, recommendation_kinds,
        schedules_json, event_count, comment_count,
        diagnostic_count, created_at, updated_at, board_rank, source_path,
        content_hash, parsed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_slug, task_key) DO UPDATE SET
       title = excluded.title, stage = excluded.stage,
       readiness = excluded.readiness, stored_readiness = excluded.stored_readiness,
       waiting = excluded.waiting, urgent = excluded.urgent,
       validation = excluded.validation, owner_user_id = excluded.owner_user_id,
       specialist_json = excluded.specialist_json,
       reviewers_json = excluded.reviewers_json,
       operator_json = excluded.operator_json, branch = excluded.branch,
       repo = excluded.repo, pr_json = excluded.pr_json,
       github_json = excluded.github_json, goal = excluded.goal,
       packet_json = excluded.packet_json,
       recommendation_count = excluded.recommendation_count,
       recommendation_kinds = excluded.recommendation_kinds,
       schedules_json = excluded.schedules_json,
       event_count = excluded.event_count,
       comment_count = excluded.comment_count,
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
    fm.waiting,
    fm.urgent ? 1 : 0,
    fm.validation,
    fm.ownerUserId,
    fm.specialist ? JSON.stringify(fm.specialist) : null,
    JSON.stringify(fm.reviewers),
    fm.operator ? JSON.stringify(fm.operator) : null,
    fm.branch,
    fm.repo ?? project?.repo ?? null,
    fm.pr ? JSON.stringify(fm.pr) : null,
    fm.github ? JSON.stringify(fm.github) : null,
    parsed.goal,
    parsed.packet ? JSON.stringify(parsed.packet) : null,
    fm.recommendations.length,
    JSON.stringify(fm.recommendations.map((r) => r.kind)),
    JSON.stringify(fm.schedules),
    parsed.timeline.length,
    commentCount,
    allDiagnostics.length,
    fm.createdAt,
    fm.updatedAt,
    fm.boardRank,
    sourcePath,
    contentHash,
    nowIso(),
  );

  db.prepare(
    `DELETE FROM task_events WHERE project_slug = ? AND task_key = ?`,
  ).run(slug, fm.key);
  const insertEvent = db.prepare(
    `INSERT INTO task_events
       (project_slug, task_key, position, occurred_at, type, actor_kind,
        actor_ref, actor_json, title, text, to_agent, evidence_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  parsed.timeline.forEach((event, position) => {
    const actorKind =
      event.actor.kind === "human"
        ? "human"
        : event.actor.kind === "system"
          ? "system"
          : event.actor.kind === "operator"
            ? "operator"
            : "agent";
    const actorRef =
      event.actor.kind === "human"
        ? event.actor.userId
        : event.actor.kind === "agent"
          ? `${event.actor.backend}/${event.actor.role.toLowerCase().replace(/\s+/g, "-")}`
          : event.actor.kind === "system"
            ? event.actor.systemId
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
  emitProjectionEvent({
    type: "task.updated",
    projectSlug: slug,
    taskKey: fm.key,
    occurredAt: nowIso(),
  });

  return { action: "projected", kind: "task", projectSlug: slug, taskKey: fm.key };
}

// ------------------------------------------------------------ path router

const TASK_PATH_RE = /^projects\/([^/]+)\/tasks\/([^/]+)\/task\.md$/;
const PROJECT_PATH_RE = /^projects\/([^/]+)\/project\.md$/;

/**
 * Single-file incremental rebuild for any absolute path under the data
 * root. Non-store paths are ignored. Used by the watcher and mutations.
 */
export function rebuildPath(
  db: Database.Database,
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

// ------------------------------------------------------------ full rescan

/** Full rescan: project every store file, prune vanished rows. */
export function rebuildAll(
  db: Database.Database,
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
  }

  // Prune rows whose backing files are gone.
  const projectRows = db.prepare(`SELECT slug FROM projects`).all() as {
    slug: string;
  }[];
  for (const row of projectRows) {
    if (!seenProjects.has(row.slug)) {
      track(rebuildProjectFile(db, row.slug, options));
    }
  }
  const taskRows = db
    .prepare(`SELECT project_slug, task_key FROM task_projections`)
    .all() as { project_slug: string; task_key: string }[];
  for (const row of taskRows) {
    if (!seenTasks.has(`${row.project_slug}\u0000${row.task_key}`)) {
      track(rebuildTaskFile(db, row.project_slug, row.task_key, options));
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
