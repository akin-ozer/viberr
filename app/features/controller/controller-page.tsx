import {
  isDeadDependencyState,
  joinDependencyEntries,
  parseDependencyRef,
  type DependencyRender,
} from "~/shared/dependencies";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TurnStep, WorkingSentence } from "./turn-step";
import { useFreshMessageIds } from "./use-fresh-messages";
import {
  Link,
  useFetcher,
  useLocation,
  useNavigate,
  useRevalidator,
  useSearchParams,
} from "react-router";
import type {
  ControllerSurfaceView,
  ConversationListItem,
} from "./controller-query.server";
import type { GoalView } from "~/server/tasks/goal-actions.server";
import { Icon } from "~/ui/icon";
import { Markdown } from "~/ui/markdown";
import { RichText } from "~/ui/rich-text";
import { Pill, type PillKind } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useCsrfToken } from "~/ui/csrf-input";
import { LocalDayDotTime } from "~/ui/local-time";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";
import { sseScopes } from "~/features/live-updates/event-types";
import { AgentLogsPanel, LiveRunPanel } from "~/features/runtime/runs-panels";
import { useRunLogStream } from "~/features/runtime/use-run-log-stream";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { useModifierHint } from "~/ui/use-shortcut-hint";
import { controllerExamples } from "./controller-examples";
import { NEW_CONVERSATION_PARAM } from "./conversation-param";
import { viewerTimeZone } from "~/shared/dates/time-zone";

/**
 * The controller surface (ruling 99): a conversation list, one transcript,
 * a composer, and — on the project surface — the Goals panel where a human
 * sees and redirects every chain.
 *
 * Shared by `/controller` (instance scope) and `/projects/:slug/controller`
 * (board scope). The active conversation rides `?c=<id>`; a bare URL opens
 * this scope's newest thread and `?c=new` the blank composer (U33-8, below),
 * and sending with no active conversation starts one. Live: the loader
 * revalidates on the owner-routed `controller.updated` SSE reference, with a
 * slow fallback poll while a turn is working.
 */

interface ActionResult {
  ok: boolean;
  error?: string;
  toast?: string;
  conversationId?: string;
}

/**
 * Toasts an interrupt or goal-op result once: the server's `toast` (tinted by
 * `ok`), else a failure's `error`. The run strip and every goal card answer
 * through it.
 */
function useOpResultToast(fetcher: ReturnType<typeof useFetcher<ActionResult>>) {
  const push = useToast();
  useFetcherResult(fetcher, (d) => {
    if (d.toast) push(d.toast, d.ok ? "success" : "error");
    else if (!d.ok && d.error) push(d.error, "error");
  });
}

/**
 * Ruling 127: what a viewer whose Claude is not connected reads here.
 *
 * The controller bills the ASKER, so this is never "the deployment has no
 * credential" — it is one person's account, and the remedy is theirs. The
 * words are the server's own (`controllerRefusalNote` in
 * controller-run.server.ts), so the disabled composer and the refusal the
 * transcript would record say the same thing. Exported because the DOCK
 * (ruling 121) is a second composer for the same turn and must not tell a
 * second story about one refusal.
 */
export const CLAUDE_NOT_CONNECTED =
  "The controller runs on your own Claude account, and Claude isn't connected " +
  "for you yet. Connect it on your Profile → Agent accounts, then send your " +
  "message again.";

/** Where the sentence above sends a person, linked where it is printed. */
const AGENT_ACCOUNTS_PLACE = "Profile → Agent accounts";

/** What a composer that cannot send yet says in its own box. */
export const CONNECT_TO_SEND = "Connect Claude to send a message.";

/**
 * U39-10 (pass 39): ruling 127's sentence where a person can read it and act
 * on it. Both composers carried it as the PLACEHOLDER of a disabled textarea:
 * placeholder grey on a disabled field, cut after two lines on a phone (the
 * dock's box is two rows), and never a link. The product's own rule for a
 * disabled control is a visible note beside it (`.deny-note`), and this is
 * that note, with the place it names linked. Shared by the page and the dock
 * (ruling 121), so the two still tell one story.
 */
export function NotConnectedNote() {
  const [before, after] = CLAUDE_NOT_CONNECTED.split(AGENT_ACCOUNTS_PLACE);
  return (
    <p className="deny-note ctl-unavailable" data-not-connected>
      <Icon name="alert" />
      <span>
        {before}
        <Link className="linkish" to="/profile">
          {AGENT_ACCOUNTS_PLACE}
        </Link>
        {after}
      </span>
    </p>
  );
}

/**
 * Where a conversation (or, with `null`, the blank composer) lives on this
 * surface. One builder for the rail, the phone picker and the header's New, so
 * the three cannot disagree about what a missing `c` means (U33-8) or drop the
 * org admin's `all` view in one place and keep it in another.
 */
function conversationHref(
  params: URLSearchParams,
  showingAll: boolean,
  conversationId: string | null,
): string {
  const next = new URLSearchParams(params);
  // A missing `c` means "the newest thread here", so New asks for the blank
  // composer explicitly.
  next.set("c", conversationId ?? NEW_CONVERSATION_PARAM);
  if (!showingAll) next.delete("all");
  return `?${next.toString()}`;
}

/** The one form a message is sent with, from the composer or an example. */
function sendForm(
  csrf: string,
  text: string,
  surface: string,
  conversationId: string | null,
): FormData {
  const body = new FormData();
  body.set("_csrf", csrf);
  body.set("intent", "send");
  body.set("text", text);
  body.set("surface", surface);
  // U39-24: the controller quotes times in the zone this page prints them in.
  body.set("timeZone", viewerTimeZone());
  if (conversationId) body.set("conversationId", conversationId);
  return body;
}

export function ControllerPage({
  view,
  projectSlug,
  canRedirectGoals,
}: {
  view: ControllerSurfaceView;
  /** Present on the project surface; null at instance scope. */
  projectSlug: string | null;
  /** Whether the viewer may use the goal redirect controls (server-checked
   *  again on submit; this only hides dead buttons). */
  canRedirectGoals: boolean;
}) {
  const csrf = useCsrfToken();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const revalidator = useRevalidator();
  useLiveUpdates(
    useMemo(
      () =>
        projectSlug
          ? [sseScopes.user(), sseScopes.project(projectSlug)]
          : [sseScopes.user()],
      [projectSlug],
    ),
  );

  // Fallback poll while a turn is working: the settle SSE can be missed by a
  // paused stream, and a transcript that never shows its reply reads as a hang.
  useEffect(() => {
    if (!view.turn.working) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [view.turn.working, revalidator]);

  const send = useFetcher<ActionResult>();
  const push = useToast();
  useFetcherResult(send, (data) => {
    if (!data.ok && data.error) {
      push(data.error, "error");
      return;
    }
    // A send that started a NEW conversation selects it.
    if (data.conversationId && params.get("c") !== data.conversationId) {
      const next = new URLSearchParams(params);
      next.set("c", data.conversationId);
      setParams(next, { preventScrollReset: true });
    }
  });

  return (
    // The instance controller (/controller) mounts with no shell around it,
    // so it keeps a frame of its own; inside a project it takes the shell's.
    <main
      className={"ctl-wrap" + (projectSlug ? "" : " standalone")}
      data-screen-label="Controller"
    >
      <header className="ctl-head">
        <span className="ctl-head-icon">
          <Icon name="cpu" />
        </span>
        <div className="ctl-head-text">
          <h1>{view.controllerName}</h1>
          <p className="fine dim">
            {view.conversation?.taskKey
              ? `Anchored to ${view.conversation.taskKey} on the ${view.projectName ?? projectSlug} board, with your own permissions.`
              : projectSlug
                ? `Managing the ${view.projectName ?? projectSlug} board with your own permissions.`
                : "Managing this instance with your own permissions."}
          </p>
        </div>
        {/* Ruling 127: a controller turn runs on the ASKER's own Claude
            account, so this pill is about the person reading it. Another
            member with Claude connected converses normally while this one
            cannot, which the old instance-wide wording could not express. */}
        {!view.available && <Pill kind="risk">Claude not connected</Pill>}
        {/* Ruling 419(a): the page's two navigation moves live at its top.
            "New" sat in the Conversations panel's head, and on a project the
            rail stacks that panel UNDER every goal chain: live on ax-clone it
            began 4,419px down on a desktop and 5,576px down on a phone, so
            starting a conversation took five screens of scrolling. */}
        <div className="ctl-head-acts">
          <ConversationPicker view={view} />
          <Link
            className="btn sm"
            to={conversationHref(params, view.showingAll, null)}
            data-new-conversation
          >
            <Icon name="plus" />
            New conversation
          </Link>
          {!projectSlug && (
            <Link to="/" className="btn sm">
              <Icon name="arrow" className="r180" />
              Home
            </Link>
          )}
        </div>
      </header>
      <div className="ctl-layout">
        <div className="ctl-main">
          {view.conversation ? (
            // Keyed by conversation: the log selection and the stream cursors
            // belong to ONE thread, and switching threads starts them over.
            <ConversationRuntime
              key={view.conversation.id}
              view={view}
              csrf={csrf}
              conversationId={view.conversation.id}
            >
              <Transcript view={view} />
              <Composer
                view={view}
                csrf={csrf}
                send={send}
                conversationId={view.conversation.id}
              />
            </ConversationRuntime>
          ) : (
            <>
              <Transcript
                view={view}
                examples={controllerExamples(projectSlug ? { kind: "board" } : { kind: "instance" })}
                examplesDisabled={!view.available || send.state !== "idle"}
                onExample={(text) =>
                  send.submit(sendForm(csrf, text, `${location.pathname}${location.search}`, null), {
                    method: "post",
                  })
                }
              />
              <Composer view={view} csrf={csrf} send={send} conversationId={null} />
            </>
          )}
        </div>
        {/* Ruling 419(a)/(b): the conversations lead the rail and the goal
            chains follow, and on a desktop the rail is its own scroller beside
            the conversation (app.css `.ctl-side`), so a long chain list neither
            buries the list above it nor stretches the page beside it. */}
        <aside className="ctl-side">
          <ConversationList view={view} />
          {view.goals !== null && (
            <GoalsPanel
              goals={view.goals}
              csrf={csrf}
              canRedirect={canRedirectGoals}
              viewerId={view.viewerId}
            />
          )}
        </aside>
      </div>
    </main>
  );
}

/**
 * The open conversation's EXECUTION, on this surface: the task page's two
 * runtime panels, fed by the same projection (`view.runtime`, asked for the
 * ruling-99 scope a controller run is stored under).
 *
 * - The **Live run** strip while a turn is working: what the controller is
 *   doing (its phase and last tool step), elapsed from the run's own start,
 *   turns and tokens off the run row (refreshed by the page's poll and by the
 *   `controller.updated` reference a lifecycle flip publishes), the model,
 *   View logs, and Interrupt for the conversation's owner or an org admin
 *   (`canInterruptTurn`; the engine re-checks). Interrupt confirms first (D6):
 *   a stopped turn settles with "This turn was stopped before I could answer."
 *   and nothing it was about to apply is applied.
 * - The **Agent logs** console below the composer: every turn of the thread as
 *   one grouped stream with `run N of M` boundaries, tailed live through the
 *   controller channel of `useRunLogStream` (`controller.log-appended` on the
 *   owner's user stream) and paged backwards through `/resources/run-log`,
 *   behind the same owner-or-admin gate that serves the raw view.
 *
 * Wraps the transcript and composer so the strip sits above the conversation
 * and the console below it, with one owner for the selection and the stream.
 * Renders neither panel for a thread that has not run yet.
 */
function ConversationRuntime({
  view,
  csrf,
  conversationId,
  children,
}: {
  view: ControllerSurfaceView;
  csrf: string;
  conversationId: string;
  children: ReactNode;
}) {
  const runtime = view.runtime;
  const [sel, setSel] = useState<string | null>(null);
  const [confirmInterrupt, setConfirmInterrupt] = useState<string | null>(null);
  const stop = useFetcher<ActionResult>();
  useOpResultToast(stop);

  const { linesByThread, streamError, olderByThread, loadOlder } = useRunLogStream({
    source: { kind: "controller", conversationId },
    threads: runtime.map((r) => ({
      threadId: r.id,
      runId: r.serverRunId,
      lines: r.lines.map((display, i) => ({ display, raw: r.raw[i] ?? "" })),
      window: r.logWindow,
    })),
    hasActiveRun: runtime.some((r) => r.state === "running"),
  });

  const stopping = stop.state !== "idle";
  const onInterrupt = (threadId: string) => {
    const run = runtime.find((r) => r.id === threadId);
    if (!run || stopping) return;
    const body = new FormData();
    body.set("_csrf", csrf);
    body.set("intent", "interrupt");
    body.set("conversationId", conversationId);
    body.set("runId", run.serverRunId);
    stop.submit(body, { method: "post" });
  };
  // F39 (owner decision): the console is a DISCLOSURE on the live-run card, not
  // a jump. It used to select the thread and scroll to a panel that was already
  // on the page — measured here, 886px below the strip with the whole
  // conversation in between, so the control read as navigation, took the reader
  // out of the conversation, and offered nothing to get back with.
  // Open by default: before F39 the console was ALWAYS on the page, just a
  // viewport away. The disclosure is there to move it and to let a reader
  // collapse it, not to take the stream away until someone asks for it.
  const [consoleOpen, setConsoleOpen] = useState(true);
  /** Is any run of this conversation streaming right now? */
  const live = runtime.some((r) => r.state === "running");
  /** One console, wherever it renders — the props cannot drift between the two
   *  positions because there is only one object. */
  const logProps = {
    runtime,
    sel,
    onSel: setSel,
    linesByThread,
    streamError,
    olderByThread,
    onLoadOlder: loadOlder,
  };
  const onViewLogs = (threadId: string) => {
    setSel(threadId);
    setConsoleOpen((open) => !open);
  };

  return (
    <>
      {runtime.length > 0 && (
        <LiveRunPanel
          runtime={runtime}
          onViewLogs={onViewLogs}
          onInterrupt={(id) => setConfirmInterrupt(id)}
          canInterrupt={view.canInterruptTurn}
          interrupting={stopping}
          consoleOpen={consoleOpen}
          console={<AgentLogsPanel {...logProps} />}
        />
      )}
      {children}
      {/* The archive. While a turn streams its console lives on the card above,
          so this is the settled-runs view — one panel either way, never two. */}
      {runtime.length > 0 && !live && <AgentLogsPanel {...logProps} />}
      {/* D6: stopping a turn discards what it was about to apply, which is
          ruling 149's destructive class, so the commit keeps the shared
          `danger` default. Ruling 150 puts the same red on the trigger: the
          shared `btn ghost sm danger` in `LiveRunPanel`. */}
      {confirmInterrupt && (
        <ConfirmDialog
          screenLabel="Interrupt turn dialog"
          title="Interrupt this turn?"
          body="The controller stops where it is. Anything it was about to apply is not applied, and the transcript records that the turn was stopped. You can send your message again afterward."
          confirmLabel="Interrupt turn"
          busy={stopping}
          onCancel={() => setConfirmInterrupt(null)}
          onConfirm={() => {
            onInterrupt(confirmInterrupt);
            setConfirmInterrupt(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Ruling 419(a): the phone's conversation switcher, in the page head.
 *
 * Below the two-column breakpoint the rail stacks under the conversation, so on
 * a phone the list of threads was the LAST thing on the page — after a
 * transcript measured at 12,625px and six goal chains. A native select is the
 * control a phone already knows how to present, and it names the open thread
 * where a person looks first. The rail's list stays for the wide layout, where
 * app.css hides this one (`.ctl-picker`).
 */
function ConversationPicker({ view }: { view: ControllerSurfaceView }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  if (view.conversations.length === 0) return null;
  const active = view.conversation?.id ?? "";
  return (
    <select
      className="ctl-picker"
      aria-label="Conversation"
      value={active}
      onChange={(e) =>
        navigate(conversationHref(params, view.showingAll, e.target.value || null))
      }
    >
      {/* The blank composer is a place too: a person who pressed New is not
          reading any thread, and the select must not claim they are. */}
      {!active && <option value="">New conversation</option>}
      {view.conversations.map((c) => (
        <option key={c.id} value={c.id}>
          {/* O39-d: a native option holds text only. */}
          {c.unread ? "New reply · " : ""}
          {c.taskKey ? `${c.taskKey} · ${c.title}` : c.title}
        </option>
      ))}
    </select>
  );
}

function ConversationList({ view }: { view: ControllerSurfaceView }) {
  const [params] = useSearchParams();
  // U33-8: what is OPEN, not what the URL asked for. With no `?c=` the loader
  // opens this scope's newest thread (the dock's rule), and the rail has to
  // mark the row the transcript is actually showing.
  const active = view.conversation?.id ?? null;
  const href = (c: ConversationListItem) => conversationHref(params, view.showingAll, c.id);
  return (
    <section className="panel ctl-convs">
      {/* Ruling 419(a): New moved to the page head, where it is reachable
          from wherever this panel happens to be. */}
      <div className="panel-head">
        <Icon name="message" />
        <h2>Conversations</h2>
      </div>
      {view.viewerIsOrgAdmin && (
        <p className="fine xs dim ctl-all-toggle">
          {view.showingAll ? (
            <Link className="linkish" to="?">
              Show mine only
            </Link>
          ) : (
            <Link className="linkish" to="?all=1">
              Show everyone&apos;s (org admin)
            </Link>
          )}
        </p>
      )}
      {view.conversations.length === 0 ? (
        <p className="empty sm">No conversations yet. Say something below.</p>
      ) : (
        <ul className="ctl-conv-list">
          {view.conversations.map((c) => (
            <li key={c.id}>
              <Link
                className={`ctl-conv${c.id === active ? " on" : ""}${c.unread ? " unread" : ""}`}
                to={href(c)}
              >
                <span className="ctl-conv-title">
                  {/* O39-d: a reply this person has not opened yet. */}
                  {c.unread && <span className="unseen-dot" aria-hidden="true" />}
                  {c.taskKey && (
                    <span className="pill agent sm ctl-conv-task">{c.taskKey}</span>
                  )}
                  {c.title}
                  {c.unread && <span className="vh">, new reply</span>}
                </span>
                <span className="fine xs dim">
                  {!c.own && `${c.ownerLabel} · `}
                  {c.lastMessageAt ? (
                    <LocalDayDotTime iso={c.lastMessageAt} />
                  ) : (
                    "empty"
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Transcript({
  view,
  examples = [],
  examplesDisabled = false,
  onExample,
}: {
  view: ControllerSurfaceView;
  /** Ruling 419(g): ruling 314's examples, on the blank transcript only. */
  examples?: string[];
  examplesDisabled?: boolean;
  onExample?: (text: string) => void;
}) {
  const scrollRef = useRef<HTMLElement | null>(null);
  const count = view.messages.length;
  // Ruling 451(d): a reply that lands while the transcript is up enters the way
  // it does in the dock; history never animates.
  const fresh = useFreshMessageIds(view.messages, view.conversation?.id ?? null);
  useEffect(() => {
    // Ruling 419(b): scroll the TRANSCRIPT, never the page. This used to be
    // `scrollIntoView` on an end marker, which scrolls every scrollable
    // ancestor too: on a phone the page itself jumped to the bottom of a
    // 12,625px conversation, past the header, the thread switcher and the
    // goals, on every load and every new message. The transcript is its own
    // capped scroller at every width now, so only its own box moves.
    const box = scrollRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [count, view.turn.working]);

  if (!view.conversation) {
    return (
      // Design pass 2026-09-08: this was a bordered, shadowed panel — the
      // page's heaviest frame — drawn around 320px of nothing, with the one
      // sentence pinned to its top edge in --placeholder. It is the app's
      // composed empty state now (the hero Home and Insights use), centred in
      // the column the transcript will fill; the composer under it is the
      // page's single object until something is said.
      <section className="ctl-transcript">
        <div className="empty-hero" data-screen-label="Empty state">
          <span className="glyph">
            <Icon name="cpu" />
          </span>
          <h2>Nothing asked yet</h2>
          <p>
            Ask a question or ask for a change: boards, tasks, users, resources,
            agents, goal chains. Everything runs with your own permissions, and
            refusals say why.
          </p>
          {/* Ruling 314 as the dock has it: clicking one SENDS it. */}
          {examples.length > 0 && onExample && (
            <ul className="ctl-examples">
              {examples.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    className="ctl-example"
                    onClick={() => onExample(example)}
                    disabled={examplesDisabled}
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    );
  }
  return (
    <section
      ref={scrollRef}
      className="panel ctl-transcript"
      aria-label="Conversation transcript"
    >
      <div className="ctl-msgs">
        {view.messages.map((m) => (
          <article
            key={m.id}
            className={`ctl-msg ${m.author === "user" ? "from-user" : "from-controller"}`}
            data-fresh={fresh.has(m.id) ? "true" : undefined}
          >
            <header>
              <span className="ctl-msg-who">
                {m.author === "user" ? (
                  view.conversation?.userLabel
                ) : (
                  <>
                    <Icon name="cpu" /> {view.controllerName}
                  </>
                )}
              </span>
              <LocalDayDotTime iso={m.createdAt} />
              {m.surface && (
                <span className="ctl-msg-surface" title={m.surface}>
                  from {surfaceLabel(m.surface)}
                </span>
              )}
            </header>
            <div className="md-body">
              <Markdown text={m.text} taskLinks={view.taskLinks} />
            </div>
          </article>
        ))}
        {view.turn.working && (
          <div className="ctl-working" role="status">
            <span className="live-dot" />
            <WorkingSentence name={view.controllerName} />
            {/* Ruling 250 (F37-79): the turn's own phase and step, in the place
                the person is waiting. Both are on the run row already and both
                already render in the live-run panel further down this page;
                the conversation showed one static line for turns measured in
                minutes. `phase` is null while it is the generic "Working" —
                the sentence above already says that. */}
            <TurnStep turn={view.turn} />
          </div>
        )}
      </div>
    </section>
  );
}

function Composer({
  view,
  csrf,
  send,
  conversationId,
}: {
  view: ControllerSurfaceView;
  csrf: string;
  send: ReturnType<typeof useFetcher<ActionResult>>;
  conversationId: string | null;
}) {
  const [text, setText] = useState("");
  const location = useLocation();
  // Ruling 419(d): the send handler takes ⌘ OR Ctrl, so the hint names the key
  // this keyboard has (UI-55's rule, which P13-D-39 applied to the comment
  // composer and this one missed).
  const sendHint = useModifierHint("↵");
  const busy = send.state !== "idle";
  // Ruling 259 (pass 37, F37-90): the box keeps the words until the server
  // takes them. `setText("")` used to run at submit, optimistically, and
  // nothing anywhere held the string — an expired CSRF token (refused before
  // the engine runs, so the text reaches no transcript), a 404 on a scope that
  // is not open, or any transport failure destroyed what the person wrote, and
  // the only account of it was a toast that unmounts itself after 2.6 seconds.
  const pending = useRef<string | null>(null);
  useFetcherResult(send, (data) => {
    // Cleared only on success, and only if the box still holds exactly what
    // went out — somebody who started typing the next message while this one
    // was in flight keeps it. On a failure the text and the Send button both
    // stay, so the person can retry or copy it out.
    if (data.ok) setText((cur) => (cur === pending.current ? "" : cur));
    pending.current = null;
  });
  const disabled =
    !view.available || (view.conversation !== null && !view.viewerOwnsActive);
  const submit = () => {
    const value = text.trim();
    if (!value || busy || disabled) return;
    pending.current = value;
    send.submit(sendForm(csrf, value, `${location.pathname}${location.search}`, conversationId), {
      method: "post",
    });
  };
  return (
    <div className="ctl-composer">
      {!view.available && <NotConnectedNote />}
      <textarea
        value={text}
        autoFocus={!disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        rows={3}
        placeholder={
          disabled
            ? view.available
              ? "Read-only: only the conversation's owner can talk in it."
              : // Ruling 127's sentence is the note above the box (U39-10).
                CONNECT_TO_SEND
            : "Ask the controller, or tell it what to do…"
        }
        disabled={disabled}
        aria-label="Message to the controller"
      />
      <div className="ctl-composer-foot">
        <span className="fine xs dim">
          Acts with your permissions · refusals say why
          {/* A touch screen has no key to name; app.css drops this on a
              coarse pointer (`.kbd-hint`). */}
          <span className="kbd-hint" suppressHydrationWarning>
            {` · ${sendHint} sends`}
          </span>
        </span>
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
  );
}

/**
 * Ruling 121: the surface a message was sent from, as a short word — the
 * workspace view's name, a task key, or "Home". The full path stays in the
 * title attribute.
 */
export function surfaceLabel(surface: string): string {
  const path = surface.split("?")[0] ?? surface;
  const task = path.match(/^\/projects\/[^/]+\/tasks\/([^/]+)/);
  if (task?.[1]) return task[1];
  const view = path.match(/^\/projects\/[^/]+(?:\/([^/]+))?/);
  if (view) {
    const segment = view[1] ?? "board";
    return segment.charAt(0).toUpperCase() + segment.slice(1);
  }
  if (path === "/") return "Home";
  const top = path.split("/").filter(Boolean)[0] ?? "";
  return top ? top.charAt(0).toUpperCase() + top.slice(1) : "Home";
}

// ---------------------------------------------------------------- goals

const GOAL_PILL = {
  active: { kind: "agent", label: "active" },
  paused: { kind: "neutral", label: "paused" },
  attention: { kind: "input", label: "attention" },
  completed: { kind: "done", label: "completed" },
  cancelled: { kind: "neutral", label: "cancelled" },
} satisfies Record<GoalView["status"], { kind: PillKind; label: string }>;

const LINK_PILL = {
  pending: { kind: "neutral", label: "pending" },
  active: { kind: "agent", label: "active" },
  done: { kind: "done", label: "done" },
  failed: { kind: "risk", label: "failed" },
  skipped: { kind: "neutral", label: "skipped" },
} satisfies Record<
  GoalView["links"][number]["status"],
  { kind: PillKind; label: string }
>;

/**
 * Ruling 425(a): a link whose task exists but is still held by unfinished work.
 * The chain calls it `active` from the moment its task is created, and live on
 * ax-clone goal-6 link 1 read "active" over AX-6, which sat in Triage waiting
 * on ten other links. It says what the board's card for the same task says,
 * "blocked", in the same colour: one task, one word, on every surface.
 */
const HELD_PILL = { kind: "blocked", label: "blocked" } satisfies { kind: PillKind; label: string };

/** Ruling 425(b): the one word each entry of a wait list gets. */
function waitStateWord(entry: DependencyRender): string {
  switch (entry.state) {
    case "done":
      return "done";
    case "open":
      // A goal link with no task has not been started by its chain yet.
      return entry.taskKey ? "open" : "not started";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "missing":
      return "missing";
  }
}

/**
 * Ruling 425(b): the title of the work a wait entry names, when this page holds
 * the chain it belongs to. A reference like `goal-4 link 6` is an address;
 * a person reading the rail needs to know what it is.
 */
export function waitEntryTitle(entry: DependencyRender, goals: readonly GoalView[]): string | null {
  const ref = parseDependencyRef(entry.ref);
  if (ref?.kind === "goal") {
    return goals.find((g) => g.id === ref.goal)?.links.find((l) => l.index === ref.link)?.title ?? null;
  }
  if (!entry.taskKey) return null;
  for (const g of goals) {
    const link = g.links.find((l) => l.taskKey === entry.taskKey);
    if (link) return link.title;
  }
  return null;
}

/**
 * Ruling 425(b): what a link waits on, as a count a person can scan and a list
 * they can open.
 *
 * The rail printed every entry as one sentence of addresses. Live on ax-clone,
 * goal-6's fifth link read "waits on goal-6 link 3, goal-4 link 5 (AX-21),
 * goal-4 link 6, goal-4 link 7, goal-5 link 1 (AX-5), goal-5 link 2, goal-5
 * link 3 (AX-22), goal-5 link 4, goal-4 link 2 (AX-24, done) …", thirteen
 * entries, none of them named by what it is. The summary says how many are
 * still open, how many are done, and how many can never finish; the list
 * gives each one its state, a link to its task or chain, and its title.
 */
function LinkWaits({
  entries,
  goals,
}: {
  entries: readonly DependencyRender[];
  goals: readonly GoalView[];
}) {
  const location = useLocation();
  const open = entries.filter((e) => e.state !== "done");
  const done = entries.filter((e) => e.state === "done");
  const dead = open.filter((e) => isDeadDependencyState(e.state)).length;
  const summary =
    open.length === 0
      ? `waited on ${entries.length === 1 ? "one entry" : `${entries.length}`}, all done`
      : `waits on ${open.length}${done.length > 0 ? ` · ${done.length} done` : ""}`;
  return (
    <details className="ctl-link-waits" data-link-wait>
      <summary>
        {summary}
        {dead > 0 && <span className="ctl-wait-dead"> · {dead} can never finish</span>}
      </summary>
      <ul>
        {[...open, ...done].map((e) => {
          const title = waitEntryTitle(e, goals);
          return (
            <li key={e.ref} data-state={e.state}>
              <span className="ctl-wait-state">{waitStateWord(e)}</span>
              {e.taskKey ? (
                <Link className="mono" to={`../tasks/${e.taskKey}`} relative="path">
                  {e.taskKey}
                </Link>
              ) : e.goalId ? (
                <Link
                  className="mono"
                  to={{ pathname: location.pathname, search: location.search, hash: e.goalId }}
                >
                  {e.ref}
                </Link>
              ) : (
                <span className="mono">{e.ref}</span>
              )}
              {/* Always the third cell, so the row's subgrid stays aligned. */}
              <span className="ctl-wait-title">{title}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** How many history entries a chain shows before "Show all". */
const HISTORY_PREVIEW = 6;

/**
 * Ruling 419(h): open the chain a link pointed at (`#goal-4`, from the task
 * page's chain chip) and bring it into view. Only the nearest scroller moves
 * (the rail on a desktop, the page column on a phone): `scrollIntoView` would
 * move the document as well, which the shell never lets a person scroll back.
 */
function useTargetedGoal(): void {
  const location = useLocation();
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    const card = document.getElementById(id);
    if (!(card instanceof HTMLDetailsElement) || !card.classList.contains("ctl-goal")) return;
    card.open = true;
    let box = card.parentElement;
    while (
      box &&
      !(box.scrollHeight > box.clientHeight && /(auto|scroll)/.test(getComputedStyle(box).overflowY))
    ) {
      box = box.parentElement;
    }
    if (box) box.scrollTop += card.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
    card.querySelector("summary")?.focus({ preventScroll: true });
  }, [location.hash]);
}

function GoalsPanel({
  goals,
  csrf,
  canRedirect,
  viewerId,
}: {
  goals: GoalView[];
  csrf: string;
  canRedirect: boolean;
  /** Ruling 260: the viewer, so a chain's own creator gets its controls. */
  viewerId: string;
}) {
  useTargetedGoal();
  const running = goals.filter((g) => !isSettled(g)).length;
  return (
    <section className="panel ctl-goals" aria-label="Goal chains">
      <div className="panel-head">
        <Icon name="flag" />
        <h2>Goals</h2>
        {goals.length > 0 && (
          <span className="fine xs dim ctl-goals-count">
            {running} running · {goals.length - running} settled
          </span>
        )}
      </div>
      {goals.length === 0 ? (
        <p className="empty sm">
          No goal chains yet. Ask the controller to plan one: it decomposes an
          outcome into an ordered chain of tasks and advances it as each link
          completes.
        </p>
      ) : (
        goals.map((g) => (
          <GoalCard
            key={g.id}
            goal={g}
            goals={goals}
            csrf={csrf}
            // Ruling 260 (F37-91): the server's gate is creator OR run-agents
            // (`requireGoalAuthority`). The page knew only the role half, so a
            // contributor who created a chain — `create-task` is a contributor
            // action, `run-agents` is not — was shown their own chain with no
            // Pause, Resume, Cancel, Retry or Skip, and this is the ONLY goal
            // redirect UI in the product. The server stays the authority; this
            // just stops the page refusing on its behalf.
            canRedirect={canRedirect || g.createdBy === viewerId}
          />
        ))
      )}
    </section>
  );
}

function isSettled(goal: GoalView): boolean {
  return goal.status === "completed" || goal.status === "cancelled";
}

/**
 * Ruling 419(c): the links in OTHER chains that a cancel would strand.
 *
 * A cancelled chain never starts another link (`reconcileGoal` returns early on
 * a terminal chain, and every link op refuses on it), so a wait on one of its
 * links that has no task yet resolves as `cancelled` from then on and never
 * releases (`resolveDependencies`, F37-63). A link that already has a task is
 * not stranded: its wait follows the task, which stays on the board. The page
 * holds every chain, so it can name them before the click rather than leave
 * the dead-dependency note to explain it afterwards.
 */
export function linksStrandedByCancel(goal: GoalView, goals: readonly GoalView[]): string[] {
  const dying = new Set(
    goal.links
      .filter((l) => !l.taskKey && l.status !== "done" && l.status !== "skipped")
      .map((l) => `${goal.id} link ${l.index}`),
  );
  const stranded: string[] = [];
  for (const other of goals) {
    if (other.id === goal.id || isSettled(other)) continue;
    for (const link of other.links) {
      if (link.status === "done" || link.status === "skipped") continue;
      if (link.blockedBy.some((ref) => dying.has(ref))) {
        stranded.push(`${other.id} link ${link.index}`);
      }
    }
  }
  return stranded;
}

type GoalConfirm = { kind: "cancel" } | { kind: "skip"; index: number; title: string };

function GoalCard({
  goal,
  goals,
  csrf,
  canRedirect,
}: {
  goal: GoalView;
  /** Every chain on the board, for what a cancel would strand in the others. */
  goals: readonly GoalView[];
  csrf: string;
  canRedirect: boolean;
}) {
  const op = useFetcher<ActionResult>();
  useOpResultToast(op);
  const [confirm, setConfirm] = useState<GoalConfirm | null>(null);
  const [reason, setReason] = useState("");
  const [showAllHistory, setShowAllHistory] = useState(false);

  const busy = op.state !== "idle";
  const act = (fields: Record<string, string>) => {
    const body = new FormData();
    body.set("_csrf", csrf);
    body.set("intent", "goal-op");
    body.set("goalId", goal.id);
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    op.submit(body, { method: "post" });
  };
  const ask = (next: GoalConfirm) => {
    setReason("");
    setConfirm(next);
  };
  const pill = GOAL_PILL[goal.status];
  const settled = isSettled(goal);
  const done = goal.links.filter((l) => l.status === "done").length;
  const skipped = goal.links.filter((l) => l.status === "skipped").length;
  const unstarted = goal.links.filter(
    (l) => !l.taskKey && l.status !== "done" && l.status !== "skipped",
  ).length;
  const stranded = confirm?.kind === "cancel" ? linksStrandedByCancel(goal, goals) : [];
  const reasonField = (
    <label className="field ctl-confirm-reason">
      <span className="flabel">Why (optional, recorded on the chain&apos;s history)</span>
      <textarea
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
      />
    </label>
  );
  return (
    // Ruling 419(d): a chain is a disclosure. A settled one folds to its head
    // line: live on ax-clone the completed goal-1 took 479px of rail to say
    // four links were done. `open` is only the starting state; React leaves a
    // person's own toggle alone until the chain settles or reopens.
    <details className="ctl-goal" open={!settled} data-goal={goal.id} id={goal.id}>
      <summary>
        <span className="ctl-goal-line">
          <span className="ctl-goal-id mono">{goal.id}</span>
          <Pill kind={pill.kind} sm>
            {pill.label}
          </Pill>
          <span className="ctl-goal-progress" data-goal-progress>
            {done} of {goal.links.length} done
            {skipped > 0 && ` · ${skipped} skipped`}
          </span>
        </span>
        <strong className="ctl-goal-title">{goal.title}</strong>
      </summary>
      <ol className="ctl-links">
        {goal.links.map((l) => {
          const held =
            l.status === "active" && (l.waits ?? []).some((e) => e.state !== "done");
          const lp = held ? HELD_PILL : (LINK_PILL[l.status] ?? LINK_PILL.pending);
          return (
            <li key={l.index} className={l.index === goal.currentIndex ? "on" : ""}>
              <Pill kind={lp.kind} sm>
                {lp.label}
              </Pill>
              {/* Ruling 425(c): the link's OWN task sits beside its title. After
                  the wait sentence it read as one more thing waited on: "waits
                  on AX-20 AX-21", where AX-21 was the link's own task. */}
              {l.taskKey && (
                <Link className="mono ctl-link-task" to={`../tasks/${l.taskKey}`} relative="path">
                  {l.taskKey}
                </Link>
              )}
              <span className="ctl-link-title">{l.title}</span>
              {l.blockedBy.length > 0 &&
                (l.waits ? (
                  <LinkWaits entries={l.waits} goals={goals} />
                ) : (
                  <span className="sub" data-link-wait>
                    waits on {joinDependencyEntries(l.blockedBy)}
                  </span>
                ))}
              {canRedirect && !settled && l.status === "failed" && (
                <span className="ctl-link-acts">
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busy}
                    onClick={() => act({ op: "retry_link", index: String(l.index) })}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busy}
                    onClick={() => ask({ kind: "skip", index: l.index, title: l.title })}
                  >
                    Skip
                  </button>
                </span>
              )}
              {l.note && (
                <span className="fine xs dim ctl-link-note">
                  <RichText text={l.note} mentions={false} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {/* Ruling 419(h): what the chain is FOR, and what has happened to it.
          The task page sends a person here to read the whole chain, and the
          page showed neither the outcome it serves nor its history, where a
          pause, a skip and a cancel's reason are recorded. */}
      {(goal.description.trim() || goal.history.length > 0) && (
        <details className="ctl-goal-more">
          <summary>About this chain</summary>
          {goal.description.trim() && (
            <div className="md-body ctl-goal-desc">
              <Markdown text={goal.description} />
            </div>
          )}
          {goal.history.length > 0 && (
            <ol className="ctl-goal-history" aria-label={`${goal.id} history`}>
              {(showAllHistory ? goal.history : goal.history.slice(0, HISTORY_PREVIEW)).map(
                (entry, i) => (
                  <li key={i}>
                    <LocalDayDotTime iso={entry.occurredAt} />
                    {/* U39-21's rule here too: a chain's history is written
                        with `code` (a reason, a link title) like the rest. */}
                    <span>
                      <RichText text={entry.text} mentions={false} />
                    </span>
                  </li>
                ),
              )}
            </ol>
          )}
          {goal.history.length > HISTORY_PREVIEW && (
            <button
              type="button"
              className="linkish fine xs"
              onClick={() => setShowAllHistory((all) => !all)}
            >
              {showAllHistory
                ? "Show the latest only"
                : `Show all ${goal.history.length} entries`}
            </button>
          )}
        </details>
      )}
      {canRedirect && !settled && (
        <footer className="ctl-goal-acts">
          {goal.status === "paused" || goal.status === "attention" ? (
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => act({ op: "resume" })}
            >
              Resume
            </button>
          ) : (
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              onClick={() => act({ op: "pause" })}
            >
              Pause
            </button>
          )}
          {/* Ruling 419(c): cancel is terminal (resume refuses a cancelled
              chain) and it strands waits elsewhere, so it is ruling 149's
              destructive class: the danger face, and a confirm first. */}
          <button
            type="button"
            className="btn ghost sm danger"
            disabled={busy}
            onClick={() => ask({ kind: "cancel" })}
          >
            Cancel goal
          </button>
        </footer>
      )}
      {confirm?.kind === "cancel" && (
        <ConfirmDialog
          screenLabel="Cancel goal dialog"
          title={`Cancel ${goal.id}?`}
          body={
            `A cancelled chain cannot be resumed, and none of its ${unstarted} unstarted ` +
            `link${unstarted === 1 ? "" : "s"} will ever start. Tasks it already started stay on the ` +
            "board with their work, and its record stays readable." +
            (stranded.length > 0
              ? ` ${joinDependencyEntries(stranded)} ${stranded.length === 1 ? "waits" : "wait"} on ` +
                `those unstarted links and would wait forever unless ${stranded.length === 1 ? "its wait is" : "their waits are"} changed.`
              : "")
          }
          confirmLabel="Cancel goal"
          cancelLabel="Keep it running"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const why = reason.trim();
            act(why ? { op: "cancel", reason: why } : { op: "cancel" });
            setConfirm(null);
          }}
        >
          {reasonField}
        </ConfirmDialog>
      )}
      {confirm?.kind === "skip" && (
        <ConfirmDialog
          screenLabel="Skip link dialog"
          title={`Skip link ${confirm.index}?`}
          body={
            `"${confirm.title}" will never run, and a skipped link cannot be retried. ` +
            "The chain moves past it, and anything that waits on it is released as if it were done."
          }
          confirmLabel="Skip link"
          cancelLabel="Keep it"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const why = reason.trim();
            const index = String(confirm.index);
            act(why ? { op: "skip_link", index, reason: why } : { op: "skip_link", index });
            setConfirm(null);
          }}
        >
          {reasonField}
        </ConfirmDialog>
      )}
    </details>
  );
}
