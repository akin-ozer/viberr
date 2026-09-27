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
  ControllerSurfaceView,
  ConversationListItem,
} from "./controller-query.server";
import { Icon } from "~/ui/icon";
import { Markdown } from "~/ui/markdown";
import { Pill } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { correctionAnchor, proposalAnchor } from "~/shared/page-anchors";
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
import { ControllerExampleList, controllerExamples, type ControllerExample } from "./controller-examples";
import { NEW_CONVERSATION_PARAM } from "./conversation-param";
import { CONNECT_TO_SEND, NotConnectedNote } from "./not-connected";
import { KnowledgePanel } from "./knowledge-panel";
import { useOpResultToast, type ActionResult } from "./op-result";
import { viewerTimeZone } from "~/shared/dates/time-zone";

/**
 * The controller surface (ruling 99): a conversation list, one transcript,
 * a composer, and — on the project surface — the Knowledge base panel. The
 * Goals panel that stood under it went with the chains it showed (ruling
 * 503): a board's planned work is its epics, on the Epics page.
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
}: {
  view: ControllerSurfaceView;
  /** Present on the project surface; null at instance scope. */
  projectSlug: string | null;
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
            rail stacked that panel under every goal chain the page then
            showed: live on ax-clone it began 4,419px down on a desktop and
            5,576px down on a phone, so starting a conversation took five
            screens of scrolling. */}
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
        {view.conversation ? (
          // Keyed by conversation: the log selection and the stream cursors
          // belong to ONE thread, and switching threads starts them over. It
          // renders the conversation's column and the run pane beside it.
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
          <div className="ctl-main">
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
          </div>
        )}
        {/* Ruling 419(a)/(b): the conversations lead the rail, and on a
            desktop the rail is its own scroller beside the conversation
            (app.css `.ctl-side`), so a long panel under the list neither
            buries the list nor stretches the page beside it. */}
        <aside className="ctl-side">
          <ConversationList view={view} csrf={csrf} />
          {/* Ruling 498: what the board's agents changed in its knowledge,
              where the owner looks; with ruling 483's proposals that
              documents still hold. */}
          {view.corrections && view.proposals !== null && projectSlug && (
            <KnowledgePanel
              corrections={view.corrections}
              proposals={view.proposals}
              projectSlug={projectSlug}
              canResolve={view.viewerIsOrgAdmin}
              csrf={csrf}
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
 * - The **Agent logs** console: every turn of the thread as one grouped stream
 *   with `run N of M` boundaries, tailed live through the controller channel
 *   of `useRunLogStream` (`controller.log-appended` on the owner's user
 *   stream) and paged backwards through `/resources/run-log`, behind the same
 *   owner-or-admin gate that serves the raw view. Disclosed on the strip while
 *   a turn streams (ruling 380), the settled-runs archive after.
 *
 * Ruling 524(a): it renders the conversation's column (`.ctl-main`, the
 * transcript and composer it wraps) and then the run pane (`.ctl-run`, the
 * strip or the archive), both cells of the page's grid, so a wide screen puts
 * the run beside the conversation and a narrow one under the composer, in the
 * order the DOM reads. One owner for the selection and the stream. Renders no
 * pane for a thread that has not run yet.
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
      <div className="ctl-main">{children}</div>
      {/* Ruling 524(a): the run pane. While a turn streams it holds the strip
          with its console on it; after, the archive of the settled runs. One
          console either way, never two (ruling 380). `data-console` tells the
          sheet which, so a hidden console hands its column back to the
          conversation instead of leaving it empty under the strip. */}
      {runtime.length > 0 && (
        <div className="ctl-run" data-console={live ? (consoleOpen ? "open" : "closed") : "archive"}>
          {live ? (
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
          ) : (
            <AgentLogsPanel {...logProps} />
          )}
        </div>
      )}
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
      {/* Ruling 525: a thread the viewer may delete but not read opens
          nothing, so it is not a place to switch to. */}
      {view.conversations.filter((c) => c.readable).map((c) => (
        <option key={c.id} value={c.id}>
          {/* O39-d: a native option holds text only. */}
          {c.unread ? "New reply · " : ""}
          {c.taskKey ? `${c.taskKey} · ${c.title}` : c.title}
        </option>
      ))}
    </select>
  );
}

function ConversationList({ view, csrf }: { view: ControllerSurfaceView; csrf: string }) {
  const [params] = useSearchParams();
  // U33-8: what is OPEN, not what the URL asked for. With no `?c=` the loader
  // opens this scope's newest thread (the dock's rule), and the rail has to
  // mark the row the transcript is actually showing.
  const active = view.conversation?.id ?? null;
  const href = (c: ConversationListItem) => conversationHref(params, view.showingAll, c.id);
  // Ruling 525: each row the viewer may delete carries its Delete, confirmed
  // first. Deleting the open thread answers with a redirect to where a bare
  // visit lands, which carries no result to toast: the fetcher keeps the data
  // it had, so an unchanged result is that redirect, and it is said here. A
  // refusal is a new result, which `useOpResultToast` says.
  const remove = useFetcher<ActionResult>();
  useOpResultToast(remove);
  const push = useToast();
  const [confirm, setConfirm] = useState<ConversationListItem | null>(null);
  const leaving = useRef<{ before: ActionResult | undefined } | null>(null);
  useEffect(() => {
    if (remove.state !== "idle" || !leaving.current) return;
    if (remove.data === leaving.current.before) push("Conversation deleted.");
    leaving.current = null;
  }, [remove.state, remove.data, push]);
  const deleting = remove.state !== "idle";
  const onDelete = (c: ConversationListItem) => {
    if (deleting) return;
    const body = new FormData();
    body.set("_csrf", csrf);
    body.set("intent", "delete-conversation");
    body.set("conversationId", c.id);
    // What the server needs to know to move the page off a thread it deletes.
    if (active) body.set("open", active);
    if (view.showingAll) body.set("all", "1");
    leaving.current = c.id === active ? { before: remove.data } : null;
    remove.submit(body, { method: "post" });
  };
  const deletingId = deleting ? String(remove.formData?.get("conversationId") ?? "") : null;
  return (
    <section className="panel ctl-convs">
      {/* Ruling 419(a): New moved to the page head, where it is reachable
          from wherever this panel happens to be. */}
      <div className="panel-head">
        <Icon name="message" />
        <h2>Conversations</h2>
      </div>
      {view.showAllAs && (
        <p className="fine xs dim ctl-all-toggle">
          {view.showingAll ? (
            <Link className="linkish" to="?">
              Show mine only
            </Link>
          ) : (
            <Link className="linkish" to="?all=1">
              Show everyone&apos;s ({view.showAllAs})
            </Link>
          )}
        </p>
      )}
      {view.conversations.length === 0 ? (
        <p className="empty sm">No conversations yet. Say something below.</p>
      ) : (
        <ul className="ctl-conv-list">
          {view.conversations.map((c) => {
            const face = (
              <>
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
                  {/* A thread the viewer cannot read is titled by its owner. */}
                  {!c.own && c.readable && `${c.ownerLabel} · `}
                  {c.lastMessageAt ? (
                    <LocalDayDotTime iso={c.lastMessageAt} />
                  ) : (
                    "empty"
                  )}
                </span>
              </>
            );
            return (
              <li key={c.id} className={"ctl-conv-row" + (c.canDelete ? " deletable" : "")}>
                {c.readable ? (
                  <Link
                    className={`ctl-conv${c.id === active ? " on" : ""}${c.unread ? " unread" : ""}`}
                    // Interface review 2026-09-24 (acce-9): set by hand, since
                    // NavLink matches the pathname and ignores ?c=.
                    aria-current={c.id === active ? "page" : undefined}
                    to={href(c)}
                  >
                    {face}
                  </Link>
                ) : (
                  // Ruling 525: listed so it can be deleted, never opened. Not
                  // a `.ctl-conv`: that is a link, and presses like one.
                  <div className="ctl-conv-sealed">{face}</div>
                )}
                {c.canDelete && (
                  <button
                    type="button"
                    className="stg-x destructive ctl-conv-del"
                    title="Delete conversation"
                    aria-label={`Delete ${c.title}`}
                    disabled={deleting}
                    aria-busy={deletingId === c.id || undefined}
                    onClick={() => setConfirm(c)}
                  >
                    <Icon name="x" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {confirm && (
        <DeleteConversationConfirm
          conversation={confirm}
          busy={deleting}
          onCancel={() => setConfirm(null)}
          onConfirm={() => onDelete(confirm)}
        />
      )}
    </section>
  );
}

/**
 * Ruling 525: what deleting a conversation does, said before it is done. It
 * is permanent, so the commit keeps the shared `danger` (ruling 149), and the
 * sentence names whose it is when it is not the reader's own.
 */
function DeleteConversationConfirm({
  conversation: c,
  busy,
  onCancel,
  onConfirm,
}: {
  conversation: ConversationListItem;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const what = c.readable ? (
    <>&ldquo;{c.title}&rdquo;</>
  ) : (
    <>
      {/* The head already says whose it is. */}
      This conversation {c.taskKey ? `about ${c.taskKey}` : "about this board"}
      {c.lastMessageAt && (
        <>
          , last active <LocalDayDotTime iso={c.lastMessageAt} />,
        </>
      )}
    </>
  );
  return (
    <ConfirmDialog
      screenLabel="Delete conversation dialog"
      title={c.own ? "Delete this conversation?" : `Delete ${c.ownerLabel}'s conversation?`}
      body={
        <>
          {what} goes for good{c.own ? "" : `, for ${c.ownerLabel} too`}: its messages and the
          logs of its turns.{c.working && " The turn it is working on stops first."} This cannot
          be undone.
        </>
      }
      confirmLabel="Delete conversation"
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
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
  examples?: ControllerExample[];
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
  // rail, on every load and every new message. The transcript is its own
  // capped scroller at every width now, so only its own box moves. Ruling
  // 476(c): and a reply that lands shows its first line, not its last.
  useTranscriptFollow(scrollRef, view.messages, fresh, view.turn.working, view.conversation?.id ?? "");
  // A reply that names an open knowledge-base proposal links it to its entry
  // in the panel beside the transcript (owner, 2026-09-25), and one that names
  // a correction to its entry there too (ruling 498).
  const messageLinks = useMemo(
    () =>
      view.proposals?.length || view.corrections?.shown.length
        ? {
            ...view.taskLinks,
            ...Object.fromEntries((view.proposals ?? []).map((p) => [p.id, `#${proposalAnchor(p.id)}`])),
            ...Object.fromEntries(
              (view.corrections?.shown ?? []).map((c) => [c.id, `#${correctionAnchor(c.id)}`]),
            ),
          }
        : view.taskLinks,
    [view.taskLinks, view.proposals, view.corrections],
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
            Ask a question or ask for a change: boards, tasks, epics, users,
            resources, agents. Everything runs with your own permissions, and
            refusals say why.
          </p>
          {/* Ruling 314 as the dock has it: clicking one SENDS it. */}
          {examples.length > 0 && onExample && (
            <ControllerExampleList examples={examples} disabled={examplesDisabled} onSend={onExample} />
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
          already render in the run pane beside the conversation;
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
