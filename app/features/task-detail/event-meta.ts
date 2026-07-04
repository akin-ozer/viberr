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
  policy: { node: "policy", icon: "shield", label: "Policy violation" },
  quality: { node: "quality", icon: "flag", label: "Quality flag" },
  transition: { node: "transition", icon: "arrow", label: "Transition request" },
  blocked: { node: "blocked", icon: "alert", label: "Blocked decision" },
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
  quality: "risk",
  transition: "info",
  blocked: "blocked",
  agent: "agent",
  assign: "info",
};

export function typedKind(type: string): PillKind {
  return TYPED_KIND[type] ?? "neutral";
}
