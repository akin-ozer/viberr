import type { ReactNode } from "react";

/**
 * Pill + ReadinessPill + ValidationPill, ported from design/html-app/app/ui.jsx.
 *
 * ORCHESTRATOR RULING 1: the canonical readiness enum is
 * `ready | input_required | inconsistency_risk_detected | blocked`; this is
 * the ONE mapping module from canonical values to the mock's pill CSS kinds
 * and labels. "accepted" is a derived display state (stage done + accepted),
 * never a stored readiness value. CSS class names stay exactly the mock's
 * (`ready`, `input`, `risk`, `blocked`, `done`, ...).
 */

export type PillKind =
  | "ready"
  | "input"
  | "risk"
  | "blocked"
  | "info"
  | "agent"
  | "neutral"
  | "done";

export function Pill({
  kind,
  children,
  dot,
  sm,
}: {
  kind?: PillKind | "";
  children?: ReactNode;
  dot?: boolean;
  sm?: boolean;
}) {
  return (
    <span className={"pill " + (kind || "") + (sm ? " sm" : "")}>
      {dot && <span className="pdot" />}
      {children}
    </span>
  );
}

/** Canonical readiness values (CONVENTIONS) — derivation happens server-side. */
export type ReadinessValue =
  | "ready"
  | "input_required"
  | "inconsistency_risk_detected"
  | "blocked";

/** Readiness plus the derived "accepted" display state (done + accepted). */
export type ReadinessDisplayValue = ReadinessValue | "accepted";

const READINESS_DISPLAY: Record<
  ReadinessDisplayValue,
  { kind: PillKind; label: string }
> = {
  ready: { kind: "ready", label: "ready" },
  input_required: { kind: "input", label: "input required" },
  inconsistency_risk_detected: { kind: "risk", label: "inconsistency risk" },
  blocked: { kind: "blocked", label: "blocked" },
  accepted: { kind: "done", label: "accepted" },
};

/** Always dotted (mock contract). Unknown values fall back to `ready`. */
export function ReadinessPill({
  value,
  sm,
}: {
  value: ReadinessDisplayValue | (string & {});
  sm?: boolean;
}) {
  const r =
    READINESS_DISPLAY[value as ReadinessDisplayValue] ??
    READINESS_DISPLAY.ready;
  return (
    <Pill kind={r.kind} dot sm={sm}>
      {r.label}
    </Pill>
  );
}

export type ValidationValue = "healthy" | "changed" | "failing" | "none";

const VALIDATION_DISPLAY: Record<
  ValidationValue,
  { kind: PillKind; label: string }
> = {
  healthy: { kind: "ready", label: "validation healthy" },
  changed: { kind: "input", label: "evidence changed" },
  failing: { kind: "blocked", label: "validation failing" },
  none: { kind: "neutral", label: "no validation" },
};

/** Never dotted (mock contract). Unknown values fall back to `none`. */
export function ValidationPill({
  value,
  sm,
}: {
  value: ValidationValue | (string & {});
  sm?: boolean;
}) {
  const v =
    VALIDATION_DISPLAY[value as ValidationValue] ?? VALIDATION_DISPLAY.none;
  return (
    <Pill kind={v.kind} sm={sm}>
      {v.label}
    </Pill>
  );
}
