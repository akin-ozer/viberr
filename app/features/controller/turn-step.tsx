import type { ConversationTurnState } from "~/server/controller/controller-run.server";
import { readableStep } from "~/features/runtime/readable-step";
import { useFreshLine } from "~/ui/use-fresh-line";

/**
 * Ruling 257 (pass 37, F37-79): what the live controller turn is doing, on the
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
  // Before the early return: a turn with no step yet is the first paint too.
  const fresh = useFreshLine(detail);
  if (!detail) return null;
  // Ruling 284(a): keyed on the step, so a new step is a new line that rises
  // in (the sheet's `swap-in`) instead of words changing under the reader.
  // Only a step that replaces the one on screen when the page or dock opened
  // rises (`data-fresh`); that first one stands still.
  return (
    <span
      key={detail}
      className="ctl-working-step"
      title={detail}
      data-fresh={fresh ? "true" : undefined}
    >
      {readableStep(detail)}
    </span>
  );
}

/**
 * Ruling 320 (F40-8): where an unanswered user message stands, on the page and
 * the dock alike. A message sent while a turn works is queued on the server;
 * the transcript rendered it as the newest message with "is working…" under
 * it, as if the running turn were answering it, and a person could not tell
 * whether it was being worked on, waiting, or lost. The words come from the
 * server's view of the lease (`turn.answering`, `turn.queued`), never from
 * what the page last sent, and a message that already has a reply says
 * nothing (the caller renders this only for one that has none). The words
 * carry it, in the header's own small type (`.fine`, the surface chip's
 * look), so no rule joins the stylesheet every page loads.
 *
 * Ruling 291 adds the two steering words: "steering · next step" on a message
 * waiting for the running turn's next step (`turn.steering`), and "steered"
 * on one a turn read, for good (`steered`, from the message row). A steered
 * message has no reply of its own, and the word says why.
 */
export function MessageState({
  turn,
  messageId,
  steered = false,
}: {
  turn: Pick<ConversationTurnState, "answering" | "queued" | "steering"> | null;
  messageId: string;
  /** Ruling 291: a turn read this message at one of its steps. */
  steered?: boolean;
}): React.ReactNode {
  if (steered) {
    return (
      <span
        className="fine"
        data-msg-state="steered"
        title="The turn it sits in read it at one of its steps, and that turn's reply answers it."
      >
        steered
      </span>
    );
  }
  if (!turn) return null;
  if (turn.answering === messageId) {
    return (
      <span className="fine" data-msg-state="answering">
        answering now
      </span>
    );
  }
  if (turn.steering.includes(messageId)) {
    return (
      <span className="fine" data-msg-state="steering" title="It goes into the running turn at its next step.">
        steering · next step
      </span>
    );
  }
  const queued = turn.queued.find((q) => q.messageId === messageId);
  if (!queued) return null;
  return (
    <span className="fine" data-msg-state="queued">
      {`queued · ${queued.ahead} ahead`}
    </span>
  );
}

/**
 * Ruling 284: the sentence that says a controller turn is working, on the
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
