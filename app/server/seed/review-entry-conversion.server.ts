import type { DatabaseSync } from "node:sqlite";
import type { ProjectFrontmatter, WorkflowBoundary } from "~/schemas/project-file.schema";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { readProjectFile, updateProjectFile } from "~/server/files/project-writer.server";
import { logger } from "~/server/logging/logger.server";
import { listProjects } from "~/server/projections/board-query.server";
import { reprojectProject } from "~/server/projections/rebuilder.server";
import { toError } from "~/shared/errors";
import { humanGatesPreWorkAdvance, stageName } from "~/shared/workflow/stage-roles";
import { TEMPLATE_REVIEW_ENTRY_BY } from "~/shared/workflow/templates";

/**
 * The words the Standard template gave its In Progress → Review edge while
 * that edge was an `approval`. Only project creation ever wrote them: a
 * boundary a person sets on the Policy page is rewritten with
 * `defaultTransitionBy`'s words, so an edge carrying these is one nobody chose.
 */
const APPROVAL_REVIEW_ENTRY_BY = "Operator transition request, with evidence attached";

/**
 * The edge to convert: the template's approval into Review, untouched since
 * the project was created, on a board where a person does not gate every
 * advance. A strict board (every boundary short of the last stage is a
 * person's, `humanGatesPreWorkAdvance`) keeps it, as a strict board created
 * now gets it.
 */
function templateReviewEntry(
  frontmatter: Pick<ProjectFrontmatter, "stages" | "workflow">,
): WorkflowBoundary | undefined {
  const { stages, workflow } = frontmatter;
  if (humanGatesPreWorkAdvance(stages, workflow)) return undefined;
  const terminalId = stages.at(-1)?.id;
  return workflow.find(
    (w) => w.boundary === "approval" && w.by === APPROVAL_REVIEW_ENTRY_BY && w.to !== terminalId,
  );
}

/** The edge one conversion wrote, by stage id and name, for its audit row. */
interface ConvertedEdge {
  from: string;
  to: string;
  fromName: string;
  toName: string;
}

/** The locked mutator's result, carried out of the closure — a plain `let` is
 *  narrowed to `null` past the callback that assigns it. */
interface ConvertedEdgeSlot {
  edge: ConvertedEdge | null;
}

/**
 * Ruling 519, once at boot: a board created from the Standard template before
 * the ruling still asks a person to confirm the move into Review. Its edge
 * becomes the template's edge now, `auto` with the template's words, so the
 * operator moves the task there itself. Each change is a
 * `project.policy.boundary_changed` audit row by the system, which the
 * project's activity and the Policy page's last-change line show.
 *
 * After the rescan (the project rows exist) and before the watcher (no
 * concurrent writer). A converted edge no longer carries the old words, so a
 * second boot changes nothing. A project that fails is logged and retried on
 * the next boot. Returns the slugs it converted.
 */
export async function convertTemplateReviewEntry(
  db: DatabaseSync,
  options: { dataRoot?: string } = {},
): Promise<string[]> {
  const converted: string[] = [];
  for (const project of listProjects(db)) {
    const ref = { projectSlug: project.slug, dataRoot: options.dataRoot };
    try {
      const file = readProjectFile(ref);
      if (!file || !templateReviewEntry(file.parsed.frontmatter)) continue;
      const written: ConvertedEdgeSlot = { edge: null };
      await updateProjectFile(ref, (parsed) => {
        // Re-read under the lock: the read above is not the decision.
        const rule = templateReviewEntry(parsed.frontmatter);
        if (!rule) return;
        rule.boundary = "auto";
        rule.by = TEMPLATE_REVIEW_ENTRY_BY;
        const stages = parsed.frontmatter.stages;
        written.edge = {
          from: rule.from,
          to: rule.to,
          fromName: stageName(stages, rule.from),
          toName: stageName(stages, rule.to),
        };
      });
      const edge = written.edge;
      if (!edge) continue;
      reprojectProject(db, { dataRoot: options.dataRoot }, project.slug);
      recordAudit(db, {
        action: "project.policy.boundary_changed",
        actor: SYSTEM_ACTOR,
        subjectKind: "workflow_boundary",
        subjectId: `${edge.from}>${edge.to}`,
        projectSlug: project.slug,
        details: { from: edge.fromName, to: edge.toName, boundary: "auto", ruling: 519 },
      });
      converted.push(project.slug);
    } catch (error) {
      logger.error("making the move into Review automatic failed for a project; it is retried on the next boot", {
        project: project.slug,
        err: toError(error),
      });
    }
  }
  if (converted.length > 0) {
    logger.info("made the move into Review automatic (ruling 519)", { projects: converted });
  }
  return converted;
}
