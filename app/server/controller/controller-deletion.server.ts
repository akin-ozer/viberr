import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { recordAudit, type AuditEventInput } from "~/server/audit/audit-recorder.server";
import { assertProjectAction, isOrgAdmin } from "~/server/auth/project-authority.server";
import { withTransaction } from "~/server/db/transaction.server";
import { AppError } from "~/server/errors/app-error.server";
import { interruptRunOnConversationDeletion } from "~/server/runtimes/run-service.server";
import { roleCan, type ProjectRole } from "~/shared/rbac";
import {
  getConversation,
  publishConversationUpdated,
  type ControllerConversation,
} from "./controller-conversations.server";
import { purgeDeletedConversationLogs } from "./controller-purge.server";
import { dropConversationLease } from "./controller-run.server";

/**
 * Ruling 525: deleting a controller conversation.
 *
 * WHO. The person who started it, always: it is theirs (ruling 99(d)). An org
 * admin, any: they already read every one (ruling 100(b)). And, for a
 * conversation about a project (bound to its board or anchored to one of its
 * tasks), whoever holds `delete-controller-conversations` there, a project
 * admin by default (`app/shared/rbac.ts`); an org admin passes that gate as
 * the audited D2 override, as on every project action. A conversation about
 * no project has no project role to hold, so it stays its starter's and the
 * org admins'.
 *
 * WHAT. The conversation and its messages, and what its turns said and did:
 * their console lines, raw logs and provider transcripts
 * (`controller-purge.server.ts`). The turns' run rows stay as the record of
 * what was spent. A turn that is running is stopped first, and the queue
 * behind it goes with the conversation. It is permanent: nothing restores it.
 * The page asks first, and the audit row says who deleted whose conversation
 * and how much of it, never what it said.
 */

/** Who is looking, for the Delete a page offers. */
export interface ConversationDeleter {
  userId: string;
  /** A live org admin. */
  orgAdmin: boolean;
  /** The viewer's role in the project the page is about; null elsewhere. */
  projectRole: ProjectRole | null;
}

/**
 * May this viewer delete this conversation? What the page shows, never an
 * audit row: the delete itself re-decides through the guards below, and the
 * two agree by construction (starter, org admin, or the row's role on a
 * conversation about a project).
 */
export function mayDeleteConversation(
  conversation: Pick<ControllerConversation, "userId" | "projectSlug">,
  viewer: ConversationDeleter,
): boolean {
  if (conversation.userId === viewer.userId || viewer.orgAdmin) return true;
  return (
    conversation.projectSlug !== null &&
    roleCan(viewer.projectRole, "delete-controller-conversations")
  );
}

export interface DeleteConversationInput {
  conversationId: string;
  /**
   * The scope of the page it is deleted from, which only lists its own: null
   * is the instance page, a slug that project's page (its board's threads and
   * its tasks'). A conversation of another scope is not found here, as the
   * page's loader would not open it (ruling 121).
   */
  projectSlug: string | null;
  dataRoot?: string;
}

export interface DeleteConversationResult {
  /** The conversation as it stood. */
  conversation: ControllerConversation;
  /** How many running turns the deletion stopped. */
  stopped: number;
}

/** How the actor held the delete, for the audit row. */
type DeletedAs = "starter" | "org-admin" | "project-role";

function notFound(): AppError {
  // The 404 every non-reader gets about a conversation (ruling 99(d)).
  return AppError.notFound("Conversation not found.");
}

/** The guard: throws unless `actor` may delete it, and says how they may. */
function requireDeletion(
  db: DatabaseSync,
  conversation: ControllerConversation,
  actor: { userId: string; label: string },
  dataRoot?: string,
): DeletedAs {
  if (conversation.userId === actor.userId) return "starter";
  if (conversation.projectSlug) {
    // Archived or not: a conversation is app-owned state, not the project's
    // files, and clearing one out changes nothing a read-only project holds.
    const options: Parameters<typeof assertProjectAction>[5] = { allowArchived: true };
    if (dataRoot) options.dataRoot = dataRoot;
    const grant = assertProjectAction(
      db,
      "delete-controller-conversations",
      conversation.projectSlug,
      actor,
      "delete another person's controller conversation",
      options,
    );
    return grant.isOrgAdminOverride ? "org-admin" : "project-role";
  }
  if (isOrgAdmin(db, actor.userId)) return "org-admin";
  throw notFound();
}

/** Counts for the audit row. */
const sizeSchema = z.object({ messages: z.number(), turns: z.number() });

/** The runs of a conversation still queued or running. */
const liveTurnSchema = z.array(z.object({ id: z.string() }));

export function deleteControllerConversation(
  db: DatabaseSync,
  input: DeleteConversationInput,
  actor: { userId: string; label: string },
): DeleteConversationResult {
  const conversation = getConversation(db, input.conversationId);
  if (!conversation || conversation.projectSlug !== input.projectSlug) throw notFound();
  const deletedAs = requireDeletion(db, conversation, actor, input.dataRoot);

  const size = sizeSchema.parse(
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM controller_messages WHERE conversation_id = ?) AS messages,
           (SELECT COUNT(*) FROM agent_runs
             WHERE kind = 'controller' AND project_slug = '' AND task_key = ?) AS turns`,
      )
      .get(conversation.id, conversation.id),
  );
  // No queued message may start a turn in it from here on.
  dropConversationLease(conversation.id);
  withTransaction(db, () => {
    db.prepare(`DELETE FROM controller_messages WHERE conversation_id = ?`).run(conversation.id);
    db.prepare(`DELETE FROM controller_conversations WHERE id = ?`).run(conversation.id);
  });
  // A running turn stops now. It settles into a conversation that is gone,
  // which purges the lines it writes on its way out (`settleTurn`).
  const live = liveTurnSchema.parse(
    db
      .prepare(
        `SELECT id FROM agent_runs
          WHERE kind = 'controller' AND project_slug = '' AND task_key = ?
            AND state IN ('queued', 'running')`,
      )
      .all(conversation.id),
  );
  let stopped = 0;
  for (const run of live) {
    if (interruptRunOnConversationDeletion(db, run.id, actor.userId) === "interrupted") {
      stopped += 1;
    }
  }
  purgeDeletedConversationLogs(db, conversation.id, input.dataRoot);

  const audit: AuditEventInput = {
    action: "controller.conversation.deleted",
    actor: { userId: actor.userId, label: actor.label },
    subjectKind: "conversation",
    subjectId: conversation.id,
    // Its words are gone and stay gone: the row says whose it was and how
    // much of it there was, never its title.
    details: {
      ownerUserId: conversation.userId,
      ownerLabel: conversation.userLabel,
      deletedAs,
      messages: size.messages,
      turns: size.turns,
      stoppedTurns: stopped,
    },
  };
  if (conversation.projectSlug) audit.projectSlug = conversation.projectSlug;
  if (conversation.taskKey) audit.taskKey = conversation.taskKey;
  recordAudit(db, audit);
  // The starter's open surfaces let go of it (the dock falls back to the
  // scope's newest thread).
  publishConversationUpdated(conversation.id, conversation.userId);
  return { conversation, stopped };
}
