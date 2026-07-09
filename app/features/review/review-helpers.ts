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
}

/** The subline stripper is the shared `plainText` helper (same regexes as
 * the mock's `rqStripMd` — ruling 14, one stripper app-wide). */
export function reviewRowSub(t: ReviewRowView): string {
  return t.packet
    ? t.packet.kind + " — " + t.packet.title
    : t.latestEventText
      ? plainText(t.latestEventText)
      : "Agent working — the packet arrives at the boundary.";
}
