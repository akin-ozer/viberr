import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useFetcher, useSearchParams } from "react-router";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import { formatDayDotTime } from "~/shared/dates/format";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { Markdown } from "~/ui/markdown";
import { findMentionSpans } from "~/ui/mention-spans";
import { Pill } from "~/ui/pill";
import { RichText } from "~/ui/rich-text";
import { useToast } from "~/ui/toast";
import { eventMeta, typedKind } from "./event-meta";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import { MentionMenu } from "./mention-menu";
import { useMentionAutocomplete } from "./use-mention-autocomplete";

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

/**
 * Render the composer draft with `@mention` spans wrapped in `.mention` for the
 * highlight backdrop behind the textarea. Mentions are matched by the shared
 * span-finder against the known mentionable NAMES (so a multi-word "@Arda Kaya"
 * highlights as one chip), falling back to the `@word` token. Text between
 * mentions is plain — the backdrop mirrors the textarea character-for-character
 * (mention spans carry NO layout-affecting padding), so it stays pixel-aligned
 * with the transparent textarea text on top. The trailing "\n" keeps the box
 * height in sync when the draft ends on a newline.
 */
function highlightDraft(text: string, names: string[]): ReactNode {
  // Only KNOWN handles light up, so the chip appearing IS the confirmation that
  // the tag will route (P13-LV-12).
  const spans = findMentionSpans(text, names).filter((s) => s.known);
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const { start, end } of spans) {
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <span className="mention" key={key++}>
        {text.slice(start, end)}
      </span>,
    );
    last = end;
  }
  parts.push(text.slice(last) + "\n");
  return <Fragment>{parts}</Fragment>;
}

/**
 * Every string that ACTUALLY routes, for whole-name highlight matching: agent
 * display names AND their profile ids/handles, user display names and their
 * email-local handles, and the reserved role handles. The highlight is only
 * honest if this list is exactly what the server resolves (P13-LV-12).
 */
function mentionNamesOf(m: Mentionables): string[] {
  return [
    ...m.agents.flatMap((a) => [a.name, a.handle]),
    ...m.users.flatMap((u) => [u.name, u.handle]),
    ...m.reserved.map((r) => r.handle),
  ];
}

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
          {guest && (
            <Pill kind="neutral" sm>
              app user · not in project
            </Pill>
          )}
          <span className="tl-time">{formatDayDotTime(ev.occurredAt)}</span>
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
  const [draft, setDraft] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLDivElement>(null);
  const mentions = useMentionAutocomplete(mentionables, taRef, draft, setDraft);
  // Known mentionable names — drives whole-name @mention highlighting in the
  // composer backdrop and in rendered comment bodies.
  const mentionNames = useMemo(() => mentionNamesOf(mentionables), [mentionables]);
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
      setDraft((d) => (d.trim() ? d : "@operator "));
      if (taRef.current) {
        taRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
        taRef.current.focus();
      }
    }
  }, [ask]);

  // Comment result: success clears the draft + toasts (server copy);
  // failure keeps the draft and shows the inline error below.
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    if (fetcher.data.ok) {
      setDraft("");
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
    const text = draft.trim();
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
          {TL_FILTERS.map((x) => (
            <button
              type="button"
              key={x.id}
              className={f === x.id ? "on" : ""}
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
          <div className="composer-input" style={{ position: "relative" }}>
            {/* Highlight backdrop: mirrors the draft with @mentions styled,
                sitting behind the transparent-text textarea so mentions light
                up live as you type — matching the posted comment. */}
            <div className="composer-hl" aria-hidden="true" ref={hlRef}>
              {highlightDraft(draft, mentionNames)}
            </div>
            <textarea
              ref={taRef}
              placeholder="Add a comment… type @ to tag the operator, an agent, or a teammate"
              value={draft}
              role="combobox"
              aria-expanded={mentions.open}
              aria-controls={mentions.open ? mentions.listId : undefined}
              aria-autocomplete="list"
              aria-activedescendant={mentions.activeId}
              onChange={(e) => {
                setDraft(e.target.value);
                // Recompute after React applies the value (caret is settled).
                requestAnimationFrame(mentions.refresh);
              }}
              onKeyUp={mentions.refresh}
              onClick={mentions.refresh}
              onSelect={mentions.refresh}
              onScroll={(e) => {
                // Keep the highlight backdrop scroll-locked to the textarea.
                if (hlRef.current) hlRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
              onBlur={mentions.close}
              onKeyDown={(e) => {
                // The autocomplete claims navigation/selection keys while open;
                // ⌘/Ctrl+Enter always falls through to send.
                if (mentions.onKeyDown(e)) return;
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
              }}
            />
            <MentionMenu
              id={mentions.listId}
              items={mentions.open ? mentions.items : []}
              active={mentions.active}
              query={mentions.query}
              onPick={mentions.pick}
              onHover={mentions.setActive}
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
            >
              ⌘↵ to send
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
        {items.length === 0 ? (
          <div className="empty">
            No activity yet — this task hasn't started its operator loop.
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
