import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Link,
  useFetcher,
  useLocation,
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
import { Pill, type PillKind } from "~/ui/pill";
import { useToast } from "~/ui/toast";
import { useCsrfToken } from "~/ui/csrf-input";
import { LocalDayDotTime } from "~/ui/local-time";
import { useLiveUpdates } from "~/features/live-updates/use-live-updates";
import { sseScopes } from "~/features/live-updates/event-types";
import { AgentLogsPanel, LiveRunPanel } from "~/features/runtime/runs-panels";
import { useRunLogStream } from "~/features/runtime/use-run-log-stream";
import { ConfirmDialog } from "~/ui/confirm-dialog";

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

/**
 * U33-8: `?c=new` — the blank composer, asked for by name.
 *
 * Ruling 121 gave the DOCK a continuity rule: with nothing selected it opens
 * the newest thread of the scope you are standing in. This page opened an
 * empty composer instead, so the same person, on the same scope, got a
 * different answer depending on which entry point they used. The page now
 * follows the dock — which leaves "start a fresh thread" needing a token of
 * its own. It is the same `"new"` the dock sends (`DOCK_NEW_CONVERSATION` in
 * controller-dock-query.server.ts); the two route loaders resolve it.
 */
export const NEW_CONVERSATION_PARAM = "new";

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
  const answeredRef = useRef<ActionResult | null>(null);
  useEffect(() => {
    if (send.state !== "idle" || !send.data || answeredRef.current === send.data) {
      return;
    }
    answeredRef.current = send.data;
    if (!send.data.ok && send.data.error) {
      push(send.data.error, "error");
      return;
    }
    // A send that started a NEW conversation selects it.
    if (send.data.conversationId && params.get("c") !== send.data.conversationId) {
      const next = new URLSearchParams(params);
      next.set("c", send.data.conversationId);
      setParams(next, { preventScrollReset: true });
    }
  }, [send.state, send.data, params, setParams, push]);

  return (
    <main className="ctl-wrap" data-screen-label="Controller">
      <header className="ctl-head">
        <span className="ctl-head-icon">
          <Icon name="cpu" />
        </span>
        <div>
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
        {!projectSlug && (
          <Link to="/" className="btn sm ctl-home">
            <Icon name="arrow" className="r180" />
            Home
          </Link>
        )}
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
              <Transcript view={view} />
              <Composer view={view} csrf={csrf} send={send} conversationId={null} />
            </>
          )}
        </div>
        <aside className="ctl-side">
          {view.goals !== null && (
            <GoalsPanel
              goals={view.goals}
              csrf={csrf}
              canRedirect={canRedirectGoals}
            />
          )}
          <ConversationList view={view} />
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
  const push = useToast();
  const answeredRef = useRef<ActionResult | null>(null);
  useEffect(() => {
    if (stop.state !== "idle" || !stop.data || answeredRef.current === stop.data) return;
    answeredRef.current = stop.data;
    if (stop.data.toast) push(stop.data.toast, stop.data.ok ? "success" : "error");
    else if (!stop.data.ok && stop.data.error) push(stop.data.error, "error");
  }, [stop.state, stop.data, push]);

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
  const onViewLogs = (threadId: string) => {
    setSel(threadId);
    requestAnimationFrame(() => {
      // Optional-chained CALL, as the transcript's own scroll: jsdom's Element
      // carries no `scrollIntoView`.
      document
        .querySelector('[data-comment-anchor="agent-logs"]')
        ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    });
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
        />
      )}
      {children}
      {runtime.length > 0 && (
        <AgentLogsPanel
          runtime={runtime}
          sel={sel}
          onSel={setSel}
          linesByThread={linesByThread}
          streamError={streamError}
          olderByThread={olderByThread}
          onLoadOlder={loadOlder}
        />
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
          onConfirm={() => {
            onInterrupt(confirmInterrupt);
            setConfirmInterrupt(null);
          }}
        />
      )}
    </>
  );
}

function ConversationList({ view }: { view: ControllerSurfaceView }) {
  const [params] = useSearchParams();
  // U33-8: what is OPEN, not what the URL asked for. With no `?c=` the loader
  // opens this scope's newest thread (the dock's rule), and the rail has to
  // mark the row the transcript is actually showing.
  const active = view.conversation?.id ?? null;
  const href = (c: ConversationListItem | null) => {
    const next = new URLSearchParams(params);
    // A missing `c` now means "the newest thread here", so New has to ask for
    // the blank composer explicitly.
    next.set("c", c ? c.id : NEW_CONVERSATION_PARAM);
    if (!view.showingAll) next.delete("all");
    return `?${next.toString()}`;
  };
  return (
    <section className="panel ctl-convs">
      <div className="panel-head">
        <Icon name="message" />
        <h2>Conversations</h2>
        <div className="right">
          <Link className="btn sm ghost" to={href(null)}>
            New
          </Link>
        </div>
      </div>
      {view.viewerIsOrgAdmin && (
        <p className="fine xs dim ctl-all-toggle">
          {view.showingAll ? (
            <Link to="?">Show mine only</Link>
          ) : (
            <Link to="?all=1">Show everyone's (org admin)</Link>
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
                className={`ctl-conv${c.id === active ? " on" : ""}`}
                to={href(c)}
              >
                <span className="ctl-conv-title">
                  {c.taskKey && (
                    <span className="pill agent sm ctl-conv-task">{c.taskKey}</span>
                  )}
                  {c.title}
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

function Transcript({ view }: { view: ControllerSurfaceView }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const count = view.messages.length;
  useEffect(() => {
    // Optional-chained CALL, the same idiom date-picker/label-input use: jsdom's
    // Element carries no `scrollIntoView`, and pinning this surface's copy in a
    // component test must not depend on a browser-only scroll nicety.
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [count, view.turn.working]);

  if (!view.conversation) {
    return (
      <section className="panel ctl-transcript">
        <div className="empty">
          <p>
            Ask a question or ask for a change: boards, tasks, users, resources,
            agents, goal chains. Everything runs with your own permissions, and
            refusals say why.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className="panel ctl-transcript" aria-label="Conversation transcript">
      <div className="ctl-msgs">
        {view.messages.map((m) => (
          <article
            key={m.id}
            className={`ctl-msg ${m.author === "user" ? "from-user" : "from-controller"}`}
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
              <Markdown text={m.text} />
            </div>
          </article>
        ))}
        {view.turn.working && (
          <div className="ctl-working" role="status">
            <span className="live-dot" /> {view.controllerName} is working…
          </div>
        )}
        <div ref={endRef} />
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
  const busy = send.state !== "idle";
  const disabled =
    !view.available || (view.conversation !== null && !view.viewerOwnsActive);
  const submit = () => {
    const value = text.trim();
    if (!value || busy || disabled) return;
    const body = new FormData();
    body.set("_csrf", csrf);
    body.set("intent", "send");
    body.set("text", value);
    body.set("surface", `${location.pathname}${location.search}`);
    if (conversationId) body.set("conversationId", conversationId);
    send.submit(body, { method: "post" });
    setText("");
  };
  return (
    <div className="ctl-composer">
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
              : // Ruling 127: the same sentence the refused turn records
                // (`controllerRefusalNote`), so the composer and the transcript
                // cannot tell two stories about one refusal.
                CLAUDE_NOT_CONNECTED
            : "Ask the controller, or tell it what to do…"
        }
        disabled={disabled}
        aria-label="Message to the controller"
      />
      <div className="ctl-composer-foot">
        <span className="fine xs dim">
          Acts with your permissions · refusals say why · ⌘↵ sends
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

function GoalsPanel({
  goals,
  csrf,
  canRedirect,
}: {
  goals: GoalView[];
  csrf: string;
  canRedirect: boolean;
}) {
  return (
    <section className="panel ctl-goals" aria-label="Goal chains">
      <div className="panel-head">
        <Icon name="flag" />
        <h2>Goals</h2>
      </div>
      {goals.length === 0 ? (
        <p className="empty sm">
          No goal chains yet. Ask the controller to plan one: it decomposes an
          outcome into an ordered chain of tasks and advances it as each link
          completes.
        </p>
      ) : (
        goals.map((g) => (
          <GoalCard key={g.id} goal={g} csrf={csrf} canRedirect={canRedirect} />
        ))
      )}
    </section>
  );
}

function GoalCard({
  goal,
  csrf,
  canRedirect,
}: {
  goal: GoalView;
  csrf: string;
  canRedirect: boolean;
}) {
  const op = useFetcher<ActionResult>();
  const push = useToast();
  const answeredRef = useRef<ActionResult | null>(null);
  useEffect(() => {
    if (op.state !== "idle" || !op.data || answeredRef.current === op.data) return;
    answeredRef.current = op.data;
    if (op.data.toast) push(op.data.toast, op.data.ok ? "success" : "error");
    else if (!op.data.ok && op.data.error) push(op.data.error, "error");
  }, [op.state, op.data, push]);

  const busy = op.state !== "idle";
  const act = (fields: Record<string, string>) => {
    const body = new FormData();
    body.set("_csrf", csrf);
    body.set("intent", "goal-op");
    body.set("goalId", goal.id);
    for (const [k, v] of Object.entries(fields)) body.set(k, v);
    op.submit(body, { method: "post" });
  };
  const pill = GOAL_PILL[goal.status];
  const settled = goal.status === "completed" || goal.status === "cancelled";
  return (
    <article className="ctl-goal">
      <header>
        <span className="ctl-goal-id mono">{goal.id}</span>
        <strong>{goal.title}</strong>
        <Pill kind={pill.kind} sm>
          {pill.label}
        </Pill>
      </header>
      <ol className="ctl-links">
        {goal.links.map((l) => {
          const lp = LINK_PILL[l.status] ?? LINK_PILL.pending;
          return (
            <li key={l.index} className={l.index === goal.currentIndex ? "on" : ""}>
              <Pill kind={lp.kind} sm>
                {lp.label}
              </Pill>
              <span className="ctl-link-title">{l.title}</span>
              {l.blockedBy.length > 0 && (
                <span className="sub" data-link-wait>
                  waits on {l.blockedBy.join(", ")}
                </span>
              )}
              {l.taskKey && (
                <Link className="mono ctl-link-task" to={`../tasks/${l.taskKey}`} relative="path">
                  {l.taskKey}
                </Link>
              )}
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
                    onClick={() => act({ op: "skip_link", index: String(l.index) })}
                  >
                    Skip
                  </button>
                </span>
              )}
              {l.note && <span className="fine xs dim ctl-link-note">{l.note}</span>}
            </li>
          );
        })}
      </ol>
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
          <button
            type="button"
            className="btn ghost sm"
            disabled={busy}
            onClick={() => act({ op: "cancel" })}
          >
            Cancel goal
          </button>
        </footer>
      )}
    </article>
  );
}
