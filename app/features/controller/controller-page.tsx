import {
  isDeadDependencyState,
  joinDependencyEntries,
  parseDependencyRef,
  type DependencyRender,
} from "~/shared/dependencies";
import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MessageState, TurnStep, WorkingSentence } from "./turn-step";
import { answeredMessageIds, inReplyOrder, workingRowAfter } from "~/shared/controller-thread";
import { useFreshMessageIds } from "./use-fresh-messages";
import { useTranscriptFollow, useTurnAnnouncement } from "./transcript-follow";
import {
  Link,
  useFetcher,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router";
import type {
  ControllerGoalView,
  ControllerSurfaceView,
  ConversationListItem,
} from "./controller-query.server";
import type { GoalLinkView, GoalView } from "~/server/tasks/goal-actions.server";
import type { CardStatusKind } from "~/features/board/card-status";
import { dependencyAnchor, goalLinkAnchor } from "~/shared/goal-anchor";
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
import {
  useRunFacts,
  useRunLogStream,
  type RunLogStore,
} from "~/features/runtime/use-run-log-stream";
import { namedTurnPhase, type RunView } from "~/features/runtime/runtime-types";
import type { ConversationTurnState } from "~/server/controller/controller-run.server";
import { ConfirmDialog } from "~/ui/confirm-dialog";
import { useModifierHint } from "~/ui/use-shortcut-hint";
import { controllerExamples } from "./controller-examples";
import { NEW_CONVERSATION_PARAM } from "./conversation-param";
import { CONNECT_TO_SEND, NotConnectedNote } from "./not-connected";
import { ProposalsPanel } from "./proposals-panel";
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
 * revalidates on the owner-routed `controller.updated` SSE reference; while a
 * turn is working the console reads the turn's tail every 5 s as the fallback
 * for a missed settle, and revalidates once the tail says it ended (ruling
 * 457, CTL-2).
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
  useLiveUpdates(
    useMemo(
      () =>
        projectSlug
          ? [sseScopes.user(), sseScopes.project(projectSlug)]
          : [sseScopes.user()],
      [projectSlug],
    ),
    // Ruling 457: this page renders the conversation, so `controller.updated`
    // revalidates it; every other surface hands that event to the dock.
    { conversations: true },
  );

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
      <TurnAnnouncer view={view} />
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
          {/* Ruling 483 (F40-59): what the board's agents proposed about its
              knowledge, where the owner looks, before the chains. */}
          {view.proposals !== null && projectSlug && (
            <ProposalsPanel
              proposals={view.proposals}
              projectSlug={projectSlug}
              canResolve={view.viewerIsOrgAdmin}
              available={view.available}
              sending={send.state !== "idle"}
              onAsk={(text) =>
                send.submit(
                  sendForm(
                    csrf,
                    text,
                    `${location.pathname}${location.search}`,
                    view.conversation?.id ?? null,
                  ),
                  { method: "post" },
                )
              }
            />
          )}
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
 * Ruling 476(d) (F40-24): the page's one status region, mounted outside the
 * per-thread subtree so it is on the page before the first message of a new
 * thread starts a turn, and only its text changes: "<name> is working" when a
 * turn starts, "<name> replied: <first sentence>" when the reply lands.
 */
function TurnAnnouncer({ view }: { view: ControllerSurfaceView }) {
  const fresh = useFreshMessageIds(view.messages, view.conversation?.id ?? null);
  const said = useTurnAnnouncement(view.controllerName, view.messages, fresh, view.turn.working);
  return (
    <span className="vh" role="status" aria-live="polite" data-turn-announcer>
      {said}
    </span>
  );
}

/** Ruling 457 (CTL-2): how often a working turn's tail is read when no line
 *  arrives, the cadence the page's revalidation poll had (ruling 250). */
const TURN_POLL_MS = 5_000;

/** The open conversation's run-log store, for the transcript's working row. */
const TurnStoreContext = createContext<RunLogStore | null>(null);

/**
 * Ruling 250's step on the working row, from the console's tail reads (ruling
 * 457, CTL-2): each line and each 5 s status read carries the run row's phase
 * and step, so the row moves without the page revalidating. Until a read moves
 * them past what the page loaded, the loader's own turn state stands (it and
 * the run projection were read together).
 */
function LiveTurnStep({ turn, runtime }: { turn: ConversationTurnState; runtime: RunView[] }) {
  const facts = useRunFacts(useContext(TurnStoreContext), turn.runId);
  const loaded = runtime.find((r) => r.serverRunId === turn.runId);
  const moved =
    facts !== null && (!loaded || facts.phase !== loaded.phase || facts.step !== loaded.step);
  return (
    <TurnStep
      turn={moved ? { ...turn, phase: namedTurnPhase(facts.phase), step: facts.step } : turn}
    />
  );
}

/**
 * The open conversation's EXECUTION, on this surface: the task page's two
 * runtime panels, fed by the same projection (`view.runtime`, asked for the
 * ruling-99 scope a controller run is stored under).
 *
 * - The **Live run** strip while a turn is working: what the controller is
 *   doing (its phase and last tool step), elapsed from the run's own start,
 *   turns and tokens off the run row (refreshed by each tail read of the
 *   console, a line or the 5 s status read, and by the `controller.updated`
 *   reference a lifecycle flip publishes; ruling 457), the model,
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

  const runLog = useRunLogStream({
    source: { kind: "controller", conversationId },
    threads: runtime,
    hasActiveRun: runtime.some((r) => r.state === "running"),
    // Ruling 457 (CTL-2): the fallback for a settle the stream missed (a
    // paused stream drops the `controller.updated` that shows the reply). It
    // used to revalidate root, the layout and this page every 5 s of a turn,
    // transcript, goals and console included, to move one step line; now it
    // reads the turn's tail (its new lines and the row's facts) and
    // revalidates once, when the tail says the run ended.
    poll: { runId: view.turn.working ? view.turn.runId : null, everyMs: TURN_POLL_MS },
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
  const logProps = { runtime, sel, onSel: setSel, store: runLog };
  const onViewLogs = (threadId: string) => {
    setSel(threadId);
    setConsoleOpen((open) => !open);
  };

  return (
    <TurnStoreContext.Provider value={runLog}>
      {runtime.length > 0 && (
        <LiveRunPanel
          store={runLog}
          runtime={runtime}
          onViewLogs={onViewLogs}
          onInterrupt={(id) => setConfirmInterrupt(id)}
          canInterrupt={view.canInterruptTurn}
          interrupting={stopping}
          interruptingRunId={stopping ? String(stop.formData?.get("runId") ?? "") : null}
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
          onConfirm={() => onInterrupt(confirmInterrupt)}
        />
      )}
    </TurnStoreContext.Provider>
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
  const planned = view.plannedElsewhere ?? [];
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
        <p className="empty sm">
          {planned.length > 0 ? "No conversations on this board yet." : "No conversations yet."}{" "}
          Say something below.
        </p>
      ) : (
        <ul className="ctl-conv-list">
          {view.conversations.map((c) => (
            <li key={c.id}>
              <Link
                className={`ctl-conv${c.id === active ? " on" : ""}${c.unread ? " unread" : ""}`}
                // Interface review 2026-09-24 (acce-9): set by hand, since
                // NavLink matches the pathname and ignores ?c=.
                aria-current={c.id === active ? "page" : undefined}
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
      {/* Ruling 476(h) (F40-61): the threads this board's chains were planned
          in that the list above does not hold, an instance thread most often,
          so the reasoning behind a chain is one click from the chain. */}
      {planned.length > 0 && (
        <>
          <h3 className="ctl-planned-head">Where this board&apos;s chains were planned</h3>
          <ul className="ctl-conv-list" data-planned-elsewhere>
            {planned.map((p) => (
              <li key={p.id}>
                <Link className="ctl-conv" to={p.href}>
                  <span className="ctl-conv-title">{p.title}</span>
                  <span className="fine xs dim">
                    {p.scopeLabel} · planned {p.goalIds.join(", ")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
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
  // Ruling 451(d): a reply that lands while the transcript is up enters the way
  // it does in the dock; history never animates.
  const fresh = useFreshMessageIds(view.messages, view.conversation?.id ?? null);
  // Ruling 419(b): scroll the TRANSCRIPT, never the page. This used to be
  // `scrollIntoView` on an end marker, which scrolls every scrollable
  // ancestor too: on a phone the page itself jumped to the bottom of a
  // 12,625px conversation, past the header, the thread switcher and the
  // goals, on every load and every new message. The transcript is its own
  // capped scroller at every width now, so only its own box moves. Ruling
  // 476(c): and a reply that lands shows its first line, not its last.
  useTranscriptFollow(scrollRef, view.messages, fresh, view.turn.working, view.conversation?.id ?? "");
  // A reply that names an open knowledge-base proposal links it to its entry
  // in the Proposals panel beside the transcript (owner, 2026-09-25).
  const messageLinks = useMemo(
    () =>
      view.proposals?.length
        ? {
            ...view.taskLinks,
            ...Object.fromEntries(view.proposals.map((p) => [p.id, `#proposal-${p.id}`])),
          }
        : view.taskLinks,
    [view.taskLinks, view.proposals],
  );

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
  // Ruling 465 (F40-8): each reply sits under the message it answers, an
  // unanswered message says where it stands, and "is working…" sits under
  // the message the live turn answers, never under a later one.
  const ordered = inReplyOrder(view.messages);
  const answered = answeredMessageIds(view.messages);
  const workingAfter = workingRowAfter(ordered, view.turn.answering);
  // Ruling 476(d): the row is what a sighted person watches. The page's one
  // status region (`TurnAnnouncer`) says that the turn started and that it
  // replied; this row, inserted with its sentence already in it, was skipped.
  const working = view.turn.working && (
    <div className="ctl-working">
      <span className="live-dot" />
      <WorkingSentence name={view.controllerName} />
      {/* Ruling 250 (F37-79): the turn's own phase and step, in the place
          the person is waiting. Both are on the run row already and both
          already render in the live-run panel further down this page;
          the conversation showed one static line for turns measured in
          minutes. `phase` is null while it is the generic "Working" —
          the sentence above already says that. */}
      <LiveTurnStep turn={view.turn} runtime={view.runtime} />
    </div>
  );
  return (
    <section
      ref={scrollRef}
      className="panel ctl-transcript"
      aria-label="Conversation transcript"
    >
      <div className="ctl-msgs">
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
                {m.author === "user" && !answered.has(m.id) && (
                  <MessageState turn={view.turn} messageId={m.id} />
                )}
              </header>
              <div className="md-body">
                <Markdown text={m.text} taskLinks={messageLinks} />
              </div>
            </article>
            {m.id === workingAfter && working}
          </Fragment>
        ))}
        {workingAfter === null && working}
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
    // Cleared only on success, and only if the box still holds what went out —
    // somebody who started typing the next message while this one was in
    // flight keeps it. What went out is the TRIMMED text, so the box is
    // compared trimmed too: a message sent with a trailing space or newline
    // clears like any other. `sent` is read before the ref is nulled, because
    // React may run the updater later than this line. On a failure the text
    // and the Send button both stay, so the person can retry or copy it out.
    const sent = pending.current;
    pending.current = null;
    if (data.ok) setText((cur) => (cur.trim() === sent ? "" : cur));
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
          aria-busy={busy || undefined}
        >
          {busy && <Icon name="loader" className="spin" />}
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

/**
 * Ruling 476(g): the pill tint for each of the board card's status words, the
 * colour its `chip st` carries on the board (`.pill.info` is the board's
 * "waiting on you" blue, `.pill.neutral` its grey for a human or a clock).
 * `blocked` keeps ruling 425(a)'s pill.
 */
const CARD_PILL = {
  archived: "neutral",
  queued: "agent",
  agent: "agent",
  you: "info",
  human: "neutral",
  scheduled: "neutral",
  ready: "ready",
  input: "input",
  blocked: "blocked",
  done: "done",
  unknown: "neutral",
} satisfies Record<CardStatusKind, PillKind>;

/** A link's pill: its tint, its word, and the clock a scheduled task names. */
interface LinkPill {
  kind: PillKind;
  label: string;
  resumesAt: string | null;
}

/**
 * What a link's pill says. Ruling 476(g) (F40-56): a started link says what
 * the board's card for its task says, in its colour: live, goal-1 called
 * WEB-2, WEB-3 and WEB-5 "active" in the agent-working purple while their
 * cards said "waiting on you", and WEB-3's open packet held five other links.
 * Without the card's status (a surface that does not carry it), ruling
 * 425(a)'s held rule and the chain's own word stand.
 */
function linkPill(link: GoalLinkView): LinkPill {
  const status = link.status === "active" ? link.taskStatus : undefined;
  if (status) {
    return {
      kind: CARD_PILL[status.kind],
      label: status.label,
      resumesAt: status.kind === "scheduled" ? status.resumesAt : null,
    };
  }
  const held = link.status === "active" && (link.waits ?? []).some((e) => e.state !== "done");
  const pill = held ? HELD_PILL : (LINK_PILL[link.status] ?? LINK_PILL.pending);
  return { ...pill, resumesAt: null };
}

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
function waitEntryTitle(entry: DependencyRender, goals: readonly GoalView[]): string | null {
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
  // Ruling 476(b): a count that cannot read as a link number. "waits on 1"
  // beside a row, on a page where everything else says "link 1", read as
  // "waits on link 1": live, link 10 said it while it waited on link 9.
  const summary =
    open.length === 0
      ? `waited on ${entries.length === 1 ? "one entry" : `${entries.length} entries`}, all done`
      : `waits on ${open.length} open${done.length > 0 ? ` · ${done.length} done` : ""}`;
  return (
    <details className="ctl-link-waits" data-link-wait>
      <summary>
        {summary}
        {dead > 0 && <span className="ctl-wait-dead"> · {dead} can never finish</span>}
        <Icon name="chevron" className="disc-chev" />
      </summary>
      <ul>
        {[...open, ...done].map((e) => {
          const title = waitEntryTitle(e, goals);
          // Ruling 476(b): a goal link opens its own row, not its chain's head.
          const anchor = dependencyAnchor(e);
          return (
            <li key={e.ref} data-state={e.state}>
              <span className="ctl-wait-state">{waitStateWord(e)}</span>
              {e.taskKey ? (
                <Link className="mono" to={`../tasks/${e.taskKey}`} relative="path">
                  {e.taskKey}
                </Link>
              ) : anchor ? (
                <Link
                  className="mono"
                  to={{ pathname: location.pathname, search: location.search, hash: anchor }}
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
 * Ruling 419(h): open the chain a link pointed at (`#goal-4`) and bring it into
 * view. Only the nearest scroller moves (the rail on a desktop, the page column
 * on a phone): `scrollIntoView` would move the document as well, which the
 * shell never lets a person scroll back.
 *
 * Ruling 476(b): a link's own row is a target too (`#goal-4-link-6`, from the
 * task page's chain chip and from a wait entry naming a goal link). Its chain
 * opens, the row comes to the top of the scroller and takes focus, and the
 * returned id marks it (`data-targeted`). A keyboard or screen-reader user
 * following "goal-1 link 5" used to land on goal-1's summary, 5 rows short.
 */
function useTargetedGoal(): string {
  const location = useLocation();
  const id = hashTarget(location.hash);
  useEffect(() => {
    if (!id) return;
    const target = document.getElementById(id);
    const card = target?.closest("details.ctl-goal");
    if (!target || !(card instanceof HTMLDetailsElement)) return;
    card.open = true;
    let box = card.parentElement;
    while (
      box &&
      !(box.scrollHeight > box.clientHeight && /(auto|scroll)/.test(getComputedStyle(box).overflowY))
    ) {
      box = box.parentElement;
    }
    if (box) box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top - 8;
    const focusable = target === card ? card.querySelector("summary") : target;
    focusable?.focus({ preventScroll: true });
  }, [id]);
  return id;
}

/** The element id a URL's hash names; a hash that is not valid percent-encoding
 *  names nothing (the id is read while rendering now, so it must not throw). */
function hashTarget(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return "";
  }
}

/**
 * Ruling 476(f) (F40-26): the Goals head counts chains by what they are doing.
 * It said "N running · M settled", and `running` was every chain not completed
 * or cancelled, so a chain the owner paused, or one stopped on a failed link
 * and waiting for Retry or Skip, was counted as running: the headline said
 * work was moving when the chain was waiting for the person reading it.
 */
export function goalsCountLine(goals: readonly GoalView[]): string {
  const count = (test: (g: GoalView) => boolean) => goals.filter(test).length;
  const attention = count((g) => g.status === "attention");
  const parts: [number, string][] = [
    [count((g) => g.status === "active"), "active"],
    [count((g) => g.status === "paused"), "paused"],
    [attention, attention === 1 ? "needs attention" : "need attention"],
    [count(isSettled), "settled"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(" · ");
}

function GoalsPanel({
  goals,
  csrf,
  canRedirect,
  viewerId,
}: {
  goals: ControllerGoalView[];
  csrf: string;
  canRedirect: boolean;
  /** Ruling 260: the viewer, so a chain's own creator gets its controls. */
  viewerId: string;
}) {
  const targeted = useTargetedGoal();
  return (
    <section className="panel ctl-goals" aria-label="Goal chains">
      <div className="panel-head">
        <Icon name="flag" />
        <h2>Goals</h2>
        {goals.length > 0 && (
          <span className="fine xs dim ctl-goals-count">{goalsCountLine(goals)}</span>
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
            targeted={targeted}
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
  targeted,
  csrf,
  canRedirect,
}: {
  goal: ControllerGoalView;
  /** Every chain on the board, for what a cancel would strand in the others. */
  goals: readonly GoalView[];
  /** Ruling 476(b): the element id the URL's hash points at. */
  targeted: string;
  csrf: string;
  canRedirect: boolean;
}) {
  const op = useFetcher<ActionResult>();
  useOpResultToast(op);
  const [confirm, setConfirm] = useState<GoalConfirm | null>(null);
  const [reason, setReason] = useState("");
  const [showAllHistory, setShowAllHistory] = useState(false);

  const busy = op.state !== "idle";
  // Ruling 368: every goal control rides this one fetcher, so the one whose
  // op (and, for a link, whose index) is in flight shows the work; the rest
  // only wait.
  const opInFlight = busy ? String(op.formData?.get("op") ?? "") : null;
  const opIndex = busy ? String(op.formData?.get("index") ?? "") : null;
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
  // Ruling 476(g): the links whose task waits on a person, by the board's word.
  const waitingOn = (kind: CardStatusKind) =>
    goal.links.filter((l) => l.status === "active" && l.taskStatus?.kind === kind).length;
  const progress = [
    `${done} of ${goal.links.length} done`,
    skipped > 0 && `${skipped} skipped`,
    waitingOn("you") > 0 && `${waitingOn("you")} waiting on you`,
    waitingOn("human") > 0 && `${waitingOn("human")} waiting on a human`,
  ].filter((part) => part !== false);
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
            {/* Each part keeps its words together; the line breaks between. */}
            {progress.map((part, i) => (
              <Fragment key={part}>
                {i > 0 && " · "}
                <span>{part}</span>
              </Fragment>
            ))}
          </span>
          <Icon name="chevron" className="disc-chev" />
        </span>
        <strong className="ctl-goal-title">{goal.title}</strong>
      </summary>
      <ol className="ctl-links">
        {goal.links.map((l) => {
          const lp = linkPill(l);
          const anchor = goalLinkAnchor(goal.id, l.index);
          return (
            // Ruling 476(b): every surface names a link by its number ("goal-1
            // · link 3", "waiting on goal-1 link 1", the controller's "Links 6
            // and 10"), and the rail printed none, so finding link N meant
            // counting rows. The row says its number and is the target of
            // `#goal-1-link-3` (focusable only by that jump).
            <li
              key={l.index}
              id={anchor}
              tabIndex={-1}
              className={l.index === goal.currentIndex ? "on" : ""}
              data-targeted={anchor === targeted || undefined}
            >
              <span className="ctl-link-n">
                <span className="vh">Link </span>
                {l.index}
              </span>
              <Pill kind={lp.kind} sm>
                {lp.label}
                {lp.resumesAt && (
                  <>
                    {" "}
                    <LocalDayDotTime iso={lp.resumesAt} />
                  </>
                )}
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
                    aria-busy={(opInFlight === "retry_link" && opIndex === String(l.index)) || undefined}
                    onClick={() => act({ op: "retry_link", index: String(l.index) })}
                  >
                    {opInFlight === "retry_link" && opIndex === String(l.index) ? (
                      <>
                        <Icon name="loader" className="spin" />
                        Retrying…
                      </>
                    ) : (
                      "Retry"
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    disabled={busy}
                    aria-busy={(opInFlight === "skip_link" && opIndex === String(l.index)) || undefined}
                    onClick={() => ask({ kind: "skip", index: l.index, title: l.title })}
                  >
                    {opInFlight === "skip_link" && opIndex === String(l.index) ? (
                      <>
                        <Icon name="loader" className="spin" />
                        Skipping…
                      </>
                    ) : (
                      "Skip"
                    )}
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
      {(goal.description.trim() || goal.history.length > 0 || goal.plannedIn) && (
        <details className="ctl-goal-more">
          <summary>
            About this chain
            <Icon name="chevron" className="disc-chev" />
          </summary>
          {/* Ruling 476(h): the conversation that planned the chain holds the
              reasoning behind its links and waits; the project's own page
              said "No conversations yet" beside a chain built in 16 messages
              at instance scope. Shown only to a viewer who can open it. */}
          {goal.plannedIn && (
            <p className="ctl-goal-planned" data-goal-planned>
              Planned in{" "}
              <Link className="linkish" to={goal.plannedIn.href}>
                {goal.plannedIn.title}
              </Link>
              <span className="dim"> · {goal.plannedIn.scopeLabel}</span>
            </p>
          )}
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
              aria-busy={opInFlight === "resume" || undefined}
              onClick={() => act({ op: "resume" })}
            >
              {opInFlight === "resume" && <Icon name="loader" className="spin" />}
              {opInFlight === "resume" ? "Resuming…" : "Resume"}
            </button>
          ) : (
            <button
              type="button"
              className="btn ghost sm"
              disabled={busy}
              aria-busy={opInFlight === "pause" || undefined}
              onClick={() => act({ op: "pause" })}
            >
              {opInFlight === "pause" && <Icon name="loader" className="spin" />}
              {opInFlight === "pause" ? "Pausing…" : "Pause"}
            </button>
          )}
          {/* Ruling 419(c): cancel is terminal (resume refuses a cancelled
              chain) and it strands waits elsewhere, so it is ruling 149's
              destructive class: the danger face, and a confirm first. */}
          <button
            type="button"
            className="btn ghost sm danger"
            disabled={busy}
            aria-busy={opInFlight === "cancel" || undefined}
            onClick={() => ask({ kind: "cancel" })}
          >
            {opInFlight === "cancel" && <Icon name="loader" className="spin" />}
            {opInFlight === "cancel" ? "Cancelling…" : "Cancel goal"}
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
          }}
        >
          {reasonField}
        </ConfirmDialog>
      )}
    </details>
  );
}
