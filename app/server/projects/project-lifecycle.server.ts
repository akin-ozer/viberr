import type Database from "better-sqlite3";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";

/** Reject every mutation against archived history until the project is restored. */
export function assertProjectActive(
  db: Database.Database,
  projectSlug: string,
): void {
  const row = db
    .prepare(`SELECT archived FROM projects WHERE slug = ?`)
    .get(projectSlug) as { archived: number } | undefined;
  if (!row) throw AppError.notFound(`Project ${projectSlug} not found.`);
  if (row.archived === 1) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage:
        "This project is archived and read-only. Restore it in Settings before making changes or running agents.",
      kind: "user",
    });
  }
}
