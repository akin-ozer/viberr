import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TurnStep, WorkingSentence } from "./turn-step";
import { useFreshMessageIds } from "./use-fresh-messages";
import {
  Link,
  useFetcher,
  useLocation,
  useMatches,
  useRouteLoaderData,
} from "react-router";
import { z } from "zod";
import type { ControllerDockView } from "./controller-dock-query.server";
import { CONNECT_TO_SEND, NotConnectedNote } from "./controller-page";
import { controllerExamples } from "./controller-examples";
import type { loader as projectLoader } from "~/routes/project";
import type { UnseenReplyView } from "~/routes/resources.controller-unseen";
import {
  dockContextFromMatches,
  dockScopeKey,
  dockViewUrl,
  type DockContext,
} from "./controller-dock-context";
import { Icon } from "~/ui/icon";
import { Markdown } from "~/ui/markdown";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { useCsrfToken } from "~/ui/csrf-input";
import { LocalDayDotTime } from "~/ui/local-time";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useModifierHint } from "~/ui/use-shortcut-hint";
import { viewerTimeZone } from "~/shared/dates/time-zone";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";
import { sseScopes } from "~/features/live-updates/event-types";

/**
 * The controller DOCK (ruling 121): one floating Controller button on every
 * signed-in surface, opening a docked, NON-MODAL panel bound to the place the
 * person is standing — the instance, one board, or one task. Mounted once in
 * root; the scope follows the matched routes (`controller-dock-context.ts`).
 *
 * Same controller, same authority: sending here is the same turn the full
 * page sends, through `/resources/controller`. The panel keeps the page
 * usable (no scrim, no focus trap, no scroll lock), reopens the newest thread
 * of the current scope, remembers the selected thread per scope and its
 * open/closed state for the life of the tab, and shows one line naming what
 * the controller knows here.
 *
 * Live: the view is a root-owned `fetcher.load`, which React Router re-runs on
 * every revalidation — so every surface that already streams the `user` scope
 * refreshes the dock for free; while open, the dock also holds its own stream
 * for the surfaces that have none, and polls while a turn is working.
 */

const OPEN_KEY = "viberr.dock.open";
const SELECTED_KEY = "viberr.dock.selected";
const WORKING_POLL_MS = 5_000;
/** The dock's `c` value that means "start with no conversation". */
const NEW_THREAD = "new";
const USER_SCOPES = [sseScopes.user()];

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
/** The stored selection map, parsed at the storage boundary: a scope key to
 *  a conversation id (or "new"). Anything else reads as empty. */
const selectedSchema = z.record(z.string(), z.string());
function readSelected() {
  const raw = readSession(SELECTED_KEY);
  if (!raw) return {};
  try {
    const parsed = selectedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
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

/** O39-d: the viewer's unseen controller replies, for the button. */
const UNSEEN_URL = "/resources/controller-unseen";

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
  const projectName = workspace?.board.project.name ?? null;
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

function DockShell({ context }: { context: DockContext }) {
  const csrf = useCsrfToken();
  const push = useToast();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  // Ruling 419(d): the send handler takes ⌘ OR Ctrl, so the hint names the key
  // this keyboard has (UI-55; the page's composer shares the rule).
  const sendHint = useModifierHint("↵");
  const restored = useRef(false);
  const panelRef = useRef<HTMLElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const view = useFetcher<DockPayload>({ key: "controller-dock" });
  const send = useFetcher<SendResult>({ key: "controller-dock-send" });

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
    // so it wins. (`selected` needs no such guard: every writer of it is
    // inside the panel, which cannot have been open yet.)
    setOpen((clicked) => clicked || stored);
    setSelected(readSelected());
    restored.current = true;
  }, []);
  useEffect(() => {
    if (restored.current) writeSession(OPEN_KEY, open ? "1" : "0");
  }, [open]);
  useEffect(() => {
    if (restored.current) writeSession(SELECTED_KEY, JSON.stringify(selected));
  }, [selected]);

  const selectedId = selected[context.key] ?? null;
  // O39-d: `seen` only while the panel is open. The working poll below loads
  // this view with the panel closed too, and that load reads nothing.
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

  // The server could not honour the stored selection - another user's thread
  // after an account switch in this tab, a re-baselined database, a thread from
  // another scope - and answered this scope's newest thread instead. Forget the
  // id rather than asking for it again on every load (review finding 2).
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

  // Poll while a turn is working — open or not, so the working dot on the
  // button stays honest after the panel is closed.
  const working = current?.turn.working ?? false;
  const viewState = useRef(view.state);
  useEffect(() => {
    viewState.current = view.state;
  });
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => {
      if (viewState.current === "idle") load(url);
    }, WORKING_POLL_MS);
    return () => clearInterval(timer);
  }, [working, url, load]);

  // O39-d: replies the viewer has not seen, whatever scope they were asked
  // in. A turn runs one to five minutes, and a person who moved to another
  // page learned nothing when its answer landed. Loaded on every navigation
  // and after the panel shows a transcript (which marks it seen); React
  // Router also revalidates it on the page's own live stream.
  const unseenFetch = useFetcher<{ unseen: UnseenReplyView[] }>({ key: "controller-unseen" });
  const loadUnseen = unseenFetch.load;
  const { pathname } = useLocation();
  const shownId = current?.conversation?.id ?? null;
  const shownCount = current?.messages.length ?? 0;
  useEffect(() => {
    loadUnseen(UNSEEN_URL);
  }, [loadUnseen, pathname, open, shownId, shownCount]);
  // The transcript the open panel shows is being read.
  const unseen = (unseenFetch.data?.unseen ?? []).filter((u) => !(open && u.id === shownId));

  // A send's result: an error is a toast (the transport failed; refusals are
  // in the transcript); a success selects the thread it landed in and reloads.
  const sentUnder = useRef(context.key);
  /** Ruling 259: what was submitted, held until the server answers. */
  const pending = useRef<string | null>(null);
  useFetcherResult(send, (result) => {
    if (!result.ok) {
      // The text is still in the composer, and Send is live again: the person
      // can retry or copy it out.
      push(result.error ?? "The controller could not take that. Try again.", "error");
      pending.current = null;
      return;
    }
    // Ruling 259: cleared HERE, and only if the box still holds exactly what
    // went out — somebody who started typing the next message while this one
    // was in flight keeps it.
    setText((cur) => (cur === pending.current ? "" : cur));
    pending.current = null;
    const key = sentUnder.current;
    setSelected((s) =>
      s[key] === result.conversationId ? s : { ...s, [key]: result.conversationId },
    );
    // Only reload while the dock still stands where the send was made. The
    // context here is the CURRENT one, so after a navigation this would ask for
    // a task thread under the board's scope - a request the route cannot answer
    // (review finding 2, path (a)). Recording the selection is enough: the load
    // effect fires when the person comes back to that scope.
    if (key === context.key) load(dockViewUrl(context, result.conversationId, open));
  });

  // Close: a pointer close plays the exit transition and unmounts on
  // transitionend (the useDialog recipe); Escape closes instantly, because a
  // keyboard-initiated action never animates.
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
    [],
  );
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
  }, [closing]);
  // Escape is handled ON THE PANEL (its onKeyDown below), not on the document.
  // `useDismiss` closes on any Escape anywhere, so dismissing the palette, a
  // confirm dialog or a stage menu took the helper with it (review finding 8).
  // An outside press still never closes the dock.
  //
  // Interface review 2026-09-24 (acce-14): one exception. With no focus trap
  // (ruling 121), Tab walks onto page controls the panel covers, and at 320px
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
  }, [open, closeDock]);

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
  // link and the page heading. So both arms ask whether the person opened it.
  const openedByUser = useRef(false);
  const focusInside = useCallback(() => {
    const composer = composerRef.current;
    if (composer && !composer.disabled) composer.focus();
    else panelRef.current?.focus();
  }, []);
  // Closing returns focus to the trigger when focus was INSIDE the panel at
  // that moment — however the panel came to be open. Anything else leaves a
  // keyboard user's focus on nothing after the element holding it disappears.
  // (Opening is the asymmetric half: only a user action moves focus in.)
  const hadFocusInside = useRef(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      if (openedByUser.current) focusInside();
    } else if (wasOpen.current && hadFocusInside.current) {
      fabRef.current?.focus();
    }
    wasOpen.current = open;
  }, [open, focusInside]);

  // Message entry motion: only a message that arrives while THIS conversation
  // is already on screen animates (the page shares the rule, ruling 451(d)).
  const conversationId = current?.conversation?.id ?? null;
  const messages = current?.messages ?? [];
  const fresh = useFreshMessageIds(messages, conversationId);

  // Keep the newest message in view without scrolling the page underneath.
  // `open` is in the deps because closing unmounts the scroll container and
  // reopening mounts a fresh one at scrollTop 0 - with the same thread and the
  // same message count nothing else here changes, so the transcript came back
  // scrolled to its oldest message (review finding 16).
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, messages.length, working, threadsOpen, conversationId]);

  const busy = send.state !== "idle";
  // The scope itself is not this person's to talk in here (an unknown or
  // forbidden project, an unknown task): the panel says so and offers no
  // composer, and the page it sits on is untouched (review finding 2).
  const unavailable = current?.unavailable ?? false;
  const disabled =
    !current ||
    unavailable ||
    !current.available ||
    (current.conversation !== null && !current.viewerOwnsActive);
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
  }, [open, disabled, threadsOpen, focusInside]);

  /**
   * Ruling 314: `override` is the example the person clicked. It is a parameter
   * rather than `setText` + `submit()` because React has not re-rendered inside
   * the click — reading `text` there would post the EMPTY box, which is exactly
   * the failure `pending.current` exists to make impossible for typed messages.
   */
  const submit = (override?: string) => {
    const value = (override ?? text).trim();
    if (!value || busy || disabled || !current) return;
    const body = new FormData();
    body.set("_csrf", csrf);
    body.set("intent", "send");
    body.set("text", value);
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
    body.set("conversationId", target === NEW_THREAD ? NEW_THREAD : target);
    sentUnder.current = context.key;
    // Ruling 259 (pass 37, F37-90): the box keeps the words until the server
    // takes them. `setText("")` used to run here, optimistically, and nothing
    // anywhere held the string — so an expired CSRF token, a 404 on a scope
    // that is not open, or any transport failure destroyed what the person had
    // written, leaving only a toast that unmounts itself after 2.6 seconds.
    // Four of the five longest messages on the live board are 1,800 to 2,200
    // characters, typed into a two-row textarea.
    pending.current = value;
    send.submit(body, { method: "post", action: "/resources/controller" });
  };

  const pick = (id: string) => {
    setSelected((s) => ({ ...s, [context.key]: id }));
    setThreadsOpen(false);
  };

  const scopeLabel = current?.scope.label ?? localScopeLabel(context);
  const threads = current?.threads ?? [];
  const pageHref =
    (current?.scope.pageHref ??
      (context.projectSlug ? `/projects/${context.projectSlug}/controller` : "/controller")) +
    // Ruling 121 + pass 33: the page now opens this scope's NEWEST thread when
    // no `?c=` is given (U33-8), so a dock sitting on a fresh, unsent thread must
    // say so explicitly — a bare link would hand the person an older
    // conversation instead of the blank composer they were looking at. `?c=new`
    // is the page's own token for "start empty".
    (current?.conversation
      ? `?c=${encodeURIComponent(current.conversation.id)}`
      : "?c=new");

  return (
    <div className="dock" data-open={open ? "true" : "false"}>
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
          <header className="dock-head">
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
                onClick={() => setThreadsOpen((t) => !t)}
              >
                <Icon name="message" />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="New thread"
                onClick={() => pick(NEW_THREAD)}
              >
                <Icon name="plus" />
              </button>
              <Link
                className="icon-btn"
                to={pageHref}
                aria-label="Open the full controller page"
                onClick={() => closeDock(true)}
              >
                <Icon name="ext" />
              </Link>
              <button
                type="button"
                className="icon-btn"
                aria-label="Close the controller dock"
                onClick={() => closeDock(false)}
              >
                <Icon name="x" />
              </button>
            </div>
          </header>
          <p className="dock-context fine xs dim">
            {current?.scope.contextLine ?? "Reading where you are…"}
          </p>
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
                      <button type="button" className="linkish" onClick={() => pick(u.id)}>
                        {u.title}
                      </button>
                    ) : (
                      <Link className="linkish" to={u.href} onClick={() => closeDock(true)}>
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
                        onClick={() => pick(t.id)}
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
                          onClick={() => submit(example)}
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
                  {messages.map((m) => (
                    <article
                      key={m.id}
                      className={`ctl-msg ${m.author === "user" ? "from-user" : "from-controller"}`}
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
                      </header>
                      <div className="md-body">
                        <Markdown text={m.text} taskLinks={current.taskLinks} />
                      </div>
                    </article>
                  ))}
                  {current.turn.working && (
                    <div className="ctl-working" role="status">
                      <span className="live-dot" />
                      <WorkingSentence name={current.controllerName} />
                      {/* Ruling 250: the dock follows a person onto every page
                          and has no live-run panel at all, so this row is the
                          ONLY place the turn's own step can reach them here. */}
                      <TurnStep turn={current.turn} />
                    </div>
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
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    submit();
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
                  onClick={() => submit()}
                  disabled={busy || disabled || !text.trim()}
                >
                  {busy ? "Sending…" : "Send"}
                </button>
              </div>
            </div>
          </div>
        </section>
      )}
      <button
        ref={fabRef}
        type="button"
        className="dock-fab"
        aria-label={`Controller · ${scopeLabel}${
          unseen.length === 0 ? "" : unseen.length === 1 ? " · a new reply" : ` · ${unseen.length} new replies`
        }`}
        aria-haspopup="dialog"
        aria-expanded={open}
        // A dangling `aria-controls` is worse than none (the repo already
        // decided this in command-palette.tsx and create-profile-modal.tsx):
        // the panel only exists while open.
        aria-controls={open ? "controller-dock-panel" : undefined}
        onClick={() => {
          if (open) {
            closeDock(false);
            return;
          }
          openedByUser.current = true;
          setOpen(true);
        }}
      >
        <Icon name="cpu" />
        {working && <span className="live-dot" aria-hidden="true" />}
        {!working && unseen.length > 0 && <span className="unseen-dot" aria-hidden="true" />}
      </button>
      {/* The dot is decorative, and the panel's own status row is unmounted
          while the dock is closed — so the one programmatic form of "a turn is
          running" lives here, outside the panel (review finding 26). */}
      <span className="vh" role="status" aria-live="polite">
        {working
          ? `${current?.controllerName ?? "Controller"} is working`
          : unseen.length === 1
            ? `${current?.controllerName ?? "Controller"} replied in “${unseen[0]!.title}”`
            : unseen.length > 1
              ? `${current?.controllerName ?? "Controller"} replied in ${unseen.length} conversations`
              : ""}
      </span>
    </div>
  );
}
