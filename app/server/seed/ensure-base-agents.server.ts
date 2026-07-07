import type Database from "better-sqlite3";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import { projectFilePath } from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { serializeProjectFile } from "~/server/files/project-file.server";
import { listProjects } from "~/server/projections/board-query.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { logger } from "~/server/logging/logger.server";
import { baseAgentDeployments } from "./demo-data.server";

/**
 * Backfill the built-in agent roster — the operator plus the base specialists
 * (Developer, Reviewer, Tester) — into every project that is missing any of
 * them, so the operator is preinstalled (its create-time auto-invoke fires) and
 * the core specialists are usable across all boards, including projects that
 * predate them (e.g. app-created before these shipped, or seeded with a trimmed
 * roster). Idempotent (each agent is only added when its profileId is absent)
 * and best-effort (a per-project failure is logged, never blocks boot). Runs at
 * boot after the projection rescan, before the file watcher starts, so there is
 * no concurrent writer.
 */
export function ensureBaseAgentsDeployed(
  db: Database.Database,
  dataRoot?: string,
): void {
  const base = baseAgentDeployments();
  for (const project of listProjects(db)) {
    try {
      const file = readProjectFile({
        projectSlug: project.slug,
        ...(dataRoot !== undefined ? { dataRoot } : {}),
      });
      if (!file) continue;

      const present = new Set(
        file.parsed.frontmatter.agents.map((a) => a.profileId),
      );
      // Preserve roster order intent: operator first, then the specialists that
      // are missing, then whatever the project already deployed.
      const missing = base.filter((d) => !present.has(d.profileId));
      if (missing.length === 0) continue;

      const next = {
        ...file.parsed,
        frontmatter: {
          ...file.parsed.frontmatter,
          agents: [...missing, ...file.parsed.frontmatter.agents],
        },
      };
      writeFileAtomic(
        projectFilePath(project.slug, dataRoot),
        serializeProjectFile(next),
      );
      rebuildPath(db, projectFilePath(project.slug, dataRoot), {
        ...(dataRoot !== undefined ? { dataRoot } : {}),
      });
      logger.info("backfilled built-in agents into project", {
        project: project.slug,
        added: missing.map((d) => d.profileId),
      });
    } catch (error) {
      logger.error("failed backfilling built-in agents", {
        project: project.slug,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}
