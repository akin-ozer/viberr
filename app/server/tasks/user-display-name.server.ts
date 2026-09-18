import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

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
