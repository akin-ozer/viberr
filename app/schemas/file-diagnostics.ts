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
  return { severity: "info", code, message, ...(path ? { path } : {}) };
}

export function diagWarning(
  code: string,
  message: string,
  path?: string,
): FileDiagnostic {
  return { severity: "warning", code, message, ...(path ? { path } : {}) };
}

export function diagError(
  code: string,
  message: string,
  path?: string,
  hardStop = false,
): FileDiagnostic {
  return {
    severity: "error",
    code,
    message,
    ...(path ? { path } : {}),
    ...(hardStop ? { hardStop: true } : {}),
  };
}
