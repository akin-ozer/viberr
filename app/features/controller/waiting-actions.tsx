import { useFetcher } from "react-router";
import type { ConversationTurnState } from "~/server/controller/controller-run.server";
import { useToast } from "~/ui/toast";
import { useFetcherResult } from "~/ui/use-fetcher-result";

/** What Send now and Retract answer (ruling 527). */
export interface WaitingActionResult {
  ok: boolean;
  error?: string;
  toast?: string;
  /** Retract: the message's own text, for the composer. */
  retracted?: string;
}

/**
 * Ruling 527: the composer's box once a retracted message comes back. What
 * the person is typing stays where it is and the message goes under it, so
 * neither is lost (ruling 259's rule for the box).
 */
export function withRetracted(box: string, retracted: string): string {
  return box.trim() ? `${box.trimEnd()}\n\n${retracted}` : retracted;
}

/** Ruling 527: where a message waits on the running turn, if it still does. */
type WaitingState = "queued" | "steering";

interface WaitingActionsProps {
  turn: Pick<ConversationTurnState, "queued" | "steering"> | null;
  messageId: string;
  conversationId: string;
  csrf: string;
  /** The door that answers them: the dock's resource route. Absent, the
   *  page's own route. */
  action?: string;
  onRetracted: (text: string) => void;
}

/**
 * Ruling 527: what a message still waiting on the running turn lets its
 * sender do, on the page and in the dock. **Send now** takes a queued message
 * into the running turn at its next step (the server sends it next instead
 * when that turn can take no more). **Retract** takes back a message nothing
 * has read, queued or waiting to steer: it leaves the conversation and its
 * text goes back to the composer. Rendered for the conversation's owner only;
 * the server re-checks both. A message that is not waiting renders nothing
 * and mounts no fetcher.
 */
export function WaitingActions(props: WaitingActionsProps): React.ReactNode {
  const { turn, messageId } = props;
  const state: WaitingState | null = turn?.steering.includes(messageId)
    ? "steering"
    : turn?.queued.some((q) => q.messageId === messageId)
      ? "queued"
      : null;
  return state ? <WaitingMessageActions {...props} state={state} /> : null;
}

function WaitingMessageActions({
  state,
  messageId,
  conversationId,
  csrf,
  action,
  onRetracted,
}: WaitingActionsProps & { state: WaitingState }): React.ReactNode {
  const fetcher = useFetcher<WaitingActionResult>();
  const push = useToast();
  useFetcherResult(fetcher, (result) => {
    if (!result.ok) {
      push(result.error ?? "That did not go through. Try again.", "error");
      return;
    }
    if (result.retracted !== undefined) onRetracted(result.retracted);
    if (result.toast) push(result.toast);
  });
  const busy = fetcher.state !== "idle";
  const submit = (intent: "send-now" | "retract") => {
    const body = new FormData();
    body.set("_csrf", csrf);
    body.set("intent", intent);
    body.set("conversationId", conversationId);
    body.set("messageId", messageId);
    // The dock's door changes nothing the page under it renders (ruling 457,
    // CTL-4, as its sends); the dock reloads on the `controller.updated` the
    // change publishes.
    fetcher.submit(body, action ? { method: "post", action, defaultShouldRevalidate: false } : { method: "post" });
  };
  return (
    <span className="ctl-msg-acts">
      {state === "queued" && (
        <button
          type="button"
          className="linkish"
          disabled={busy}
          title="Send it into the running turn at its next step"
          onClick={() => submit("send-now")}
        >
          Send now
        </button>
      )}
      <button
        type="button"
        className="linkish"
        disabled={busy}
        title="Take it back into your composer"
        onClick={() => submit("retract")}
      >
        Retract
      </button>
    </span>
  );
}
