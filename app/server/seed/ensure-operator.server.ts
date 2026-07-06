import type Database from "better-sqlite3";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import { projectFilePath } from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { serializeProjectFile } from "~/server/files/project-file.server";
import { listProjects } from "~/server/projections/board-query.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { logger } from "~/server/logging/logger.server";
import { operatorDeployment } from "./demo-data.server";

/**
 * Backfill the operator deployment into every project that lacks one, so the
 * operator is preinstalled and the create-time auto-invoke actually fires —
 * including projects that predate the operator (e.g. app-created before it
 * shipped). Idempotent (skips projects that already deploy an operator) and
 * best-effort (a per-project failure is logged, never blocks boot). Runs at
 * boot after the projection rescan, before the file watcher starts, so there
 * is no concurrent writer.
 */
export function ensureOperatorDeployed(
  db: Database.Database,
  dataRoot?: string,
): void {
  for (const project of listProjects(db)) {
    try {
      const file = readProjectFile({
        projectSlug: project.slug,
        ...(dataRoot !== undefined ? { dataRoot } : {}),
      });
      if (!file) continue;
      const already = file.parsed.frontmatter.agents.some(
        (a) => a.profileId === "operator",
      );
      if (already) continue;

      const next = {
        ...file.parsed,
        frontmatter: {
          ...file.parsed.frontmatter,
          agents: [operatorDeployment(), ...file.parsed.frontmatter.agents],
        },
      };
      writeFileAtomic(
        projectFilePath(project.slug, dataRoot),
        serializeProjectFile(next),
      );
      rebuildPath(db, projectFilePath(project.slug, dataRoot), {
        ...(dataRoot !== undefined ? { dataRoot } : {}),
      });
      logger.info("backfilled operator deployment into project", {
        project: project.slug,
      });
    } catch (error) {
      logger.error("failed backfilling operator deployment", {
        project: project.slug,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}
