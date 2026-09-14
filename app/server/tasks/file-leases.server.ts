/**
 * Ruling 245(b) (pass 37, F37-76): a lease whose HOLDER is finished holds
 * nothing.
 *
 * Ruling 245 shipped with `FileLease.taskKey` documented as "released when it
 * reaches a terminal stage" and nothing implementing it. The controller read
 * that contract, believed it, and wrote it into the first real lease's own
 * reason — "Lease releases when SHOP-11 merges". SHOP-11 then merged, and the
 * lease stood: `pnpm-lock.yaml` owned by a completed task, refusing SHOP-5's
 * delivery in the name of work that had already landed, with two records
 * promising the opposite. A comment claiming a mechanism nobody built is the
 * defect this pass has found more often than any other, and ruling 245's own
 * finding note called a stale lease "its own stale-record problem".
 *
 * Resolved at READ time rather than swept on completion, for ruling 131(e)'s
 * reason: a sweep is a hook that some path completing a task will eventually
 * miss, while a resolution converges no matter how the holder finished —
 * accepted, force-accepted, archived, or edited on disk. The row stays in
 * `project.md` until someone clears it, which is honest: the declaration was
 * made and is now spent, and `staleFileLeases` names exactly those so a surface
 * can offer to tidy them.
 */
import type { DatabaseSync } from "node:sqlite";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import type { FileLease } from "~/shared/file-leases";

/** Is this lease's holder finished, so the lease binds nobody? */
function holderIsSpent(
  projectSlug: string,
  taskKey: string,
  stages: readonly { id: string }[],
  dataRoot?: string,
): boolean {
  const file = readTaskFile(
    dataRoot ? { projectSlug, taskKey, dataRoot } : { projectSlug, taskKey },
  );
  // A holder that no longer exists is spent too: it can neither deliver the
  // file nor release the lease, so leaving it binding would fence the path off
  // forever in the name of a task nobody can open.
  if (!file) return true;
  const fm = file.parsed.frontmatter;
  return fm.archived === true || isTerminalStage(fm.stage, stages);
}

/**
 * The project's leases that still BIND, with spent ones dropped.
 *
 * Every gate reads through this rather than the raw frontmatter, so a lease
 * cannot outlive its holder at any of them.
 */
export function activeFileLeases(
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): FileLease[] {
  const project = readProjectFile(
    ctx.dataRoot ? { projectSlug, dataRoot: ctx.dataRoot } : { projectSlug },
  );
  if (!project) return [];
  const fm = project.parsed.frontmatter;
  const leases = fm.fileLeases ?? [];
  if (leases.length === 0) return [];
  return leases.filter(
    (lease) => !holderIsSpent(projectSlug, lease.taskKey, fm.stages, ctx.dataRoot),
  );
}

/**
 * The leases that are SPENT — declared, and no longer binding because their
 * holder finished. Named rather than silently dropped so a surface can say
 * "these three are done, clear them?" instead of leaving a person to notice.
 */
export function staleFileLeases(
  _db: DatabaseSync | null,
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): FileLease[] {
  const project = readProjectFile(
    ctx.dataRoot ? { projectSlug, dataRoot: ctx.dataRoot } : { projectSlug },
  );
  if (!project) return [];
  const fm = project.parsed.frontmatter;
  return (fm.fileLeases ?? []).filter((lease) =>
    holderIsSpent(projectSlug, lease.taskKey, fm.stages, ctx.dataRoot),
  );
}
