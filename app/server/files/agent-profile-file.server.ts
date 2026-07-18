import { z } from "zod";
import {
  diagWarning,
  type FileDiagnostic,
} from "~/schemas/file-diagnostics";
import { CAPABILITY_MODES } from "~/schemas/project-file.schema";
import {
  serializeFrontmatterFile,
  splitFrontmatter,
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

export interface ParsedAgentProfile {
  frontmatter: AgentProfileFrontmatter;
  /** Markdown body — the profile description. */
  description: string;
}

export function parseAgentProfileContent(
  content: string,
  context: { fallbackId?: string } = {},
): { parsed: ParsedAgentProfile | null; diagnostics: FileDiagnostic[] } {
  const diagnostics: FileDiagnostic[] = [];
  const { data, body, diagnostics: fmDiags } = splitFrontmatter(content);
  diagnostics.push(...fmDiags);

  const result = agentProfileFrontmatterSchema.safeParse(
    typeof data === "object" && data !== null
      ? { id: context.fallbackId, ...(data as Record<string, unknown>) }
      : { id: context.fallbackId },
  );
  if (!result.success) {
    diagnostics.push(
      diagWarning(
        "agent_profile.invalid",
        `Agent profile file is invalid (${result.error.issues[0]?.message ?? "unparseable"}).`,
      ),
    );
    return { parsed: null, diagnostics };
  }
  return {
    parsed: { frontmatter: result.data, description: body.trim() },
    diagnostics,
  };
}

export function serializeAgentProfile(parsed: ParsedAgentProfile): string {
  return serializeFrontmatterFile(
    parsed.frontmatter as unknown as Record<string, unknown>,
    {},
    parsed.description,
  );
}
