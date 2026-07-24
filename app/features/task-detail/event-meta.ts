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

export const EVENT_META: Record<string, EventMeta> = {
  comment: { node: "", icon: "message", label: "commented" },
  completion: { node: "completion", icon: "check", label: "Completion report" },
  github: { node: "github", icon: "github", label: "GitHub" },
  // Reserved for genuine governance violations/refusals (a PAT missing a scope,
  // a directive that asked an agent to do something it was never granted).
  policy: { node: "policy", icon: "shield", label: "Policy violation" },
  // Neutral governance/lifecycle notes: a goal edit, a divergence note, a
  // scheduled re-run. Same "note" node styling as a comment row, no shield.
  note: { node: "note", icon: "message", label: "Note" },
  quality: { node: "quality", icon: "flag", label: "Quality flag" },
  transition: { node: "transition", icon: "arrow", label: "Transition request" },
  blocked: { node: "blocked", icon: "alert", label: "Blocked decision" },
  // The operator's coordination actions (deploy/engage/run/release a specialist).
  // Keeps the "Operator" category label — the event/comment distinction is now
  // carried by the "agent" badge being COMMENT-ONLY (NEW-6), so this pill needn't
  // rename; the row still reads as the operator's own action.
  agent: { node: "agent", icon: "agents", label: "Operator" },
  assign: { node: "transition", icon: "user", label: "Ownership" },
};

export function eventMeta(type: string): EventMeta {
  return EVENT_META[type] ?? EVENT_META.comment!;
}

const TYPED_KIND: Record<string, PillKind> = {
  completion: "done",
  github: "neutral",
  policy: "input",
  note: "neutral",
  quality: "risk",
  transition: "info",
  blocked: "blocked",
  agent: "agent",
  assign: "info",
};

export function typedKind(type: string): PillKind {
  return TYPED_KIND[type] ?? "neutral";
}
