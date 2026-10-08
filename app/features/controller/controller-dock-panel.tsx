import { useEffect, useRef, useState, type RefObject } from "react";
import { useFreshMessageIds } from "./use-fresh-messages";
import { useTranscriptFollow, useTurnAnnouncement } from "./transcript-follow";
import type { ControllerDockView } from "./controller-dock-query.server";
import type {
  ConversationTurnState,
  SendMode,
} from "~/server/controller/controller-run.server";
import type { UnseenReplyView } from "~/routes/resources.controller-unseen";
import { DockBodyBox, DockComposer, DockUnseenLine } from "./controller-dock-panel-regions";
import { useModifierHint } from "~/ui/use-shortcut-hint";
import { useFileDrop } from "~/ui/attach-files";
import { addPickedFiles } from "~/ui/picked-files";
import { MESSAGE_BATCH } from "~/shared/attachment-kinds";

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
 *
 * Ruling 700(e): the body keeps its hooks and composes the regions in
 * `controller-dock-panel-regions.tsx`, which call none.
 */

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
  /** Sends the box, or the example the person clicked (ruling 314); ruling
   *  527's `queue` waits behind a working turn instead of steering it. */
  onSubmit: (override?: string, mode?: SendMode) => void;
  /** Ruling 527: the waiting messages' Send now and Retract post with it. */
  csrf: string;
  /** Opens a thread of this scope in place. */
  onPick: (id: string) => void;
  /** A link out of the dock was followed: close without animating. */
  onLeave: () => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  /** Ruling 573: the files going with the next message, held by the shell. */
  files: File[];
  onFiles: (update: (current: File[]) => File[]) => void;
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
  csrf,
  onPick,
  onLeave,
  composerRef,
  onMount,
  files,
  onFiles,
}: DockPanelBodyProps) {
  // Ruling 419(d): the send handler takes ⌘ OR Ctrl, so the hint names the key
  // this keyboard has (UI-55; the page's composer shares the rule).
  const sendHint = useModifierHint("↵");
  const queueHint = useModifierHint("⇧↵");
  const threads = current?.threads ?? [];
  const unavailable = current?.unavailable ?? false;
  const working = turn?.working ?? false;

  useEffect(() => {
    onMount();
  }, [onMount]);

  // Ruling 573: picked, dropped or pasted files, refused as the server would.
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const addFiles = (incoming: readonly File[]) => {
    const next = addPickedFiles(files, incoming, MESSAGE_BATCH);
    onFiles(() => next.files);
    setFileProblem(next.problem);
  };
  const { dropping, dropProps } = useFileDrop(addFiles, disabled);

  // Message entry motion: only a message that arrives while THIS conversation
  // is already on screen animates (the page shares the rule, ruling 451(d)).
  const conversationId = current?.conversation?.id ?? null;
  const messages = current?.messages ?? [];
  const fresh = useFreshMessageIds(messages, conversationId);

  // Scroll the transcript's own box, never the page underneath. This body
  // mounts on every open, and a fresh scroll container starts at scrollTop 0,
  // so an open places it too: the transcript came back scrolled to its oldest
  // message (review finding 16). Ruling 476(c): the page's rule, so a reply
  // that lands shows its first line, not its last.
  const scrollRef = useRef<HTMLDivElement>(null);
  // The thread list draws into the transcript's own box (DockBodyBox keeps
  // one <section>, which React updates in place), so the transcript comes back
  // at whatever offset the list left. `threadsOpen` in the follow key makes
  // that return an open too, and the transcript is placed again. Ruling 572:
  // the page's way back to the newest message, too.
  const jump = useTranscriptFollow(scrollRef, messages, fresh, working, `${conversationId ?? ""}:${threadsOpen}`);
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
        <DockUnseenLine unseen={unseen} threads={threads} onPick={onPick} onLeave={onLeave} />
      )}
      <DockBodyBox
        current={current}
        turn={turn}
        unavailable={unavailable}
        threadsOpen={threadsOpen}
        threads={threads}
        messages={messages}
        fresh={fresh}
        conversationId={conversationId}
        csrf={csrf}
        text={text}
        onText={onText}
        onFiles={onFiles}
        busy={busy}
        disabled={disabled}
        onSubmit={onSubmit}
        onPick={onPick}
        scrollRef={scrollRef}
        jump={jump}
      />
      <DockComposer
        current={current}
        turn={turn}
        text={text}
        onText={onText}
        files={files}
        onFiles={onFiles}
        fileProblem={fileProblem}
        onFileProblem={setFileProblem}
        addFiles={addFiles}
        dropping={dropping}
        dropProps={dropProps}
        composerRef={composerRef}
        busy={busy}
        disabled={disabled}
        onSubmit={onSubmit}
        sendHint={sendHint}
        queueHint={queueHint}
      />
    </>
  );
}
