import type { IconName } from "~/ui/icon";
import type { BoardCard } from "./board-card";
import { readinessLabel, validationLabel, validationQuiet } from "~/ui/pill";
import { checksPill, prStatePill, reviewPill } from "~/features/github/github-pills";

/**
 * Ruling 365 — the board card's ONE status seat and its problem chips.
 *
 * Before this the card stated its state in three seats: a readiness pill beside
 * the key, problem pills in the foot's left cell and a wait tag in its right
 * cell, with `readinessYields` deciding which of the three got to speak. The
 * card now answers "what is this task waiting on, or doing?" once, here:
 *
 *   - the wait, when there is one (an agent working or queued, a human — you
 *     or someone else — a clock), else
 *   - the readiness word (ready · input required · goal edit pending · blocked
 *     · accepted · merged; "unknown" for a value the vocabulary does not know),
 *   - and `archived` on an archived card, which owes nobody anything (F19-8).
 *
 * Everything that is WRONG with the task is a problem chip, most severe first:
 * a failing validation, failing checks, a review asking for changes, a closed
 * PR, an inconsistency risk (a readiness value, but a problem rather than a
 * demand — ruling 168(a) — so it never takes the seat), a degraded continuity
 * (D4), and the amber "merge pending" a human still owes (R16-6). A hold
 * (`blocked`) displaced from the seat by a working agent joins them: ruling
 * 168(a) kept it beside "agent working" because the two are different facts,
 * while a human wait absorbs it (the hold IS what the human is asked about).
 * So does a decision the viewer owes (ruling 529), first and in the seat's own
 * words: a question can stand open while an agent keeps working.
 *
 * Every label comes from the vocabulary that owns it (`pill.tsx`,
 * `github-pills.ts`); the only words minted here are the wait tags, which have
 * always been the board's own.
 */

export type CardStatusKind =
  | "archived"
  | "queued"
  | "agent"
  | "you"
  | "human"
  | "scheduled"
  | "ready"
  | "input"
  | "blocked"
  | "done"
  | "unknown";

export interface CardStatus {
  kind: CardStatusKind;
  label: string;
  /** The mark beside the word; null for "agent working", whose mark is the live pulse. */
  icon: IconName | null;
  /** `scheduled` only: the instant the task picks itself back up (ruling 225). */
  resumesAt?: string | null;
}

export function cardStatus(task: BoardCard): CardStatus | null {
  if (task.archived) return { kind: "archived", label: "archived", icon: "lock" };
  if (task.waiting === "agent") {
    // Ruling 349: parked behind the concurrent-run cap — no pulse, nothing streams.
    return task.liveRun === "queued"
      ? { kind: "queued", label: "agent queued", icon: "ring" }
      : { kind: "agent", label: "agent working", icon: null };
  }
  if (task.waiting === "human") {
    // R8-3: only the viewer who can act sees "waiting on you".
    return task.waitingOnMe
      ? { kind: "you", label: "waiting on you", icon: "hand" }
      : { kind: "human", label: "waiting on a human", icon: "hand" };
  }
  if (task.waiting === "schedule") {
    return { kind: "scheduled", label: "resumes", icon: "clock", resumesAt: task.resumesAt ?? null };
  }
  const r = task.displayReadiness;
  switch (r) {
    case "ready":
      return { kind: "ready", label: readinessLabel(r), icon: "ring" };
    case "input_required":
    case "goal_edit_pending":
      return { kind: "input", label: readinessLabel(r), icon: "activity" };
    case "blocked":
      return { kind: "blocked", label: readinessLabel(r), icon: "ban" };
    case "accepted":
    case "merged":
      return { kind: "done", label: readinessLabel(r), icon: "checkcircle" };
    case "agent_working":
      return { kind: "agent", label: readinessLabel(r), icon: null };
    case "agent_queued":
      return { kind: "queued", label: readinessLabel(r), icon: "ring" };
    case "inconsistency_risk_detected":
      return null;
    default:
      return { kind: "unknown", label: readinessLabel(r), icon: "activity" };
  }
}

export interface CardProblem {
  key: string;
  label: string;
  icon: IconName;
  /** A demand rather than a failure: amber ink instead of red; blue for a
   *  decision the viewer owes, the seat's "waiting on you" ink (ruling 529). */
  tone?: "amber" | "blue";
}

/** How many problem chips a card draws before folding the rest into "+N". */
export const PROBLEM_CAP = 2;

export function cardProblems(task: BoardCard): CardProblem[] {
  // F19-8: abandoned work owes nobody anything — no problem is live on it.
  if (task.archived) return [];
  const terminal = task.displayReadiness === "accepted" || task.displayReadiness === "merged";
  const out: CardProblem[] = [];
  // Ruling 529: CALC-1's card said only "agent working" while a decision
  // waited on its owner. Both were true, and the one that is the viewer's own
  // leads, as it does when it holds the seat (R8-3: only the viewer who can
  // act is named).
  if (task.waitingOnMe === true && task.waiting === "agent") {
    out.push({ key: "you", label: "waiting on you", icon: "hand", tone: "blue" });
  }
  if (task.displayReadiness === "blocked" && task.waiting === "agent") {
    out.push({ key: "blocked", label: readinessLabel("blocked"), icon: "ban", tone: "amber" });
  }
  // P13-D-6 / ruling 168(b): validation is a problem or nothing — the fill
  // tier only ("validation failing", and the force-accept override "accepted ·
  // gate bypassed"); the quiet tier stays on the task hero. C2 / UXO-1: a
  // terminal completion owes no verdict, so its validation is withdrawn.
  if (!terminal && !validationQuiet(task.validation)) {
    out.push({
      key: "validation",
      label: validationLabel(task.validation),
      icon: task.validation === "failing" ? "xcircle" : "alert",
    });
  }
  // P13-D-28: CI health only when it is actionable.
  if (task.prChecks?.state === "failing") {
    out.push({ key: "checks", label: checksPill(task.prChecks).label, icon: "xcircle" });
  }
  if (task.prReview === "changes_requested") {
    out.push({ key: "review", label: reviewPill(task.prReview).label, icon: "alert" });
  }
  if (task.pr?.state === "closed") {
    out.push({ key: "closed", label: prStatePill("closed").label, icon: "xcircle" });
  }
  if (task.displayReadiness === "inconsistency_risk_detected") {
    out.push({ key: "risk", label: readinessLabel("inconsistency_risk_detected"), icon: "alert" });
  }
  if (task.continuity === "degraded") {
    out.push({ key: "continuity", label: "degraded continuity", icon: "refresh" });
  }
  // R16-6: merge stays human-only, so an accepted PR still owes a human the merge.
  if (task.pr?.state === "accepted") {
    out.push({ key: "merge", label: prStatePill("accepted").label, icon: "pr", tone: "amber" });
  }
  return out;
}
