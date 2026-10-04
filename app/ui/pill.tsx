import type { ReactNode } from "react";
import type { Validation } from "~/schemas/task-file.schema";
import type { DisplayReadiness } from "~/shared/mapping/task.server";
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
  quiet,
}: {
  kind?: PillKind | "";
  children?: ReactNode;
  dot?: boolean;
  sm?: boolean;
  /** Descriptive, not a state: drop the fill and let the states be the loud
   *  things on the row. `quiet` is a TIER, orthogonal to `kind` — it overrides
   *  the tone's fill, so pass it when the chip describes the task rather than
   *  telling the reader what the task is waiting for. */
  quiet?: boolean;
}) {
  return (
    <span
      className={
        "pill " + (kind || "") + (sm ? " sm" : "") + (quiet ? " quiet" : "")
      }
    >
      {dot && <span className="pdot" />}
      {children}
    </span>
  );
}

/** What a pill renders for one value: its CSS kind and its label, plus whether
 *  it belongs to the quiet tier — see `Pill`'s `quiet` prop. */
interface PillDisplay {
  kind: PillKind;
  label: string;
  quiet?: boolean;
}

const READINESS_DISPLAY = {
  ready: { kind: "ready", label: "ready" },
  input_required: { kind: "input", label: "input required" },
  inconsistency_risk_detected: { kind: "risk", label: "inconsistency risk" },
  blocked: { kind: "blocked", label: "blocked" },
  accepted: { kind: "done", label: "accepted" },
  merged: { kind: "done", label: "merged" },
  agent_working: { kind: "agent", label: "agent working" },
  agent_queued: { kind: "agent", label: "agent queued" },
  goal_edit_pending: { kind: "input", label: "goal edit pending" },
} satisfies Record<DisplayReadiness, PillDisplay>;

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

/** The readiness vocabulary's label alone — for the board card's status chip
 *  (ruling 365), which draws the value with its own mark. Unknown values fall
 *  back to "unknown" exactly as the pill does (C12: never greenwash). */
export function readinessLabel(value: string): string {
  return (READINESS_BY_VALUE.get(value) ?? READINESS_UNKNOWN).label;
}

/**
 * Self-labelling readiness chip. C5: the readiness value alone collided with a
 * user-authored stage name — the default workflow ships a "Ready" stage, so the
 * hero read "Ready" (stage) immediately followed by "ready" (readiness),
 * distinguishable only by capitalisation and dot colour. The chip now carries a
 * status glyph (the shared `activity` pulse mark, `currentColor`-tinted to the
 * kind) so it reads as a different CLASS of object from the stage's colour dot.
 * This reuses the existing Icon-in-Pill pattern (the `archived` pill does the
 * same) — no new app.css class, which the stylesheet's integrity gate requires.
 * Ruling 169 went further on the hero: the stage and the status there are
 * labelled fields ("Stage", "Status"), because the glyph alone still let the
 * owner read the Ready stage as a status word.
 */
export function ReadinessPill({
  value,
  sm,
}: {
  value: DisplayReadiness | (string & {});
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

/** The canonical validation enum, under the name the review rows import. */
export type ValidationValue = Validation;

/**
 * Design pass 2026-09-08 — which of these fill and which stay quiet.
 *
 * Readiness and validation are different questions ("what is this task waiting
 * for?" vs "what does the evidence say?"), but two of their values map to the
 * same amber `input` tone, so a card in review printed `input required` and
 * `awaiting verdict` as twin amber pills and neither read as distinct.
 *
 * The rule that separates them: a FILL is a problem or a demand; an OUTLINE
 * describes. `failing` and `bypassed` are problems and keep their fills. The
 * other three state where the evidence stands without asking anything of the
 * reader — including `healthy`, which is the least actionable thing on a board,
 * and was spending a green fill to say "nothing to do here".
 */
const VALIDATION_DISPLAY = {
  healthy: { kind: "ready", label: "validation healthy", quiet: true },
  // `changed` = the delivered revision has no reviewer verdict covering it
  // (never reviewed, or re-delivered since the last verdict). The old label
  // "evidence changed" described the MECHANISM; this one names what is owed —
  // owner feedback 2026-07-26.
  changed: { kind: "input", label: "awaiting verdict", quiet: true },
  failing: { kind: "blocked", label: "validation failing" },
  none: { kind: "neutral", label: "no validation", quiet: true },
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

/** The validation vocabulary's label alone — for surfaces that fold a pill
 *  into a "+N" overflow and need its words for the title (one vocabulary
 *  source; restating the labels elsewhere is how they drift). */
export function validationLabel(value: string): string {
  return (VALIDATION_BY_VALUE.get(value) ?? VALIDATION_DISPLAY.none).label;
}

/** Whether a validation value belongs to the quiet tier — a description of
 *  where the evidence stands, not a problem. The board card and list row draw
 *  only the fills (ruling 168, `StateSignals`); the task hero draws every value.
 *  Read from the vocabulary so the tier is decided in one place. */
export function validationQuiet(value: string): boolean {
  return (VALIDATION_BY_VALUE.get(value) ?? VALIDATION_DISPLAY.none).quiet === true;
}

/** Never dotted (mock contract). Unknown values fall back to `none`. */
export function ValidationPill({
  value,
  sm,
}: {
  value: ValidationValue | (string & {});
  sm?: boolean;
}) {
  const v = VALIDATION_BY_VALUE.get(value) ?? VALIDATION_DISPLAY.none;
  return (
    <Pill kind={v.kind} sm={sm} quiet={v.quiet}>
      {v.label}
    </Pill>
  );
}
