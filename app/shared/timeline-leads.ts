/**
 * Ruling 693: the opening words of the timeline entries a count is read from.
 *
 * What a task took (`what-it-took.server.ts`) counts the rounds a person was
 * asked, the questions agents raised and the times a person sent the work
 * back by reading the entries their writers leave on the timeline. Nothing
 * else records them for good: the audit rows expire and the packet leaves
 * with its answer. So each lead has this one home, which its writer and its
 * reader both import, and a rewording here moves the two together.
 *
 * No imports and no `.server` suffix: a browser module may read it too.
 */

/** Every decision a person records on a task opens with this: an answered
 *  packet (`resolvePacket`) and a declined recommendation alike. */
export const DECISION_LEAD = "**Decision:**";

/** The entry an agent's question to a person opens with, on either transport
 *  (the Claude toolkit's `ask_human`, the Codex outcome envelope). */
export const QUESTION_LEAD = "**Question for a human:**";

/**
 * The stable timeline title every DECLINED operator recommendation carries.
 * The record is READ BACK: `operatorSnapshot` shows a re-invoked coordinator
 * what a human already refused, and the task file is what every future agent
 * and reviewer re-anchors on.
 */
export const RECOMMENDATION_DECLINED_TITLE = "Recommendation declined";

/**
 * The sentence a stage move's timeline entry opens with: a person's move, or
 * the operator's when `byOperator`. The names are the stages' display names
 * as the project spells them at the time of the move.
 */
export function stageMoveLead(
  taskKey: string,
  fromName: string,
  toName: string,
  byOperator: boolean,
): string {
  return `**Transition:** ${byOperator ? "operator " : ""}moved ${taskKey} from ${fromName} to ${toName}.`;
}
