import { z } from "zod";
import { REPO_SLUG_RE } from "~/shared/repo-ref";
import { stageColorSchema } from "~/shared/workflow/stage-colors";
import {
  diagError,
  diagWarning,
  tolerantField,
  tolerantListField,
  type FileDiagnostic,
  type TolerantField,
  type TolerantListField,
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

/** Agent capability modes (ruling 26(a)): forbidden === "human".
 * `off` is the operator-RBAC "don't recommend" mode — the capability is
 * withheld entirely (the tool is not even offered), distinct from `human`
 * (reserved for a human to perform). Added for operator assignment RBAC. */
export const CAPABILITY_MODES = ["direct", "recommend", "human", "off"] as const;
export type CapabilityMode = (typeof CAPABILITY_MODES)[number];

// ------------------------------------------------------------ sub-shapes

const stageSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** One of the twenty named presets (ruling 279); absent reads as slate. */
    color: stageColorSchema.default("slate"),
  })
  .loose();
export type StageDef = z.infer<typeof stageSchema>;

const workflowBoundarySchema = z
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

const memberSchema = z
  .object({
    userId: z.string().min(1),
    role: z.enum(PROJECT_ROLES),
  })
  .loose();

const capabilityGrantSchema = z
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
const agentDeploymentDefinitionSchema = z
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
const agentDeploymentSchema = z
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
const credentialPolicySchema = z
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

/**
 * Ruling 89 (pass 36, G36-3): one project-level REQUIRED-reviewer rule —
 * "profile X reviews at stage Y". Before this rule, required-ness was emergent:
 * a reviewer was required on a task only once the operator engaged it there,
 * so a task whose operator never engaged the reviewer was acceptable with no
 * verdict at all. The acceptance gate, the review queue, the operator snapshot
 * and the controller all read this list; `stageId` names where the review is
 * run (a non-terminal stage), `profileId` a deployed verdict-capable
 * specialist. Both are checked by the writers (Settings, the controller tool);
 * the parser keeps whatever the file says so a stale id is visible, never
 * silently dropped.
 */
const requiredReviewerSchema = z
  .object({
    stageId: z.string().min(1),
    profileId: z.string().min(1),
  })
  .loose();
export type RequiredReviewerRule = z.infer<typeof requiredReviewerSchema>;

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
 * and the admin toggle gated nothing). Ruling 225: the parse below holds it
 * to `REPO_SLUG_RE`, so no reader builds a checkout path from anything else. */
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
          `Frontmatter \`${path}[${i}].capabilities[${j}]\` is invalid (${parsed.error.issues[0]?.message ?? "unparseable"}); dropping this grant, keeping the deployment.`,
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
const requiredReviewersSchema = z.array(requiredReviewerSchema);

/**
 * Ruling 60: the lease rows, named so the tolerant parser can reach
 * `.element` — the same shape `requiredReviewersSchema` is extracted for.
 */
const fileLeasesSchema = z.array(
  z
    .object({
      paths: z.array(z.string().min(1)).min(1),
      taskKey: z.string().min(1),
      reason: z.string().default(""),
    })
    .loose(),
);

/** The stored lease row, `.loose()` like every other frontmatter row so a
 *  later version's keys survive a read/write cycle. */
export type FileLeaseRow = z.infer<typeof fileLeasesSchema>[number];

/**
 * Ruling 17 (pass 40, F40-52): the project's GATES — commands Viberr itself
 * runs in a checkout of every delivered revision, as the task owner's agent
 * uid, recording each exit code, wall time and log on the task
 * (`app/server/tasks/project-gates.server.ts`). Before this the gate list was
 * prose in a knowledge base, restated in every directive, and the person who
 * accepted a production merge read an agent's claim that the gates passed.
 *
 * The limits are the writer's (Settings, the controller's
 * `set_project_gates`): a parse keeps whatever the file says, row by row.
 */
export const PROJECT_GATES_MAX = 10;
export const GATE_NAME_MAX_CHARS = 40;
export const GATE_COMMAND_MAX_CHARS = 2000;
/** A gate with no `timeoutSeconds` is killed after this many seconds. */
export const GATE_DEFAULT_TIMEOUT_SECONDS = 600;
export const GATE_MAX_TIMEOUT_SECONDS = 3600;

const projectGateSchema = z
  .object({
    /** Short and unique within the project ("install", "build"). */
    name: z.string().min(1),
    /** Run with `sh -c` in the checkout's root. */
    command: z.string().min(1),
    timeoutSeconds: z.number().int().min(1).max(GATE_MAX_TIMEOUT_SECONDS).optional(),
  })
  .loose();
export type ProjectGate = z.infer<typeof projectGateSchema>;
const projectGatesSchema = z.array(projectGateSchema);

const projectFrontmatterSchema = z.object({
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
  requiredReviewers: requiredReviewersSchema,
  /**
   * Ruling 208(a) (pass 37): the project's RULINGS knowledge base, by store
   * directory, or null when the project has not named one.
   *
   * Unlike `agents[].resources.kb`, which is a per-profile grant a controller
   * can forget on the one profile that needed it, this KB reaches EVERY agent
   * on the project — deliverer, reviewer and operator alike — and the
   * controller itself while it is scoped to the project. It is the channel for
   * a rule the project has settled, so the next task does not re-litigate it.
   *
   * `nullish().catch(null)` for the same reason every other late field uses it:
   * a project.md written before this existed parses unchanged.
   */
  rulingsKb: z.string().nullish().catch(null),
  /**
   * Ruling 60 (pass 37, F37-74): per-file LEASES — which task owns a shared
   * path until it merges.
   *
   * `blockedBy` says "do not START until done" and is the only ordering
   * primitive the product had, so "both may proceed, this one owns
   * `pnpm-lock.yaml` until it lands" was unsayable and lived in prose that every
   * agent re-derived. Live on this pass that cost two decision packets in one
   * evening and a human decision that could not take effect.
   *
   * Empty on every project that declares none, and `catch([])` for the same
   * reason the field above uses its own catch: a project.md written before this
   * existed parses unchanged.
   */
  fileLeases: fileLeasesSchema.default([]).catch([]),
  /**
   * Ruling 17: the commands Viberr runs on every delivered revision. Absent
   * (not `[]`) on a project that declares none, so a project.md written
   * before this existed is not rewritten with an empty key.
   */
  gates: projectGatesSchema.optional(),
});
export type ProjectFrontmatter = z.infer<typeof projectFrontmatterSchema>;

const PROJECT_FRONTMATTER_KEYS: readonly (keyof ProjectFrontmatter)[] = [
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
  "requiredReviewers",
  "rulingsKb",
  "fileLeases",
  "gates",
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

/** The shared tolerant readers (`file-diagnostics.ts`), held to this file's
 *  keys: `tolerant` falls a whole field back, `tolerantRows` keeps a list's
 *  good rows (the F18 contract). */
const tolerant: TolerantField<keyof ProjectFrontmatter> = tolerantField;
const tolerantRows: TolerantListField<keyof ProjectFrontmatter> = tolerantListField;

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
          `Frontmatter slug \`${slug}\` does not match the project directory \`${context.fallbackSlug}\`. The directory name wins.`,
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
        `Frontmatter has no valid \`slug\`; inferred \`${slug}\` from the project directory.`,
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
    name: tolerant(diagnostics, data, "name", projectNameSchema, slug, {
      required: true,
    }),
    slug,
    archived: tolerant(diagnostics, data, "archived", archivedSchema, false),
    // Ruling 225: a repository outside the pattern reads as none (ruling
    // 224's project with no repository), and as an error, so `store:check`
    // lists the project among the degraded files and names the field. The
    // pattern is applied here, not on `repoSchema`: the browser loads this
    // module for its constants, and only the server parses project.md.
    repo: tolerant(
      diagnostics,
      data,
      "repo",
      repoSchema.refine(
        (repo) => repo === null || REPO_SLUG_RE.test(repo),
        "not a GitHub owner/name, so the project reads as having no repository",
      ),
      null,
      { severity: "error" },
    ),
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
    stages: tolerantRows(diagnostics, data, "stages", stagesSchema.element, {
      required: true,
    }),
    workflow: tolerantRows(diagnostics, data, "workflow", workflowSchema.element),
    members: tolerantRows(diagnostics, data, "members", membersSchema.element),
    agents: tolerantRows(
      diagnostics,
      { ...data, agents: cleanAgentGrants(diagnostics, data, "agents") },
      "agents",
      agentsSchema.element,
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
    guardrails: tolerantRows(diagnostics, data, "guardrails", guardrailsSchema.element),
    // Ruling 17: per row for the same reason — an emptied list reads as "no
    // required reviewer", which silently reopens the acceptance gate.
    requiredReviewers: tolerantRows(
      diagnostics,
      data,
      "requiredReviewers",
      requiredReviewersSchema.element,
    ),
    // Ruling 208(a): the project's rulings KB. `tolerant` with a null fallback,
    // like `credentialPolicy` — a garbled value must read as "no rulings KB"
    // rather than failing the whole project parse, and a project.md written
    // before this field existed has none.
    rulingsKb: tolerant(diagnostics, data, "rulingsKb", z.string().nullish(), null) ?? null,
    // Per-ROW, like every other list this parser reads: one malformed lease must
    // not drop the others, because a dropped lease silently unblocks a delivery
    // that a person deliberately fenced off. The field-by-field build is why
    // this line has to exist at all — `rulingsKb` shipped without it earlier in
    // this same pass and wrote fine while reading back undefined.
    fileLeases: tolerantRows(diagnostics, data, "fileLeases", fileLeasesSchema.element),
  };
  // Ruling 17: per ROW, because a dropped gate silently stops being run and
  // stops blocking. Absent stays absent: only a project that declared gates
  // carries the key.
  if (data.gates !== undefined) {
    frontmatter.gates = tolerantRows(diagnostics, data, "gates", projectGatesSchema.element);
  }

  if (frontmatter.stages.length === 0) {
    diagnostics.push(
      diagError(
        "project.no_stages",
        "Project defines no stages; the board cannot render columns.",
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
