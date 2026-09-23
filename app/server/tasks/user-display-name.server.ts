import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { decodeControllerInstrument } from "~/server/files/actor-ref.server";

const userNameRowSchema = z.object({ name: z.string() });

/**
 * The user's DISPLAY name — the thing the @mention ladder can actually resolve
 * (`mention-notify.server.ts` matches an email's local part, a full name or a
 * first name, never a whole address). NEW-4: an email tag chips nothing and
 * notifies nobody.
 *
 * It lives in its own module because both `task-actions.server.ts` (which
 * re-exports it as `userName`) and `specialist-run.server.ts` need it, and
 * specialist-run deliberately holds only a TYPE import from task-actions to
 * keep the two out of a module cycle (ruling 207(e)).
 *
 * Returns the id when no such user exists, so a caller can tell "resolved" from
 * "unknown" by comparing against the id it passed.
 */
export function userDisplayName(db: DatabaseSync, userId: string): string {
  const row = userNameRowSchema.safeParse(
    db.prepare(`SELECT name FROM users WHERE id = ?`).get(userId),
  );
  return row.success ? row.data.name : userId;
}

/**
 * U39-18 (pass 39): a person, as a sentence people read names them.
 *
 * `actor.label` is the address, with the controller's instrument appended
 * (`arda@viberr.dev · via controller`, ruling 99(b)), which is what an audit
 * row wants. Written into prose it read "Released: arda@viberr.dev · via
 * controller cleared the wait on AX-22" and "Link 2 edited by arda@viberr.dev
 * · via controller" on the task and chain a teammate reads. Here it is the
 * display name, with the instrument said in words. A label with no user
 * behind it is left as it is.
 */
export function actorProseName(
  db: DatabaseSync,
  actor: { userId: string | null; label: string },
): string {
  const { label, viaController } = decodeControllerInstrument(actor.label);
  const name = actor.userId ? userDisplayName(db, actor.userId) : null;
  const who = name && name !== actor.userId ? name : label;
  return viaController ? `${who} (via the controller)` : who;
}
