import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { decodeControllerInstrument } from "~/shared/mapping/actor.server";

const userNameRowSchema = z.object({ name: z.string() });

/**
 * The user's DISPLAY name — the thing the @mention ladder can actually resolve
 * (`mention-notify.server.ts` matches an email's local part, a full name or a
 * first name, never a whole address). NEW-4: an email tag chips nothing and
 * notifies nobody.
 *
 * It lives in its own module because both the task-action modules and
 * `specialist-run.server.ts` need it, and specialist-run takes values only
 * from the task-mutation substrate, never statically from a task-action module
 * (those load specialist-run when they run), so the two stay out of a module
 * cycle (ruling 13).
 *
 * Returns the id when no such user exists, so a caller can tell "resolved" from
 * "unknown" by comparing against the id it passed. `users.name` is NOT NULL, so
 * a row that fails the parse is a missing user, and the id is then the honest
 * display fallback.
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
 * (`arda@viberr.dev · via controller`, ruling 247), which is what an audit
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
  const person = decodeControllerInstrument(actor.label);
  const name = actor.userId ? userDisplayName(db, actor.userId) : null;
  const who = name && name !== actor.userId ? name : (person ?? actor.label);
  return person !== null ? `${who} (via the controller)` : who;
}
