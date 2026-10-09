import type { RecommendationView } from "./operator-recommendations";

// Lives apart from operator-recommendations.tsx so that file exports only
// components (Fast Refresh boundary, as app/ui/initials.ts is for avatar.tsx).

/**
 * F19-3 + F19-26 — does APPLYING this recommendation reach acceptance? The
 * page routes such an Apply through the accept confirm, and ruling 95 has the
 * card print the gate's refusal on it.
 *
 * Gate on the recommendation's TARGET, never on its `kind`. A supervised
 * operator can recommend a plain `transition` to the terminal stage; applying it
 * runs the identical full acceptance contract (transitionStage → acceptCompletion
 * → the real PR merge) under a label that says only "Move the task to Done".
 * A kind-only test would let that one through the ceremony it needs most.
 */
export function reachesAcceptance(r: RecommendationView, terminalStageId: string | null): boolean {
  return (
    r.kind === "accept_completion" ||
    (r.kind === "transition" && terminalStageId !== null && r.toStageId === terminalStageId)
  );
}
