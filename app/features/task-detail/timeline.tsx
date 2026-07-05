import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useSearchParams } from "react-router";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import { formatDayDotTime } from "~/shared/dates/format";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
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

export type TimelineFilterId = (typeof TL_FILTERS)[number]["id"];

export function TimelineItem({ ev }: { ev: TimelineEventRender }) {
  const meta = eventMeta(ev.type);
  const actor = ev.actor;
  const isTyped = ev.type !== "comment";
  const role = "role" in actor ? actor.role : undefined;
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
          <span className="tl-actor">
            {actor.name}
            {role ? " · " + role : ""}
          </span>
          {isTyped && (
            <Pill kind={typedKind(ev.type)} sm>
              {meta.label}
            </Pill>
          )}
          {actor.kind === "agent" && (
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
            <div className="tl-text">
              <RichText text={ev.text} />
            </div>
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
}) {
  const [f, setF] = useState<TimelineFilterId>(tlDefault);
  const [draft, setDraft] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentionAutocomplete(mentionables, taRef, draft, setDraft);
  const seenAsk = useRef(ask);
  const [, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<{ ok: boolean; toast?: string; error?: string }>();
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
    }
  }, [fetcher.state, fetcher.data, push]);

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
        <div className="composer-box">
          <div style={{ position: "relative" }}>
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
            <span style={{ fontSize: ".72rem", color: "var(--placeholder)" }}>
              Open to every registered user · @mentions route to agents
            </span>
            {commentError && (
              <span
                style={{ fontSize: ".72rem", color: "var(--coral-dark)" }}
                role="alert"
              >
                {commentError}
              </span>
            )}
            <span
              style={{
                marginLeft: "auto",
                fontSize: ".72rem",
                color: "var(--placeholder)",
              }}
              className="mono"
            >
              ⌘↵ to send
            </span>
            <button
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
          items.map((ev) => <TimelineItem key={ev.id} ev={ev} />)
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
