import type { DatabaseSync } from "node:sqlite";
import type { ProjectRole } from "~/schemas/project-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { initialsOfName } from "~/shared/mapping/actor.server";

/**
 * Membership read model for the Settings + Policy panels.
 *
 * project.md is the canonical membership store ({userId, role} rows) — the
 * project_members projection carries only userId/role, so this helper reads
 * the file and joins the users table for display fields. Identity is user id
 * everywhere (ruling 6); names/emails are render-only.
 */

export interface MembershipView {
  userId: string;
  role: ProjectRole;
  name: string;
  email: string;
  initials: string;
  tone: string;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  avatar_tone: string | null;
}

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
    `SELECT id, name, email, avatar_tone FROM users WHERE id = ?`,
  );
  return file.parsed.frontmatter.members.map((member) => {
    const user = stmt.get(member.userId) as UserRow | undefined;
    const name = user?.name ?? member.userId;
    return {
      userId: member.userId,
      role: member.role,
      name,
      email: user?.email ?? "",
      initials: initialsOfName(name),
      tone: user?.avatar_tone ?? "",
    };
  });
}
