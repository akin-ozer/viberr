import type { ValidationValue } from "~/ui/pill";
import { plainText } from "~/features/notifications/notification-meta";

export interface ReviewRowView {
  key: string;
  title: string;
  waiting: "human" | "agent" | "none";
  packet: { kind: string; title: string } | null;
  latestEventText: string | null;
  pr: { number: number; state: "review" | "merged" } | null;
  validation: ValidationValue;
  /** F10-11: why the current revision is NOT acceptance-ready (null when it is).
   *  Only ever populated on "Still in review" rows — the acceptance panel holds
   *  only rows with a null block reason. */
  blockReason: string | null;
}

/** The subline stripper is the shared `plainText` helper (same regexes as
 * the mock's `rqStripMd` — ruling 14, one stripper app-wide). */
export function reviewRowSub(t: ReviewRowView): string {
  // F10-11: a not-yet-acceptable task states WHY (failing / awaiting a reviewer /
  // no delivered revision) instead of a generic "needs a human decision".
  if (t.blockReason) return t.blockReason;
  if (t.packet) return t.packet.kind + " — " + t.packet.title;
  if (t.latestEventText) return plainText(t.latestEventText);
  // No packet, no timeline event yet. Don't claim "agent working" on a task
  // that is waiting on a HUMAN (R8-3, same fix as the wait-tag) — a human-
  // waiting row needs a person, not an agent.
  return t.waiting === "human"
    ? "Waiting at the review boundary — needs a human decision."
    : "Agent working — the packet arrives at the boundary.";
}
