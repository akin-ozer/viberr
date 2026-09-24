import type { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import { projectFilePath } from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { serializeProjectFile } from "~/server/files/project-file.server";
import { listProjects } from "~/server/projections/board-query.server";
import { reprojectProject } from "~/server/projections/rebuilder.server";
import { logger } from "~/server/logging/logger.server";
import { baseAgentDeployments } from "./agent-catalog.server";

/** The system operator's profile id (never removable, always ensured). */
const OPERATOR_PROFILE_ID = "operator";

/**
 * Ensure each project's built-in agent roster at boot — WITHOUT undoing
 * deliberate roster edits (E10: the old version re-injected Developer/
 * Reviewer into every project on every boot, so removing one never stuck).
 *
 * Rules:
 * - The OPERATOR is unconditionally ensured on every project (it is the
 *   system profile — its create-time auto-invoke and packet loop depend
 *   on it being deployed).
 * - The base specialists (Developer, Reviewer) are backfilled ONLY into a
 *   project that has NO specialist deployments at all (first boot / a board
 *   that predates them). A project with ≥1 specialist — even a custom one,
 *   even after removing a built-in — keeps its roster exactly as-is.
 *
 * Idempotent and best-effort (a per-project failure is logged, never blocks
 * boot). Runs at boot after the projection rescan, before the file watcher
 * starts, so there is no concurrent writer.
 */
export function ensureBaseAgentsDeployed(
  db: DatabaseSync,
  dataRoot?: string,
): void {
  const base = baseAgentDeployments();
  const operator = base.find((d) => d.profileId === OPERATOR_PROFILE_ID);
  const baseSpecialists = base.filter(
    (d) => d.profileId !== OPERATOR_PROFILE_ID,
  );
  for (const project of listProjects(db)) {
    try {
      const file = readProjectFile({
        projectSlug: project.slug,
        dataRoot,
      });
      if (!file) continue;

      const agents = file.parsed.frontmatter.agents;
      const present = new Set(agents.map((a) => a.profileId));
      const hasAnySpecialist = agents.some(
        (a) => a.profileId !== OPERATOR_PROFILE_ID,
      );

      // Operator: always ensured. Base specialists: first boot only — a
      // project that already deploys ANY specialist keeps its roster.
      const missing = [
        ...(operator && !present.has(OPERATOR_PROFILE_ID) ? [operator] : []),
        ...(!hasAnySpecialist
          ? baseSpecialists.filter((d) => !present.has(d.profileId))
          : []),
      ];
      if (missing.length === 0) continue;

      const next = {
        ...file.parsed,
        frontmatter: {
          ...file.parsed.frontmatter,
          agents: [...missing, ...agents],
        },
      };
      writeFileAtomic(
        projectFilePath(project.slug, dataRoot),
        serializeProjectFile(next),
      );
      reprojectProject(db, { dataRoot }, project.slug);
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
