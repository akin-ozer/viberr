import { Fragment, type RefObject } from "react";
import { Link } from "react-router";
import { TurnStep, WorkingSentence } from "./turn-step";
import type { TranscriptJump } from "./transcript-follow";
import { TranscriptJumpButton } from "./transcript-jump";
import type { ControllerDockThread, ControllerDockView } from "./controller-dock-query.server";
import type { ControllerMessage } from "~/server/controller/controller-conversations.server";
import type {
  ConversationTurnState,
  SendMode,
} from "~/server/controller/controller-run.server";
import { withRetracted } from "./with-retracted";
import { MessageList } from "./message-list";
import type { UnseenReplyView } from "~/routes/resources.controller-unseen";
import { NotConnectedNote } from "./not-connected";
import { ControllerExampleList, controllerExamples, type ControllerExample } from "./controller-examples";
import { Icon } from "~/ui/icon";
import { LocalDayDotTime } from "~/ui/local-time";
import { AttachButton, AttachTray, type FileDropProps } from "~/ui/attach-files";
import { addPickedFiles, filesFromPaste } from "~/ui/picked-files";
import { MESSAGE_BATCH } from "~/shared/attachment-kinds";

/**
 * The OPEN controller dock's regions (ruling 696(e), the large-component split
 * on the task page's recipe, applied to `controller-dock-panel.tsx`): the
 * replies waiting elsewhere, the body's one box (the note where the controller
 * cannot work, the thread list or the transcript) and the composer. Each takes
 * the slot its markup held in `DockPanelBody` and calls no hook: the body keeps
 * every hook (the transcript's follow and announcer, the file drop, the
 * shortcut hints) and hands their results down, so the markup and every id
 * React derives from the tree are what they were. Loaded with the body, on
 * demand (ruling 457, FL-1).
 */

/** Ruling 314's examples for the scope the dock is open on (shared with the
 *  page, ruling 419(g)). */
function emptyExamples(view: ControllerDockView): ControllerExample[] {
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
    return `Ask about the ${view.scope.projectName} board or say what to do on it: tasks, epics, agents.`;
  }
  return "Ask about this instance or say what to do: projects, users, resources, agents, epics.";
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

/** O39-d: the replies waiting in other threads, the first three named. */
export function DockUnseenLine({
  unseen,
  threads,
  onPick,
  onLeave,
}: {
  unseen: readonly UnseenReplyView[];
  threads: readonly ControllerDockThread[];
  onPick: (id: string) => void;
  onLeave: () => void;
}) {
  return (
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
  );
}

/**
 * The body's box: the note where the controller cannot work, the thread list,
 * or the transcript. One component draws all three because to React they are
 * ONE `<section>` in one unkeyed slot of `DockPanelBody`: a Threads toggle, or
 * a view that turns unavailable, updates that element in place, so its node,
 * its scroll offset and the transcript's ref carry over. A component per box
 * would put three types in the slot and mount a fresh box on every toggle
 * (review of the ruling 696(e) split). The first child each box draws straight
 * into it stays inline for the same reason: the loading, no-threads and
 * unavailable notes are one `<p>` React keeps across those changes.
 */
export function DockBodyBox({
  current,
  turn,
  unavailable,
  threadsOpen,
  threads,
  messages,
  fresh,
  conversationId,
  csrf,
  text,
  onText,
  onFiles,
  busy,
  disabled,
  onSubmit,
  onPick,
  scrollRef,
  jump,
}: {
  current: ControllerDockView | null;
  turn: ConversationTurnState | null;
  /** The scope is not this person's to talk in, or they are signed out. */
  unavailable: boolean;
  threadsOpen: boolean;
  threads: readonly ControllerDockThread[];
  messages: readonly ControllerMessage[];
  fresh: ReadonlySet<string>;
  conversationId: string | null;
  csrf: string;
  text: string;
  onText: (text: string) => void;
  onFiles: (update: (current: File[]) => File[]) => void;
  busy: boolean;
  disabled: boolean;
  onSubmit: (override?: string, mode?: SendMode) => void;
  onPick: (id: string) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  jump: TranscriptJump | null;
}) {
  if (unavailable) {
    return (
      <section className="dock-body" aria-label="Controller unavailable here">
        <p className="empty sm">
          {current?.signedOut ? (
            // Ruling 457: the dock's loads answer a signed-out tab 401, never
            // a login redirect; the page's own navigation asks for the sign-in.
            <>
              You're signed out, so the controller can't answer here. Reload
              the page to sign in again.
            </>
          ) : (
            <>
              The controller has nothing to work with here: this project or
              task is not open to you, or it no longer exists. Everything else
              on the page still works.
            </>
          )}
        </p>
      </section>
    );
  }
  if (threadsOpen) {
    // The threads of this scope, the one on screen marked.
    return (
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
    );
  }
  // The transcript's box: loading, the scope's examples, or the thread.
  return (
    <section
      className="dock-body dock-transcript"
      ref={scrollRef}
      aria-label="Conversation transcript"
      // Ruling 626: as the page's transcript, a scroller the keyboard reaches.
      tabIndex={0}
    >
      {!current ? (
        <p className="empty sm">Loading…</p>
      ) : !current.conversation ? (
        <DockEmptyScope view={current} busy={busy} disabled={disabled} onSubmit={onSubmit} />
      ) : (
        <MessageList
          inDock
          messages={messages}
          turn={turn}
          fresh={fresh}
          controllerName={current.controllerName}
          userLabel="You"
          taskLinks={current.taskLinks}
          waiting={
            current.viewerOwnsActive && conversationId
              ? {
                  conversationId,
                  csrf,
                  action: "/resources/controller",
                  onRetracted: (retracted, back) => {
                    onText(withRetracted(text, retracted));
                    if (back.length > 0) onFiles((cur) => addPickedFiles(cur, back, MESSAGE_BATCH).files);
                  },
                }
              : null
          }
          working={turn?.working && <DockWorkingRow name={current.controllerName} turn={turn} />}
        />
      )}
      <TranscriptJumpButton jump={jump} />
    </section>
  );
}

/** A scope with no thread yet: what to ask here, and ruling 314's examples. */
function DockEmptyScope({
  view,
  busy,
  disabled,
  onSubmit,
}: {
  view: ControllerDockView;
  busy: boolean;
  disabled: boolean;
  onSubmit: (override?: string, mode?: SendMode) => void;
}) {
  return (
    <div className="ctl-empty">
      <p className="empty sm">{emptyCopy(view)}</p>
      {/* Ruling 625: as on the page, no examples a viewer whose
          Claude is not connected could not send; the note says what
          to do instead. */}
      {view.available && (
        <ControllerExampleList
          examples={emptyExamples(view)}
          disabled={busy || disabled}
          onSend={onSubmit}
        />
      )}
    </div>
  );
}

/** What the box says it is waiting for, or why it takes nothing. */
function composerPlaceholder(current: ControllerDockView | null, disabled: boolean): string | undefined {
  return !current
    ? "Loading…"
    : disabled
      ? current.signedOut
        ? "Sign in again to send a message."
        : current.available
          ? "Read-only: only the thread's owner can talk in it."
          : // Ruling 127: the dock bills the person reading it,
            // and says so in the note above the box (U39-10);
            // ruling 625: the box does not repeat it.
            undefined
      : "Ask the controller, or tell it what to do here…";
}

/** The composer: the not-connected note, the tray, the box and its foot. */
export function DockComposer({
  current,
  turn,
  text,
  onText,
  files,
  onFiles,
  fileProblem,
  onFileProblem,
  addFiles,
  dropping,
  dropProps,
  composerRef,
  busy,
  disabled,
  onSubmit,
  sendHint,
  queueHint,
}: {
  current: ControllerDockView | null;
  turn: ConversationTurnState | null;
  text: string;
  onText: (text: string) => void;
  files: File[];
  onFiles: (update: (current: File[]) => File[]) => void;
  fileProblem: string | null;
  onFileProblem: (problem: string | null) => void;
  addFiles: (incoming: readonly File[]) => void;
  dropping: boolean;
  dropProps: FileDropProps;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  busy: boolean;
  disabled: boolean;
  onSubmit: (override?: string, mode?: SendMode) => void;
  sendHint: string;
  queueHint: string;
}) {
  // Ruling 527: while a turn holds the thread, a message steers it or queues
  // behind it, and the composer offers both.
  const live = (turn?.answering ?? null) !== null;
  const empty = !text.trim() && files.length === 0;
  return (
    <div className="dock-composer">
      <div className="ctl-composer" data-dropping={dropping ? "" : undefined} {...dropProps}>
        {current && !current.available && !current.signedOut && <NotConnectedNote />}
        <AttachTray
          files={files}
          problem={fileProblem}
          disabled={busy}
          onRemove={(name) => {
            onFiles((cur) => cur.filter((f) => f.name !== name));
            onFileProblem(null);
          }}
        />
        <textarea
          ref={composerRef}
          value={text}
          onChange={(e) => onText(e.target.value)}
          onPaste={(e) => {
            // Ruling 573: a bare screenshot goes with the message; copied
            // text, cells included, stays text.
            const pasted = filesFromPaste(e.clipboardData, true, files);
            if (!pasted) return;
            e.preventDefault();
            addFiles(pasted);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              // Ruling 527: ⇧ queues behind a working turn.
              onSubmit(undefined, live && e.shiftKey ? "queue" : "steer");
            }
          }}
          rows={2}
          placeholder={composerPlaceholder(current, disabled)}
          disabled={disabled}
          aria-label="Message to the controller"
        />
        <DockComposerFoot
          live={live}
          busy={busy}
          disabled={disabled}
          blocked={busy || disabled || empty}
          addFiles={addFiles}
          onSubmit={onSubmit}
          sendHint={sendHint}
          queueHint={queueHint}
        />
      </div>
    </div>
  );
}

/** The composer's foot: attach, the key hint, and Queue beside Steer or Send. */
function DockComposerFoot({
  live,
  busy,
  disabled,
  blocked,
  addFiles,
  onSubmit,
  sendHint,
  queueHint,
}: {
  live: boolean;
  busy: boolean;
  disabled: boolean;
  /** Busy, disabled or empty: nothing can be sent. */
  blocked: boolean;
  addFiles: (incoming: readonly File[]) => void;
  onSubmit: (override?: string, mode?: SendMode) => void;
  sendHint: string;
  queueHint: string;
}) {
  return (
    <div className="ctl-composer-foot">
      <span className="att-lead">
        <AttachButton onFiles={addFiles} disabled={disabled || busy} />
        <span className="fine xs dim">
          Acts with your permissions
          <span className="kbd-hint" suppressHydrationWarning>
            {live ? ` · ${sendHint} steers · ${queueHint} queues` : ` · ${sendHint} sends`}
          </span>
        </span>
      </span>
      <span className="inline-row">
        {live && (
          <button
            type="button"
            className="btn sm"
            title="Wait for its own turn, after the one working now"
            onClick={() => onSubmit(undefined, "queue")}
            disabled={blocked}
          >
            Queue
          </button>
        )}
        <button
          type="button"
          className="btn primary sm"
          title={live ? "Go into the turn working now, at its next step" : undefined}
          onClick={() => onSubmit(undefined, "steer")}
          disabled={blocked}
          aria-busy={busy || undefined}
        >
          {busy && <Icon name="loader" className="spin" />}
          {busy ? "Sending…" : live ? "Steer" : "Send"}
        </button>
      </span>
    </div>
  );
}
