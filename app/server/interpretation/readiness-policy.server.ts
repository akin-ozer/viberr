import type { FileDiagnostic } from "~/schemas/file-diagnostics";
import type { Readiness } from "~/schemas/task-file.schema";
import {
  READINESS_RANK,
  worstReadinessEffect,
} from "./diagnostics-policy.server";

/**
 * THE readiness derivation — the only place readiness is derived
 * (docs/architecture/decisions.md: "Derivation lives ONLY in
 * app/server/interpretation/readiness-policy.server.ts").
 *
 * Rules (orchestrator ruling 1 + phase brief):
 * - The file's STORED readiness is respected unless derivation must
 *   downgrade (worsen) it:
 *     · parse diagnostics — warning → floor `input_required`,
 *       error → floor `inconsistency_risk_detected` (severity mapping in
 *       diagnostics-policy.server.ts);
 *     · hard stops (unreadable/untrusted file) → floor `blocked`.
 * - Derivation never IMPROVES readiness: a stored `blocked` stays blocked
 *   even with a clean parse.
 * - "accepted" is a DISPLAY state derived from the stage being the
 *   project's done stage — it is never stored and never returned here
 *   (the mapping layer adds it; ReadinessPill translates it to the mock's
 *   `done` pill kind).
 */

export interface ReadinessDerivation {
  readiness: Readiness;
  /** True when a floor forced a worse value than the stored one. */
  downgraded: boolean;
  /** The floor imposed by diagnostics, when any. */
  diagnosticsFloor: Readiness | null;
  /** Ruling 131: the floor imposed by a non-empty `blockedBy` list (`blocked`),
   *  or null when the task waits on nothing. */
  dependencyFloor: Readiness | null;
}

export function deriveReadiness(input: {
  /** Parsed stored readiness; null when missing/invalid in the file. */
  storedReadiness: Readiness | null;
  diagnostics: FileDiagnostic[];
  /** Ruling 131 (pass 34): the task's `blockedBy` list is non-empty. While it
   *  is, readiness floors at `blocked` (rank 3, so it can never IMPROVE a
   *  stored value): the task waits on other work and nothing on it should
   *  read as ready. The list's states are resolved at read time; the floor
   *  reads only that a list exists. Optional so the parse-only callers keep
   *  their shape. */
  dependenciesListed?: boolean;
}): ReadinessDerivation {
  const stored: Readiness = input.storedReadiness ?? "ready";
  const diagnosticsFloor = worstReadinessEffect(input.diagnostics);
  const dependencyFloor: Readiness | null = input.dependenciesListed ? "blocked" : null;
  const floors = [diagnosticsFloor, dependencyFloor].filter(
    (f): f is Readiness => f !== null,
  );
  const floor =
    floors.length === 0
      ? null
      : floors.reduce((worst, f) => (READINESS_RANK[f] > READINESS_RANK[worst] ? f : worst));

  if (floor && READINESS_RANK[floor] > READINESS_RANK[stored]) {
    return { readiness: floor, downgraded: true, diagnosticsFloor, dependencyFloor };
  }
  return { readiness: stored, downgraded: false, diagnosticsFloor, dependencyFloor };
}

/**
 * Display-state helper (the ONE rule for "accepted"): a task renders the
 * accepted pill when it sits in the project's final (done) stage.
 * Kept here so the definition of "accepted" lives beside the derivation.
 */
export function isAcceptedDisplayState(input: {
  stage: string;
  stageIds: string[];
}): boolean {
  if (input.stageIds.length === 0) return input.stage === "done";
  return input.stage === input.stageIds[input.stageIds.length - 1];
}
