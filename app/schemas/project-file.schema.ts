import { z } from "zod";
import {
  diagError,
  diagWarning,
  type FileDiagnostic,
} from "./file-diagnostics";

/**
 * Zod schemas + tolerant parser for `projects/<slug>/project.md` frontmatter
 * (canonical format documented in docs/architecture/file-formats.md).
 *
 * Same tolerance contract as task-file.schema.ts: unknown fields preserved,
 * missing/invalid fields produce diagnostics + fallbacks, never a throw.
 */

// ---------------------------------------------------------------- enums

/** Project membership roles — the 4-role system from contracts §3.2
 * (separate from org roles admin|member and from agent capability policy).
 * `contributor` was formerly named `reviewer`; the rename dropped a misleading
 * label (review authority actually rides per-task ownership, not the role) while
 * keeping the tier's one real power — creating tasks — above read-only `viewer`. */
export const PROJECT_ROLES = ["admin", "maintainer", "contributor", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** Legacy `reviewer` → `contributor` coercion for project.md files written
 * before the rename. Applied at parse time so no data migration is needed. */
function coerceProjectRole(value: unknown): unknown {
  return value === "reviewer" ? "contributor" : value;
}

/** Workflow transition boundaries (contracts §2.5). review→done is locked
 * `human` in V1 — enforced server-side, not just data. */
export const BOUNDARY_VALUES = ["auto", "approval", "human"] as const;
export type Boundary = (typeof BOUNDARY_VALUES)[number];

/** Agent capability modes (orchestrator ruling 2): forbidden === "human".
 * `off` is the operator-RBAC "don't recommend" mode — the capability is
 * withheld entirely (the tool is not even offered), distinct from `human`
 * (reserved for a human to perform). Added for operator assignment RBAC. */
export const CAPABILITY_MODES = ["direct", "recommend", "human", "off"] as const;
export type CapabilityMode = (typeof CAPABILITY_MODES)[number];

// ------------------------------------------------------------ sub-shapes

export const stageSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** Hex ("#7b61ff") or var(--*) string — both accepted (ruling 15). */
    color: z.string().default("var(--muted)"),
  })
  .loose();
export type StageDef = z.infer<typeof stageSchema>;

export const workflowBoundarySchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    boundary: z.enum(BOUNDARY_VALUES),
    /** Display copy — who moves the task across this boundary. */
    by: z.string().default(""),
    locked: z.boolean().default(false),
  })
  .loose();
export type WorkflowBoundary = z.infer<typeof workflowBoundarySchema>;

export const memberSchema = z
  .object({
    userId: z.string().min(1),
    role: z.preprocess(coerceProjectRole, z.enum(PROJECT_ROLES)),
  })
  .loose();
export type ProjectMember = z.infer<typeof memberSchema>;

export const capabilityGrantSchema = z
  .object({
    /** Id into the shared CAP_CATALOG (app/shared/capabilities.ts). */
    capabilityId: z.string().min(1),
    mode: z.enum(CAPABILITY_MODES),
  })
  .loose();
export type CapabilityGrant = z.infer<typeof capabilityGrantSchema>;

/** Loose per-deployment `definition` override (agents spec §8.1). Every field
 * is optional — the org template value wins when absent. Kept `.loose()` so
 * project-created profiles can carry their full definition here without every
 * field being enumerated. `effort` is the profile's chosen reasoning level,
 * threaded into a run alongside `model`. This is the SINGLE source of truth for
 * the deployment-definition shape — agents-query re-exports the inferred type
 * (no hand-mirrored interface). */
export const agentDeploymentDefinitionSchema = z
  .object({
    kind: z.enum(["operator", "specialist"]).optional(),
    name: z.string().optional(),
    role: z.string().optional(),
    icon: z.string().optional(),
    backends: z.array(z.enum(["codex", "claude"])).optional(),
    model: z.string().optional(),
    /** Reasoning/effort level the run passes to the SDK. */
    effort: z.string().optional(),
    scope: z.string().optional(),
    desc: z.string().optional(),
    /** The profile's long persona/instructions (D6) — the run's system-prompt
     *  material. Distinct from `desc` (the short copy the operator selects
     *  by). Project-created/edited profiles carry it here; org templates carry
     *  it as their markdown body. */
    persona: z.string().optional(),
    stages: z.array(z.string()).optional(),
    spanAll: z.boolean().optional(),
    /** Operator only: default autonomy level (supervised recommends at governed
     *  boundaries; full performs them + may accept completion to Done). */
    autonomy: z.enum(["supervised", "full"]).optional(),
    /** Project-created profiles' bundled resources (org templates carry these
     *  in their own frontmatter; a project deployment override carries them
     *  here). */
    resources: z
      .object({
        skills: z.array(z.string()).optional(),
        mcps: z.array(z.string()).optional(),
        kb: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .loose();
export type AgentDeploymentDefinition = z.infer<
  typeof agentDeploymentDefinitionSchema
>;

/** Per-project deployment of an org-level agent profile template.
 * `capabilities` is the id-based policy; `extras` carries bespoke labels
 * that have no catalog id (near-miss strings kept per contracts §7 #7).
 * `definition` is the optional loose per-field override (project-created
 * profiles carry their full definition here). */
export const agentDeploymentSchema = z
  .object({
    profileId: z.string().min(1),
    capabilities: z.array(capabilityGrantSchema).default([]),
    extras: z
      .array(
        z
          .object({ label: z.string().min(1), mode: z.enum(CAPABILITY_MODES) })
          .loose(),
      )
      .default([]),
    definition: agentDeploymentDefinitionSchema.optional(),
  })
  .loose();
export type AgentDeployment = z.infer<typeof agentDeploymentSchema>;

/** Non-secret credential policy. The PAT itself lives AES-encrypted in
 * SQLite (Phase 7) — never in files. */
export const credentialPolicySchema = z
  .object({
    credentialLabel: z.string().default(""),
    masked: z.string().default(""),
    requiredScopes: z.array(z.string()).default([]),
  })
  .loose();
export type CredentialPolicy = z.infer<typeof credentialPolicySchema>;

export const guardrailSchema = z
  .object({
    id: z.string().min(1),
    desc: z.string().default(""),
    on: z.boolean().default(true),
    value: z.number().optional(),
    unit: z.string().optional(),
  })
  .loose();
export type Guardrail = z.infer<typeof guardrailSchema>;

// -------------------------------------------------------- frontmatter

export const projectFrontmatterSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Archived projects are hidden from the active workspace (restorable by an
   * admin). Absent for active projects — only archived ones carry the key, so
   * it stays optional in the frontmatter type; the tolerant parse fills a
   * concrete `false` on read. */
  archived: z.boolean().optional(),
  /** Project default GitHub repo ("owner/name"); tasks may override. */
  repo: z.string().nullable(),
  defaultBranch: z.string().min(1),
  /** Task key prefix ("VIB" → VIB-142). */
  taskPrefix: z.string().regex(/^[A-Za-z]+$/),
  /** Next task number for the atomic per-project counter. */
  nextTaskNumber: z.number().int().min(1).nullable(),
  stages: z.array(stageSchema),
  workflow: z.array(workflowBoundarySchema),
  members: z.array(memberSchema),
  agents: z.array(agentDeploymentSchema),
  credentialPolicy: credentialPolicySchema.nullable(),
  guardrails: z.array(guardrailSchema),
});
export type ProjectFrontmatter = z.infer<typeof projectFrontmatterSchema>;

export const PROJECT_FRONTMATTER_KEYS: readonly (keyof ProjectFrontmatter)[] = [
  "name",
  "slug",
  "archived",
  "repo",
  "defaultBranch",
  "taskPrefix",
  "nextTaskNumber",
  "stages",
  "workflow",
  "members",
  "agents",
  "credentialPolicy",
  "guardrails",
];

export interface TolerantProjectFrontmatterResult {
  frontmatter: ProjectFrontmatter;
  unknown: Record<string, unknown>;
  diagnostics: FileDiagnostic[];
}

export interface ParsedProjectFile {
  frontmatter: ProjectFrontmatter;
  unknownFrontmatter: Record<string, unknown>;
  /** Markdown body — the project description. */
  description: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tolerant<T>(
  diagnostics: FileDiagnostic[],
  path: string,
  value: unknown,
  schema: z.ZodType<T>,
  fallback: T,
  required = false,
): T {
  if (value === undefined) {
    if (required) {
      diagnostics.push(
        diagWarning(
          "frontmatter.missing_field",
          `Frontmatter field \`${path}\` is missing — using a default.`,
          path,
        ),
      );
    }
    return fallback;
  }
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  diagnostics.push(
    diagWarning(
      "frontmatter.invalid_field",
      `Frontmatter field \`${path}\` is invalid (${result.error.issues[0]?.message ?? "unparseable"}) — using a default.`,
      path,
    ),
  );
  return fallback;
}

/**
 * Per-ENTRY tolerant parse for a list field (F18). The whole-array `tolerant`
 * above dropped an ENTIRE list on one bad row — a single malformed `members[]`
 * entry silently wiped every member's role (ACL integrity), and the same shape
 * applied to stages / workflow / agents. Here we keep every valid entry and drop
 * only the unparseable ones, each with its own indexed diagnostic. Mirrors the
 * per-entry contract the task-file `parseEngagements` already used.
 */
function tolerantArray<T>(
  diagnostics: FileDiagnostic[],
  path: string,
  value: unknown,
  arraySchema: z.ZodArray<z.ZodType<T>>,
  required = false,
): T[] {
  if (value === undefined) {
    if (required) {
      diagnostics.push(
        diagWarning(
          "frontmatter.missing_field",
          `Frontmatter field \`${path}\` is missing — using a default.`,
          path,
        ),
      );
    }
    return [];
  }
  if (!Array.isArray(value)) {
    diagnostics.push(
      diagWarning(
        "frontmatter.invalid_field",
        `Frontmatter field \`${path}\` is not a list — using an empty list.`,
        path,
      ),
    );
    return [];
  }
  const element = arraySchema.element;
  const out: T[] = [];
  value.forEach((entry, i) => {
    const r = element.safeParse(entry);
    if (r.success) {
      out.push(r.data);
    } else {
      diagnostics.push(
        diagWarning(
          "frontmatter.invalid_field",
          `Frontmatter \`${path}[${i}]\` is invalid (${r.error.issues[0]?.message ?? "unparseable"}) — dropping this entry, keeping the rest.`,
          `${path}[${i}]`,
        ),
      );
    }
  });
  return out;
}

function derivePrefix(slug: string): string {
  const letters = slug.replace(/[^a-z]/gi, "");
  return (letters.slice(0, 3) || "TSK").toUpperCase();
}

/**
 * Tolerant project frontmatter parse. `fallbackSlug` (the project directory
 * name) rescues files with a missing/invalid `slug`.
 */
export function parseProjectFrontmatter(
  raw: unknown,
  context: { fallbackSlug?: string } = {},
): TolerantProjectFrontmatterResult {
  const diagnostics: FileDiagnostic[] = [];
  const data: Record<string, unknown> = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) {
    diagnostics.push(
      diagError(
        "frontmatter.not_a_map",
        "Frontmatter is not a YAML mapping — all fields fall back to defaults.",
        undefined,
        true,
      ),
    );
  }

  let slug: string;
  const slugResult = projectFrontmatterSchema.shape.slug.safeParse(data.slug);
  if (slugResult.success) {
    slug = slugResult.data;
    if (context.fallbackSlug && slug !== context.fallbackSlug) {
      diagnostics.push(
        diagError(
          "frontmatter.slug_mismatch",
          `Frontmatter slug \`${slug}\` does not match the project directory \`${context.fallbackSlug}\` — the directory name wins.`,
          "slug",
        ),
      );
      slug = context.fallbackSlug;
    }
  } else if (context.fallbackSlug) {
    slug = context.fallbackSlug;
    diagnostics.push(
      diagWarning(
        "frontmatter.missing_slug",
        `Frontmatter has no valid \`slug\` — inferred \`${slug}\` from the project directory.`,
        "slug",
      ),
    );
  } else {
    slug = "unknown-project";
    diagnostics.push(
      diagError(
        "frontmatter.missing_slug",
        "Frontmatter has no valid `slug` and no directory fallback.",
        "slug",
        true,
      ),
    );
  }

  const frontmatter: ProjectFrontmatter = {
    name: tolerant(
      diagnostics,
      "name",
      data.name,
      projectFrontmatterSchema.shape.name,
      slug,
      true,
    ),
    slug,
    archived: tolerant(
      diagnostics,
      "archived",
      data.archived,
      projectFrontmatterSchema.shape.archived,
      false,
    ),
    repo: tolerant(
      diagnostics,
      "repo",
      data.repo,
      projectFrontmatterSchema.shape.repo,
      null,
    ),
    defaultBranch: tolerant(
      diagnostics,
      "defaultBranch",
      data.defaultBranch,
      projectFrontmatterSchema.shape.defaultBranch,
      "main",
    ),
    taskPrefix: tolerant(
      diagnostics,
      "taskPrefix",
      data.taskPrefix,
      projectFrontmatterSchema.shape.taskPrefix,
      derivePrefix(slug),
    ),
    nextTaskNumber: tolerant(
      diagnostics,
      "nextTaskNumber",
      data.nextTaskNumber,
      projectFrontmatterSchema.shape.nextTaskNumber,
      null,
    ),
    // F18: per-entry — one bad row drops only itself, never the whole list.
    stages: tolerantArray(
      diagnostics,
      "stages",
      data.stages,
      projectFrontmatterSchema.shape.stages,
      true,
    ),
    workflow: tolerantArray(
      diagnostics,
      "workflow",
      data.workflow,
      projectFrontmatterSchema.shape.workflow,
    ),
    members: tolerantArray(
      diagnostics,
      "members",
      data.members,
      projectFrontmatterSchema.shape.members,
    ),
    agents: tolerantArray(
      diagnostics,
      "agents",
      data.agents,
      projectFrontmatterSchema.shape.agents,
    ),
    credentialPolicy: tolerant(
      diagnostics,
      "credentialPolicy",
      data.credentialPolicy,
      projectFrontmatterSchema.shape.credentialPolicy,
      null,
    ),
    guardrails: tolerant(
      diagnostics,
      "guardrails",
      data.guardrails,
      projectFrontmatterSchema.shape.guardrails,
      [],
    ),
  };

  if (frontmatter.stages.length === 0) {
    diagnostics.push(
      diagError(
        "project.no_stages",
        "Project defines no stages — the board cannot render columns.",
        "stages",
      ),
    );
  }

  const unknown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!(PROJECT_FRONTMATTER_KEYS as readonly string[]).includes(k)) {
      unknown[k] = v;
    }
  }

  return { frontmatter, unknown, diagnostics };
}
