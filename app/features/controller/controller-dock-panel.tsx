import { Fragment, useEffect, useRef, type RefObject } from "react";
import { Link } from "react-router";
import { MessageState, TurnStep, WorkingSentence } from "./turn-step";
import { answeredMessageIds, inReplyOrder, workingRowAfter } from "~/shared/controller-thread";
import { useFreshMessageIds } from "./use-fresh-messages";
import { useTranscriptFollow, useTurnAnnouncement } from "./transcript-follow";
import type { ControllerDockView } from "./controller-dock-query.server";
import type { ConversationTurnState } from "~/server/controller/controller-run.server";
import type { UnseenReplyView } from "~/routes/resources.controller-unseen";
import { CONNECT_TO_SEND, NotConnectedNote } from "./not-connected";
import { controllerExamples } from "./controller-examples";
import { Icon } from "~/ui/icon";
import { Markdown } from "~/ui/markdown";
import { LocalDayDotTime } from "~/ui/local-time";
import { useModifierHint } from "~/ui/use-shortcut-hint";

/**
 * The OPEN controller dock's body (ruling 121): the context line, the replies
 * waiting elsewhere, the transcript or the thread list, and the composer.
 *
 * Loaded on demand (ruling 457, FL-1). Root mounts the dock on every page, and
 * the transcript renders through the markdown pipeline, the heaviest thing the
 * dock needs, for a panel that starts closed. `controller-dock.tsx` keeps the
 * button, the panel's frame and header, and every piece of state, so closing
 * and reopening loses nothing; this module is only what the open panel draws,
 * and the button preloads it when a pointer or focus reaches it.
 */

/** Ruling 314's examples for the scope the dock is open on (shared with the
 *  page, ruling 419(g)). */
function emptyExamples(view: ControllerDockView): string[] {
  return controllerExamples(
    view.scope.kind === "task" && view.scope.taskKey
      ? { kind: "task", taskKey: view.scope.taskKey }
      : view.scope.kind === "board"
        ? { kind: "board" }
        : { kind: "instance" },
  );
}

function emptyCopy(view: ControllerDockView): string {
  if (view.scope.kind === "task") {
    return `Ask about ${view.scope.taskKey} or say what to do with it. The controller already has its task file.`;
  }
  if (view.scope.kind === "board") {
    return `Ask about the ${view.scope.projectName} board or say what to do on it: tasks, agents, goal chains.`;
  }
  return "Ask about this instance or say what to do: projects, users, resources, agents, goal chains.";
}

/**
 * The dock's "is working…" row (ruling 250's step beside it). Visual only
 * (ruling 476(d)): the announcer beside the dock's button says the turn is
 * working, and the panel's own region says it replied.
 */
function DockWorkingRow({ name, turn }: { name: string; turn: ConversationTurnState }) {
  return (
    <div className="ctl-working">
      <span className="live-dot" />
      <WorkingSentence name={name} />
      {/* Ruling 250: the dock follows a person onto every page and has no
          live-run panel at all, so this row is the ONLY place the turn's own
          step can reach them here. */}
      <TurnStep turn={turn} />
    </div>
  );
}

export interface DockPanelBodyProps {
  /** The view for the CURRENT scope, or null while it loads. */
  current: ControllerDockView | null;
  /** The shown thread's turn: the view's, with the step the dock's status
   *  polled since (ruling 457, CTL-2). */
  turn: ConversationTurnState | null;
  /** Replies waiting in other threads (the one on screen is left out). */
  unseen: readonly UnseenReplyView[];
  threadsOpen: boolean;
  busy: boolean;
  disabled: boolean;
  text: string;
  onText: (text: string) => void;
  /** Sends the box, or the example the person clicked (ruling 314). */
  onSubmit: (override?: string) => void;
  /** Opens a thread of this scope in place. */
  onPick: (id: string) => void;
  /** A link out of the dock was followed: close without animating. */
  onLeave: () => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  /** The body is on screen; focus may move into it (a lazy load lands after
   *  the open that asked for it). */
  onMount: () => void;
}

export function DockPanelBody({
  current,
  turn,
  unseen,
  threadsOpen,
  busy,
  disabled,
  text,
  onText,
  onSubmit,
  onPick,
  onLeave,
  composerRef,
  onMount,
}: DockPanelBodyProps) {
  // Ruling 419(d): the send handler takes ⌘ OR Ctrl, so the hint names the key
  // this keyboard has (UI-55; the page's composer shares the rule).
  const sendHint = useModifierHint("↵");
  const threads = current?.threads ?? [];
  const unavailable = current?.unavailable ?? false;
  const working = turn?.working ?? false;

  useEffect(() => {
    onMount();
  }, [onMount]);

  // Message entry motion: only a message that arrives while THIS conversation
  // is already on screen animates (the page shares the rule, ruling 451(d)).
  const conversationId = current?.conversation?.id ?? null;
  const messages = current?.messages ?? [];
  const fresh = useFreshMessageIds(messages, conversationId);
  // Ruling 465: the page's order and vocabulary — each reply under the
  // message it answers, "answering now" / "queued · N ahead" on a message
  // with no reply yet, and "is working…" under the message the turn answers.
  const ordered = inReplyOrder(messages);
  const answered = answeredMessageIds(messages);
  const workingAfter = workingRowAfter(ordered, turn?.answering ?? null);

  // Scroll the transcript's own box, never the page underneath. This body
  // mounts on every open, and a fresh scroll container starts at scrollTop 0,
  // so an open places it too: the transcript came back scrolled to its oldest
  // message (review finding 16). Ruling 476(c): the page's rule, so a reply
  // that lands shows its first line, not its last.
  const scrollRef = useRef<HTMLDivElement>(null);
  // The thread list swaps the transcript's box out, and the box it swaps back
  // in starts at its top: that is an open too.
  useTranscriptFollow(scrollRef, messages, fresh, working, `${conversationId ?? ""}:${threadsOpen}`);
  // Ruling 476(d): a reply to the thread on screen is announced here; the
  // announcer beside the button leaves this thread out while the panel is open.
  const said = useTurnAnnouncement(current?.controllerName ?? "Controller", messages, fresh, false);

  return (
    <>
      <p className="dock-context fine xs dim">
        {current?.scope.contextLine ?? "Reading where you are…"}
      </p>
      <span className="vh" role="status" aria-live="polite" data-turn-announcer>
        {said}
      </span>
      {unseen.length > 0 && (
        <p className="dock-unseen fine xs">
          <span className="unseen-dot" aria-hidden="true" />
          <span>
            New {unseen.length === 1 ? "reply" : "replies"} in{" "}
            {unseen.slice(0, 3).map((u, i) => (
              <Fragment key={u.id}>
                {i > 0 && ", "}
                {threads.some((t) => t.id === u.id) ? (
                  // A thread of this scope opens right here.
                  <button type="button" className="linkish" onClick={() => onPick(u.id)}>
                    {u.title}
                  </button>
                ) : (
                  <Link className="linkish" to={u.href} onClick={onLeave}>
                    {u.taskKey ? `${u.taskKey} · ${u.title}` : u.title}
                  </Link>
                )}
              </Fragment>
            ))}
            {unseen.length > 3 && ` and ${unseen.length - 3} more`}
          </span>
        </p>
      )}
      {unavailable ? (
        <section className="dock-body" aria-label="Controller unavailable here">
          <p className="empty sm">
            The controller has nothing to work with here: this project or
            task is not open to you, or it no longer exists. Everything else
            on the page still works.
          </p>
        </section>
      ) : threadsOpen ? (
        <section className="dock-body dock-threads" aria-label="Threads here">
          {threads.length === 0 ? (
            <p className="empty sm">No threads here yet.</p>
          ) : (
            <ul className="ctl-conv-list">
              {threads.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className={`ctl-conv${t.id === conversationId ? " on" : ""}${t.unread ? " unread" : ""}`}
                    aria-current={t.id === conversationId ? "true" : undefined}
                    onClick={() => onPick(t.id)}
                  >
                    <span className="ctl-conv-title">
                      {t.unread && <span className="unseen-dot" aria-hidden="true" />}
                      {t.title}
                      {t.unread && <span className="vh">, new reply</span>}
                    </span>
                    <span className="fine xs dim">
                      {t.lastMessageAt ? <LocalDayDotTime iso={t.lastMessageAt} /> : "empty"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section
          className="dock-body dock-transcript"
          ref={scrollRef}
          aria-label="Conversation transcript"
        >
          {!current ? (
            <p className="empty sm">Loading…</p>
          ) : !current.conversation ? (
            <div className="ctl-empty">
              <p className="empty sm">{emptyCopy(current)}</p>
              {/* Ruling 314: clicking one SENDS it. An example that only
                  fills the box would teach the same lesson and then ask the
                  person to find the button, which is the thing they were
                  already unsure about. */}
              <ul className="ctl-examples">
                {emptyExamples(current).map((example) => (
                  <li key={example}>
                    <button
                      type="button"
                      className="ctl-example"
                      onClick={() => onSubmit(example)}
                      disabled={busy || disabled}
                    >
                      {example}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="ctl-msgs dock-msgs">
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
                          "You"
                        ) : (
                          <>
                            <Icon name="cpu" /> {current.controllerName}
                          </>
                        )}
                      </span>
                      <LocalDayDotTime iso={m.createdAt} />
                      {m.author === "user" && !answered.has(m.id) && (
                        <MessageState turn={turn} messageId={m.id} />
                      )}
                    </header>
                    <div className="md-body">
                      <Markdown text={m.text} taskLinks={current.taskLinks} />
                    </div>
                  </article>
                  {m.id === workingAfter && turn?.working && (
                    <DockWorkingRow name={current.controllerName} turn={turn} />
                  )}
                </Fragment>
              ))}
              {workingAfter === null && turn?.working && (
                <DockWorkingRow name={current.controllerName} turn={turn} />
              )}
            </div>
          )}
        </section>
      )}
      <div className="dock-composer">
        <div className="ctl-composer">
          {current && !current.available && <NotConnectedNote />}
          <textarea
            ref={composerRef}
            value={text}
            onChange={(e) => onText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                onSubmit();
              }
            }}
            rows={2}
            placeholder={
              !current
                ? "Loading…"
                : disabled
                  ? current.available
                    ? "Read-only: only the thread's owner can talk in it."
                    : // Ruling 127: the dock bills the person reading it,
                      // and says so in the note above the box (U39-10).
                      CONNECT_TO_SEND
                  : "Ask the controller, or tell it what to do here…"
            }
            disabled={disabled}
            aria-label="Message to the controller"
          />
          <div className="ctl-composer-foot">
            <span className="fine xs dim">
              Acts with your permissions
              <span className="kbd-hint" suppressHydrationWarning>
                {` · ${sendHint} sends`}
              </span>
            </span>
            <button
              type="button"
              className="btn primary sm"
              onClick={() => onSubmit()}
              disabled={busy || disabled || !text.trim()}
              aria-busy={busy || undefined}
            >
              {busy && <Icon name="loader" className="spin" />}
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

