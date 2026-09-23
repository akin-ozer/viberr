import type { ConversationTurnState } from "~/server/controller/controller-run.server";
import { readableStep } from "~/features/runtime/readable-step";

export { readableStep };

/**
 * Ruling 250 (pass 37, F37-79): what the live controller turn is doing, on the
 * row that says it is working.
 *
 * Measured live: a controller turn ran 201s over 11 turns for $4.11, and the
 * conversation showed `Controller is working…` and nothing else for the whole
 * of it, while the SAME page rendered `Working` + `mcp__viberr_controller__
 * get_task · {"taskKey":"SHOP-31","events":2}` in the live-run panel below it.
 * The fact was already computed, already on the run row and already streaming
 * to the page; it just never reached the place the person was looking. The
 * dock is worse: it follows a person onto every page and carries no run panel,
 * so there the step had nowhere to appear at all.
 *
 * Deliberately plain and one line. The step is a live hint, not a transcript
 * (`clampStep` caps it at 120 chars server-side), and a wrapping tool payload
 * under a waiting message would push the conversation around while the person
 * reads it.
 */
export function TurnStep({ turn }: { turn: ConversationTurnState }): React.ReactNode {
  // `phase` arrives null while it is the generic "Working" — the sentence this
  // sits beside already says that, so only a phase that means something else
  // ("Preparing workspace") is worth the row.
  const detail = [turn.phase, turn.step].filter(Boolean).join(" · ");
  if (!detail) return null;
  // Ruling 451(a): keyed on the step, so a new step is a new line that rises
  // in (the sheet's `swap-in`) instead of words changing under the reader.
  return (
    <span key={detail} className="ctl-working-step mono" title={detail}>
      {readableStep(detail)}
    </span>
  );
}

/**
 * Ruling 451(a): the sentence that says a controller turn is working, on the
 * dock and the page. A highlight band crosses it while the turn holds (the
 * sheet's `.ctl-working-text`, transitions.dev's "Shimmer text"): the band is
 * a copy of these words drawn on `::before` from `data-text`, so the two must
 * always carry the same string.
 */
export function WorkingSentence({ name }: { name: string }): React.ReactNode {
  const sentence = `${name} is working…`;
  return (
    <span className="ctl-working-text" data-text={sentence}>
      {sentence}
    </span>
  );
}
