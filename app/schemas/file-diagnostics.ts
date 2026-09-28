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
        `${d.subject} is invalid (${r.error.issues[0]?.message ?? "unparseable"}); dropping this ${d.noun}, keeping the rest.`,
        d.path,
      ),
    );
  });
  return out;
}

/** A frontmatter mapping as the file reader decoded it: keys exactly as
 *  written, every value still undecoded. The schemas' `RawFrontmatter`
 *  (`z.record(z.string(), z.unknown())`), derived from the zod type rather
 *  than a schema value, so this module's zod import stays type-only. */
type FrontmatterFields = z.infer<z.ZodRecord<z.ZodString, z.ZodUnknown>>;

export interface TolerantFieldOptions {
  /** An absent field is diagnosed too; otherwise it reads the fallback in silence. */
  required?: boolean;
  /** The diagnostic's severity; `warning` unless the field says otherwise. */
  severity?: "info" | "warning";
}

/**
 * Ruling 458(h): a field that falls back names the value it fell back to, in
 * `project.md` and `task.md` alike — both read through the helpers below, on
 * the task file's wording ("; using <fallback>.").
 */
function usingFallback<T>(fallback: T): string {
  return `; using ${JSON.stringify(fallback)}.`;
}

/**
 * Runs `schema` over `data[path]`; on failure records a diagnostic and returns
 * `fallback`. Absent (undefined) values only diagnose when `required`. The
 * whole value falls back at once, so a list whose loss would persist reads
 * through {@link tolerantListField} instead.
 */
export function tolerantField<T>(
  diagnostics: FileDiagnostic[],
  data: FrontmatterFields,
  path: string,
  schema: z.ZodType<T>,
  fallback: T,
  options: TolerantFieldOptions = {},
): T {
  const make = options.severity === "info" ? diagInfo : diagWarning;
  const value = data[path];
  if (value === undefined) {
    if (options.required) {
      diagnostics.push(
        make(
          "frontmatter.missing_field",
          `Frontmatter field \`${path}\` is missing${usingFallback(fallback)}`,
          path,
        ),
      );
    }
    return fallback;
  }
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  diagnostics.push(
    make(
      "frontmatter.invalid_field",
      `Frontmatter field \`${path}\` is invalid (${result.error.issues[0]?.message ?? "unparseable"})${usingFallback(fallback)}`,
      path,
    ),
  );
  return fallback;
}

/**
 * Validate a list field ONE ROW AT A TIME, keeping the good rows and dropping
 * only the bad ones with a per-index diagnostic — the F18 contract.
 *
 * The whole-array {@link tolerantField} empties the ENTIRE list on one bad row:
 * a single malformed `members[]` entry silently wiped every member's role (ACL
 * integrity), and the same shape applied to stages / workflow / agents and the
 * task file's engagements. Because the diagnostic is only a warning (not a
 * hardStop) the file stays writable, so the next write serializes the emptied
 * list back over the rows that had been fine — a durable, silent loss. Any
 * list whose loss would persist (verdicts, schedules, engagements, members, …)
 * parses through here. An absent list reads `[]`, diagnosed only when
 * `required`.
 */
export function tolerantListField<T>(
  diagnostics: FileDiagnostic[],
  data: FrontmatterFields,
  path: string,
  element: z.ZodType<T>,
  options: Pick<TolerantFieldOptions, "required"> = {},
): T[] {
  const value = data[path];
  if (value === undefined) {
    if (options.required) {
      diagnostics.push(
        diagWarning(
          "frontmatter.missing_field",
          `Frontmatter field \`${path}\` is missing${usingFallback([])}`,
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
        `Frontmatter field \`${path}\` is not a list; using an empty list.`,
        path,
      ),
    );
    return [];
  }
  return tolerantRowsOf(
    diagnostics,
    value,
    element,
    "frontmatter.invalid_field",
    (i) => ({
      subject: `Frontmatter \`${path}[${i}]\``,
      noun: "entry",
      path: `${path}[${i}]`,
    }),
  );
}

/**
 * The two readers above, held to one file's frontmatter keys. Each schema
 * binds them to its own key union (`const tolerant:
 * TolerantField<keyof ProjectFrontmatter> = tolerantField`), so a misspelt
 * field fails to compile instead of reading `undefined` and falling back in
 * silence — the builders read field by field, and a field read under the wrong
 * name writes fine and reads back as its default.
 */
export type TolerantField<K extends string> = <T>(
  diagnostics: FileDiagnostic[],
  data: FrontmatterFields,
  path: K,
  schema: z.ZodType<T>,
  fallback: T,
  options?: TolerantFieldOptions,
) => T;

export type TolerantListField<K extends string> = <T>(
  diagnostics: FileDiagnostic[],
  data: FrontmatterFields,
  path: K,
  element: z.ZodType<T>,
  options?: Pick<TolerantFieldOptions, "required">,
) => T[];
