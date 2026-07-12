import { existsSync, rmSync } from "node:fs";
import type Database from "better-sqlite3";
import { projectDir } from "~/server/files/file-store-root.server";
import { disposeRunsForProject } from "~/server/runtimes/run-service.server";
import { rawLogPath } from "~/server/runtimes/run-store.server";

/**
 * Permanently remove every operational row/file keyed by a project slug.
 * Project deletion deliberately chooses purge semantics: recreating the same
 * slug starts clean and cannot inherit credentials, runs, policy violations,
 * notifications, provenance, or an earlier project's audit stream.
 */
export function purgeProjectOperationalState(
  db: Database.Database,
  projectSlug: string,
  dataRoot?: string,
): void {
  const runs = db
    .prepare(`SELECT id FROM agent_runs WHERE project_slug = ?`)
    .all(projectSlug) as { id: string }[];

  disposeRunsForProject(db, projectSlug);

  db.transaction(() => {
    db.prepare(
      `DELETE FROM run_log_lines
       WHERE run_id IN (SELECT id FROM agent_runs WHERE project_slug = ?)`,
    ).run(projectSlug);
    db.prepare(`DELETE FROM agent_runs WHERE project_slug = ?`).run(projectSlug);
    db.prepare(`DELETE FROM project_github_credentials WHERE project_slug = ?`).run(
      projectSlug,
    );
    db.prepare(`DELETE FROM scope_violations WHERE project_slug = ?`).run(
      projectSlug,
    );
    db.prepare(`DELETE FROM notifications WHERE project_slug = ?`).run(
      projectSlug,
    );
    db.prepare(`DELETE FROM diagnostics WHERE project_slug = ?`).run(projectSlug);
    db.prepare(`DELETE FROM task_events WHERE project_slug = ?`).run(projectSlug);
    db.prepare(`DELETE FROM task_projections WHERE project_slug = ?`).run(
      projectSlug,
    );
    db.prepare(`DELETE FROM project_members WHERE project_slug = ?`).run(
      projectSlug,
    );
    db.prepare(`DELETE FROM projects WHERE slug = ?`).run(projectSlug);
    db.prepare(`DELETE FROM audit_events WHERE project_slug = ?`).run(projectSlug);

    const sourceRoot = projectDir(projectSlug, dataRoot);
    db.prepare(
      `DELETE FROM provenance
       WHERE source_path = ? OR source_path LIKE ?`,
    ).run(sourceRoot, `${sourceRoot}/%`);
  })();

  // Run JSONL is named by run id, so remove every possible backend copy. A
  // fallback adapter may have written under the requested or effective
  // backend depending on when it exited.
  for (const { id } of runs) {
    for (const backend of ["claude", "codex", "simulated"] as const) {
      const file = rawLogPath(backend, id, dataRoot);
      if (existsSync(file)) rmSync(file, { force: true });
    }
  }
}
