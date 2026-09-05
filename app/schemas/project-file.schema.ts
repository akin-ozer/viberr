import { z } from "zod";
import {
  diagError,
  diagWarning,
  tolerantRowsOf,
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
    role: z.enum(PROJECT_ROLES),
  })
  .loose();

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

/* Each frontmatter field gets its own named schema. The tolerant parse below
 * validates one field at a time, so it needs the individual validators —
 * naming them keeps `projectFrontmatterSchema` the single composition of the
 * same instances rather than a second definition to drift from. */

const projectNameSchema = z.string().min(1);
const projectSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
/** Archived projects are hidden from the active workspace (restorable by an
 * admin). Absent for active projects — only archived ones carry the key, so
 * it stays optional in the frontmatter type; the tolerant parse fills a
 * concrete `false` on read. */
const archivedSchema = z.boolean().optional();
/** The project's GitHub repo ("owner/name"). One project, one repository —
 * P13-D-5 deleted the task-level override (nothing ever wrote `task.repo`
 * and the admin toggle gated nothing). */
const repoSchema = z.string().nullable();
const defaultBranchSchema = z.string().min(1);
/** Task key prefix ("VIB" → VIB-142). */
const taskPrefixSchema = z.string().regex(/^[A-Za-z]+$/);
/** Next task number for the atomic per-project counter. */
const nextTaskNumberSchema = z.number().int().min(1).nullable();
const stagesSchema = z.array(stageSchema);
const workflowSchema = z.array(workflowBoundarySchema);
const membersSchema = z.array(memberSchema);
const agentsSchema = z.array(agentDeploymentSchema);

/** Just enough of a raw deployment row to reach its grant list, decoded rather
 *  than type-guarded (the rest of the row is passed through untouched). */
const rawDeploymentSchema = z
  .object({ capabilities: z.array(z.unknown()).optional() })
  .loose();

/**
 * `agents` is parsed per ROW like every other frontmatter list, but each row's
 * `capabilities` was a plain `z.array(capabilityGrantSchema)` — so ONE
 * malformed grant failed the whole deployment, and the per-row tolerance then
 * dropped the entire agent: its other grants, its extras, its definition. The
 * next project write serialized that loss, which is exactly the whole-array
 * fallback the tolerant-parse rule exists to forbid (F31-C5 fixed the same
 * shape for packet options).
 *
 * Split the grants per row here, with a diagnostic naming each one dropped, so
 * a bad grant costs its own line and nothing else. A grant is authority, so
 * dropping one is also the fail-closed direction — but never silently.
 */
function cleanAgentGrants(
  diagnostics: FileDiagnostic[],
  data: RawFrontmatter,
  path: string,
): RawFrontmatter[string] {
  const rows = data[path];
  if (!Array.isArray(rows)) return rows;
  return rows.map((row, i) => {
    const decoded = rawDeploymentSchema.safeParse(row);
    if (!decoded.success || decoded.data.capabilities === undefined) return row;
    const kept = decoded.data.capabilities.filter((grant, j) => {
      const parsed = capabilityGrantSchema.safeParse(grant);
      if (parsed.success) return true;
      diagnostics.push(
        diagWarning(
          "frontmatter.invalid_field",
          `Frontmatter \`${path}[${i}].capabilities[${j}]\` is invalid (${parsed.error.issues[0]?.message ?? "unparseable"}) — dropping this grant, keeping the deployment.`,
          `${path}[${i}].capabilities[${j}]`,
        ),
      );
      return false;
    });
    return { ...decoded.data, capabilities: kept };
  });
}
const projectCredentialPolicySchema = credentialPolicySchema.nullable();
const guardrailsSchema = z.array(guardrailSchema);

export const projectFrontmatterSchema = z.object({
  name: projectNameSchema,
  slug: projectSlugSchema,
  archived: archivedSchema,
  repo: repoSchema,
  defaultBranch: defaultBranchSchema,
  taskPrefix: taskPrefixSchema,
  nextTaskNumber: nextTaskNumberSchema,
  stages: stagesSchema,
  workflow: workflowSchema,
  members: membersSchema,
  agents: agentsSchema,
  credentialPolicy: projectCredentialPolicySchema,
  guardrails: guardrailsSchema,
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

/** Widened to `string` so the raw-key scan below can test membership without
 * asserting a YAML key into `keyof ProjectFrontmatter`. */
const PROJECT_FRONTMATTER_KEY_SET = new Set<string>(PROJECT_FRONTMATTER_KEYS);

/** The frontmatter mapping as YAML handed it over: keys exactly as written,
 * every value still undecoded (the field schemas above do the decoding, one
 * field at a time). This is also the contract for the leftover keys the writer
 * round-trips back into the file verbatim — those are never parsed at all, so
 * their values stay whatever YAML produced. */
const rawFrontmatterSchema = z.record(z.string(), z.unknown());
export type RawFrontmatter = z.infer<typeof rawFrontmatterSchema>;

export interface TolerantProjectFrontmatterResult {
  frontmatter: ProjectFrontmatter;
  unknown: RawFrontmatter;
  diagnostics: FileDiagnostic[];
}

export interface ParsedProjectFile {
  frontmatter: ProjectFrontmatter;
  unknownFrontmatter: RawFrontmatter;
  /** Markdown body — the project description. */
  description: string;
}

function tolerant<T>(
  diagnostics: FileDiagnostic[],
  data: RawFrontmatter,
  path: keyof ProjectFrontmatter,
  schema: z.ZodType<T>,
  fallback: T,
  required = false,
): T {
  const value = data[path];
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
  data: RawFrontmatter,
  path: keyof ProjectFrontmatter,
  arraySchema: z.ZodArray<z.ZodType<T>>,
  required = false,
): T[] {
  const value = data[path];
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
  return tolerantRowsOf(
    diagnostics,
    value,
    arraySchema.element,
    "frontmatter.invalid_field",
    (i) => ({
      subject: `Frontmatter \`${path}[${i}]\``,
      noun: "entry",
      path: `${path}[${i}]`,
    }),
  );
}

function derivePrefix(slug: string): string {
  const letters = slug.replace(/[^a-z]/gi, "");
  return (letters.slice(0, 3) || "TSK").toUpperCase();
}

/**
 * Tolerant project frontmatter parse. `data` is the frontmatter mapping the
 * reader decoded off disk — a file whose frontmatter is not a mapping arrives
 * here empty, so every field falls back to its default. `fallbackSlug` (the
 * project directory name) rescues files with a missing/invalid `slug`.
 */
export function parseProjectFrontmatter(
  data: RawFrontmatter,
  context: { fallbackSlug?: string } = {},
): TolerantProjectFrontmatterResult {
  const diagnostics: FileDiagnostic[] = [];

  let slug: string;
  const slugResult = projectSlugSchema.safeParse(data.slug);
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
    name: tolerant(diagnostics, data, "name", projectNameSchema, slug, true),
    slug,
    archived: tolerant(diagnostics, data, "archived", archivedSchema, false),
    repo: tolerant(diagnostics, data, "repo", repoSchema, null),
    defaultBranch: tolerant(
      diagnostics,
      data,
      "defaultBranch",
      defaultBranchSchema,
      "main",
    ),
    taskPrefix: tolerant(
      diagnostics,
      data,
      "taskPrefix",
      taskPrefixSchema,
      derivePrefix(slug),
    ),
    nextTaskNumber: tolerant(
      diagnostics,
      data,
      "nextTaskNumber",
      nextTaskNumberSchema,
      null,
    ),
    // F18: per-entry — one bad row drops only itself, never the whole list.
    stages: tolerantArray(diagnostics, data, "stages", stagesSchema, true),
    workflow: tolerantArray(diagnostics, data, "workflow", workflowSchema),
    members: tolerantArray(diagnostics, data, "members", membersSchema),
    agents: tolerantArray(
      diagnostics,
      { ...data, agents: cleanAgentGrants(diagnostics, data, "agents") },
      "agents",
      agentsSchema,
    ),
    credentialPolicy: tolerant(
      diagnostics,
      data,
      "credentialPolicy",
      projectCredentialPolicySchema,
      null,
    ),
    // Per-entry too, for the same F18 reason as the four above: on the
    // whole-array path one bad row emptied the WHOLE list, which reads to
    // every consumer as "nothing configured" — every anti-noise guardrail off,
    // and an explicitly disabled `delete-branch-after-merge` flipped back to
    // its ON default. The next project write then persisted the empty list.
    guardrails: tolerantArray(diagnostics, data, "guardrails", guardrailsSchema),
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

  const unknown: RawFrontmatter = {};
  for (const [k, v] of Object.entries(data)) {
    if (!PROJECT_FRONTMATTER_KEY_SET.has(k)) {
      unknown[k] = v;
    }
  }

  return { frontmatter, unknown, diagnostics };
}
