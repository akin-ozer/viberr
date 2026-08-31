import type { z } from "zod";

/**
 * Diagnostics produced by tolerant file parsing (task.md / project.md /
 * agent profile files). Parsing NEVER throws and NEVER drops an entity:
 * malformed input yields fallback values plus one of these records.
 *
 * Severity semantics (see app/server/interpretation/diagnostics-policy.server.ts
 * for the readiness mapping and user-facing copy):
 *   - info    — worth surfacing, no readiness effect
 *   - warning — suspicious/recoverable → readiness floors at `input_required`
 *   - error   — data integrity in doubt → readiness floors at
 *               `inconsistency_risk_detected`
 *   - hardStop (flag on top of severity) — the file cannot be trusted at all
 *               (unreadable, unparseable frontmatter, unidentifiable key)
 *               → readiness floors at `blocked`
 */

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface FileDiagnostic {
  severity: DiagnosticSeverity;
  /** Stable machine code, dot-separated: "frontmatter.invalid_field", ... */
  code: string;
  /** Field/section path the problem was found at, e.g. "readiness". */
  path?: string;
  /** Human-readable description (shown in the task diagnostics console). */
  message: string;
  /** Floors readiness at `blocked` regardless of severity. */
  hardStop?: boolean;
}

/** Convenience constructors used by the tolerant parsers. */
export function diagInfo(
  code: string,
  message: string,
  path?: string,
): FileDiagnostic {
  const diagnostic: FileDiagnostic = { severity: "info", code, message };
  if (path) diagnostic.path = path;
  return diagnostic;
}

export function diagWarning(
  code: string,
  message: string,
  path?: string,
): FileDiagnostic {
  const diagnostic: FileDiagnostic = { severity: "warning", code, message };
  if (path) diagnostic.path = path;
  return diagnostic;
}

export function diagError(
  code: string,
  message: string,
  path?: string,
  hardStop = false,
): FileDiagnostic {
  const diagnostic: FileDiagnostic = { severity: "error", code, message };
  if (path) diagnostic.path = path;
  if (hardStop) diagnostic.hardStop = true;
  return diagnostic;
}

/**
 * The F18 per-ROW tolerance idiom, once (V17): validate each element of an
 * already-extracted list, keep the good rows, and record one warning per bad
 * row instead of voiding the whole list. Shared by the task/project
 * frontmatter list parsers and the packet-option probe — three hand-rolled
 * copies of this loop had already drifted apart in diagnostic wording and
 * path shape. Callers keep their own container handling (absent field,
 * non-array value): that part differs legitimately per site.
 */
export function tolerantRowsOf<T>(
  diagnostics: FileDiagnostic[],
  rows: readonly unknown[],
  element: z.ZodType<T>,
  code: string,
  describe: (index: number) => { subject: string; noun: string; path: string },
): T[] {
  const out: T[] = [];
  rows.forEach((entry, i) => {
    const r = element.safeParse(entry);
    if (r.success) {
      out.push(r.data);
      return;
    }
    const d = describe(i);
    diagnostics.push(
      diagWarning(
        code,
        `${d.subject} is invalid (${r.error.issues[0]?.message ?? "unparseable"}) — dropping this ${d.noun}, keeping the rest.`,
        d.path,
      ),
    );
  });
  return out;
}
