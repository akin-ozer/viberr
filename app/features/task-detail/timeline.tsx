import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useSearchParams } from "react-router";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { LocalDayDotTime } from "~/ui/local-time";
import { Markdown } from "~/ui/markdown";
import { Pill } from "~/ui/pill";
import { RichText } from "~/ui/rich-text";
import { useModifierHint } from "~/ui/use-shortcut-hint";
import { useToast } from "~/ui/toast";
import { eventMeta, typedKind } from "./event-meta";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import {
  CommentComposer,
  mentionNamesFor,
  type CommentComposerHandle,
} from "./comment-composer";

/**
 * Unified timeline — 1:1 port of Timeline/TimelineItem (task.jsx §4.6/§4.7):
 * filter tabs (All / Important events / Comments), comment composer with
 * ⌘↵ send + @agent routing (server-detected), newest-first event list with
 * the 9 typed-event renderings, evidence rows, guest pills, toagent tint.
 *
 * Real-app replacements: events carry UTC ISO `occurredAt` → the shared
 * ruling-4 formatter renders "9:41" / "Yesterday · 15:12" / "Mar 30 · 17:26";
 * posting goes through the route action (revalidation, no optimistic
 * governed state; failures keep the draft and show an inline error);
 * long histories are served as a bounded newest-first slice with a
 * "Show older" affordance driving the `?events=` param (progressive
 * disclosure — the first payload never ships the full history).
 */

const TL_FILTERS = [
  { id: "all", label: "All" },
  { id: "typed", label: "Important events" },
  { id: "comment", label: "Comments" },
] as const;

export type TimelineFilterId = (typeof TL_FILTERS)[number]["id"];

/** Comments taller than this (px) clamp by default with a "Show more" toggle. */
const COLLAPSE_MAX = 340;

/**
 * A comment body that clamps when it's very tall (long agent replies) so a
 * single answer can't dominate the timeline. Measures the rendered markdown's
 * full height after mount; if it exceeds COLLAPSE_MAX it renders clamped (with
 * a soft fade) behind a Show more / Show less toggle. Expanding restores the
 * full output verbatim — nothing is truncated from the record, only the view.
 * SSR-safe: starts un-clamped (matches the server render), then the effect
 * measures on the client and clamps.
 */
function CollapsibleComment({
  text,
  mentionNames,
}: {
  text: string;
  mentionNames?: string[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // scrollHeight reports the FULL content height even while clamped by
    // max-height, so this stays correct in both states.
    const measure = () => setOverflowing(el.scrollHeight > COLLAPSE_MAX + 24);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const clamped = overflowing && !expanded;
  return (
    <div className="md-collapse">
      <div
        ref={ref}
        className={"tl-text md-body" + (clamped ? " clamped" : "")}
        style={clamped ? { maxHeight: COLLAPSE_MAX } : undefined}
      >
        <Markdown text={text} mentionNames={mentionNames} />
      </div>
      {overflowing && (
        <button
          type="button"
          className="md-collapse-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <Icon name="chevron" />
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

export function TimelineItem({
  ev,
  mentionNames = [],
}: {
  ev: TimelineEventRender;
  /** Known mentionable names, for whole-name highlight in comment bodies. */
  mentionNames?: string[];
}) {
  const meta = eventMeta(ev.type);
  const actor = ev.actor;
  const isTyped = ev.type !== "comment";
  const guest = actor.kind === "human" && "guest" in actor && actor.guest;
  return (
    <div className="tl-item">
      <div className="tl-rail">
        <div className={"tl-node " + meta.node}>
          <Icon name={meta.icon} />
        </div>
        <div className="tl-line" />
      </div>
      <div className="tl-body">
        <div className="tl-meta">
          {/* Identity is the actor's NAME only — for agents that is the
              agent's own name (e.g. "Reviewer"), never the runtime label or a
              trailing role. */}
          <span className="tl-actor">{actor.name}</span>
          {isTyped && (
            <Pill kind={typedKind(ev.type)} sm>
              {meta.label}
            </Pill>
          )}
          {/* The "agent" badge marks a COMMENT written by an agent — the one
              place it adds signal (agent- vs human-authored message). A typed
              event is already an agent/system action (colored node + category
              pill), so the badge there was redundant noise that made an event
              look identical to a comment (NEW-6). */}
          {!isTyped && actor.kind === "agent" && (
            <Pill kind="agent" sm>
              agent
            </Pill>
          )}
          {/* E1: this pill dates from app-wide commenting, and read "app user ·
              not in project" as if outsiders could post here. They cannot — a
              signed-in non-member 404s on the task and on the comment POST. The
              flag survives because membership is read at PROJECTION time, so it
              now marks exactly one thing: the author has since left the project.
              (`actor.server.ts` derives it; the wording is this surface's.) */}
          {guest && (
            <Pill kind="neutral" sm>
              no longer a member
            </Pill>
          )}
          <span className="tl-time">
            <LocalDayDotTime iso={ev.occurredAt} />
          </span>
        </div>

        {ev.type === "comment" ? (
          <div className={"comment-card" + (ev.toAgent ? " toagent" : "")}>
            {/* Comments (agent replies AND user comments) are real multi-line
                markdown — render with the GFM renderer, not the inline-only
                RichText. Long replies clamp behind a Show more toggle so one
                answer can't swallow the timeline. Typed events stay on RichText. */}
            <CollapsibleComment text={ev.text} mentionNames={mentionNames} />
          </div>
        ) : (
          <>
            {ev.title && (
              <div className="tl-text">
                <strong>{ev.title}</strong>
              </div>
            )}
            <div className="tl-text">
              <RichText text={ev.text} />
            </div>
            {ev.evidence && (
              <div className="tl-card evidence">
                {ev.evidence.map((e, i) => (
                  <div className="ev-row" key={i}>
                    <span>{e.label}</span>
                    <span>
                      <span className="add">{e.add}</span>{" "}
                      <span className="del">{e.del}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function Timeline({
  events,
  hasMore,
  remaining,
  nextLimit,
  tlDefault,
  ask,
  mentionables,
  onAgentLog,
  taskClosed,
}: {
  /** Newest-first bounded slice from the loader. */
  events: TimelineEventRender[];
  hasMore: boolean;
  remaining: number;
  nextLimit: number;
  tlDefault: TimelineFilterId;
  /** "Ask operator" counter — each bump prefills + focuses the composer. */
  ask: number;
  /** @-mention autocomplete directory (loader) — agents/users/reserved. */
  mentionables: Mentionables;
  /** BUG 3: when an @agent comment triggers a run, the server returns the
   *  grouped Agent-logs id to auto-select + stream. Fired once per success. */
  onAgentLog?: (threadId: string) => void;
  /** Terminal-stage task (R7-6): comments stay ENABLED — only a subtle hint
   *  above the composer says the task is closed. */
  taskClosed?: boolean;
}) {
  const [f, setF] = useState<TimelineFilterId>(tlDefault);
  // The raw draft, synced synchronously from the editor. A ref, not state:
  // nothing renders from it (the editor owns the draft UI), and send() must
  // read the exact current text — not a value one batch behind the keystroke.
  const draftRef = useRef("");
  // P13-D-39: the send handler below accepts either modifier, so the hint has to
  // name the one the viewer's keyboard actually has (UI-55's rule).
  const sendHint = useModifierHint("↵");
  const composerRef = useRef<CommentComposerHandle>(null);
  const composerBoxRef = useRef<HTMLDivElement>(null);
  // Known mentionable names — drives whole-name @mention highlighting in the
  // composer and in rendered comment bodies.
  const mentionNames = useMemo(() => mentionNamesFor(mentionables), [mentionables]);
  const seenAsk = useRef(ask);
  const [, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<{
    ok: boolean;
    toast?: string;
    error?: string;
    logThreadId?: string | null;
  }>();
  const csrf = useCsrfToken();
  const push = useToast();
  const busy = fetcher.state !== "idle";
  const handled = useRef<unknown>(null);

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
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    if (fetcher.data.ok) {
      draftRef.current = "";
      // Clear the editor AND its undo history — ⌘Z must not resurrect a
      // posted comment. A failure runs neither: the draft stays as typed.
      composerRef.current?.clearAfterSuccess();
      if (fetcher.data.toast) push(fetcher.data.toast);
      // BUG 3: hand the grouped Agent-logs id up so the page selects + scrolls
      // to the mentioned agent's live output.
      if (fetcher.data.logThreadId && onAgentLog) onAgentLog(fetcher.data.logThreadId);
    }
  }, [fetcher.state, fetcher.data, push, onAgentLog]);

  const commentError =
    fetcher.state === "idle" && fetcher.data && !fetcher.data.ok
      ? fetcher.data.error
      : null;

  const items = useMemo(
    () =>
      events.filter((e) =>
        f === "all" ? true : f === "comment" ? e.type === "comment" : e.type !== "comment",
      ),
    [events, f],
  );

  const send = () => {
    const text = draftRef.current.trim();
    if (!text || busy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "comment");
    fd.set("text", text);
    fetcher.submit(fd, { method: "post" });
  };

  const showOlder = () => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("events", String(nextLimit));
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="activity" />
        <h2>Timeline</h2>
        <span className="right tl-filter">
          {/* UI-57: the filter tabs carried selection by CSS class only. */}
          {TL_FILTERS.map((x) => (
            <button
              type="button"
              key={x.id}
              className={f === x.id ? "on" : ""}
              aria-pressed={f === x.id}
              onClick={() => setF(x.id)}
            >
              {x.label}
            </button>
          ))}
        </span>
      </div>

      <div className="composer">
        {/* R7-6: Done tasks stay commentable — one subtle line, no freeze. */}
        {taskClosed && (
          <div style={{ fontSize: ".75rem", color: "var(--faint)" }}>
            This task is closed — comments are still recorded.
          </div>
        )}
        <div className="composer-box">
          <div className="composer-input" ref={composerBoxRef}>
            {/* Lexical plain-text editor: known @mentions highlight live as
                character-editable text (no backdrop mirroring); the posted
                value stays exactly the trimmed plain draft. */}
            <CommentComposer
              ref={composerRef}
              mentionables={mentionables}
              onChange={(raw) => {
                draftRef.current = raw;
              }}
              onSubmit={send}
            />
          </div>
          <div className="composer-foot">
            <span style={{ fontSize: ".75rem", color: "var(--placeholder)" }}>
              Open to every registered user · @mentions route to agents
            </span>
            {commentError && (
              <span
                style={{ fontSize: ".75rem", color: "var(--coral-dark)" }}
                role="alert"
              >
                {commentError}
              </span>
            )}
            <span
              style={{
                marginLeft: "auto",
                fontSize: ".75rem",
                color: "var(--placeholder)",
              }}
              className="mono"
              suppressHydrationWarning
            >
              {sendHint} to send
            </span>
            <button
              type="button"
              className="btn primary sm"
              onClick={send}
              disabled={busy}
              aria-busy={busy}
            >
              <Icon name="send" />
              Comment
            </button>
          </div>
        </div>
      </div>

      <div className="timeline" style={{ marginTop: "1.1rem" }}>
        {/* UI-40: `items` is the FILTERED view of an already-bounded slice, so
            "this task hasn't started" was printed for a task with plenty of
            history whenever the active tab matched nothing — with "Show older
            events · N more" rendered directly beneath it. */}
        {items.length === 0 ? (
          <div className="empty">
            {events.length === 0
              ? "No activity yet — this task hasn't started its operator loop."
              : f === "comment"
                ? "No comments in the loaded history — switch to All, or load older events."
                : "No governance events in the loaded history — switch to All, or load older events."}
          </div>
        ) : (
          items.map((ev) => (
            <TimelineItem key={ev.id} ev={ev} mentionNames={mentionNames} />
          ))
        )}
        {hasMore && (
          <button
            type="button"
            className="btn ghost sm"
            style={{ width: "100%", marginTop: ".6rem" }}
            onClick={showOlder}
          >
            <Icon name="chevron" />
            Show older events · {remaining} more
          </button>
        )}
      </div>
    </div>
  );
}
