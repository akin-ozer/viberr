import { existsSync, readdirSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { projectsDir } from "~/server/files/file-store-root.server";
import { listGoalIds, readGoalFile, updateGoalFile } from "~/server/files/goal-writer.server";
import { logger } from "~/server/logging/logger.server";
import { rebuildGoalFile } from "~/server/projections/rebuilder.server";
import { decodeControllerInstrument } from "~/shared/mapping/actor.server";
import { toError } from "~/shared/errors";

/**
 * Ruling 476(j) (live verification 2026-09-25, F40-61, extending (h)): a chain
 * written before `conversationId` existed learns the conversation it was
 * planned in.
 *
 * `create_goal` records the turn's conversation only from the build that added
 * the key, so goal-1 on the owner's instance (created 2026-09-24 20:47:16Z by
 * the controller) kept `conversationId: null` and its project's Controller page
 * still showed no "Planned in" link. The store already holds the answer: the
 * chain's `goal.created` audit row is written inside the controller turn that
 * called the tool, that turn is a `kind = 'controller'` run whose window covers
 * the row, and the run's reply in `controller_messages` names its conversation.
 * Live: 20:47:16Z falls in run_j6tgNgM5keud (20:42:11 to 20:48:36), whose reply
 * is in cnv_Edgq8wV-6U_N.
 *
 * Only a chain whose creator is recorded through the controller
 * (`<email> · via controller`, ruling 99(b)) was planned in a conversation, and
 * only the creator's own conversations can have planned it. The key is written
 * when exactly ONE conversation matches; none or several leave it null, since a
 * wrong "Planned in" link would send a person to reasoning that is not this
 * chain's. Idempotent: a chain that carries a conversation is never touched,
 * and the writer re-checks that under the file lock.
 */

export interface GoalConversationBackfill {
  /** The chains that now name the conversation they were planned in. */
  recorded: { projectSlug: string; goalId: string; conversationId: string }[];
  /** Controller-made chains left null: `candidates` conversations matched. */
  unresolved: { projectSlug: string; goalId: string; candidates: number }[];
}

const occurredRows = z.array(z.object({ occurred_at: z.string() }));
const conversationRows = z.array(z.object({ conversation_id: z.string() }));

/** Project directories in the store, as the rescan walks them. */
function storeProjectSlugs(dataRoot: string | undefined): string[] {
  const root = projectsDir(dataRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() && !entry.name.startsWith(".") ? [entry.name] : [],
  );
}

/**
 * The creator's controller conversations whose turn was running when the chain
 * was created: a `goal.created` row by the creator, inside the window of a
 * controller run (still running, or finished no earlier than the row) that
 * wrote a message in a conversation the creator owns. Times are compared as
 * instants, not strings.
 */
function planningConversations(
  db: DatabaseSync,
  projectSlug: string,
  goalId: string,
  createdBy: string,
): Set<string> {
  const created = occurredRows.parse(
    db
      .prepare(
        `SELECT occurred_at FROM audit_events
          WHERE action = 'goal.created' AND subject_kind = 'goal'
            AND subject_id = ? AND project_slug = ? AND actor_user_id = ?`,
      )
      .all(goalId, projectSlug, createdBy),
  );
  const covering = db.prepare(
    `SELECT DISTINCT m.conversation_id
       FROM agent_runs r
       JOIN controller_messages m ON m.run_id = r.id
       JOIN controller_conversations c ON c.id = m.conversation_id
      WHERE r.kind = 'controller'
        AND c.user_id = ?
        AND r.started_at IS NOT NULL
        AND julianday(r.started_at) <= julianday(?)
        AND (r.finished_at IS NULL OR julianday(?) <= julianday(r.finished_at))`,
  );
  const found = new Set<string>();
  for (const { occurred_at: at } of created) {
    for (const row of conversationRows.parse(covering.all(createdBy, at, at))) {
      found.add(row.conversation_id);
    }
  }
  return found;
}

export async function backfillGoalConversations(
  db: DatabaseSync,
  options: { dataRoot?: string } = {},
): Promise<GoalConversationBackfill> {
  const { dataRoot } = options;
  const out: GoalConversationBackfill = { recorded: [], unresolved: [] };
  for (const projectSlug of storeProjectSlugs(dataRoot)) {
    for (const goalId of listGoalIds(projectSlug, dataRoot)) {
      const fm = readGoalFile({ projectSlug, goalId, dataRoot })?.parsed.frontmatter;
      if (!fm || fm.conversationId !== null) continue;
      if (decodeControllerInstrument(fm.createdByLabel) === null) continue;
      const found = planningConversations(db, projectSlug, goalId, fm.createdBy);
      const [conversationId] = [...found];
      if (found.size !== 1 || conversationId === undefined) {
        out.unresolved.push({ projectSlug, goalId, candidates: found.size });
        continue;
      }
      try {
        await updateGoalFile({ projectSlug, goalId, dataRoot }, (goal) => {
          if (goal.frontmatter.conversationId === null) {
            goal.frontmatter.conversationId = conversationId;
          }
        });
        rebuildGoalFile(db, projectSlug, goalId, { dataRoot });
        out.recorded.push({ projectSlug, goalId, conversationId });
      } catch (error) {
        logger.warn("could not record the conversation a chain was planned in", {
          projectSlug,
          goalId,
          err: toError(error),
        });
      }
    }
  }
  if (out.recorded.length > 0) {
    logger.info("recorded the conversation each older chain was planned in", {
      goals: out.recorded.map((g) => `${g.projectSlug}/${g.goalId} -> ${g.conversationId}`),
    });
  }
  if (out.unresolved.length > 0) {
    logger.info(
      "left chains without a planning conversation: not exactly one of their creator's controller turns covers their creation",
      {
        goals: out.unresolved.map(
          (g) => `${g.projectSlug}/${g.goalId} (${g.candidates} conversations)`,
        ),
      },
    );
  }
  return out;
}
