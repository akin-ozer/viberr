import type { IconName } from "~/ui/icon";

/**
 * THE shared notification kind → icon/color mapping + markdown stripper
 * (contracts §4 / ruling 14 — the mock duplicates both ×3; port once).
 * The `act-*` classes are the timeline event palette in app.css (ported from
 * the mock's viberr.css).
 */

export interface NtfMeta {
  icon: IconName;
  cls:
    | "act-blocked"
    | "act-completion"
    | "act-transition"
    | "act-comment"
    | "act-quality"
    | "act-policy";
}

export function ntfMeta(n: {
  kind: string;
  ptype?: "input" | "blocked" | null;
}): NtfMeta {
  if (n.kind === "packet") {
    // F19-24: the non-blocked branch used to be `check` + `act-completion` —
    // the COMPLETION palette — so an operator's scoping question rendered with
    // a completion checkmark, exactly the "something to accept" reading a
    // supervisor scanning the inbox must NOT get. A non-blocked packet is an
    // open question: `hand` is the glyph this app already uses for "waiting on
    // a human" (the board card's status chip, "Waiting on me" filter, review
    // queue). Ruling 625: on the blue palette, the one colour "a decision
    // waits on you" wears everywhere (the board's chip, the review queue);
    // amber stays an agent's question below.
    return n.ptype === "blocked"
      ? { icon: "alert", cls: "act-blocked" }
      : { icon: "hand", cls: "act-transition" };
  }
  // Ruling 481(a) (F40-48): an agent's question waits on a human exactly like
  // an operator's open question, so it wears the same hand on the same
  // palette. Filed as an `approval` it wore the stage-transition arrow.
  if (n.kind === "question") return { icon: "hand", cls: "act-policy" };
  if (n.kind === "approval") return { icon: "arrow", cls: "act-transition" };
  if (n.kind === "mention") return { icon: "message", cls: "act-comment" };
  if (n.kind === "quality") return { icon: "flag", cls: "act-quality" };
  // Ruling 99: goal-chain progress an inbox kept from before ruling 503 — the
  // comment palette (the controller is conversational), with the cpu glyph
  // naming the sender.
  if (n.kind === "controller") return { icon: "cpu", cls: "act-comment" };
  // Ruling 503: an epic's membership or status moved — forward motion, on the
  // transition palette, with the stacked glyph the Epics rail item wears.
  if (n.kind === "epic") return { icon: "epic", cls: "act-transition" };
  // Ruling 131: a released wait is forward motion — the transition palette
  // with the lock glyph the board's wait chip wears.
  if (n.kind === "dependency") return { icon: "lock", cls: "act-transition" };
  // Ruling 140: a seat change is about a person — the user glyph on the
  // transition palette (nothing was violated, nothing is blocked).
  if (n.kind === "ownership") return { icon: "user", cls: "act-transition" };
  return { icon: "alert", cls: "act-policy" }; // "policy" + unknown fallback
}

/** Strips the RichText micro-format markers (popovers render plain text). */
export function plainText(s: string | null | undefined): string {
  return (s || "").replace(/\*\*/g, "").replace(/`/g, "");
}

/**
 * Notification kind → type-pill on the /notifications "Waiting on you"
 * cards (contracts §4; mock `ntfPill`, notifications.jsx — Phase 9C).
 *
 * The label is DERIVED from `ptype` because the notification row does not carry
 * the packet's own `kind` string. It cannot drift today — `operatorOpenPacket`
 * is the sole writer of `kind: "packet"` rows and computes both the packet's
 * stored `kind` and this row's `ptype` from one `packetType` — but the honest
 * end state is to carry the stored string on the row (select the packet's
 * `kind` in `listNotifications`' existing task_projections join and surface it
 * as an optional `packetKind` on `NotificationView`) and prefer it here.
 */
export interface NtfPill {
  kind: "info" | "blocked" | "input";
  label: string;
}

export function ntfPill(n: {
  kind: string;
  ptype?: "input" | "blocked" | null;
}): NtfPill {
  if (n.kind === "approval") return { kind: "info", label: "approval" };
  // Ruling 481(a): the task page names the same packet "Agent question"
  // (`AGENT_QUESTION_PACKET_KIND`); the pill is its lowercased form, on the
  // input (amber) tone ruling 625 keeps for an agent's question.
  if (n.kind === "question") return { kind: "input", label: "agent question" };
  // F19-24: this used to end in `return { kind: "input", label: "completion
  // report" }` as the FALL-THROUGH, so every non-blocked packet was pilled a
  // completion report — a scoping question, a redirect, an edit_goal. That name
  // is load-bearing elsewhere (the `completion` timeline event, what the Review
  // queue says lands at the acceptance boundary), and the row contradicted its
  // own title one line to its left ("Decision needed: …") and the same packet's
  // pill on the task page ("Decision required"). Name the packet instead. The
  // two labels below are the lowercased forms of the `kind` string the packet
  // itself stores (`operatorOpenPacket` in operator-packets.server.ts, written
  // from the SAME `packetType` that becomes this row's `ptype` further down
  // that function) — see the note on NtfPill about threading the stored string
  // through instead.
  // Ruling 625: "decision required" is blue (info), as every other decision
  // that waits on you; amber (input) is an agent's question, above.
  if (n.kind === "packet") {
    return n.ptype === "blocked"
      ? { kind: "blocked", label: "blocked decision" }
      : { kind: "info", label: "decision required" };
  }
  // Nothing else reaches this pill — "Waiting on you" holds the decision
  // kinds only (`DECISION_NOTIFICATION_KINDS`). If something ever does, it
  // names itself rather than borrowing a decision's vocabulary (the UI-57
  // tolerant-AND-honest fallback, event-meta.ts).
  return { kind: "info", label: n.kind || "notification" };
}
