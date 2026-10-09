import type { DatabaseSync } from "node:sqlite";
import type { ProjectRole } from "~/schemas/project-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { removedAccountLabel } from "~/server/projections/board-query.server";
import { initialsOf } from "~/ui/initials";

/**
 * Membership read model for the Settings + Policy panels.
 *
 * project.md is the canonical membership store ({userId, role} rows) — the
 * project_members projection carries only userId/role, so this helper reads
 * the file and joins the users table for display fields. Identity is user id
 * everywhere (ruling 26(a)); names/emails are render-only.
 */

export interface MembershipView {
  userId: string;
  role: ProjectRole;
  name: string;
  email: string;
  initials: string;
  tone: string;
  /**
   * LV-04/UI-29: the membership references a user id with no live `users` row
   * (the org account was deleted while project.md kept the entry). Every
   * surface that renders a member must say so instead of printing the raw
   * `u_RT7-QeTWOwP4` id as if it were a person, and the row must stay removable.
   */
  missing: boolean;
  /** The account exists but is disabled — it cannot sign in or act. */
  disabled: boolean;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  avatar_tone: string | null;
  disabled: number;
}

/** Re-exported so every membership surface uses the ONE label (LV-04). */
export { removedAccountLabel };

export function listMembershipViews(
  db: DatabaseSync,
  projectSlug: string,
  ctx: { dataRoot?: string } = {},
): MembershipView[] {
  const file = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!file) return [];
  const stmt = db.prepare(
    `SELECT id, name, email, avatar_tone, disabled FROM users WHERE id = ?`,
  );
  return file.parsed.frontmatter.members.map((member) => {
    // SAFETY: UserRow names exactly the five columns the statement above
    // selects, in the types 0001_baseline declares for them (`avatar_tone`
    // nullable, `disabled` the 0/1 INTEGER). A member id with no account row
    // yields undefined — the LV-04 branch below.
    const user = stmt.get(member.userId) as UserRow | undefined;
    // LV-04: never fall back to the raw id — a deleted account renders as an
    // explicit "Removed account", which is what it is.
    const name = user?.name ?? removedAccountLabel(member.userId);
    return {
      userId: member.userId,
      role: member.role,
      name,
      email: user?.email ?? "",
      initials: user ? initialsOf(user.name) : "?",
      tone: user?.avatar_tone ?? "",
      missing: user === undefined,
      disabled: user?.disabled === 1,
    };
  });
}

/** The one column {@link isLastLiveAdmin} reads per member. */
interface DisabledFlagRow {
  disabled: number;
}

/**
 * UI-29: a project keeps at least one admin who can ACTUALLY administer. Is
 * `targetUserId` the last of them, whose seat neither a demotion
 * (`setMemberRole`) nor a removal (`removeMember`) may take?
 *
 * The last-admin guards used to count project.md admin entries, so one ghost
 * admin (an org-deleted account project.md still listed) satisfied the guard
 * and let the only real admin demote or remove themselves — leaving a project
 * nobody could govern. A member with no `users` row, or a disabled one, cannot
 * sign in, so neither counts, and neither is ever the last: taking its seat
 * leaves the admins who can sign in as they were. Refusing that removal
 * deadlocked the one way to clear a ghost admin (F18-6), and the demotion is
 * let go exactly as the removal is (ruling 26).
 */
export function isLastLiveAdmin(
  db: DatabaseSync,
  members: readonly { userId: string; role: ProjectRole }[],
  targetUserId: string,
): boolean {
  const stmt = db.prepare(`SELECT disabled FROM users WHERE id = ?`);
  const live = members.filter((member) => {
    if (member.role !== "admin") return false;
    // SAFETY: the statement selects the single `disabled` column, an INTEGER
    // 0/1 in 0001_baseline; an org-deleted account yields no row at all.
    const row = stmt.get(member.userId) as DisabledFlagRow | undefined;
    return row !== undefined && row.disabled !== 1;
  });
  return live.length === 1 && live[0]?.userId === targetUserId;
}
