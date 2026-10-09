import type { DatabaseSync } from "node:sqlite";
import { data } from "react-router";
import type { SessionUser } from "~/server/auth/require-user.server";
import {
  getBoardWithTasks,
  type BoardData,
  type TaskActivitySummary,
} from "~/server/projections/board-query.server";
import {
  getReviewQueue,
  type ReviewQueueData,
} from "~/server/projections/review-queue.server";
import type { ProjectRole } from "~/shared/rbac";
import { isArchived } from "~/features/board/board-filters";

/**
 * Ruling 11 (BOARD-6): the project read the workspace layout and the board
 * share. The board's columns used to live in the layout loader, so the task
 * page and every other project page computed and shipped the whole board on
 * every revalidation for nothing. They are the board route's own loader now,
 * and both loaders read the project through here: React Router hands every
 * loader of one GET request the same Request object (single fetch runs the
 * layout and the board together), so the task list is built once per request
 * however many of them ask, as it was when the layout alone built it.
 *
 * Reads only: a POST resolves afresh, and the loaders that follow an action
 * get a new Request from the router.
 */
export interface WorkspaceRead {
  board: BoardData;
  /** Every task in `listProjectTasks` order, archived ones included. */
  tasks: TaskActivitySummary[];
  /** The viewer's membership role; null for the org-admin override. */
  memberRole: ProjectRole | null;
  /** D2 (R7-1): an org admin viewing a project they are not a member of. */
  orgAdminOverride: boolean;
  /** U35-5: the review queue, read once — `total` is the rail badge and
   *  `ready` feeds the board's "waiting on me" (UI-48). */
  reviewQueue: ReviewQueueData;
}

const readsByRequest = new WeakMap<Request, Map<string, WorkspaceRead>>();

/**
 * The project `slug` as `user` may read it, or the byte-identical 404 an
 * unknown slug gets (R15-4 / WI-13): a signed-in non-member cannot tell the
 * two apart. The refusal comes BEFORE any viewer-scoped projection work: the
 * review queue below is a per-viewer read a non-member must never trigger.
 */
export function readWorkspace(
  request: Request,
  db: DatabaseSync,
  slug: string,
  user: Pick<SessionUser, "id" | "role">,
): WorkspaceRead {
  const reuse = request.method === "GET" || request.method === "HEAD";
  const key = `${slug}\n${user.id}`;
  const known = reuse ? readsByRequest.get(request)?.get(key) : undefined;
  if (known) return known;
  const read = readUncached(db, slug, user);
  if (reuse) {
    const byKey = readsByRequest.get(request) ?? new Map<string, WorkspaceRead>();
    byKey.set(key, read);
    readsByRequest.set(request, byKey);
  }
  return read;
}

function readUncached(
  db: DatabaseSync,
  slug: string,
  user: Pick<SessionUser, "id" | "role">,
): WorkspaceRead {
  const loaded = getBoardWithTasks(db, slug);
  if (!loaded) {
    throw data(`No project at projects/${slug}.`, { status: 404 });
  }
  const { board, tasks } = loaded;
  const memberRole = board.members.find((m) => m.userId === user.id)?.role ?? null;
  // D2 (R7-1): an ORG admin holds audited emergency project-admin authority on
  // every project. When they view a project they're NOT a member of, the UI
  // unlocks the admin affordances the server would grant anyway (each use is
  // audited server-side as `project.org_admin.override`) and the topbar shows
  // an honest "org-admin override" pill instead of silently pretending
  // membership. `user.role` is the session's resolved org role.
  const orgAdminOverride = memberRole === null && user.role === "admin";
  if (memberRole === null && !orgAdminOverride) {
    throw data(`No project at projects/${slug}.`, { status: 404 });
  }
  // Ruling 11: from the board's own rows — archived ones dropped by the ONE
  // predicate (F19-9), which is exactly the `archived = 0` list the queue would
  // otherwise map a second time.
  const reviewQueue = getReviewQueue(db, slug, {
    viewerUserId: user.id,
    tasks: tasks.filter((t) => !isArchived(t)),
    project: board.project,
  });
  return { board, tasks, memberRole, orgAdminOverride, reviewQueue };
}
