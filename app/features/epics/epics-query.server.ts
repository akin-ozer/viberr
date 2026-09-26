import type { DatabaseSync } from "node:sqlite";
import { data } from "react-router";
import type { SessionUser } from "~/server/auth/require-user.server";
import {
  canAccessConversation,
  getConversation,
} from "~/server/controller/controller-conversations.server";
import type { TaskActivitySummary } from "~/server/projections/board-query.server";
import { waitingOnViewer } from "~/server/projections/decisions.server";
import {
  getEpicDetail,
  listEpicChips,
  listEpics,
  type EpicDetail,
  type EpicSummary,
} from "~/server/projections/epic-query.server";
import { taskKeyLinks } from "~/server/projections/task-key-links.server";
import { liveRunStateByTask } from "~/server/runtimes/run-store.server";
import { withLiveRun } from "~/shared/mapping/task.server";
import type { TaskLinks } from "~/shared/task-key-links";
import { toBoardCard } from "~/features/board/board-card";
import { cardStatus, type CardStatus } from "~/features/board/card-status";
import type { WorkspaceRead } from "~/routes/project-workspace.server";

/**
 * Ruling 503: what the Epics pages read. Both answer from the workspace read
 * the layout already made for the same request (`readWorkspace`), so the
 * membership refusal, the project's stages and members and its task rows are
 * read once, and from the epic projection (`epic-query.server.ts`), whose
 * progress is counted from those same rows.
 */

/** A stage as the progress bar paints it. */
export interface EpicStageView {
  id: string;
  name: string;
  color: string;
}

/** A project member a lead can be picked from. */
export interface EpicMemberView {
  userId: string;
  name: string;
}

export interface EpicsPageView {
  epics: EpicSummary[];
  stages: EpicStageView[];
  members: EpicMemberView[];
}

/** One of an epic's tasks, as its page lists it. */
export interface EpicTaskView {
  key: string;
  title: string;
  stageId: string;
  archived: boolean;
  /** The board card's status for this task, computed exactly as the board
   *  computes it (the viewer's "waiting on you", the run row's queue), so a
   *  task reads the same word on its card and in its epic. */
  status: CardStatus | null;
  /** Its human owner's name, when a person owns it. */
  owner: { name: string; initials: string; tone: string } | null;
  /** How many of what it waits on are not done yet (ruling 131). */
  waitsOn: number;
}

/** A task that could join the epic, for the Add tasks dialog. */
export interface EpicCandidateView {
  key: string;
  title: string;
  /** The epic it is in now; joining this one moves it. */
  epicId: string | null;
}

/** Ruling 476(h), kept for epics: the conversation an epic was planned in,
 *  as a link, when the viewer may open it. */
export interface PlannedConversation {
  id: string;
  title: string;
  href: string;
  /** Where it lives: "Instance", the task it is anchored to, or its board. */
  scopeLabel: string;
}

export interface EpicPageView {
  epic: EpicDetail;
  stages: EpicStageView[];
  members: EpicMemberView[];
  tasks: EpicTaskView[];
  candidates: EpicCandidateView[];
  /** Every other epic by id and title, so a candidate in another epic says
   *  which. */
  otherEpics: { id: string; title: string }[];
  plannedIn: PlannedConversation | null;
  /** The task keys the description and the history name, as the pages this
   *  viewer can open (U39-31). */
  taskLinks: TaskLinks;
}

function stagesOf(workspace: WorkspaceRead): EpicStageView[] {
  return workspace.board.project.stages.map((s) => ({ id: s.id, name: s.name, color: s.color }));
}

/** The members a lead can be, by name. A member whose account is gone is
 *  left out: nobody can lead from a deleted account. */
function membersOf(workspace: WorkspaceRead): EpicMemberView[] {
  return workspace.board.members
    .filter((m) => !m.missing)
    .map((m) => ({ userId: m.userId, name: m.user.kind === "human" ? m.user.name : m.userId }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getEpicsPage(db: DatabaseSync, slug: string, workspace: WorkspaceRead): EpicsPageView {
  return {
    epics: listEpics(db, slug),
    stages: stagesOf(workspace),
    members: membersOf(workspace),
  };
}

/**
 * One epic's page: the epic with its history, its tasks with the board's
 * status word for each, the tasks that could join it, and the conversation it
 * was planned in. A 404 for an id the project has no epic by.
 */
export function getEpicPage(
  db: DatabaseSync,
  slug: string,
  epicId: string,
  input: {
    workspace: WorkspaceRead;
    viewer: Pick<SessionUser, "id" | "role">;
    dataRoot?: string;
  },
): EpicPageView {
  const epic = getEpicDetail(db, slug, epicId, input.dataRoot ? { dataRoot: input.dataRoot } : {});
  if (!epic) throw data(`No epic ${epicId} in projects/${slug}.`, { status: 404 });
  const { workspace, viewer } = input;
  const inEpic = workspace.tasks.filter((t) => t.epicId === epicId);
  const statuses = boardStatuses(db, viewer.id, slug, inEpic, workspace.reviewQueue.ready.map((r) => r.key));
  const others = listOtherEpics(db, slug, epicId);
  return {
    epic,
    stages: stagesOf(workspace),
    members: membersOf(workspace),
    tasks: inEpic
      .map((t) => ({
        key: t.key,
        title: t.title,
        stageId: t.stage,
        archived: t.archived,
        status: statuses.get(t.key) ?? null,
        owner:
          t.owner && t.owner.kind === "human"
            ? { name: t.owner.name, initials: t.owner.initials, tone: t.owner.tone }
            : null,
        waitsOn: t.blockedBy.filter((e) => e.state !== "done").length,
      }))
      .sort((a, b) => keyNumber(a.key) - keyNumber(b.key)),
    candidates: workspace.tasks
      .filter((t) => !t.archived && t.epicId !== epicId)
      .map((t) => ({ key: t.key, title: t.title, epicId: t.epicId ?? null }))
      .sort((a, b) => keyNumber(b.key) - keyNumber(a.key)),
    otherEpics: others,
    plannedIn: plannedConversation(db, viewer, slug, epic.conversationId),
    taskLinks: taskKeyLinks(db, [epic.description, ...epic.history.map((h) => h.text)], {
      projectSlug: slug,
      viewerId: viewer.id,
    }),
  };
}

function keyNumber(key: string): number {
  return Number(key.slice(key.lastIndexOf("-") + 1)) || 0;
}

function listOtherEpics(db: DatabaseSync, slug: string, epicId: string): { id: string; title: string }[] {
  return listEpicChips(db, slug)
    .filter((e) => e.id !== epicId)
    .map((e) => ({ id: e.id, title: e.title }));
}

/**
 * The board card's status word per task (ruling 476(g), which the goal rail
 * followed and the epic page keeps): `waitingOnMe` from `waitingOnViewer`
 * over the same review queue the board reads, the run row's queued state
 * (`withLiveRun`), then `cardStatus`.
 */
function boardStatuses(
  db: DatabaseSync,
  viewerId: string,
  projectSlug: string,
  tasks: readonly TaskActivitySummary[],
  readyKeys: Iterable<string>,
): Map<string, CardStatus> {
  const out = new Map<string, CardStatus>();
  if (tasks.length === 0) return out;
  const mine = waitingOnViewer(db, viewerId, projectSlug, readyKeys);
  const live = liveRunStateByTask(db, projectSlug);
  for (const task of tasks) {
    const status = cardStatus(
      toBoardCard(withLiveRun({ ...task, waitingOnMe: mine.has(task.key) }, live.get(task.key) ?? null)),
    );
    if (status) out.set(task.key, status);
  }
  return out;
}

/**
 * Ruling 476(h): the conversation an epic was planned in, as a link, when the
 * viewer may open it (its owner, or an org admin: `canAccessConversation`).
 * Conversations belong to the person who had them, so anyone else is shown no
 * link and no title.
 */
function plannedConversation(
  db: DatabaseSync,
  viewer: Pick<SessionUser, "id" | "role">,
  projectSlug: string,
  conversationId: string | null,
): PlannedConversation | null {
  if (!conversationId) return null;
  const found = getConversation(db, conversationId);
  if (
    !found ||
    !canAccessConversation(db, found, {
      userId: viewer.id,
      orgRole: viewer.role === "admin" ? "admin" : "member",
    })
  ) {
    return null;
  }
  return {
    id: found.id,
    title: found.title || "New conversation",
    href: `${found.projectSlug ? `/projects/${found.projectSlug}` : ""}/controller?c=${encodeURIComponent(found.id)}`,
    scopeLabel:
      found.projectSlug === null
        ? "Instance"
        : (found.taskKey ?? (found.projectSlug === projectSlug ? "This board" : found.projectSlug)),
  };
}
