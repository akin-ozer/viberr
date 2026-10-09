import type { DatabaseSync } from "node:sqlite";
import { getProject, listProjectTasks } from "~/server/projections/board-query.server";
import {
  getProjectCredentialHealth,
  type ProjectCredentialHealth,
} from "~/server/secrets/pat-store.server";
import { branchCleanupOnMerge } from "~/server/github/branch-cleanup.server";
import { listDeployedSpecialists } from "~/server/tasks/specialist-roster.server";
import {
  readRequiredReviewers,
  type RequiredReviewerView,
} from "~/server/tasks/required-reviewers.server";
import { repoFootprintTasks } from "~/server/projections/repo-footprint.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { staleFileLeases } from "~/server/tasks/file-leases.server";
import type { ProjectGate } from "~/schemas/project-file.schema";
import { listMembershipViews, type MembershipView } from "./membership.server";

/**
 * Settings view read model (project-settings spec §3): project identity +
 * stages from the projection, per-stage task counts from task_projections
 * (never the whole task list — spec §3.2), membership with invite status
 * (canonical file), and credential health (the ruling-221 single fact, phase 7).
 *
 * P13-D-5: the task-level repo-override flag (`taskRepoOverride`) used to be
 * read here for a toggle that gated nothing. One project, one repository.
 */

export interface SettingsViewData {
  project: {
    slug: string;
    name: string;
    prefix: string;
    description: string;
    repo: string | null;
    archived: boolean;
    /** Real store-relative task-file pattern (ruling 15(a)). */
    taskFilePattern: string;
  };
  stages: { id: string; name: string; color: string }[];
  stageCounts: Record<string, number>;
  members: MembershipView[];
  /**
   * The ruling-221 single credential fact — assembled here for every member and
   * REDACTED per reader in the route loader (F21-5 / R19-11: the token's label,
   * masked tail and scope verdicts reach only `grant-github-scope` holders, via
   * `features/github/credential-visibility.server`, exactly as on /github).
   * The redaction lives with the reader identity, which this query has no access
   * to and deliberately does not take.
   */
  credential: ProjectCredentialHealth;
  /** Tasks whose GitHub records (linked PR / pushed commits) point at the
   * current repo — drives the Change repository dialog's footprint
   * acknowledgment. */
  repoFootprintTasks: number;
  /** R15-6: delete a task's branch on GitHub once its PR merges (default on). */
  branchCleanupOnMerge: boolean;
  /** Ruling 89: the required-reviewer rules as project.md holds them. */
  requiredReviewers: RequiredReviewerView[];
  /** Ruling 89: the deployed specialists a rule may name — those holding
   *  report-validation-verdict, the same predicate the writer refuses on. */
  reviewerCandidates: { id: string; name: string }[];
  /** Ruling 61: the project's file leases, as project.md holds them. */
  fileLeases: FileLeaseView[];
  /** The tasks a lease may name — every live task on the board. */
  leaseCandidates: { key: string; title: string }[];
  /** Ruling 104: the commands Viberr runs on every delivered revision.
   *  Absent when the project declares none (the settings payload is budgeted,
   *  ruling 11). */
  gates?: ProjectGate[];
}

/**
 * Ruling 61 (F39-23): one file lease, readable without a lookup.
 *
 * Ruling 60 said a lease "is read where a person or an agent asks 'may I touch
 * this'", and `staleFileLeases`' docstring says the spent ones are named "so a
 * surface can offer to tidy them". Neither surface existed: leases were written
 * by one controller tool, read by another, injected into every specialist's
 * prompt, and enforced at delivery by refusing a push in a named task's name —
 * with nothing anywhere in the app that a person could open to see one.
 */
export interface FileLeaseView {
  paths: string[];
  taskKey: string;
  /** The holder's title, so the row reads on its own. Null when the project has
   *  no such task, which the writer refuses but an edited file can still hold. */
  taskTitle: string | null;
  reason: string;
  /** Ruling 60: the holder has merged or been archived, so this lease binds
   *  nobody. The row stays because the declaration is still in project.md. */
  spent: boolean;
}

export function getSettingsViewData(
  db: DatabaseSync,
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): SettingsViewData | null {
  const project = getProject(db, projectSlug);
  if (!project) return null;

  // SAFETY: `task_projections.stage` is TEXT NOT NULL in 0001_baseline, and
  // `COUNT(*)` grouped by it always answers with an integer — so every row of
  // this projection carries exactly the two named columns.
  const counts = db
    .prepare(
      // R14-3: archived tasks are off the board, so the stage rows here must not
      // still count them — Settings said "Ready · 1 task" for a column the board
      // drew empty (P14-RV-03).
      `SELECT stage, COUNT(*) AS n FROM task_projections
        WHERE project_slug = ? AND archived = 0 GROUP BY stage`,
    )
    .all(projectSlug) as { stage: string; n: number }[];

  // Ruling 61: a lease names a task, so the panel needs the board's own task
  // list to title the holder and to offer the pickable ones. Archived tasks are
  // out: a lease they hold is spent by definition (ruling 60).
  const tasks = listProjectTasks(db, projectSlug, ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {})
    .map((t) => ({ key: t.key, title: t.title }));

  const view: SettingsViewData = {
    project: {
      slug: project.slug,
      name: project.name,
      prefix: project.taskPrefix,
      description: project.description,
      repo: project.repo,
      archived: project.archived,
      taskFilePattern: `projects/${project.slug}/tasks/<key>/task.md`,
    },
    stages: project.stages.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
    })),
    stageCounts: Object.fromEntries(counts.map((c) => [c.stage, c.n])),
    members: listMembershipViews(db, projectSlug, ctx),
    credential: getProjectCredentialHealth(db, projectSlug),
    repoFootprintTasks: repoFootprintTasks(db, projectSlug),
    branchCleanupOnMerge: branchCleanupOnMerge(db, projectSlug),
    requiredReviewers: readRequiredReviewers(projectSlug, ctx),
    reviewerCandidates: listDeployedSpecialists(projectSlug, ctx)
      .filter((s) => s.capabilities.verdict)
      .map((s) => ({ id: s.id, name: s.name })),
    fileLeases: fileLeaseViews(projectSlug, tasks, ctx),
    leaseCandidates: tasks.map((t) => ({ key: t.key, title: t.title })),
  };
  if (project.gates.length > 0) view.gates = project.gates;
  return view;
}

/**
 * Ruling 61: every declared lease, with its holder named and the spent ones
 * marked.
 *
 * Read from the project file rather than `activeFileLeases`, because the page
 * has to show what is DECLARED — a spent lease is still a row somebody wrote
 * and somebody has to be able to clear it. `staleFileLeases` decides which.
 */
function fileLeaseViews(
  projectSlug: string,
  tasks: { key: string; title: string }[],
  ctx: { dataRoot?: string },
): FileLeaseView[] {
  const project = readProjectFile(
    ctx.dataRoot ? { projectSlug, dataRoot: ctx.dataRoot } : { projectSlug },
  );
  const declared = project?.parsed.frontmatter.fileLeases ?? [];
  if (declared.length === 0) return [];
  const spent = new Set(
    staleFileLeases(projectSlug, ctx).map((l) => `${l.taskKey} ${l.paths.join(" ")}`),
  );
  const titles = new Map(tasks.map((t) => [t.key, t.title]));
  return declared.map((lease) => ({
    paths: lease.paths,
    taskKey: lease.taskKey,
    taskTitle: titles.get(lease.taskKey) ?? null,
    reason: lease.reason,
    spent: spent.has(`${lease.taskKey} ${lease.paths.join(" ")}`),
  }));
}
