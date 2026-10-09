import { Fragment, type ReactNode } from "react";
import { MessageState } from "./turn-step";
import { answeredMessageIds, inReplyOrder, workingRowAfter } from "~/shared/controller-thread";
import { WaitingActions } from "./waiting-actions";
import { MessageFiles } from "./message-files";
import type { ControllerMessage } from "~/server/controller/controller-conversations.server";
import type { ConversationTurnState } from "~/server/controller/controller-run.server";
import type { TaskLinks } from "~/shared/task-key-links";
import { Icon } from "~/ui/icon";
import { Markdown } from "~/ui/markdown";
import { LocalDayDotTime } from "~/ui/local-time";

/** Ruling 251: what the sender's Send now and Retract post with. */
export interface MessageListWaiting {
  conversationId: string;
  csrf: string;
  action?: string;
  onRetracted: (text: string, files: readonly File[]) => void;
}

/**
 * A conversation's messages, as the page's transcript and the dock's draw them
 * (ruling 12: one list where each kept a copy).
 *
 * Ruling 320 (F40-8): each reply sits under the message it answers, an
 * unanswered message says where it stands ("answering now", "queued · N
 * ahead"), and `working`, the "is working…" row, sits under the message the
 * live turn answers, never under a later one. Ruling 251: a message that
 * steered the turn, or waits to, sits in it.
 */
export function MessageList({
  inDock = false,
  messages,
  turn,
  fresh,
  controllerName,
  userLabel,
  surfaceLabel,
  taskLinks,
  waiting,
  working,
}: {
  /** The dock's list, which its own rules size (`.dock-msgs`). */
  inDock?: boolean;
  messages: readonly ControllerMessage[];
  turn: ConversationTurnState | null;
  /** Ruling 284: the messages that arrived while the list was on screen. */
  fresh: ReadonlySet<string>;
  controllerName: string;
  userLabel: ReactNode;
  /** Ruling 249: the page names the surface a message was sent from. */
  surfaceLabel?: (surface: string) => string;
  taskLinks: TaskLinks;
  /** Ruling 251: Send now and Retract, when the viewer sent the messages. */
  waiting: MessageListWaiting | null;
  working: ReactNode;
}) {
  const ordered = inReplyOrder(messages, turn);
  const answered = answeredMessageIds(messages);
  const workingAfter = turn ? workingRowAfter(ordered, turn) : null;
  return (
    <div className={inDock ? "ctl-msgs dock-msgs" : "ctl-msgs"}>
      {ordered.map((m) => (
        <Fragment key={m.id}>
          <article
            className={`ctl-msg ${m.author === "user" ? "from-user" : "from-controller"}`}
            data-message-id={m.id}
            data-fresh={fresh.has(m.id) ? "true" : undefined}
          >
            <header>
              <span className="ctl-msg-who">
                {m.author === "user" ? (
                  userLabel
                ) : (
                  <>
                    <Icon name="cpu" /> {controllerName}
                  </>
                )}
              </span>
              <LocalDayDotTime iso={m.createdAt} />
              {surfaceLabel && m.surface && (
                <span className="ctl-msg-surface" title={m.surface}>
                  from {surfaceLabel(m.surface)}
                </span>
              )}
              {m.author === "user" && !answered.has(m.id) && (
                <MessageState turn={turn} messageId={m.id} steered={m.steeredInto !== null} />
              )}
              {m.author === "user" && waiting && (
                <WaitingActions turn={turn} messageId={m.id} files={m.files} {...waiting} />
              )}
            </header>
            {m.text && (
              <div className="md-body">
                <Markdown text={m.text} taskLinks={taskLinks} />
              </div>
            )}
            {m.files && <MessageFiles files={m.files} />}
          </article>
          {m.id === workingAfter && working}
        </Fragment>
      ))}
      {workingAfter === null && working}
    </div>
  );
}
