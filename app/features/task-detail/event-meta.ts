import type { IconName } from "~/ui/icon";
import type { PillKind } from "~/ui/pill";

/**
 * Timeline event display metadata — verbatim contract from the mock's
 * EVENT_META + typedKind (task.jsx, contracts §1.3). Unknown event types
 * fall back to comment meta / neutral kind (tolerant renderer).
 */

export interface EventMeta {
  /** tl-node modifier class ("" for comments). */
  node: string;
  icon: IconName;
  /** Type-pill label; comments never render a pill ("commented" is dead copy
   * in the mock — kept for fidelity). */
  label: string;
}

/** The lookup `eventMeta` reads: keyed by the contract event types, but open
 *  by contract — an unrecognized type is a miss, never a parse failure. */
interface EventMetaTable {
  [type: string]: EventMeta;
}

const EVENT_META: EventMetaTable = {
  comment: { node: "", icon: "message", label: "commented" },
  completion: { node: "completion", icon: "check", label: "Completion report" },
  github: { node: "github", icon: "github", label: "GitHub" },
  // Reserved for genuine governance violations/refusals (a PAT missing a scope,
  // a directive that asked an agent to do something it was never granted).
  policy: { node: "policy", icon: "shield", label: "Policy violation" },
  // Neutral governance/lifecycle notes: a goal edit, a divergence note, a
  // scheduled re-run. Same "note" node styling as a comment row, no shield.
  note: { node: "note", icon: "message", label: "Note" },
  // The reviewer's verdict record. Named for the CATEGORY, not for one of its
  // outcomes: "Quality flag" put a flag-shaped, risk-toned chip on "Review
  // passed" too, which reads as "something is wrong here" on good news. The
  // outcome is the event's own bold title (Review passed / Changes requested /
  // Approval noted …), so the chip stays neutral like `note` and `github`.
  quality: { node: "quality", icon: "flag", label: "Review verdict" },
  // G8: runtime-continuity reset — warning-toned (amber), refresh icon (the
  // agent re-anchored on a fresh session). Distinct from a neutral `note` so a
  // scanning supervisor sees that context was lost and recovered.
  continuity: { node: "quality", icon: "refresh", label: "Continuity reset" },
  // Ruling 267 (F40-59): a proposed knowledge-base correction. Ruling 210 filed
  // these as `quality`, so the one item in the record that asks the owner to
  // act read "Review verdict" and sat above a real verdict looking like a
  // failed review. It is a proposal: its own label, and the edit glyph.
  proposal: { node: "proposal", icon: "edit", label: "Proposal" },
  // Ruling 210: a correction an agent wrote into a knowledge base (or a
  // person's undo of one). The same tint and glyph as the proposal it replaced,
  // named for what it touched: the title says corrected or undone.
  kb_correction: { node: "proposal", icon: "edit", label: "Knowledge base" },
  transition: { node: "transition", icon: "arrow", label: "Transition request" },
  blocked: { node: "blocked", icon: "alert", label: "Blocked decision" },
  // The operator's coordination actions (deploy/engage/run/release a specialist).
  // Keeps the "Operator" category label — the event/comment distinction is now
  // carried by the "agent" badge being COMMENT-ONLY (NEW-6), so this pill needn't
  // rename; the row still reads as the operator's own action.
  agent: { node: "agent", icon: "agents", label: "Operator" },
  assign: { node: "transition", icon: "user", label: "Ownership" },
};

/**
 * UI-57: an UNKNOWN event type used to fall back to the comment meta, but
 * `timeline-entry.tsx` renders the typed branch whenever `type !== "comment"` — so an
 * unrecognized type rendered a pill literally labelled "commented". A tolerant
 * renderer must stay tolerant AND honest: the fallback now names the raw type.
 */
export function eventMeta(type: string): EventMeta {
  const known = EVENT_META[type];
  if (known) return known;
  return { node: "", icon: "message", label: type || "event" };
}

/** Same open keying as {@link EventMetaTable} — `typedKind` falls back. */
interface TypedKindTable {
  [type: string]: PillKind;
}

const TYPED_KIND: TypedKindTable = {
  completion: "done",
  github: "neutral",
  policy: "input",
  note: "neutral",
  quality: "neutral",
  continuity: "risk", // G8: amber warning tone
  // Ruling 267: a decision a person owes, not a verdict and not a warning.
  proposal: "info",
  // Ruling 210: a change to what every run reads, in the same tone.
  kb_correction: "info",
  transition: "info",
  blocked: "blocked",
  agent: "agent",
  assign: "info",
};

export function typedKind(type: string): PillKind {
  return TYPED_KIND[type] ?? "neutral";
}
