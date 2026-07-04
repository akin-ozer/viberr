import type {
  DiagnosticSeverity,
  FileDiagnostic,
} from "~/schemas/file-diagnostics";
import type { Readiness } from "~/schemas/task-file.schema";

/**
 * Severity model for parse/reference diagnostics — maps every diagnostic to
 * a readiness effect and user-facing framing (consumed by
 * readiness-policy.server.ts, the diagnostics table, and later the task
 * diagnostics console).
 *
 *   info     → no readiness effect            "Heads-up"
 *   warning  → floor `input_required`         "Needs input"
 *   error    → floor `inconsistency_risk_detected`  "Inconsistency risk"
 *   hardStop → floor `blocked`                "Blocked — file not trusted"
 *
 * Readiness only ever gets WORSE from diagnostics, never better; the stored
 * readiness is respected otherwise (see readiness-policy).
 */

/** Severity order for "worst wins" comparisons. */
export const READINESS_RANK: Record<Readiness, number> = {
  ready: 0,
  input_required: 1,
  inconsistency_risk_detected: 2,
  blocked: 3,
};

/** Readiness floor imposed by a single diagnostic. Null = no effect. */
export function readinessEffectOf(diag: FileDiagnostic): Readiness | null {
  if (diag.hardStop) return "blocked";
  switch (diag.severity) {
    case "error":
      return "inconsistency_risk_detected";
    case "warning":
      return "input_required";
    default:
      return null;
  }
}

/** Worst readiness floor across a diagnostic set. Null = no effect. */
export function worstReadinessEffect(
  diagnostics: FileDiagnostic[],
): Readiness | null {
  let worst: Readiness | null = null;
  for (const diag of diagnostics) {
    const effect = readinessEffectOf(diag);
    if (effect && (!worst || READINESS_RANK[effect] > READINESS_RANK[worst])) {
      worst = effect;
    }
  }
  return worst;
}

/** User-facing severity framing (diagnostics console copy). */
export const SEVERITY_COPY: Record<
  DiagnosticSeverity,
  { label: string; blurb: string }
> = {
  info: {
    label: "Heads-up",
    blurb: "Noted while reading the file — no effect on readiness.",
  },
  warning: {
    label: "Needs input",
    blurb:
      "The file could be read, but something is off — readiness is held at input required until it's fixed.",
  },
  error: {
    label: "Inconsistency risk",
    blurb:
      "The canonical file disagrees with itself or with the project — readiness is held at inconsistency risk.",
  },
};

export const HARD_STOP_COPY = {
  label: "Blocked",
  blurb:
    "The file could not be trusted at all — the task is blocked until the file is repaired.",
} as const;

/**
 * Reference checks that need project context (not just the file):
 * currently the stage reference. Returns extra diagnostics.
 */
export function referenceDiagnostics(input: {
  stage: string;
  knownStageIds: string[];
}): FileDiagnostic[] {
  const diagnostics: FileDiagnostic[] = [];
  if (
    input.knownStageIds.length > 0 &&
    !input.knownStageIds.includes(input.stage)
  ) {
    diagnostics.push({
      severity: "warning",
      code: "reference.unknown_stage",
      path: "stage",
      message: `Stage \`${input.stage}\` is not in the project's stage list (${input.knownStageIds.join(", ")}).`,
    });
  }
  return diagnostics;
}
