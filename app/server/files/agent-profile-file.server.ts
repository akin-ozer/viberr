import { z } from "zod";
import {
  diagWarning,
  type FileDiagnostic,
} from "~/schemas/file-diagnostics";
import { CAPABILITY_MODES } from "~/schemas/project-file.schema";
import {
  serializeFrontmatterFile,
  splitFrontmatter,
  yamlMappingSchema,
} from "./frontmatter.server";

/**
 * Org-level agent profile TEMPLATE files:
 * ${VIBERR_DATA_ROOT}/agents/profiles/<id>.md
 *
 * Two-layer agent model (contracts §3.4 / domain-model §8 Q10):
 *   1. these org templates define the base profile (backends, eligible
 *      stages, capability policy, resources);
 *   2. project.md `agents:` entries DEPLOY a template into a project by
 *      profileId, carrying the project-effective capability policy
 *      ({capabilityId, mode} + extras) which may override the template.
 *
 * The markdown body is the profile description (mock `desc`).
 */

export const agentProfileFrontmatterSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["operator", "specialist"]),
    name: z.string().min(1),
    role: z.string().min(1),
    /** Short scannable description (one paragraph) — what the OPERATOR reads
     * when picking a profile for a task (generic-agents G-selection). Distinct
     * from the markdown body, which is the long persona/instructions. Empty →
     * views fall back to the body's first paragraph. */
    desc: z.string().default(""),
    icon: z.string().default("cpu"),
    backends: z.array(z.enum(["codex", "claude"])).default([]),
    model: z.string().default(""),
    scope: z.string().default(""),
    stages: z.array(z.string()).default([]),
    spanAll: z.boolean().default(false),
    capabilities: z
      .array(
        z
          .object({
            capabilityId: z.string().min(1),
            mode: z.enum(CAPABILITY_MODES),
          })
          .loose(),
      )
      .default([]),
    extras: z
      .array(
        z
          .object({ label: z.string().min(1), mode: z.enum(CAPABILITY_MODES) })
          .loose(),
      )
      .default([]),
    resources: z
      .object({
        skills: z.array(z.string()).default([]),
        mcps: z.array(z.string()).default([]),
        kb: z.array(z.string()).default([]),
      })
      .loose()
      .default({ skills: [], mcps: [], kb: [] }),
  })
  .loose();

export type AgentProfileFrontmatter = z.infer<
  typeof agentProfileFrontmatterSchema
>;

/** Recognized top-level frontmatter keys — anything else is drift (seed #3). */
const AGENT_PROFILE_KNOWN_KEYS = new Set<string>([
  "id",
  "kind",
  "name",
  "role",
  "desc",
  "icon",
  "backends",
  "model",
  "scope",
  "stages",
  "spanAll",
  "capabilities",
  "extras",
  "resources",
]);

export interface ParsedAgentProfile {
  frontmatter: AgentProfileFrontmatter;
  /** Markdown body — the profile description. */
  description: string;
}

export interface AgentProfileParseResult {
  parsed: ParsedAgentProfile | null;
  diagnostics: FileDiagnostic[];
}

export function parseAgentProfileContent(
  content: string,
  context: { fallbackId?: string } = {},
): AgentProfileParseResult {
  const diagnostics: FileDiagnostic[] = [];
  const { data, body, diagnostics: fmDiags } = splitFrontmatter(content);
  diagnostics.push(...fmDiags);

  // Frontmatter that is not a mapping (a scalar, a sequence, an empty block)
  // contributes no fields at all; the schema below then reports the required
  // ones as missing, exactly as it did for a frontmatter-less file.
  const mapping = yamlMappingSchema.safeParse(data);
  const fields = mapping.success ? mapping.data : {};

  const result = agentProfileFrontmatterSchema.safeParse({
    id: context.fallbackId,
    ...fields,
  });
  if (!result.success) {
    diagnostics.push(
      diagWarning(
        "agent_profile.invalid",
        `Agent profile file is invalid (${result.error.issues[0]?.message ?? "unparseable"}).`,
      ),
    );
    return { parsed: null, diagnostics };
  }
  // Drift detection (seed #3): the schema is `.loose()`, so an unknown top-level
  // key (e.g. a field renamed in code but not in a hand-edited/seeded file) is
  // preserved but otherwise SILENT — the exact drift the task/project files guard
  // against. Surface it as a warning so a stale profile is diagnosable (and a
  // fixture guard can assert zero unknowns on the shipped profiles).
  const unknown = Object.keys(fields).filter(
    (k) => !AGENT_PROFILE_KNOWN_KEYS.has(k),
  );
  if (unknown.length > 0) {
    diagnostics.push(
      diagWarning(
        "agent_profile.unknown_field",
        `Agent profile has unrecognized frontmatter field(s): ${unknown.join(", ")}. This usually means the file drifted from the current schema.`,
      ),
    );
  }
  return {
    parsed: { frontmatter: result.data, description: body.trim() },
    diagnostics,
  };
}

export function serializeAgentProfile(parsed: ParsedAgentProfile): string {
  return serializeFrontmatterFile(parsed.frontmatter, {}, parsed.description);
}
