import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import type { RunView } from "~/features/runtime/runtime-types";
import { backendLabelOf } from "./run-principal-view";

// Lives apart from continuity-recovery.tsx so that file exports only
// components (Fast Refresh boundary, as app/ui/initials.ts is for avatar.tsx).

/** Where recovery stands for one affected thread. */
export type ContinuityProgress =
  /** A fresh run for that agent is queued or streaming right now. */
  | "running"
  /** The agent completed a run after re-anchoring. */
  | "recovered"
  /** The newest run ended in error or was interrupted — nothing landed. */
  | "stalled"
  /** No run group could be identified (member gate, or paged out of the window). */
  | "unknown";

export interface ContinuityAgent {
  /** Run-group id — the Agent-logs selection key (`RunView.id`). */
  threadId: string;
  name: string;
  /** "Operator" | "Delivering agent" | "Reviewer" | "Supporting agent" — the
   *  engagement, in UI words. */
  roleLabel: string;
  backendLabel: string;
  /** The provider session that is gone, when the wire envelope carried it. */
  sessionId: string | null;
  progress: ContinuityProgress;
}

export interface ContinuityLoss {
  /** ISO of the canonical `continuity` event; null when only the run marker survives. */
  occurredAt: string | null;
  /** Threads whose provider history is gone. Empty ⇒ timeline-only evidence. */
  agents: ContinuityAgent[];
}

/** A deployed profile, as far as the label needs it: whether its verdict
 *  gates acceptance (`DeployedSpecialistView`). */
export type VerdictProfile = { id: string; capabilities?: { verdict: boolean } };

function roleLabelOf(run: RunView, agents: readonly VerdictProfile[]): string {
  if (run.op || run.kind === "operator") return "Operator";
  if (run.kind === "primary") return "Delivering agent";
  // Ruling 662: `reviewer` is every non-delivering run (F31-C7), and the UI
  // calls one a reviewer only when its verdict gates acceptance, as the run
  // picker does; an unknown profile reads as supporting, the weaker claim.
  const verdict = agents.find((a) => a.id === run.profileId)?.capabilities?.verdict;
  return verdict ? "Reviewer" : "Supporting agent";
}

function progressOf(run: RunView): ContinuityProgress {
  if (run.lifecycle === "running" || run.lifecycle === "queued") return "running";
  if (run.lifecycle === "finished") return "recovered";
  return "stalled";
}

/**
 * Pure derivation — the panel renders iff this returns non-null. Exported so
 * the state machine is testable without a DOM.
 */
export function deriveContinuityLoss(input: {
  /** Newest-first timeline slice as the loader ships it. */
  timeline: TimelineEventRender[];
  runtime: RunView[];
  /** The deployed profiles (`deployedSpecialists`), for the reviewer label. */
  agents?: readonly VerdictProfile[];
}): ContinuityLoss | null {
  const event =
    input.timeline.find((e) => e.type === "continuity") ?? null;

  const agents: ContinuityAgent[] = [];
  for (const run of input.runtime) {
    if (!run.sessionMissing) continue;
    agents.push({
      threadId: run.id,
      name: run.who.name,
      roleLabel: roleLabelOf(run, input.agents ?? []),
      backendLabel: backendLabelOf(run.backend),
      sessionId: run.sessionMissing.sessionId,
      progress: progressOf(run),
    });
  }

  if (!event && agents.length === 0) return null;
  return { occurredAt: event?.occurredAt ?? null, agents };
}
