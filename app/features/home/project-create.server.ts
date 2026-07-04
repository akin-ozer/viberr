import type Database from "better-sqlite3";
import type { ProjectFrontmatter } from "~/schemas/project-file.schema";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import {
  getDataRoot,
  projectFilePath,
} from "~/server/files/file-store-root.server";
import { createProjectFile } from "~/server/files/project-writer.server";
import { getProject } from "~/server/projections/board-query.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  GOVERNED_TEMPLATE,
  LIGHTWEIGHT_TEMPLATE,
} from "~/shared/workflow/templates";
import { slugifyProjectName } from "./project-name";

/**
 * "New governed project" action (home spec §5.9/§5.10, §6.1): writes
 * projects/<slug>/project.md from the workflow template (ruling 15),
 * projects it, audits. The creator joins as project admin.
 *
 * The mock's policy preset only feeds the synthesized description — kept
 * exactly that way (agent capability presets arrive with Phase 8/9).
 */

export interface CreateProjectInput {
  name: string;
  /** Task key prefix, 2–4 uppercase letters. */
  key: string;
  /** Connection owner (repo account) — Phase-4 stand-in list. */
  owner: string;
  /** Repo name under the owner (already slugified by the modal). */
  repoName: string;
  template: "governed" | "light";
  policy: "strict" | "balanced" | "auto";
}

export interface CreateProjectResult {
  slug: string;
  key: string;
  name: string;
  /** Display path for the toast (ruling 3 — real store path). */
  storePath: string;
}

export async function createProject(
  db: Database.Database,
  input: CreateProjectInput,
  actor: { userId: string; label: string },
  ctx: { dataRoot?: string } = {},
): Promise<CreateProjectResult> {
  const name = input.name.trim();
  if (name.length < 2) {
    throw AppError.validation("A project name of at least 2 characters is required.");
  }
  const key = input.key.trim().toUpperCase();
  if (!/^[A-Z]{2,4}$/.test(key)) {
    throw AppError.validation("Task key must be 2–4 letters.");
  }
  const owner = input.owner.trim();
  if (!owner) {
    throw AppError.validation("Pick a GitHub connection first.");
  }
  const slug = slugifyProjectName(name);
  if (!slug) {
    throw AppError.validation("The project name must contain letters or digits.");
  }
  if (getProject(db, slug)) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      userMessage: `A project at projects/${slug} already exists.`,
      kind: "user",
    });
  }
  const template =
    input.template === "light" ? LIGHTWEIGHT_TEMPLATE : GOVERNED_TEMPLATE;
  const repoName = input.repoName.trim() || "new-project";

  // Synthesized description — verbatim mock mapping (home spec §5.10).
  const desc =
    (input.template === "light"
      ? "Lightweight 3-stage workflow"
      : "Governed 5-stage workflow") +
    " · " +
    (input.policy === "strict"
      ? "strict human-gate policy."
      : input.policy === "auto"
        ? "agents act within policy."
        : "balanced agent policy.");

  const frontmatter: ProjectFrontmatter = {
    name,
    slug,
    repo: `${owner}/${repoName}`,
    defaultBranch: "main",
    taskPrefix: key,
    nextTaskNumber: 1,
    stages: template.stages,
    workflow: template.workflow,
    members: [{ userId: actor.userId, role: "admin" }],
    agents: [],
    credentialPolicy: null,
    guardrails: [],
  };

  await createProjectFile(
    { projectSlug: slug, ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}) },
    { frontmatter, description: desc },
  );
  rebuildPath(db, projectFilePath(slug, ctx.dataRoot), {
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });

  recordAudit(db, {
    action: "project.created",
    actor,
    subjectKind: "project",
    subjectId: slug,
    projectSlug: slug,
    details: { name, key, repo: frontmatter.repo, template: template.id, policy: input.policy },
  });

  return {
    slug,
    key,
    name,
    storePath: `${getDataRoot(ctx.dataRoot)}/projects/${slug}`,
  };
}
