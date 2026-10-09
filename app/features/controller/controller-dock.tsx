import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  Link,
  useFetcher,
  useLocation,
  useMatches,
  useRouteLoaderData,
} from "react-router";
import type { ControllerDockView } from "./controller-dock-query.server";
import type { ConversationTurnState, SendMode } from "~/server/controller/controller-run.server";
import type { loader as projectLoader } from "~/routes/project";
import type {
  DockStatus,
  LiveTurnView,
  UnseenReplyView,
} from "~/routes/resources.controller-unseen";
import {
  DOCK_STATUS_URL,
  dockContextFromMatches,
  dockScopeKey,
  dockViewUrl,
  type DockContext,
} from "./controller-dock-context";
import { Icon } from "~/ui/icon";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { useCsrfToken } from "~/ui/csrf-input";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useSheetDrag } from "~/ui/use-sheet-drag";
import { viewerTimeZone } from "~/shared/dates/time-zone";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";
import { CONTROLLER_UPDATED_EVENT, sseScopes } from "~/features/live-updates/event-types";

/**
 * The controller DOCK (ruling 256): one floating Controller button on every
 * signed-in surface, opening a docked, NON-MODAL panel bound to the place the
 * person is standing — the instance, one board, or one task. Mounted once in
 * root; the scope follows the matched routes (`controller-dock-context.ts`).
 *
 * Same controller, same authority: sending here is the same turn the full
 * page sends, through `/resources/controller`. The panel keeps the page
 * usable (no scrim, no focus trap, no scroll lock), opens on the newest thread
 * of the current scope every time (ruling 256), keeps a thread the person
 * picks only while it stays open, remembers its open/closed state for the
 * life of the tab, and shows one line naming what the controller knows here.
 *
 * Live (ruling 11): the dock's two resources, the open panel's view and the
 * status every page's button reads (unseen replies, turns working), ride no
 * page revalidation. The dock loads them on the moments that change them: its
 * own opening, selection and sends, a `controller.updated` that the page's
 * `user` stream hands it (`CONTROLLER_UPDATED_EVENT`), and, while a turn
 * works, a 5 s poll of the small status. While open, the dock also holds its
 * own stream for the surfaces that have none.
 *
 * Ruling 11 (FL-1): this module is the CLOSED dock - the button, the panel's
 * frame and header, and all of the dock's state - and root puts it in every
 * route's first download. What the open panel draws (the transcript through
 * the markdown pipeline, the thread list, the composer) is
 * `controller-dock-panel.tsx`, loaded on the first open and preloaded when a
 * pointer or focus reaches the button.
 *
 * Ruling 13(b) (the large-component split, on the task page's recipe):
 * `DockShell` is composition. Its state and effects are hooks, called so that
 * every fetcher keeps its key and every effect its turn: the panel's frame and
 * its per-tab restore (`useDockFrame`), the selection and the view, the small
 * status and the loads that keep both current, the send and the draft it
 * carries, the close and the focus rules. The header, the trigger and its announcer are hook-free
 * components (`DockHead`, `DockTrigger`, `DockAnnouncer`). All of it stays in
 * this one module: root ships it, and a sibling would add a module to the
 * closed dock's ruling-11 budget (controller-dock-closure.perf.test.ts).
 */

const OPEN_KEY = "viberr.dock.open";
const WORKING_POLL_MS = 5_000;
/** The dock's `c` value that means "start with no conversation": the same
 *  `"new"` as `NEW_CONVERSATION_PARAM` (conversation-param.ts), spelled here
 *  because importing that leaf adds a module to the closed dock's ruling-11
 *  budget (controller-dock-closure.perf.test.ts). */
const NEW_THREAD = "new";
const USER_SCOPES = [sseScopes.user()];

/** The open panel's body, on demand (ruling 11, FL-1). */
const loadPanelBody = () => import("./controller-dock-panel");
const DockPanelBody = lazy(() =>
  loadPanelBody().then((m) => ({ default: m.DockPanelBody })),
);
function preloadPanelBody(): void {
  void loadPanelBody();
}

/**
 * What the open panel's body shows while its module loads: the same two lines
 * the body itself shows before its view has landed, so the frame reads the
 * same either way.
 */
function DockPanelBodyFallback() {
  return (
    <>
      <p className="dock-context fine xs dim">Reading where you are…</p>
      <section className="dock-body dock-transcript" aria-label="Conversation transcript">
        <p className="empty sm">Loading…</p>
      </section>
    </>
  );
}

interface DockPayload {
  view: ControllerDockView;
}

type SendResult =
  | { ok: true; conversationId: string }
  | { ok: false; error?: string };

/** Per-tab memory, wrapped: storage can be absent (SSR) or throw (private
 *  windows, blocked site data); the dock renders correctly without it. */
function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Nothing to do: the dock simply forgets across reloads.
  }
}

/**
 * The scope label from the ROUTE alone. The workspace loader already carries
 * the project's display name, so the trigger reads the same before the first
 * load and after it (review finding 17: it used to say the slug until the
 * panel had been opened once, then flip to the name).
 */
function localScopeLabel(context: DockContext): string {
  const project = context.projectName ?? context.projectSlug;
  if (context.taskKey) return `${context.taskKey} · ${project}`;
  if (project) return project;
  return "Instance";
}

export function ControllerDock() {
  const matches = useMatches();
  const location = useLocation();
  // `useRouteLoaderData`, not the match's own `data`: `useMatches()` carries no
  // loader data during SSR, so reading the name from there rendered the slug on
  // the server and the name after hydration — an attribute mismatch on the
  // trigger's accessible name. This hook is the repo's own way to read another
  // route's payload (the workspace layout reads the task route's the same way)
  // and it is typed, so nothing here parses an unknown.
  const workspace = useRouteLoaderData<typeof projectLoader>("routes/project");
  const projectName = workspace?.project.name ?? null;
  const context = useMemo(
    () => dockContextFromMatches(matches, location, projectName),
    [matches, location, projectName],
  );
  if (context.hidden) return null;
  return <DockShell context={context} />;
}

/** Holds the dock's own stream on the surfaces that have none, and only while
 *  the panel is open (a child, so the hook is never conditional). */
function DockLive() {
  useLiveUpdates(USER_SCOPES);
  return null;
}

type DockViewFetcher = ReturnType<typeof useFetcher<DockPayload | null>>;
type DockSendFetcher = ReturnType<typeof useFetcher<SendResult>>;
type DockStatusFetcher = ReturnType<typeof useFetcher<DockStatus | null>>;

/**
 * The panel's frame (ruling 13(b)): whether it is open or on its way out,
 * whether the tab's restore reopened it, whether the person opened it, and the
 * elements the close, the pull and focus move between. `useDockFrame` owns it
 * and the per-tab memory of whether it is open; the close and the focus rules
 * read it.
 */
interface DockFrame {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  closing: boolean;
  setClosing: Dispatch<SetStateAction<boolean>>;
  restoredOpen: boolean;
  setRestoredOpen: Dispatch<SetStateAction<boolean>>;
  openedByUser: RefObject<boolean>;
  hadFocusInside: RefObject<boolean>;
  dockRef: RefObject<HTMLDivElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  fabRef: RefObject<HTMLButtonElement | null>;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}

function useDockFrame(): DockFrame {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  // Ruling 285 (F24), "skip animation on page load": a panel the per-tab
  // restore reopens (a reload, or a return from a page the dock is hidden on)
  // was already open, so it appears in place and a phone's trigger lands on
  // its perch instead of flying there (`data-restored`, app.css). Only the
  // trigger clears it. A close never does: the attribute is gated on `open`,
  // so it leaves with the panel, and a leaving panel is out of its rule.
  const [restoredOpen, setRestoredOpen] = useState(false);
  // Whether the person opened the panel themselves (the focus rules in
  // `useDockFocus`). Declared with the frame because the restore reads it too.
  const openedByUser = useRef(false);
  // Whether focus was inside the panel when it closed: `closeDock` reads it
  // before the panel unmounts, and the focus rules return focus on it.
  const hadFocusInside = useRef(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const panelRef = useRef<HTMLElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Restore per-tab state AFTER hydration: reading storage during render would
  // disagree with the server's closed markup.
  useEffect(() => {
    const stored = readSession(OPEN_KEY) === "1";
    // A click can be queued BEFORE this effect runs. React flushes passive
    // effects after the commit that paints the trigger, so there is a real gap
    // in which the button is on screen, clickable, and this restore has not
    // read storage yet - long enough for a fast hand, and wide open on a
    // saturated machine. Writing the stored answer over the top of the
    // person's own closed the panel they had just opened, or, when both
    // updates landed in one batch, meant it never opened at all.
    //
    // The panel starts closed and nothing else opens it, so an `open` that is
    // already true here can ONLY be that click - and it is the newer decision,
    // so it wins.
    setOpen((clicked) => clicked || stored);
    // A click that beat this read is the person's own open, and keeps its
    // entrance. The ref is read here, not in the updater, so render stays
    // pure. The updater keeps a `true` an earlier run set: under StrictMode
    // (the dev server) React runs this effect twice, and between the runs the
    // `[open]` write below has already stored "0" from the pre-restore render,
    // so the second run reads a closed dock and would clear the mark the
    // first run set, and a restored panel would replay its entrance.
    const fromStore = stored && !openedByUser.current;
    setRestoredOpen((was) => was || fromStore);
    restored.current = true;
  }, []);
  useEffect(() => {
    if (restored.current) writeSession(OPEN_KEY, open ? "1" : "0");
  }, [open]);

  return {
    open,
    setOpen,
    closing,
    setClosing,
    restoredOpen,
    setRestoredOpen,
    openedByUser,
    hadFocusInside,
    dockRef,
    panelRef,
    fabRef,
    composerRef,
  };
}

/** The thread the person picked (ruling 256) and the view the panel shows. */
interface DockViewRead {
  selected: Record<string, string>;
  setSelected: Dispatch<SetStateAction<Record<string, string>>>;
  /** The thread picked in THIS scope, if any. */
  selectedId: string | null;
  url: string;
  /** The payload, when it answers the scope the person stands in. */
  current: ControllerDockView | null;
}

/** The open panel's view: the selection it asks for, the URL it loads and the
 *  payload that answers the scope the person stands in. */
function useDockView(view: DockViewFetcher, context: DockContext, open: boolean): DockViewRead {
  // Ruling 256: per scope, the thread the person picked, started with New or
  // sent in, held while the panel stays open. Every open starts with none,
  // which asks for the scope's newest thread wherever it was written: kept per
  // tab, it hid a conversation started on the full page or on another device.
  const [selected, setSelected] = useState<Record<string, string>>({});
  const selectedId = selected[context.key] ?? null;
  // O39-d: `seen` only while the panel is open: the view is loaded only then
  // (ruling 11), and every such load reads the transcript it shows.
  const url = dockViewUrl(context, selectedId, open);
  const load = view.load;
  // Load whenever the panel is open and the target changes: a new scope
  // (navigation) or a new selection (threads, New, a send that started one).
  useEffect(() => {
    if (open) load(url);
  }, [open, url, load]);

  // Only trust a payload that answers the CURRENT scope; a stale one would
  // show the last board's transcript under a task's label for a beat.
  const current = useMemo(() => {
    const data = view.data?.view;
    return data && dockScopeKey(data.scope) === context.key ? data : null;
  }, [view.data, context.key]);

  // The server could not honour the selection - a picked thread it can no
  // longer show in this scope - and answered this scope's newest thread
  // instead. Forget the id rather than asking for it again on every load
  // (review finding 2).
  const stale = current?.staleSelection ?? false;
  useEffect(() => {
    if (!stale) return;
    setSelected((s) => {
      if (!(context.key in s)) return s;
      const next = { ...s };
      delete next[context.key];
      return next;
    });
  }, [stale, context.key]);
  return { selected, setSelected, selectedId, url, current };
}

/** What the dock's small status says, and the fetcher that reads it. */
interface DockStatusRead {
  fetcher: DockStatusFetcher;
  /** The thread the open panel shows, if any. */
  shownId: string | null;
  unseen: UnseenReplyView[];
  /** A turn of the viewer's works in THIS scope. */
  working: boolean;
  /** The status's word on the shown thread's turn, while it works. */
  liveShown: LiveTurnView | null;
  /** The shown thread's turn, its step moved by the status. */
  shownTurn: ConversationTurnState | null;
}

function useDockStatus(
  context: DockContext,
  open: boolean,
  current: ControllerDockView | null,
): DockStatusRead {
  // O39-d: replies the viewer has not seen, whatever scope they were asked
  // in. A turn runs one to five minutes, and a person who moved to another
  // page learned nothing when its answer landed. Ruling 11: the same small
  // status also names the viewer's turns working right now, which is what the
  // button's announcer and the open panel's step line read.
  //
  // Loaded when the dock mounts (the first page, and every return from a page
  // it stays off, where the controller page may have marked a reply read),
  // when the panel opens or closes and after it shows a transcript (which
  // marks it seen), on every `controller.updated` the page's stream hands the
  // dock, and by the working poll. Not on navigation or on a page's own
  // revalidation: neither changes it (RF-8).
  const status = useFetcher<DockStatus | null>({ key: "controller-unseen" });
  const loadStatus = status.load;
  const shownId = current?.conversation?.id ?? null;
  const shownCount = current?.messages.length ?? 0;
  useEffect(() => {
    loadStatus(DOCK_STATUS_URL);
  }, [loadStatus, open, shownId, shownCount]);
  // The transcript the open panel shows is being read.
  const unseen = (status.data?.unseen ?? []).filter((u) => !(open && u.id === shownId));
  const liveTurns = status.data?.working ?? [];
  // A turn of the viewer's is working in THIS scope: the button's announcer
  // says so, and the status is polled until it settles.
  const working = liveTurns.some((t) => dockScopeKey(t) === context.key);
  // The open panel's working row: the view says whether the shown thread's
  // turn works; the status moves its step (ruling 257) between view loads.
  const liveShown = liveTurns.find((t) => t.id === shownId) ?? null;
  const shownTurn = current
    ? liveShown && current.turn.working
      ? { ...current.turn, phase: liveShown.phase, step: liveShown.step }
      : current.turn
    : null;
  return { fetcher: status, shownId, unseen, working, liveShown, shownTurn };
}

/** Ruling 11 (CTL-4, CTL-2): the loads that keep the button and the open
 *  transcript current without the page revalidating. */
function useDockRefresh(
  view: DockViewFetcher,
  status: DockStatusRead,
  open: boolean,
  url: string,
  current: ControllerDockView | null,
): void {
  const load = view.load;
  const loadStatus = status.fetcher.load;
  const { shownId, working, liveShown } = status;
  // Ruling 11 (CTL-4): a conversation changed somewhere (the page's stream
  // says so). Refresh the button, and the transcript when it is on screen.
  const viewUrl = useRef(url);
  useEffect(() => {
    viewUrl.current = url;
  });
  useEffect(() => {
    const onUpdated = () => {
      loadStatus(DOCK_STATUS_URL);
      if (open) load(viewUrl.current);
    };
    window.addEventListener(CONTROLLER_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(CONTROLLER_UPDATED_EVENT, onUpdated);
  }, [open, load, loadStatus]);

  // Poll while a turn is working — open or not, so the settle a paused stream
  // missed still lands, and with it the button's unread dot after the panel
  // is closed. Ruling 11 (CTL-2): the poll reads the small
  // status, not the whole transcript: the step line moves from it, and the
  // view is reloaded only when the status and the view disagree about whether
  // the shown turn works (it started elsewhere, or it settled).
  const viewSaysWorking = current?.turn.working ?? false;
  const polling = working || (open && viewSaysWorking);
  const statusState = useRef(status.fetcher.state);
  useEffect(() => {
    statusState.current = status.fetcher.state;
  });
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      if (statusState.current === "idle") loadStatus(DOCK_STATUS_URL);
    }, WORKING_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, loadStatus]);
  const shownLive = liveShown !== null;
  const lastLive = useRef<{ id: string | null; live: boolean } | null>(null);
  const viewState = useRef(view.state);
  useEffect(() => {
    viewState.current = view.state;
  });
  useEffect(() => {
    const was = lastLive.current;
    lastLive.current = { id: shownId, live: shownLive };
    if (!open || !was || was.id !== shownId || was.live === shownLive) return;
    // A view already on its way was asked for by the same news (a
    // `controller.updated` loads both); only the poll's flip needs its own.
    if (viewSaysWorking !== shownLive && viewState.current === "idle") load(viewUrl.current);
  }, [open, shownId, shownLive, viewSaysWorking, load]);
}

/** The next message as the composer holds it, and the send that posts it. */
interface DockSend {
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  /** Ruling 258: the files going with the next message. */
  files: File[];
  setFiles: Dispatch<SetStateAction<File[]>>;
  /** A send is out. */
  busy: boolean;
  /** Sends the box, or the example the person clicked (ruling 319). */
  submit: (override?: string, mode?: SendMode) => void;
}

/** The dock's send: the draft it carries, its post through
 *  `/resources/controller`, and its answer, which clears the draft and moves
 *  the selection. */
function useDockSend(
  send: DockSendFetcher,
  view: DockViewFetcher,
  selection: DockViewRead,
  context: DockContext,
  open: boolean,
  csrf: string,
  disabled: boolean,
): DockSend {
  const push = useToast();
  const [text, setText] = useState("");
  // Ruling 258: the files going with the next message. Held by the shell with
  // the text so a close keeps both; the panel's lazy module does the picking.
  const [files, setFiles] = useState<File[]>([]);
  const { selected, setSelected, selectedId, url, current } = selection;
  const load = view.load;
  const busy = send.state !== "idle";
  // A send's result: an error is a toast (the transport failed; refusals are
  // in the transcript); a success selects the thread it landed in and reloads.
  const sentUnder = useRef(context.key);
  /** Ruling 319: what was submitted, held until the server answers. */
  const pending = useRef<string | null>(null);
  const pendingFiles = useRef<readonly File[]>([]);
  useFetcherResult(send, (result) => {
    if (!result.ok) {
      // The text is still in the composer, and Send is live again: the person
      // can retry or copy it out.
      push(result.error ?? "The controller could not take that. Try again.", "error");
      pending.current = null;
      pendingFiles.current = [];
      return;
    }
    // Ruling 319: cleared HERE, and only if the box still holds what went out —
    // somebody who started typing the next message while this one was in
    // flight keeps it. What went out is the TRIMMED text, so the box is
    // compared trimmed too: a message sent with a trailing space or newline
    // clears like any other. `sent` is read before the ref is nulled, because
    // React may run the updater later than the line after it.
    const sent = pending.current;
    const sentFiles = pendingFiles.current;
    setText((cur) => (cur.trim() === sent ? "" : cur));
    // Ruling 319: the files the same way, each one that went out.
    setFiles((cur) => cur.filter((f) => !sentFiles.includes(f)));
    pending.current = null;
    pendingFiles.current = [];
    const key = sentUnder.current;
    // A thread the selection does not name yet (a new one, or the scope's
    // newest with nothing selected) is selected, and the load effect above
    // fetches it. Ruling 11 (CTL-4): that is the ONE load, so the thread
    // already selected is reloaded here only when nothing else will. Only
    // while the panel is open and still stands where the send was made: the
    // context is the CURRENT one, so after a navigation this would ask for a
    // task thread under the board's scope - a request the route cannot answer
    // (review finding 2, path (a)); the selection is enough, and the load
    // effect fires when the person comes back to that scope.
    if (selected[key] !== result.conversationId) {
      setSelected((s) => ({ ...s, [key]: result.conversationId }));
    } else if (open && key === context.key) {
      load(url);
    }
  });

  /**
   * Ruling 319: `override` is the example the person clicked. It is a parameter
   * rather than `setText` + `submit()` because React has not re-rendered inside
   * the click — reading `text` there would post the EMPTY box, which is exactly
   * the failure `pending.current` exists to make impossible for typed messages.
   */
  const submit = (override?: string, mode: SendMode = "steer") => {
    const value = (override ?? text).trim();
    // Ruling 258: files alone are a message.
    if ((!value && files.length === 0) || busy || disabled || !current) return;
    const body = new FormData();
    for (const file of files) body.append("files", file);
    body.set("_csrf", csrf);
    body.set("intent", "send");
    body.set("text", value);
    // Ruling 319: steer a working turn, or queue behind it.
    body.set("mode", mode);
    body.set("surface", context.surface);
    // U39-24: the controller quotes times in the zone this page prints them in.
    body.set("timeZone", viewerTimeZone());
    if (context.projectSlug) body.set("project", context.projectSlug);
    if (context.taskKey) body.set("task", context.taskKey);
    // The SELECTION decides, not the view that happens to have landed. Between
    // choosing New (or another thread) and that view arriving, `current` still
    // holds the previous thread, and posting its id put the message in the
    // thread the person had just navigated away from (review finding 15).
    const target =
      selectedId !== null && selectedId !== current.conversation?.id
        ? selectedId
        : (current.conversation?.id ?? "");
    body.set("conversationId", target);
    sentUnder.current = context.key;
    // Ruling 319 (pass 37, F37-90): the box keeps the words until the server
    // takes them. `setText("")` used to run here, optimistically, and nothing
    // anywhere held the string — so an expired CSRF token, a 404 on a scope
    // that is not open, or any transport failure destroyed what the person had
    // written, leaving only a toast that unmounts itself after 2.6 seconds.
    // Four of the five longest messages on the live board are 1,800 to 2,200
    // characters, typed into a two-row textarea.
    pending.current = value;
    pendingFiles.current = files;
    // Ruling 11 (CTL-4): a send changes the conversation and nothing the page
    // under the dock renders, so it does not re-run the page's loaders; what
    // the turn then does to a board or a task arrives on that page's stream.
    // Ruling 258: a message with files goes as a multipart form.
    send.submit(body, {
      method: "post",
      action: "/resources/controller",
      defaultShouldRevalidate: false,
      encType: files.length > 0 ? "multipart/form-data" : "application/x-www-form-urlencoded",
    });
  };
  return { text, setText, files, setFiles, busy, submit };
}

/** How the panel closes: animated or at once, or on a link out of it. */
interface DockClose {
  closeDock: (instant: boolean) => void;
  /** A link out of the dock was followed: close without animating. */
  leaveDock: () => void;
}

/** The panel's close: a pointer close's exit, Escape, and the sheet's pull. */
function useDockClose(frame: DockFrame): DockClose {
  const { open, setOpen, closing, setClosing, hadFocusInside, dockRef, panelRef } = frame;
  // Close: a pointer close plays the exit transition and unmounts on
  // transitionend (the useDialog recipe); Escape closes instantly, because a
  // keyboard-initiated action never animates.
  //
  // Ruling 285 (F20): the entrance is a transition too (from @starting-style),
  // so `data-closing` retargets the panel from wherever it is, mid-entrance
  // included. Nothing is pinned: ruling 287's live pose is for surfaces
  // that still enter on a keyframe, which Chrome will not transition out of.
  const closeDock = useCallback(
    (instant: boolean) => {
      // Read it here, before the panel unmounts and the answer is always no.
      hadFocusInside.current =
        panelRef.current?.contains(document.activeElement) ?? false;
      if (instant || !panelRef.current) {
        setClosing(false);
        setOpen(false);
        return;
      }
      setClosing(true);
    },
    [hadFocusInside, panelRef, setClosing, setOpen],
  );
  const leaveDock = useCallback(() => closeDock(true), [closeDock]);
  // A pointer close waits for its exit. Turned around before it ends (the
  // trigger's click below), `closing` goes false and the cleanup drops the
  // listener and the fallback, so nothing unmounts.
  useEffect(() => {
    if (!closing) return;
    const panel = panelRef.current;
    if (!panel) {
      setClosing(false);
      setOpen(false);
      return;
    }
    let done = false;
    let fallback: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      panel.removeEventListener("transitionend", onEnd);
      if (fallback !== null) clearTimeout(fallback);
      setClosing(false);
      setOpen(false);
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === panel) finish();
    };
    // 0/NaN in jsdom (no stylesheet), or ~0 where the sheet's reduced-motion
    // rules apply: both mean close now.
    const seconds = parseFloat(getComputedStyle(panel).transitionDuration);
    if (!(seconds > 0.02)) {
      finish();
      return;
    }
    panel.addEventListener("transitionend", onEnd);
    fallback = setTimeout(finish, seconds * 1000 + 50);
    return () => {
      panel.removeEventListener("transitionend", onEnd);
      if (fallback !== null) clearTimeout(fallback);
    };
  }, [closing, panelRef, setClosing, setOpen]);
  // Ruling 285: at sheet width a finger pulls the dock down to dismiss it.
  // The gesture has already carried the sheet out of sight when it calls
  // back, so the unmount is the instant one.
  //
  // A pointer close ends the gesture too, not only the unmount: the hook's
  // closed layout effect stops a return spring, a dismiss spring or a
  // reduced-motion fade and clears the host in the close's own commit (the
  // closing rules never read `--sheet-drag`, so the exit looks the same).
  // Left running, a trigger click that takes the close back (ruling 285,
  // F20) would drop [data-closing] under a live `data-sheet-drag`, whose
  // `transition: none` snaps the sheet and its perched trigger onto the
  // spring's offset instead of retargeting, and a dismiss spring would then
  // finish and close the dock the person had just kept open.
  useSheetDrag({
    sheetRef: panelRef,
    hostRef: dockRef,
    open: open && !closing,
    onDismiss: () => closeDock(true),
  });
  // Escape is handled ON THE PANEL (its onKeyDown in DockShell), not on the
  // document. `useDismiss` closes on any Escape anywhere, so dismissing the
  // palette, a confirm dialog or a stage menu took the helper with it (review
  // finding 8). An outside press still never closes the dock.
  //
  // Interface review 2026-09-24 (acce-14): one exception. With no focus trap
  // (ruling 318), Tab walks onto page controls the panel covers, and at 320px
  // or 200% zoom the sheet covers most of the page. Escape with focus on such a
  // control closes the dock and uncovers it, leaving focus where it is (WCAG
  // 2.4.11). Everything finding 8 protects still leaves the dock alone: an
  // Escape something else handled, focus on an open popover's trigger or in a
  // menu (useDismiss closes those without preventDefault), focus on nothing,
  // and any control the panel does not cover, which includes a modal dialog's
  // top layer.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const panel = panelRef.current;
      const focused = document.activeElement;
      if (!panel || !(focused instanceof HTMLElement) || focused === document.body) return;
      if (panel.contains(focused)) return;
      if (focused.closest('[aria-expanded="true"], [role="menu"], [role="listbox"]')) return;
      const box = focused.getBoundingClientRect();
      // Optional-chained: jsdom has no elementFromPoint, so it no-ops in tests.
      const hit = document.elementFromPoint?.(box.left + box.width / 2, box.top + box.height / 2);
      if (hit && panel.contains(hit)) closeDock(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, closeDock, panelRef]);
  return { closeDock, leaveDock };
}

/** The two moves of focus the shell makes outside the focus effects. */
interface DockFocus {
  /** Into the composer, or onto the panel when the composer takes nothing. */
  focusInside: () => void;
  /** The panel's lazy body is on screen. */
  bodyMounted: () => void;
}

/** Where focus goes when the panel opens, when its body or its composer
 *  lands, and when it closes. */
function useDockFocus(frame: DockFrame, disabled: boolean, threadsOpen: boolean): DockFocus {
  const { open, openedByUser, hadFocusInside, panelRef, fabRef, composerRef } = frame;
  // Focus, on a USER-INITIATED open only (review findings 7 and 10). Opening
  // the dock means wanting to type, so the composer takes focus; when it cannot
  // (this person has no Claude connected, a read-only thread, the view still
  // loading) the panel itself
  // does, so a keyboard user is inside the dialog either way. Closing returns
  // focus to the button - the panel renders BEFORE its trigger, like the bell
  // popover.
  //
  // The per-tab restore also flips `open`, and a restore is not a user action:
  // focusing there put every full page load inside the textarea, past the skip
  // link and the page heading. So both arms ask whether the person opened it
  // (`openedByUser`, declared with the dock's frame).
  const focusInside = useCallback(() => {
    const composer = composerRef.current;
    if (composer && !composer.disabled) composer.focus();
    else panelRef.current?.focus();
  }, [composerRef, panelRef]);
  // Closing returns focus to the trigger when focus was INSIDE the panel at
  // that moment — however the panel came to be open. Anything else leaves a
  // keyboard user's focus on nothing after the element holding it disappears.
  // (Opening is the asymmetric half: only a user action moves focus in.)
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      if (openedByUser.current) focusInside();
    } else if (wasOpen.current && hadFocusInside.current) {
      fabRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open, focusInside, openedByUser, hadFocusInside, fabRef]);
  // Ruling 11 (FL-1): the body can land after the open that asked for it (its
  // module loads on demand), and the open above could then only focus the
  // panel itself. Move in once it is there, only while focus still rests on
  // the panel - the same rule the re-aim below keeps.
  const bodyMounted = useCallback(() => {
    if (openedByUser.current && document.activeElement === panelRef.current) focusInside();
  }, [focusInside, openedByUser, panelRef]);

  // The view can land after the panel opened and only THEN enable the composer.
  // Re-aim once for that transition, and only when focus is still on the panel
  // itself - the fallback target. Focus resting on any other control in the
  // dock (Close, Threads, Send, a link in a reply) is the person's, and the 5 s
  // working poll must never take it back (review finding 7).
  const wasDisabled = useRef(true);
  useEffect(() => {
    const becameEnabled = wasDisabled.current && !disabled;
    wasDisabled.current = disabled;
    if (!open || !becameEnabled || threadsOpen || !openedByUser.current) return;
    if (document.activeElement === panelRef.current) focusInside();
  }, [open, disabled, threadsOpen, focusInside, openedByUser, panelRef]);
  return { focusInside, bodyMounted };
}

/** Whether the composer takes no message: the view has not landed, the scope
 *  is not this person's, their Claude is not connected, or the thread on
 *  screen is someone else's. */
function composerDisabled(current: ControllerDockView | null): boolean {
  // The scope itself is not this person's to talk in here (an unknown or
  // forbidden project, an unknown task): the panel says so and offers no
  // composer, and the page it sits on is untouched (review finding 2).
  const unavailable = current?.unavailable ?? false;
  return (
    !current ||
    unavailable ||
    !current.available ||
    (current.conversation !== null && !current.viewerOwnsActive)
  );
}

/** The full controller page for the scope and the thread the dock shows. */
function fullPageHref(current: ControllerDockView | null, context: DockContext): string {
  return (
    (current?.scope.pageHref ??
      (context.projectSlug ? `/projects/${context.projectSlug}/controller` : "/controller")) +
    // Ruling 256 + pass 33: the page now opens this scope's NEWEST thread when
    // no `?c=` is given (U33-8), so a dock sitting on a fresh, unsent thread must
    // say so explicitly — a bare link would hand the person an older
    // conversation instead of the blank composer they were looking at. `?c=new`
    // is the page's own token for "start empty".
    (current?.conversation
      ? `?c=${encodeURIComponent(current.conversation.id)}`
      : "?c=new")
  );
}

function DockShell({ context }: { context: DockContext }) {
  const csrf = useCsrfToken();
  // Ruling 256: a failed load answers null (the route's `clientLoader`), read
  // like the time before the first answer. Ruling 13(b): the two fetchers
  // come first, so their effects keep running ahead of the restore's.
  const view = useFetcher<DockPayload | null>({ key: "controller-dock" });
  const send = useFetcher<SendResult>({ key: "controller-dock-send" });
  const frame = useDockFrame();
  const { open, setOpen, closing, setClosing, restoredOpen, setRestoredOpen, openedByUser } = frame;
  const { dockRef, panelRef, fabRef, composerRef } = frame;
  const [threadsOpen, setThreadsOpen] = useState(false);

  const selection = useDockView(view, context, open);
  const { setSelected, url, current } = selection;
  const status = useDockStatus(context, open, current);
  useDockRefresh(view, status, open, url, current);

  const disabled = composerDisabled(current);
  const { text, setText, files, setFiles, busy, submit } = useDockSend(
    send,
    view,
    selection,
    context,
    open,
    csrf,
    disabled,
  );
  const { closeDock, leaveDock } = useDockClose(frame);
  const { focusInside, bodyMounted } = useDockFocus(frame, disabled, threadsOpen);

  const pick = (id: string) => {
    setSelected((s) => ({ ...s, [context.key]: id }));
    setThreadsOpen(false);
  };

  const onTrigger = () => {
    // Ruling 285 (F20): a click while the panel leaves takes the close
    // back. Dropping `data-closing` retargets the exit transition to
    // the open pose from wherever it has got to, and the closing
    // effect's cleanup drops its listener and timer. It is an open the
    // person asked for, so focus goes in as on any other; `open` is
    // re-asserted, never changed, so the focus effect will not do it.
    // A restored panel stops being one here: under `data-restored` the
    // way back would snap instead of retargeting. One branch per click:
    // this one never falls through to the close below.
    if (closing) {
      openedByUser.current = true;
      setRestoredOpen(false);
      setClosing(false);
      // The exit can have ended already: its transitionend (or the
      // fallback timer, or a pull's dismiss) queues `setOpen(false)` at
      // default priority, which React renders a task later, and Chrome
      // can run a queued click before that task. This handler still
      // sees `closing`, so without this the pending close would land
      // after it and unmount the composer focus is about to enter.
      // Queued after it, this open wins. While the exit still runs,
      // `open` is already true and this changes nothing.
      setOpen(true);
      focusInside();
      return;
    }
    if (open) {
      closeDock(false);
      return;
    }
    openedByUser.current = true;
    setRestoredOpen(false);
    // Ruling 256: a fresh open asks for the scope's newest thread; what
    // was picked while the panel was last open stayed with that open.
    setSelected({});
    setOpen(true);
  };

  const scopeLabel = current?.scope.label ?? localScopeLabel(context);

  return (
    <div
      className="dock"
      ref={dockRef}
      data-open={open ? "true" : "false"}
      data-restored={open && restoredOpen ? "" : undefined}
    >
      {open && context.needsOwnStream && <DockLive />}
      {open && (
        <section
          ref={panelRef}
          id="controller-dock-panel"
          className="dock-panel"
          role="dialog"
          aria-modal="false"
          aria-label="Controller dock"
          data-screen-label="Controller dock"
          tabIndex={-1}
          data-closing={closing ? "" : undefined}
          onKeyDown={(event) => {
            // Escape closes the dock only while focus is INSIDE it. On the
            // document it closed for every other overlay's Escape too (review
            // finding 8). Keyboard-initiated, so the close is instant.
            if (event.key !== "Escape") return;
            event.stopPropagation();
            closeDock(true);
          }}
        >
          {/* Ruling 285: at sheet width the grabber and the header are the
              sheet's drag handles (useSheetDrag); the grabber only says so.
              Close stays the named way out. */}
          <div className="dock-grabber" data-sheet-handle aria-hidden="true" />
          <DockHead
            current={current}
            scopeLabel={scopeLabel}
            threadsOpen={threadsOpen}
            pageHref={fullPageHref(current, context)}
            onThreads={() => setThreadsOpen((t) => !t)}
            onNew={() => pick(NEW_THREAD)}
            onLeave={leaveDock}
            onClose={() => closeDock(false)}
          />
          <Suspense fallback={<DockPanelBodyFallback />}>
            <DockPanelBody
              current={current}
              turn={status.shownTurn}
              unseen={status.unseen}
              threadsOpen={threadsOpen}
              busy={busy}
              disabled={disabled}
              text={text}
              onText={setText}
              files={files}
              onFiles={setFiles}
              onSubmit={submit}
              csrf={csrf}
              onPick={pick}
              onLeave={leaveDock}
              composerRef={composerRef}
              onMount={bodyMounted}
            />
          </Suspense>
        </section>
      )}
      <DockTrigger
        fabRef={fabRef}
        open={open}
        scopeLabel={scopeLabel}
        unseenCount={status.unseen.length}
        onClick={onTrigger}
      />
      <DockAnnouncer current={current} working={status.working} unseen={status.unseen} />
    </div>
  );
}

/** The panel's header: the controller's name, the scope, and its four
 *  moves (threads, New, the full page, Close). */
function DockHead({
  current,
  scopeLabel,
  threadsOpen,
  pageHref,
  onThreads,
  onNew,
  onLeave,
  onClose,
}: {
  current: ControllerDockView | null;
  scopeLabel: string;
  threadsOpen: boolean;
  pageHref: string;
  onThreads: () => void;
  onNew: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const threads = current?.threads ?? [];
  return (
    <header className="dock-head" data-sheet-handle>
      <span className="dock-head-icon">
        <Icon name="cpu" />
      </span>
      <span className="dock-title">{current?.controllerName ?? "Controller"}</span>
      <Pill kind="agent" sm>
        {scopeLabel}
      </Pill>
      <div className="dock-head-acts">
        <button
          type="button"
          className="icon-btn"
          // One name in both states: `aria-pressed` is what carries the
          // state, and a name that flips with it contradicts the state a
          // screen reader announces (review finding 25).
          aria-label={`Threads here (${threads.length})`}
          aria-pressed={threadsOpen}
          onClick={onThreads}
        >
          <Icon name="message" />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="New thread"
          onClick={onNew}
        >
          <Icon name="plus" />
        </button>
        <Link
          className="icon-btn"
          to={pageHref}
          aria-label="Open the full controller page"
          onClick={onLeave}
        >
          <Icon name="ext" />
        </Link>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close the controller dock"
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
      </div>
    </header>
  );
}

/** The floating Controller button every signed-in page carries. */
function DockTrigger({
  fabRef,
  open,
  scopeLabel,
  unseenCount,
  onClick,
}: {
  fabRef: RefObject<HTMLButtonElement | null>;
  open: boolean;
  scopeLabel: string;
  unseenCount: number;
  onClick: () => void;
}) {
  return (
    <button
      ref={fabRef}
      type="button"
      className="dock-fab"
      aria-label={`Controller · ${scopeLabel}${
        unseenCount === 0 ? "" : unseenCount === 1 ? " · a new reply" : ` · ${unseenCount} new replies`
      }`}
      aria-haspopup="dialog"
      aria-expanded={open}
      // A dangling `aria-controls` is worse than none (the repo already
      // decided this in command-palette.tsx and create-profile-modal.tsx):
      // the panel only exists while open.
      aria-controls={open ? "controller-dock-panel" : undefined}
      // Ruling 11 (FL-1): the open panel's body loads on demand; a pointer
      // or focus on the button is the moment to fetch it, so a click finds
      // it there.
      onPointerEnter={preloadPanelBody}
      onFocus={preloadPanelBody}
      onClick={onClick}
    >
      <Icon name="cpu" />
      {/* Ruling 291: the one dot is a reply the viewer has not read. A
          working turn shows in the open panel, never as a dot here. */}
      {unseenCount > 0 && <span className="unseen-dot" aria-hidden="true" />}
    </button>
  );
}

/**
 * The button carries no working dot (ruling 291), and the panel's working row
 * is visual only and unmounted while the dock is closed — so the one
 * programmatic form of "a turn is running" lives here, outside the panel
 * (review finding 26, ruling 320).
 */
function DockAnnouncer({
  current,
  working,
  unseen,
}: {
  current: ControllerDockView | null;
  working: boolean;
  unseen: readonly UnseenReplyView[];
}) {
  return (
    <span className="vh" role="status" aria-live="polite">
      {working
        ? `${current?.controllerName ?? "Controller"} is working`
        : unseen.length === 1
          ? `${current?.controllerName ?? "Controller"} replied in “${unseen[0]!.title}”`
          : unseen.length > 1
            ? `${current?.controllerName ?? "Controller"} replied in ${unseen.length} conversations`
            : ""}
    </span>
  );
}
