import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { useFetcher, useLocation, useNavigate } from "react-router";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import { hashTarget, timelineEventTime } from "~/shared/page-anchors";
import { MESSAGE_BATCH } from "~/shared/attachment-kinds";
import { useFileDrop } from "~/ui/attach-files";
import { useCsrfToken } from "~/ui/csrf-input";
import { useHydrated } from "~/ui/local-time";
import { addPickedFiles, type PickedFiles } from "~/ui/picked-files";
import { useToast } from "~/ui/toast";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useHashTarget } from "~/ui/use-hash-target";
import type { CommentComposerHandle } from "./comment-composer-slot";
import type { TimelineFilterId } from "./timeline";
import { isEventAnchor, shownBy } from "./timeline-derive";

/**
 * The timeline's post and its tab (ruling 695(e), the split of `timeline.tsx`
 * along the task page's recipe): the comment the composer sends, with its
 * fetcher, toast, file tray and the "Ask operator" prefill, and the filter tab
 * with the step a link to an event takes (ruling 497). `Timeline` calls them
 * where its hooks always ran, so the comment fetcher keeps its key, and draws
 * what they return. No component lives here, so the module is not a Fast Refresh
 * boundary, like `task-detail-actions.tsx`.
 */

export interface CommentPost {
  composerRef: RefObject<CommentComposerHandle | null>;
  composerBoxRef: RefObject<HTMLDivElement | null>;
  /** The comment fetcher is out. */
  busy: boolean;
  /** The last send's refusal, while the fetcher rests on it. */
  commentError: string | null | undefined;
  files: PickedFiles["files"];
  fileProblem: PickedFiles["problem"];
  addFiles: (incoming: File[]) => void;
  removeFile: (name: string) => void;
  dropping: boolean;
  dropProps: ReturnType<typeof useFileDrop>["dropProps"];
  send: () => void;
  submitDraft: () => void;
  keepDraft: (raw: string) => void;
}

/** The task comment: the composer's draft, its files and its send. */
export function useCommentPost({
  ask,
  canAttach,
  onAgentLog,
}: {
  /** "Ask operator" counter — each bump prefills + focuses the composer. */
  ask: number;
  canAttach: boolean;
  onAgentLog: ((threadId: string) => void) | undefined;
}): CommentPost {
  // The raw draft, synced synchronously from the editor. A ref, not state:
  // nothing renders from it (the editor owns the draft UI), and send() must
  // read the exact current text — not a value one batch behind the keystroke.
  const draftRef = useRef("");
  const composerRef = useRef<CommentComposerHandle>(null);
  const composerBoxRef = useRef<HTMLDivElement>(null);
  const seenAsk = useRef(ask);
  const fetcher = useFetcher<{
    ok: boolean;
    toast?: string;
    error?: string;
    logThreadId?: string | null;
  }>();
  const csrf = useCsrfToken();
  const push = useToast();
  const busy = fetcher.state !== "idle";

  // "Ask operator" (spec §4.2): prefill only a blank draft, scroll + focus.
  useEffect(() => {
    if (ask && ask !== seenAsk.current) {
      seenAsk.current = ask;
      composerRef.current?.prefillIfEmpty("@operator ");
      composerBoxRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      composerRef.current?.focus();
    }
  }, [ask]);

  // Comment result: success clears the draft + toasts (server copy);
  // failure keeps the draft and shows the inline error below.
  // Ruling 573: the files going with the comment, and the first refused.
  // One state, so an add builds on the picks before it through the updater.
  const [tray, setTray] = useState<PickedFiles>({ files: [], problem: null });
  const { files, problem: fileProblem } = tray;
  // Stable, so the memoised paperclip and tray skip a revalidation's render
  // (ruling 457).
  const addFiles = useCallback((incoming: File[]) => {
    setTray((cur) => addPickedFiles(cur.files, incoming, MESSAGE_BATCH));
  }, []);
  const removeFile = useCallback((name: string) => {
    setTray((cur) => ({ files: cur.files.filter((file) => file.name !== name), problem: null }));
  }, []);
  const { dropping, dropProps } = useFileDrop(addFiles, !canAttach);
  const pendingFiles = useRef<readonly File[]>([]);
  useFetcherResult(fetcher, (data) => {
    const sentFiles = pendingFiles.current;
    pendingFiles.current = [];
    if (data.ok) {
      // Ruling 573: the files that went out leave the tray; a failure keeps them.
      setTray((cur) => ({
        files: cur.files.filter((file) => !sentFiles.includes(file)),
        problem: null,
      }));
      draftRef.current = "";
      // Clear the editor AND its undo history — ⌘Z must not resurrect a
      // posted comment. A failure runs neither: the draft stays as typed.
      composerRef.current?.clearAfterSuccess();
      if (data.toast) push(data.toast);
      // BUG 3: hand the grouped Agent-logs id up so the page selects + scrolls
      // to the mentioned agent's live output.
      if (data.logThreadId && onAgentLog) onAgentLog(data.logThreadId);
    }
  });

  const commentError =
    fetcher.state === "idle" && fetcher.data && !fetcher.data.ok
      ? fetcher.data.error
      : null;

  const send = () => {
    const text = draftRef.current.trim();
    // Ruling 573: files alone are a comment.
    if ((!text && files.length === 0) || busy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "comment");
    fd.set("text", text);
    for (const file of files) fd.append("files", file);
    pendingFiles.current = files;
    fetcher.submit(fd, files.length > 0 ? { method: "post", encType: "multipart/form-data" } : { method: "post" });
  };
  // Ruling 457 (CS-7): the composer is memoised, so what it is handed holds
  // still while nothing it draws changed: a revalidation or a fetcher state
  // re-renders this timeline, not the editor. ⌘↵ reaches the latest `send`
  // through a ref kept current in an effect.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  const submitDraft = useCallback(() => sendRef.current(), []);
  const keepDraft = useCallback((raw: string) => {
    draftRef.current = raw;
  }, []);

  return {
    composerRef,
    composerBoxRef,
    busy,
    commentError,
    files,
    fileProblem,
    addFiles,
    removeFile,
    dropping,
    dropProps,
    send,
    submitDraft,
    keepDraft,
  };
}

/** What `useTimelineTab` hands the list: the tab, and where a link landed. */
export interface TimelineTab {
  f: TimelineFilterId;
  setF: Dispatch<SetStateAction<TimelineFilterId>>;
  /** Ruling 497: the anchor the link that opened the page names, while it
   *  marks its event. */
  targeted: string | null;
  /** Ruling 523: the event the latest link named, still focusable after the
   *  person's next press ends its mark. */
  arrived: string | null;
}

/**
 * The filter tab the timeline shows, and the event a link lands on.
 *
 * Ruling 497: a notification about an event opens it here. A filter tab that
 * hides it opens to All, older events load until it is among them, and it
 * comes into view, marked (`useHashTarget`). Each step happens once for the
 * navigation that named the event, so the person can switch tabs after.
 */
export function useTimelineTab({
  tlDefault,
  rows,
  hasMore,
  nextLimit,
}: {
  tlDefault: TimelineFilterId;
  rows: TimelineEventRender[];
  hasMore: boolean;
  nextLimit: number;
}): TimelineTab {
  const [f, setF] = useState<TimelineFilterId>(tlDefault);
  const location = useLocation();
  const navigate = useNavigate();
  // After hydration only, as `useHashTarget` reads it: the server never sees it.
  const targetTime = useHydrated() ? timelineEventTime(hashTarget(location.hash)) : null;
  const target = targetTime ? (rows.find((e) => e.occurredAt === targetTime) ?? null) : null;
  const targeted = useHashTarget(isEventAnchor, target !== null && shownBy(f, target));
  // Ruling 523: the event the latest link named, still focusable after the
  // person's next press ends its mark.
  const [arrived, setArrived] = useState<string | null>(null);
  if (targeted !== null && targeted !== arrived) setArrived(targeted);
  const steppedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!targetTime || steppedFor.current === location.key) return;
    if (target) {
      // Spent once found, even when the tab already shows it: a later tab
      // that hides it is the person's choice.
      steppedFor.current = location.key;
      if (!shownBy(f, target)) setF("all");
      return;
    }
    // Newest first: when the oldest event loaded is older than the target,
    // the target would be among them, so this timeline no longer holds it.
    const oldest = rows.at(-1);
    if (!hasMore || (oldest && oldest.occurredAt < targetTime)) return;
    steppedFor.current = location.key;
    const search = new URLSearchParams(location.search);
    search.set("events", String(nextLimit));
    void navigate(
      { pathname: location.pathname, search: `?${search}`, hash: location.hash },
      { replace: true, preventScrollReset: true },
    );
  }, [targetTime, target, f, rows, hasMore, nextLimit, location, navigate]);
  return { f, setF, targeted, arrived };
}
