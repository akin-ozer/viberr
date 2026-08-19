import { diagError, type FileDiagnostic } from "~/schemas/file-diagnostics";
import {
  parseProjectFrontmatter,
  type ParsedProjectFile,
} from "~/schemas/project-file.schema";
import {
  serializeFrontmatterFile,
  splitFrontmatter,
  yamlMappingSchema,
} from "./frontmatter.server";

/**
 * project.md parse/serialize (canonical format —
 * docs/architecture/file-formats.md). Frontmatter carries all governed
 * project state (stages, workflow boundaries, members, agent capability
 * policy, credential policy, guardrails); the markdown body is the
 * human-readable project description.
 */

export interface ProjectFileParseResult {
  parsed: ParsedProjectFile;
  diagnostics: FileDiagnostic[];
}

export function parseProjectFileContent(
  content: string,
  context: { fallbackSlug?: string } = {},
): ProjectFileParseResult {
  const diagnostics: FileDiagnostic[] = [];
  const { data, body, diagnostics: fmDiags } = splitFrontmatter(content);
  diagnostics.push(...fmDiags);

  // Frontmatter that is not a mapping (a scalar, a sequence) contributes no
  // fields at all; the schema below then falls every field back to its default.
  const mapping = yamlMappingSchema.safeParse(data);
  if (!mapping.success) {
    diagnostics.push(
      diagError(
        "frontmatter.not_a_map",
        "Frontmatter is not a YAML mapping — all fields fall back to defaults.",
        undefined,
        true,
      ),
    );
  }

  const fm = parseProjectFrontmatter(
    mapping.success ? mapping.data : {},
    context,
  );
  diagnostics.push(...fm.diagnostics);

  return {
    parsed: {
      frontmatter: fm.frontmatter,
      unknownFrontmatter: fm.unknown,
      description: body.trim(),
    },
    diagnostics,
  };
}

export function serializeProjectFile(parsed: ParsedProjectFile): string {
  return serializeFrontmatterFile(
    parsed.frontmatter,
    parsed.unknownFrontmatter,
    parsed.description,
  );
}
