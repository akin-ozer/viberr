import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { taskDir } from "~/server/files/file-store-root.server";
import { logger } from "~/server/logging/logger.server";
import {
  getProject,
  listProjects,
  listProjectTasks,
} from "~/server/projections/board-query.server";
import { TASK_CAPTURE_INPUT_DIR, TASK_CAPTURE_SCRATCH_DIR } from "~/server/runtimes/agent-isolation.server";
import { removeAgentTreeSync } from "~/server/runtimes/agent-trees.server";
import { toError } from "~/shared/errors";
import { taskWorkspaceLaunch } from "./workspace-git.server";

/**
 * Task-workspace reclamation (P13, from the ARCH-6 intent audit).
 *
 * Every task that has ever run a specialist holds a full git clone at
 * `<taskDir>/workspace/<repo>` — 11-16 MB each on a real repo. Nothing ever
 * removed one: a repo-wide search for an `rmSync` against that path found no
 * caller, so the store grew by one clone per task, forever. A one-project test
 * instance had already accumulated 101 MB across seven tasks.
 *
 * This is deliberately NOT part of `db/retention.server.ts`. That module's own
 * contract is that it "only compacts the rebuildable SQLite projection/log
 * tables" and never touches the file store; deleting directories from inside it
 * would make that docstring a lie.
 *
 * ## What is safe to delete, and why
 *
 * A workspace is a CACHE, not canonical state. The canonical record is
 * `task.md`; delivered work lives in the remote branch and the PR. The clone is
 * already treated as disposable at the other end — a failed clone falls back to
 * the workspace root and the run continues (`specialist-workspace.server.ts`
 * logs "specialist run clone failed, running WITHOUT a checkout"). So the cost
 * of reclaiming one that is needed again is a re-clone, not lost work.
 *
 * The rule is nonetheless conservative: reclaim only a task sitting in its
 * project's TERMINAL stage. A task in Done has delivered; if it is reopened the
 * next run re-clones. Nothing in flight is touched.
 *
 * Called at boot, AFTER run recovery has settled crashed runs — at that moment
 * no run of this process can be holding a working tree open.
 */

export interface WorkspaceReclamation {
  /** Workspace directories removed. */
  removed: number;
  /** Bytes reclaimed (best-effort — a directory that vanishes mid-walk is skipped). */
  bytes: number;
}

/** Recursive size of `dir`, or 0 if it cannot be read. */
function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        try {
          total += statSync(abs).size;
        } catch {
          // Raced with a delete — not worth failing a size estimate over.
        }
      }
    }
  }
  return total;
}

/**
 * Remove the workspace clone for every task in a terminal stage.
 *
 * Best-effort and idempotent: a task with no workspace is skipped, and a
 * directory that cannot be removed is logged rather than thrown, so one
 * unreadable path never aborts the sweep or blocks boot.
 */
export function reclaimTerminalTaskWorkspaces(
  db: DatabaseSync,
  options: { dataRoot?: string } = {},
): WorkspaceReclamation {
  let removed = 0;
  let bytes = 0;

  for (const project of listProjects(db)) {
    const full = getProject(db, project.slug);
    const stages = full?.stages ?? [];
    // The terminal stage is the LAST one, whatever its id — a project may have
    // renamed or replaced "done" (the stage editor allows it).
    const terminalStageId = stages[stages.length - 1]?.id;
    if (!terminalStageId) continue;

    for (const task of listProjectTasks(db, project.slug)) {
      if (task.stage !== terminalStageId) continue;
      const dir = taskDir(project.slug, task.key, options.dataRoot);
      const workspace = path.join(dir, "workspace");
      // Ruling 194: the page renderer's scratch is beside the workspace, in
      // the task's own directory. What a render or a run that a restart cut
      // short left there is reclaimed the same way; it is no workspace and is
      // not counted as one.
      for (const tree of [workspace, path.join(dir, TASK_CAPTURE_SCRATCH_DIR)]) {
        if (!existsSync(tree)) continue;
        const size = dirSize(tree);
        try {
          // Ruling 140: the tree is the agents' (a tool they ran can leave
          // directories only its uid can enter), so it goes as the task's
          // person (synchronously: nothing may start in it while it is
          // going). With isolation on and no owner this refuses and it stays.
          removeAgentTreeSync(
            tree,
            taskWorkspaceLaunch(db, { projectSlug: project.slug, taskKey: task.key, dataRoot: options.dataRoot }),
          );
          if (tree === workspace) removed += 1;
          bytes += size;
        } catch (error) {
          logger.warn("could not reclaim a finished task's workspace", {
            projectSlug: project.slug,
            taskKey: task.key,
            tree: path.basename(tree),
            err: toError(error),
          });
        }
      }
      // Ruling 194: the copy of a kept delivery a cut render was reading is
      // the server's own folder (no agent can write in it), so the server
      // removes it itself. Nothing else comes to a closed task to do it.
      const carried = path.join(dir, TASK_CAPTURE_INPUT_DIR);
      if (existsSync(carried)) {
        const size = dirSize(carried);
        try {
          rmSync(carried, { recursive: true, force: true });
          bytes += size;
        } catch (error) {
          logger.warn("could not reclaim a finished task's workspace", {
            projectSlug: project.slug,
            taskKey: task.key,
            tree: TASK_CAPTURE_INPUT_DIR,
            err: toError(error),
          });
        }
      }
    }
  }

  return { removed, bytes };
}
