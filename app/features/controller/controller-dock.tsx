import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useFetcher,
  useLocation,
  useMatches,
  useRouteLoaderData,
} from "react-router";
import { z } from "zod";
import type { ControllerDockView } from "./controller-dock-query.server";
import { CLAUDE_NOT_CONNECTED } from "./controller-page";
import type { loader as projectLoader } from "~/routes/project";
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

function emptyCopy(view: ControllerDockView): string {
  if (view.scope.kind === "task") {
    return `Ask about ${view.scope.taskKey} or say what to do with it. The controller already has its task file.`;
  }
  if (view.scope.kind === "board") {
    return `Ask about the ${view.scope.projectName} board or say what to do on it: tasks, agents, goal chains.`;
  }
  return "Ask about this instance or say what to do: projects, users, resources, agents, goal chains.";
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
  const restored = useRef(false);
  const panelRef = useRef<HTMLElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const view = useFetcher<DockPayload>({ key: "controller-dock" });
  const send = useFetcher<SendResult>({ key: "controller-dock-send" });

  // Restore per-tab state AFTER hydration: reading storage during render would
  // disagree with the server's closed markup.
  useEffect(() => {
    setOpen(readSession(OPEN_KEY) === "1");
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
  const url = dockViewUrl(context, selectedId);
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

  // A send's result: an error is a toast (the transport failed; refusals are
  // in the transcript); a success selects the thread it landed in and reloads.
  const sentUnder = useRef(context.key);
  useFetcherResult(send, (result) => {
    if (!result.ok) {
      push(result.error ?? "The controller could not take that. Try again.", "error");
      return;
    }
    const key = sentUnder.current;
    setSelected((s) =>
      s[key] === result.conversationId ? s : { ...s, [key]: result.conversationId },
    );
    // Only reload while the dock still stands where the send was made. The
    // context here is the CURRENT one, so after a navigation this would ask for
    // a task thread under the board's scope - a request the route cannot answer
    // (review finding 2, path (a)). Recording the selection is enough: the load
    // effect fires when the person comes back to that scope.
    if (key === context.key) load(dockViewUrl(context, result.conversationId));
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
    // 0/NaN in jsdom (no stylesheet) and ~0 under [data-motion="reduce"]:
    // both mean close now.
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
  // is already on screen animates. Ids seen in the previous render of the same
  // conversation are settled; a switched conversation settles everything.
  const seenIds = useRef<Set<string>>(new Set());
  const seenConversation = useRef<string | null>(null);
  const conversationId = current?.conversation?.id ?? null;
  const messages = current?.messages ?? [];
  const fresh = useMemo(() => {
    if (seenConversation.current !== conversationId) return new Set<string>();
    return new Set(messages.filter((m) => !seenIds.current.has(m.id)).map((m) => m.id));
  }, [messages, conversationId]);
  useEffect(() => {
    seenIds.current = new Set(messages.map((m) => m.id));
    seenConversation.current = conversationId;
  }, [messages, conversationId]);

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

  const submit = () => {
    const value = text.trim();
    if (!value || busy || disabled || !current) return;
    const body = new FormData();
    body.set("_csrf", csrf);
    body.set("intent", "send");
    body.set("text", value);
    body.set("surface", context.surface);
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
    send.submit(body, { method: "post", action: "/resources/controller" });
    setText("");
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
                        className={`ctl-conv${t.id === conversationId ? " on" : ""}`}
                        aria-current={t.id === conversationId ? "true" : undefined}
                        onClick={() => pick(t.id)}
                      >
                        <span className="ctl-conv-title">{t.title}</span>
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
                <p className="empty sm">{emptyCopy(current)}</p>
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
                        <Markdown text={m.text} />
                      </div>
                    </article>
                  ))}
                  {current.turn.working && (
                    <div className="ctl-working" role="status">
                      <span className="live-dot" /> {current.controllerName} is working…
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
          <div className="dock-composer">
            <div className="ctl-composer">
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
                        : // Ruling 127: the dock bills the person reading it, so
                          // it says what the page's composer and the refused
                          // turn's transcript line say, from the one home.
                          CLAUDE_NOT_CONNECTED
                      : "Ask the controller, or tell it what to do here…"
                }
                disabled={disabled}
                aria-label="Message to the controller"
              />
              <div className="ctl-composer-foot">
                <span className="fine xs dim">Acts with your permissions · ⌘↵ sends</span>
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={submit}
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
        aria-label={`Controller · ${scopeLabel}`}
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
      </button>
      {/* The dot is decorative, and the panel's own status row is unmounted
          while the dock is closed — so the one programmatic form of "a turn is
          running" lives here, outside the panel (review finding 26). */}
      <span className="vh" role="status" aria-live="polite">
        {working ? `${current?.controllerName ?? "Controller"} is working` : ""}
      </span>
    </div>
  );
}
