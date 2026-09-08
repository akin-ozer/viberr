import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useSearchParams } from "react-router";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import { useCsrfToken } from "~/ui/csrf-input";
import { Icon } from "~/ui/icon";
import { LocalDayDotTime } from "~/ui/local-time";
import { Markdown } from "~/ui/markdown";
import { AttachmentThumb } from "./attachment-image";
import { IMAGE_RE, useAttachmentLightbox } from "./attachment-lightbox";
import { Pill } from "~/ui/pill";
import { RichText } from "~/ui/rich-text";
import { useModifierHint } from "~/ui/use-shortcut-hint";
import { useToast } from "~/ui/toast";
import { EVIDENCE_EMPTY_COLUMN } from "~/schemas/task-file.schema";
import { eventMeta, typedKind } from "./event-meta";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { TaskRunPrincipalView } from "./run-principal-view";
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
  attachmentNames,
  attachmentsBase,
}: {
  text: string;
  mentionNames?: string[];
  /** The task's real attachment filenames + serving base, so an agent-written
   *  workspace-relative attachment link in the body resolves (markdown.tsx
   *  `repairAttachmentHref`). */
  attachmentNames?: ReadonlySet<string>;
  attachmentsBase?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Embedded attachment images in the body open the same lightbox the
  // thumbnail strip uses (no provider ⇒ the factory is inert, embeds stay
  // plain images).
  const lightbox = useAttachmentLightbox();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // scrollHeight reports the FULL content height even while clamped by
    // max-height, so this stays correct in both states.
    const measure = () => setOverflowing(el.scrollHeight > COLLAPSE_MAX + 24);
    measure();
    // The first measure above is the whole contract on a host that provides no
    // ResizeObserver (jsdom); only the re-measure on resize is lost.
    if (!("ResizeObserver" in globalThis)) return;
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
        <Markdown
          text={text}
          mentionNames={mentionNames}
          {...(attachmentNames ? { attachmentNames } : {})}
          {...(attachmentsBase ? { attachmentsBase } : {})}
          onAttachmentOpen={lightbox}
        />
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

/**
 * R19-19: linkify an evidence label whose tokens name a REAL attachment.
 * Agents are told to "cite the exact filename" when a screenshot backs a
 * claim; when a token (backticks/quotes/trailing punctuation stripped) matches
 * a file the task actually has, it becomes a link to the serving route.
 * Everything else renders as the plain text it always was — no guessing.
 */
function EvidenceLabel({
  label,
  attachments,
  base,
}: {
  label: string;
  attachments?: ReadonlySet<string>;
  base?: string;
}) {
  // A cited file opens the in-app card on a plain click (owner request
  // 2026-08-21, widened by the ruling-105 addendum to every kind); modified
  // clicks keep the raw-file tab.
  const lightbox = useAttachmentLightbox();
  if (!attachments || attachments.size === 0 || !base) return <span>{label}</span>;
  const parts = label.split(/(\s+)/);
  return (
    <span>
      {parts.map((part, i) => {
        const clean = part.replace(/^[`"'([]+|[`"'),.;:\]]+$/g, "");
        if (!clean || !attachments.has(clean)) return part;
        const at = part.indexOf(clean);
        const url = `${base}/${encodeURIComponent(clean)}`;
        return (
          <span key={i}>
            {part.slice(0, at)}
            <a
              className="ev-file"
              href={url}
              target="_blank"
              rel="noreferrer"
              // Images open the lightbox; text files (ruling 105) the read-only
              // viewer; any other cited file the no-preview card — every kind
              // carries the Download button (ruling 105 addendum).
              onClick={lightbox({ name: clean, url })}
            >
              {clean}
            </a>
            {part.slice(at + clean.length)}
          </span>
        );
      })}
    </span>
  );
}

export function TimelineItem({
  ev,
  mentionNames = [],
  attachmentNames,
  attachmentsBase,
}: {
  ev: TimelineEventRender;
  /** Known mentionable names, for whole-name @mention chips in comment bodies
   *  AND in typed-event text. */
  mentionNames?: string[];
  /** R19-19: the task's real attachment filenames (evidence linkify). */
  attachmentNames?: ReadonlySet<string>;
  /** The attachment route base — absent (e.g. bare renders) ⇒ plain labels. */
  attachmentsBase?: string;
}) {
  const meta = eventMeta(ev.type);
  const actor = ev.actor;
  const isTyped = ev.type !== "comment";
  const guest = actor.kind === "human" && "guest" in actor && actor.guest;
  // Image evidence pops the in-app lightbox on a plain click; the anchors stay
  // real links so modified clicks and no-provider renders keep the raw tab.
  const lightbox = useAttachmentLightbox();
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
            <CollapsibleComment
              text={ev.text}
              mentionNames={mentionNames}
              {...(attachmentNames ? { attachmentNames } : {})}
              {...(attachmentsBase ? { attachmentsBase } : {})}
            />
          </div>
        ) : (
          <>
            {ev.title && (
              <div className="tl-text">
                <strong>{ev.title}</strong>
              </div>
            )}
            <div className="tl-text">
              {/* F20: typed-event text goes through the SAME known-name filter
                  the comment bodies use — a bare `@nobody` in a system-written
                  line routes nowhere, so it must not look like a live tag. */}
              <RichText text={ev.text} names={mentionNames} />
            </div>
            {ev.evidence && (
              <div className="tl-card evidence">
                {/* The add/del columns are a DIFF shape. A verdict's rows are
                    usually citations with no counts, and the normalizer fills
                    both cells with the `—` placeholder so the `label · add ·
                    del` line still round-trips through task.md — which rendered
                    as two meaningless dashes pinned to the right of every row.
                    The placeholder stays in the FILE (the parser pops the last
                    two segments); it just stops being drawn when no row in the
                    block cites a real count. Block-level, not per-row, so rows
                    stay aligned when only some carry numbers. */}
                {(() => {
                  const counted = ev.evidence.some(
                    (e) =>
                      (e.add && e.add !== EVIDENCE_EMPTY_COLUMN) ||
                      (e.del && e.del !== EVIDENCE_EMPTY_COLUMN),
                  );
                  return ev.evidence.map((e, i) => (
                    <div className="ev-row" key={i}>
                      <EvidenceLabel
                        label={e.label}
                        {...(attachmentNames ? { attachments: attachmentNames } : {})}
                        {...(attachmentsBase ? { base: attachmentsBase } : {})}
                      />
                      {counted && (
                        <span className="ev-counts">
                          <span className="add">{e.add}</span>{" "}
                          <span className="del">{e.del}</span>
                        </span>
                      )}
                    </div>
                  ));
                })()}
              </div>
            )}
          </>
        )}
        {/* Files this event's run saved (attachments panel shows the same names
            with "added by …") — the producing message names its own files.
            Chips need the serving base; without it (bare renders, withheld
            lists) the names stay off rather than rendering dead links. */}
        {ev.attachments && ev.attachments.length > 0 && attachmentsBase && (
          <div className="tl-attach">
            {/* An image the run captured IS the deliverable on a screenshot
                task — it renders as the picture, right on the producing
                message (the owner's ask, 2026-08-20: chips alone made the
                human open the side panel to see what the agent "posted").
                Non-image files keep the chip; the route serves whitelisted
                image types inline, sandboxed, member-only. */}
            {ev.attachments.filter((name) => IMAGE_RE.test(name)).map((name) => (
              <AttachmentThumb
                key={name}
                variant="timeline"
                href={`${attachmentsBase}/${encodeURIComponent(name)}`}
                name={name}
                openLabel={`Open attachment ${name}`}
                onOpen={lightbox({
                  name,
                  url: `${attachmentsBase}/${encodeURIComponent(name)}`,
                })}
              >
                <span className="nm">{name}</span>
              </AttachmentThumb>
            ))}
            {ev.attachments.filter((name) => !IMAGE_RE.test(name)).map((name) => (
              // Ruling 105 (+ addendum): a text-typed chip opens the in-app
              // read-only viewer; any other kind the no-preview card with
              // its Download button.
              <a
                key={name}
                className="tl-attach-chip"
                href={`${attachmentsBase}/${encodeURIComponent(name)}`}
                target="_blank"
                rel="noreferrer"
                onClick={lightbox({
                  name,
                  url: `${attachmentsBase}/${encodeURIComponent(name)}`,
                })}
              >
                <Icon name="file" />
                <span className="nm">{name}</span>
              </a>
            ))}
          </div>
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
  runPrincipal,
  onAgentLog,
  taskClosed,
  runLive,
  attachmentNames,
  attachmentsBase,
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
  /** Ruling 127: the task owner whose accounts an `@claude` / `@codex` mention
   *  would bill, so the menu can mark a handle that would refuse. */
  runPrincipal?: TaskRunPrincipalView | null;
  /** BUG 3: when an @agent comment triggers a run, the server returns the
   *  grouped Agent-logs id to auto-select + stream. Fired once per success. */
  onAgentLog?: (threadId: string) => void;
  /** Terminal-stage task (R7-6): comments stay ENABLED — only a subtle hint
   *  above the composer says the task is closed. */
  taskClosed?: boolean;
  /** U33-1: a run is live (queued or running) on this task RIGHT NOW — the same
   *  projection fact the Live-run strip renders from, ~400px up the same page.
   *  Ruling 87(b) exists so a healthy pre-run phase reads as healthy, and the
   *  no-events empty state below undid half of it: it declared "this task
   *  hasn't started its operator loop" while the strip above said "Preparing
   *  workspace · Cloning akin-ozer/viberr · 13%". Absent (bare renders) ⇒ the
   *  original copy, which is honest exactly when nothing is running. */
  runLive?: boolean;
  /** R19-19: the task's real attachment filenames — evidence labels citing one
   *  become links to the serving route. Absent ⇒ plain text (bare renders,
   *  non-members whose list the loader withheld). */
  attachmentNames?: string[];
  attachmentsBase?: string;
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
  // R19-19: set-ify once per list — the per-token evidence lookup is O(1).
  const attachmentSet = useMemo(
    () => (attachmentNames?.length ? new Set(attachmentNames) : null),
    [attachmentNames],
  );
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
          <div className="fine xs">
            This task is closed. Comments are still recorded.
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
              runPrincipal={runPrincipal}
              onChange={(raw) => {
                draftRef.current = raw;
              }}
              onSubmit={send}
            />
          </div>
          <div className="composer-foot">
            {/* UXA-1: this read "Open to every registered user" — the same false
                sentence the task page's Permissions panel (since removed, ruling 167) had dropped
                under E1 ("false, and false on a surface whose whole job is
                stating what the server enforces"). Membership is the gate:
                R15-4 members-only was re-proven live this pass — a signed-in
                non-member 404s on the page and on the comment POST. Say what
                the server actually enforces, in the panel's own words. */}
            <span className="fine xs dim">
              Every project member can comment · @mentions route to agents
            </span>
            {commentError && (
              <span className="composer-err" role="alert">
                {commentError}
              </span>
            )}
            <span
              className="mono fine xs dim push"
              suppressHydrationWarning
            >
              {sendHint} to send
            </span>
            <button
              type="button"
              className="btn sm"
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

      <div className="timeline">
        {/* UI-40: `items` is the FILTERED view of an already-bounded slice, so
            "this task hasn't started" was printed for a task with plenty of
            history whenever the active tab matched nothing — with "Show older
            events · N more" rendered directly beneath it. */}
        {items.length === 0 ? (
          <div className="empty">
            {events.length === 0
              ? runLive
                ? // U33-1: the loop HAS started — the Live-run strip on this
                  //  same page is showing its progress. Saying "hasn't started"
                  //  here contradicted it, and contradicted ruling 87(b)'s whole
                  //  point (a healthy pre-run phase must be distinguishable from
                  //  a wedged one). An empty timeline under a live run is the
                  //  normal first seconds: the run has not reported yet.
                  "The loop has started. Its first events land here as the live run above reports in."
                : "No activity yet. This task hasn't started its operator loop."
              : f === "comment"
                ? "No comments in the loaded history. Switch to All, or load older events."
                : // F18-14: "governance" is a banned UI word (design/CONVERSATION-SUMMARY
                  // line 22); this is the "Important" filter's empty state, so name that tab.
                  "No important events in the loaded history. Switch to All, or load older events."}
          </div>
        ) : (
          items.map((ev) => (
            <TimelineItem
              key={ev.id}
              ev={ev}
              mentionNames={mentionNames}
              {...(attachmentSet ? { attachmentNames: attachmentSet } : {})}
              {...(attachmentsBase ? { attachmentsBase } : {})}
            />
          ))
        )}
        {hasMore && (
          <button
            type="button"
            className="btn ghost sm more-act"
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
