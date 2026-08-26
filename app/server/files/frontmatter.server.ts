import YAML from "yaml";
import { z } from "zod";
import {
  diagError,
  type FileDiagnostic,
} from "~/schemas/file-diagnostics";

/**
 * Frontmatter split/parse/serialize for the markdown file store.
 * `---` fences on their own lines; YAML in between; markdown body after.
 * Tolerant: a missing or unparseable frontmatter block yields diagnostics
 * and an empty mapping — never a throw.
 */

/** A YAML mapping as this store reads and writes one: keys exactly as
 * written, values still undecoded (the file schemas decode them field by
 * field, and the keys they do not know are round-tripped verbatim). */
export const yamlMappingSchema = z.record(z.string(), z.unknown());
export type YamlMapping = z.infer<typeof yamlMappingSchema>;

export interface FrontmatterSplit {
  /** Parsed YAML value (unknown — validate with the file schemas). */
  data: unknown;
  /** Raw body after the closing fence (leading newline trimmed). */
  body: string;
  diagnostics: FileDiagnostic[];
}

const FENCE = "---";

export function splitFrontmatter(content: string): FrontmatterSplit {
  const diagnostics: FileDiagnostic[] = [];
  // Normalize BOM and line endings (CRLF / lone CR → LF). The data root lives
  // OUTSIDE git, so a file touched by a Windows editor or `git core.autocrlf`
  // is never re-normalized. F28-D2: without this a leading `---\r\n` failed the
  // opening-fence check, so the ENTIRE file (frontmatter + task.md Goal /
  // Timeline body sections, which also split on `\n`) fell back to defaults —
  // and the rebuilder projected that broken state (the write-guard's hardStop
  // only refuses WRITES, never the read/projection path). The closing-fence
  // search was already CRLF-tolerant, which is why this was an unconsidered
  // asymmetry, not a deliberate LF-only contract.
  const text = (
    content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  ).replace(/\r\n?/g, "\n");

  if (!text.startsWith(`${FENCE}\n`) && text !== FENCE) {
    diagnostics.push(
      diagError(
        "frontmatter.missing",
        "File has no frontmatter block (`---` fences) — all fields fall back to defaults.",
        undefined,
        true,
      ),
    );
    return { data: {}, body: text, diagnostics };
  }

  const closeIdx = text.indexOf(`\n${FENCE}`, FENCE.length);
  if (closeIdx === -1) {
    diagnostics.push(
      diagError(
        "frontmatter.unterminated",
        "Frontmatter block is not terminated by a closing `---` fence.",
        undefined,
        true,
      ),
    );
    return { data: {}, body: "", diagnostics };
  }

  const yamlText = text.slice(FENCE.length + 1, closeIdx);
  const afterFence = text.slice(closeIdx + 1 + FENCE.length);
  const body = afterFence.startsWith("\n") ? afterFence.slice(1) : afterFence;

  try {
    return { data: YAML.parse(yamlText) ?? {}, body, diagnostics };
  } catch (error) {
    diagnostics.push(
      diagError(
        "frontmatter.invalid_yaml",
        `Frontmatter YAML is unparseable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        undefined,
        true,
      ),
    );
    return { data: {}, body, diagnostics };
  }
}

/** Stable YAML serialization: no line folding (round-trip friendly). */
export function toYaml(value: YamlMapping): string {
  return YAML.stringify(value, { lineWidth: 0 });
}

/**
 * Composes a full markdown file: known fields (in canonical order) merged
 * with preserved unknown fields, then the body.
 */
export function serializeFrontmatterFile(
  known: YamlMapping,
  unknown: YamlMapping,
  body: string,
): string {
  const merged: YamlMapping = { ...known };
  for (const [k, v] of Object.entries(unknown)) {
    if (!(k in merged)) merged[k] = v;
  }
  const yamlText = toYaml(merged).trimEnd();
  const trimmedBody = body.replace(/\s+$/, "");
  return `${FENCE}\n${yamlText}\n${FENCE}\n\n${trimmedBody}\n`;
}
