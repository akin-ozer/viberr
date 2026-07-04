import type { FileDiagnostic } from "~/schemas/file-diagnostics";
import {
  parseProjectFrontmatter,
  type ParsedProjectFile,
} from "~/schemas/project-file.schema";
import {
  serializeFrontmatterFile,
  splitFrontmatter,
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

  const fm = parseProjectFrontmatter(data, context);
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
    parsed.frontmatter as unknown as Record<string, unknown>,
    parsed.unknownFrontmatter,
    parsed.description,
  );
}
