import type { ReactNode } from "react";
import { Icon } from "./icon";

/**
 * Status, readiness, and validation pills.
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

/** Canonical readiness values (docs/architecture/decisions.md) — derivation happens server-side. */
export type ReadinessValue =
  | "ready"
  | "input_required"
  | "inconsistency_risk_detected"
  | "blocked";

/** Readiness plus the derived display states no file stores: the terminal pair
 * "accepted" (human accepted; merge may still be pending) and "merged" (the
 * review PR really merged — F7-UI3: "accepted" must not read stale next to
 * GitHub), and "agent_working" (R21-8: an agent is carrying the task, so the
 * slot says so instead of claiming a human is needed or painting a green
 * all-clear). Derived in ONE place — `deriveDisplayReadiness`, the mapping
 * layer — never re-decided here or in a component. */
export type ReadinessDisplayValue =
  | ReadinessValue
  | "accepted"
  | "merged"
  | "agent_working"
  | "goal_edit_pending";

/** What a pill renders for one value: its CSS kind and its label. */
interface PillDisplay {
  kind: PillKind;
  label: string;
}

const READINESS_DISPLAY = {
  ready: { kind: "ready", label: "ready" },
  input_required: { kind: "input", label: "input required" },
  inconsistency_risk_detected: { kind: "risk", label: "inconsistency risk" },
  blocked: { kind: "blocked", label: "blocked" },
  accepted: { kind: "done", label: "accepted" },
  merged: { kind: "done", label: "merged" },
  agent_working: { kind: "agent", label: "agent working" },
  goal_edit_pending: { kind: "input", label: "goal edit pending" },
} satisfies Record<ReadinessDisplayValue, PillDisplay>;

/** The same table, keyed for lookup by a value that has NOT been narrowed to
 *  the canonical enum yet (see `ReadinessPill`). */
const READINESS_BY_VALUE = new Map<string, PillDisplay>(
  Object.entries(READINESS_DISPLAY),
);

/** C12: an UNRECOGNISED readiness value must never greenwash. The lookup used to
 *  fall back to the `ready` entry, so a malformed or future value rendered as a
 *  green "ready" pill — the one thing a tolerant-parsing product must not do
 *  (decisions.md "Behavior rules": malformed input is "a readiness downgrade …
 *  never a silent drop"). It falls back to a NEUTRAL "unknown" pill instead; the
 *  diagnostics panel carries the reason. */
const READINESS_UNKNOWN: PillDisplay = {
  kind: "neutral",
  label: "unknown",
};

/**
 * Self-labelling readiness chip. C5: the readiness value alone collided with a
 * user-authored stage name — the default workflow ships a "Ready" stage, so the
 * hero read "Ready" (stage) immediately followed by "ready" (readiness),
 * distinguishable only by capitalisation and dot colour. The chip now carries a
 * status glyph (the shared `activity` pulse mark, `currentColor`-tinted to the
 * kind) so it reads as a different CLASS of object from the stage's colour dot.
 * This reuses the existing Icon-in-Pill pattern (the `archived` pill does the
 * same) — no new app.css class, which the stylesheet's integrity gate requires.
 */
export function ReadinessPill({
  value,
  sm,
}: {
  value: ReadinessDisplayValue | (string & {});
  sm?: boolean;
}) {
  const r = READINESS_BY_VALUE.get(value) ?? READINESS_UNKNOWN;
  // "agent working" is the one readiness value that means something is
  // happening RIGHT NOW, so it keeps the live dot the hero's hand-rolled
  // version used (R21-8) rather than the static status glyph.
  const live = value === "agent_working";
  return (
    <Pill kind={r.kind} sm={sm} dot={live}>
      {!live && <Icon name="activity" />}
      {r.label}
    </Pill>
  );
}

export type ValidationValue =
  | "healthy"
  | "changed"
  | "failing"
  | "none"
  | "bypassed";

const VALIDATION_DISPLAY = {
  healthy: { kind: "ready", label: "validation healthy" },
  // `changed` = the delivered revision has no reviewer verdict covering it
  // (never reviewed, or re-delivered since the last verdict). The old label
  // "evidence changed" described the MECHANISM; this one names what is owed —
  // owner feedback 2026-07-26.
  changed: { kind: "input", label: "awaiting verdict" },
  failing: { kind: "blocked", label: "validation failing" },
  none: { kind: "neutral", label: "no validation" },
  // N20-14 (§5c / C2): a durable force-accept fact — `deriveValidation` returns
  // "bypassed" when `acceptance === "forced"`. `risk`-toned because it is an
  // OVERRIDE, not a clean pass: a human accepted the completion past the verdict
  // gate. It replaces the stale "awaiting verdict" a force-accepted, Done task
  // used to re-derive on any surface that still renders its validation pill.
  bypassed: { kind: "risk", label: "accepted · gate bypassed" },
} satisfies Record<ValidationValue, PillDisplay>;

/** Lookup half of the table, for a value not yet narrowed to the enum. */
const VALIDATION_BY_VALUE = new Map<string, PillDisplay>(
  Object.entries(VALIDATION_DISPLAY),
);

/** Never dotted (mock contract). Unknown values fall back to `none`. */
/** The validation vocabulary's label alone — for surfaces that fold a pill
 *  into a "+N" overflow and need its words for the title (one vocabulary
 *  source; restating the labels elsewhere is how they drift). */
export function validationLabel(value: string): string {
  return (VALIDATION_BY_VALUE.get(value) ?? VALIDATION_DISPLAY.none).label;
}

export function ValidationPill({
  value,
  sm,
}: {
  value: ValidationValue | (string & {});
  sm?: boolean;
}) {
  const v = VALIDATION_BY_VALUE.get(value) ?? VALIDATION_DISPLAY.none;
  return (
    <Pill kind={v.kind} sm={sm}>
      {v.label}
    </Pill>
  );
}
