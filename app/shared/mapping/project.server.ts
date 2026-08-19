import type {
  AgentDeployment,
  CredentialPolicy,
  Guardrail,
  ProjectRole,
  StageDef,
  WorkflowBoundary,
} from "~/schemas/project-file.schema";

/**
 * Centralized snake_case → camelCase mapping for the `projects` +
 * `project_members` projection tables (docs/architecture/decisions.md "Data & naming").
 */

/** A type alias, not an interface, so a `SELECT`-row assertion is checked
 *  against SQLite's own output types instead of being laundered through
 *  `unknown` first (only a type alias gets the implicit index signature). */
export type ProjectRow = {
  slug: string;
  name: string;
  archived: 0 | 1;
  repo: string | null;
  default_branch: string;
  task_prefix: string;
  description: string;
  stages_json: string;
  workflow_json: string;
  agent_policy_json: string;
  credential_policy_json: string | null;
  guardrails_json: string;
  source_path: string;
  content_hash: string;
  parsed_at: string;
};

export interface ProjectRecord {
  slug: string;
  name: string;
  archived: boolean;
  repo: string | null;
  defaultBranch: string;
  taskPrefix: string;
  description: string;
  stages: StageDef[];
  workflow: WorkflowBoundary[];
  agentPolicy: AgentDeployment[];
  credentialPolicy: CredentialPolicy | null;
  guardrails: Guardrail[];
  /** Store-relative path, e.g. "projects/viberr-core/project.md". */
  sourcePath: string;
  contentHash: string;
  parsedAt: string;
}

export function mapProjectRow(row: ProjectRow): ProjectRecord {
  // SAFETY: the five `*_json` columns have ONE writer — `rebuildProjectFile`
  // (server/projections/rebuilder.server.ts) stores `JSON.stringify` of the
  // frontmatter `parseProjectFileContent` just produced, so each column holds
  // exactly the schema type named below. `credential_policy_json` is the one
  // nullable column of the five and its null is checked before the parse.
  return {
    slug: row.slug,
    name: row.name,
    archived: row.archived === 1,
    repo: row.repo,
    defaultBranch: row.default_branch,
    taskPrefix: row.task_prefix,
    description: row.description,
    stages: JSON.parse(row.stages_json) as StageDef[],
    workflow: JSON.parse(row.workflow_json) as WorkflowBoundary[],
    agentPolicy: JSON.parse(row.agent_policy_json) as AgentDeployment[],
    credentialPolicy: row.credential_policy_json
      ? (JSON.parse(row.credential_policy_json) as CredentialPolicy)
      : null,
    guardrails: JSON.parse(row.guardrails_json) as Guardrail[],
    sourcePath: row.source_path,
    contentHash: row.content_hash,
    parsedAt: row.parsed_at,
  };
}

/** Type alias for the same reason as ProjectRow above. */
export type ProjectMemberRow = {
  project_slug: string;
  user_id: string;
  role: ProjectRole;
};

export interface ProjectMemberRecord {
  projectSlug: string;
  userId: string;
  role: ProjectRole;
}

export function mapProjectMemberRow(row: ProjectMemberRow): ProjectMemberRecord {
  return { projectSlug: row.project_slug, userId: row.user_id, role: row.role };
}
