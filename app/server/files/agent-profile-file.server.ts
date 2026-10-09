import { existsSync, readFileSync } from "node:fs";
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
import { parseStoreFile } from "./parse-memo.server";

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

const agentProfileFrontmatterSchema = z
  .object({
    id: z.string().min(1),
    // "controller" is the instance-level conversational agent (one per
    // instance, ruling 247). It is machinery like the operator: never deployed
    // into a project's `agents:` list, resolved by kind from the template file.
    kind: z.enum(["operator", "specialist", "controller"]),
    name: z.string().min(1),
    /** What the profile does, shown under its name. Every kind but the operator
     *  requires one (the refinement below). The operator has none (ruling
     *  176): it is one agent, called Operator. */
    role: z.string().min(1).optional(),
    /** Short scannable description (one paragraph) — what the OPERATOR reads
     * when picking a profile for a task (generic-agents G-selection). Distinct
     * from the markdown body, which is the long persona/instructions. Empty →
     * views fall back to the body's first paragraph. */
    desc: z.string().default(""),
    icon: z.string().default("cpu"),
    backends: z.array(z.enum(["codex", "claude"])).default([]),
    model: z.string().default(""),
    /** Reasoning effort. Only the controller profile is edited through this key
     *  today (ruling 270) — deployed specialists carry model+effort on their
     *  project.md `agents:` entry, not the template — but the key is schema
     *  level so carrying it is never "drift". Absent = the backend default.
     *  TOLERANT like the pre-schema decoder it replaced: a hand-edited
     *  non-string value (`effort:` blank = YAML null, `effort: 3`) reads as
     *  absent rather than failing the WHOLE profile parse — a strict field
     *  here bricked the controller config ("profile missing from the store")
     *  over one junk line, with no in-app repair path (review D2). */
    effort: z.string().optional().catch(undefined),
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
  .loose()
  .superRefine((fm, ctx) => {
    if (fm.kind !== "operator" && fm.role === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["role"],
        message: `a ${fm.kind} profile needs a role`,
      });
    }
  });

export type AgentProfileFrontmatter = z.infer<
  typeof agentProfileFrontmatterSchema
>;

/** Recognized top-level frontmatter keys — anything else is drift (seed #3). */
export const AGENT_PROFILE_KNOWN_KEYS = new Set<string>([
  "id",
  "kind",
  "name",
  "role",
  "desc",
  "icon",
  "backends",
  "model",
  "effort",
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
  // Ruling 176: the operator has no role, so a `role` on its file (a hand-edited
  // copy from before the ruling) is drift too, and it is dropped here so no
  // reader can show it.
  const frontmatter = { ...result.data };
  const unknown = Object.keys(fields).filter(
    (k) =>
      !AGENT_PROFILE_KNOWN_KEYS.has(k) ||
      (k === "role" && frontmatter.kind === "operator"),
  );
  if (frontmatter.kind === "operator") delete frontmatter.role;
  if (unknown.length > 0) {
    diagnostics.push(
      diagWarning(
        "agent_profile.unknown_field",
        `Agent profile has unrecognized frontmatter field(s): ${unknown.join(", ")}. This usually means the file drifted from the current schema.`,
      ),
    );
  }
  return {
    parsed: { frontmatter, description: body.trim() },
    diagnostics,
  };
}

export interface AgentProfileReadResult extends AgentProfileParseResult {
  content: string;
}

/** Reads + parses one profile file; null when it is absent. The parse goes
 *  through the store readers' parse memo (ruling 21). */
export function readAgentProfileFile(
  absPath: string,
  fallbackId: string,
): AgentProfileReadResult | null {
  if (!existsSync(absPath)) return null;
  const content = readFileSync(absPath, "utf8");
  const { parsed, diagnostics } = parseStoreFile(
    "agent-profile",
    absPath,
    fallbackId,
    content,
    (c) => parseAgentProfileContent(c, { fallbackId }),
  );
  return { parsed, diagnostics, content };
}

export function serializeAgentProfile(parsed: ParsedAgentProfile): string {
  return serializeFrontmatterFile(parsed.frontmatter, {}, parsed.description);
}
