import type { ValidationValue } from "~/ui/pill";
import { plainText } from "~/features/notifications/notification-meta";
import type { PrState } from "~/schemas/task-file.schema";

export interface ReviewRowView {
  key: string;
  title: string;
  waiting: "human" | "agent" | "none";
  packet: { kind: string; title: string } | null;
  latestEventText: string | null;
  pr: { number: number; state: PrState } | null;
  validation: ValidationValue;
}

/** The subline stripper is the shared `plainText` helper (same regexes as
 * the mock's `rqStripMd` — ruling 14, one stripper app-wide). */
export function reviewRowSub(t: ReviewRowView): string {
  return t.packet
    ? t.packet.kind + " — " + t.packet.title
    : t.latestEventText
      ? plainText(t.latestEventText)
      : t.waiting === "agent"
        ? "Waiting for the agent's next turn at the review boundary."
        : t.waiting === "human"
          ? "A human decision is ready at the review boundary."
          : "No active handoff — assign an owner, reviewer, or agent.";
}
