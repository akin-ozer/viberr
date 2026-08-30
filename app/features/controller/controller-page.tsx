import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher, useRevalidator, useSearchParams } from "react-router";
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

/**
 * The controller surface (ruling 99): a conversation list, one transcript,
 * a composer, and — on the project surface — the Goals panel where a human
 * sees and redirects every chain.
 *
 * Shared by `/controller` (instance scope) and `/projects/:slug/controller`
 * (board scope). The active conversation rides `?c=<id>`; sending with no
 * active conversation starts one. Live: the loader revalidates on the
 * owner-routed `controller.updated` SSE reference, with a slow fallback poll
 * while a turn is working.
 */

interface ActionResult {
  ok: boolean;
  error?: string;
  toast?: string;
  conversationId?: string;
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
            {projectSlug
              ? `Managing the ${projectSlug} board with your own permissions.`
              : "Managing this instance with your own permissions."}
          </p>
        </div>
        {!view.available && (
          <Pill kind="risk">Claude backend unavailable</Pill>
        )}
        {!projectSlug && (
          <Link to="/" className="btn sm ctl-home">
            <Icon name="arrow" className="r180" />
            Home
          </Link>
        )}
      </header>
      <div className="ctl-layout">
        <div className="ctl-main">
          <Transcript view={view} />
          <Composer
            view={view}
            csrf={csrf}
            send={send}
            conversationId={view.conversation?.id ?? null}
          />
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

function ConversationList({ view }: { view: ControllerSurfaceView }) {
  const [params] = useSearchParams();
  const active = params.get("c");
  const href = (c: ConversationListItem | null) => {
    const next = new URLSearchParams(params);
    if (c) next.set("c", c.id);
    else next.delete("c");
    if (!view.showingAll) next.delete("all");
    const qs = next.toString();
    return qs ? `?${qs}` : "?";
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
                <span className="ctl-conv-title">{c.title}</span>
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
    endRef.current?.scrollIntoView({ block: "end" });
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
    if (conversationId) body.set("conversationId", conversationId);
    send.submit(body, { method: "post" });
    setText("");
  };
  return (
    <div className="ctl-composer">
      <textarea
        value={text}
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
              : "The Claude backend is unavailable, so the controller cannot answer."
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
