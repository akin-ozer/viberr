import { rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { logger } from "~/server/logging/logger.server";
import { agentGitLaunchFor } from "~/server/runtimes/agent-isolation.server";
import { removeAgentTreeSync } from "~/server/runtimes/agent-trees.server";
import { rawLogPath } from "~/server/runtimes/run-store.server";
import { transcriptFile } from "~/server/runtimes/session-export.server";
import { toError } from "~/shared/errors";
import { getConversation } from "./controller-conversations.server";

/**
 * Ruling 525: what a deleted controller conversation's turns leave behind,
 * taken away.
 *
 * A turn is a run (ruling 99), and a run keeps what was said and done in three
 * places: its console lines (`run_log_lines`: every tool call and reply, and
 * the inputs disclosure), its raw NDJSON (`runtimes/<backend>/<runId>.jsonl`),
 * and the provider's own session transcript in its person's runtime home. All
 * three go. The run ROW stays: it holds none of the words, and it is the
 * instance's record of what was spent (Insights counts a controller turn's
 * tokens and cost), which a deleted conversation does not make unspent. No
 * surface can open it any more: a controller run is readable only through its
 * conversation (`canReadControllerRunLog`).
 *
 * A turn still running when its conversation is deleted is stopped by the
 * deletion and writes its last lines as it exits, so this runs again at its
 * settle (`settleTurn`) and, for a turn a restart cut off before it settled,
 * at boot (`purgeOrphanedConversationLogs`). Each time is idempotent.
 */

/** A controller run of one conversation, as the purge reads it. */
const purgedRunSchema = z.object({
  id: z.string(),
  backend: z.enum(["claude", "codex"]),
  session_id: z.string().nullable(),
  credential_user_id: z.string().nullable(),
});

/**
 * Remove the logs of every turn of a conversation that no longer exists.
 * Refuses (returns 0) while the conversation is still there, so no caller can
 * reach a live conversation's record through it. Returns how many runs it
 * went through.
 */
export function purgeDeletedConversationLogs(
  db: DatabaseSync,
  conversationId: string,
  dataRoot?: string,
): number {
  if (getConversation(db, conversationId)) return 0;
  const runs = z.array(purgedRunSchema).parse(
    db
      .prepare(
        `SELECT id, backend, session_id, credential_user_id FROM agent_runs
          WHERE kind = 'controller' AND project_slug = '' AND task_key = ?`,
      )
      .all(conversationId),
  );
  if (runs.length === 0) return 0;
  // Every turn after a conversation's first resumes the one before it, so its
  // turns share a session or two (a continuity reset starts a fresh one).
  const sessions = new Map<string, { backend: "claude" | "codex"; userId: string }>();
  for (const run of runs) {
    if (run.session_id && run.credential_user_id) {
      sessions.set(run.session_id, { backend: run.backend, userId: run.credential_user_id });
    }
  }
  for (const [sessionId, session] of sessions) {
    removeTranscript(db, session.backend, session.userId, sessionId, dataRoot);
  }
  for (const run of runs) {
    // The server writes the raw log itself (`appendRawLine`), in its own
    // group, so it removes it itself.
    try {
      rmSync(rawLogPath(run.backend, run.id, dataRoot), { force: true });
    } catch (error) {
      logger.warn("a deleted conversation's raw run log could not be removed", {
        conversationId,
        runId: run.id,
        err: toError(error),
      });
    }
  }
  // The lines go last: while any remain, the boot sweep still finds the
  // conversation and finishes what a crash above interrupted.
  db.prepare(
    `DELETE FROM run_log_lines WHERE run_id IN (
       SELECT id FROM agent_runs
        WHERE kind = 'controller' AND project_slug = '' AND task_key = ?)`,
  ).run(conversationId);
  // The last tool step a turn named is its words too; a live turn clears its
  // own when it settles.
  db.prepare(
    `UPDATE agent_runs SET phase = NULL, step = NULL
      WHERE kind = 'controller' AND project_slug = '' AND task_key = ?
        AND state IN ('finished', 'error', 'interrupted')`,
  ).run(conversationId);
  return runs.length;
}

/**
 * The provider's transcript of one session, removed as its person (ruling
 * 485): it sits in their runtime home, which their agents write. A Claude
 * session keeps its subagents' and tool results' files in a folder named for
 * it beside the transcript, which goes too. Best-effort: a transcript that
 * cannot be removed is logged and never stops the deletion.
 */
function removeTranscript(
  db: DatabaseSync,
  backend: "claude" | "codex",
  userId: string,
  sessionId: string,
  dataRoot?: string,
): void {
  const file = transcriptFile(backend, userId, sessionId, dataRoot);
  if (!file) return;
  try {
    const person = agentGitLaunchFor(db, userId, dataRoot);
    removeAgentTreeSync(file, person);
    if (backend === "claude") removeAgentTreeSync(file.replace(/\.jsonl$/, ""), person);
  } catch (error) {
    logger.warn("a deleted conversation's session transcript could not be removed", {
      sessionId,
      err: toError(error),
    });
  }
}

/**
 * Boot: finish the purge for every conversation a deletion left logs behind
 * for, which is a turn that was still running when its conversation was
 * deleted and that a restart cut off before it settled. Before ruling 525 no
 * conversation was ever deleted, so a controller run with no conversation is
 * always one of these.
 */
export function purgeOrphanedConversationLogs(db: DatabaseSync, dataRoot?: string): number {
  // SAFETY: `task_key` is NOT NULL TEXT on `agent_runs` (0001_baseline).
  const orphaned = db
    .prepare(
      `SELECT DISTINCT r.task_key AS conversation_id FROM agent_runs r
        WHERE r.kind = 'controller' AND r.project_slug = ''
          AND NOT EXISTS (SELECT 1 FROM controller_conversations c WHERE c.id = r.task_key)
          AND EXISTS (SELECT 1 FROM run_log_lines l WHERE l.run_id = r.id)`,
    )
    .all() as { conversation_id: string }[];
  for (const row of orphaned) purgeDeletedConversationLogs(db, row.conversation_id, dataRoot);
  if (orphaned.length > 0) {
    logger.info("purged the logs deleted controller conversations left", {
      conversations: orphaned.length,
    });
  }
  return orphaned.length;
}
