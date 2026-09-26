import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher, useSearchParams } from "react-router";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import type { TaskLinks } from "~/shared/task-key-links";
import { useCsrfToken } from "~/ui/csrf-input";
import { gatesPill } from "~/features/github/github-pills";
import type { GateNoteState } from "~/shared/project-gates";
import { Icon, type IconName } from "~/ui/icon";
import { LocalDayDotTime } from "~/ui/local-time";
import { Markdown } from "~/ui/markdown";
import { AttachmentThumb } from "./attachment-image";
import { GateResults } from "./gate-results";
import { fileExtension, fileFamily } from "./attachment-kind";
import { IMAGE_RE, useAttachmentLightbox } from "./attachment-lightbox";
import { Pill } from "~/ui/pill";
import { useModifierHint } from "~/ui/use-shortcut-hint";
import { useToast } from "~/ui/toast";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { useStableRows, useStableValue } from "~/ui/use-stable-rows";
import { EVIDENCE_EMPTY_COLUMN } from "~/schemas/task-file.schema";
import { eventMeta, typedKind } from "./event-meta";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { TaskRunPrincipalView } from "./run-principal-view";
import { mentionNamesFor } from "./mention-autocomplete";
import {
  CommentComposer,
  type CommentComposerHandle,
} from "./comment-composer-slot";

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
 * Ruling 478(f) (F40-35): every entry sits under the Timeline's own h2, so the
 * top heading its author wrote renders one level below it, and deeper levels
 * follow (`~/ui/markdown.tsx`).
 */
const ENTRY_HEADING_BASE = 3;

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
  taskLinks,
}: {
  text: string;
  mentionNames?: string[];
  /** U39-31: the other tasks the text names, key to path. */
  taskLinks?: TaskLinks;
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
          headingBase={ENTRY_HEADING_BASE}
          {...(taskLinks ? { taskLinks } : {})}
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

/**
 * Ruling 493: a gate run's note takes its ending's mark on the rail and its
 * word in the pill, in the PR card's colours (`gatesPill`). Beside the actor
 * the pill finishes the sentence: "Project gates passed".
 */
const GATE_NOTE_META = {
  passed: { node: "completion", icon: "check", label: "passed" },
  failed: { node: "blocked", icon: "x", label: "failed" },
  error: { node: "blocked", icon: "alert", label: "could not run" },
} as const satisfies Record<GateNoteState, { node: string; icon: IconName; label: string }>;

/** Row keys for `useStableRows` (stable, module-level). */
const eventKeyOf = (ev: TimelineEventRender) => String(ev.id);

/** A mention-free default that keeps its identity, so a bare render's memo
 *  compares equal (an inline `= []` is a new array on every call). */
const NO_NAMES: string[] = [];

/**
 * Ruling 457 (CS-3 / TASK-4): memoised. Its props hold still while its event
 * does (the timeline shares the rows and the lookups it passes across
 * revalidations), so a send's fetcher states and a live event that brings
 * the same rows back re-render none of the items; each used to re-run its
 * Markdown, its hooks and its icons.
 */
export const TimelineItem = memo(function TimelineItem({
  ev,
  mentionNames = NO_NAMES,
  attachmentNames,
  attachmentsBase,
  taskLinks,
  knowledgeHref,
}: {
  ev: TimelineEventRender;
  /** U39-31: the other tasks the event names, key to path. */
  taskLinks?: TaskLinks;
  /** Rulings 483 and 497: the project's Controller page, whose Knowledge base
   *  panel a `proposal` or an agent's `kb_correction` links to; absent in bare
   *  renders. */
  knowledgeHref?: string;
  /** Known mentionable names, for whole-name @mention chips in comment bodies
   *  AND in typed-event text. */
  mentionNames?: string[];
  /** R19-19: the task's real attachment filenames (evidence linkify). */
  attachmentNames?: ReadonlySet<string>;
  /** The attachment route base — absent (e.g. bare renders) ⇒ plain labels. */
  attachmentsBase?: string;
}) {
  const gates = ev.gates;
  const meta = gates ? GATE_NOTE_META[gates.state] : eventMeta(ev.type);
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
            <Pill kind={gates ? gatesPill(gates.state).kind : typedKind(ev.type)} sm>
              {meta.label}
            </Pill>
          )}
          {gates?.sha && (
            <span className="tl-gate-rev">
              on <code>{gates.sha}</code>
            </span>
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
                markdown — render with the GFM renderer. Long replies clamp
                behind a Show more toggle so one answer can't swallow the
                timeline. */}
            <CollapsibleComment
              text={ev.text}
              mentionNames={mentionNames}
              {...(taskLinks ? { taskLinks } : {})}
              {...(attachmentNames ? { attachmentNames } : {})}
              {...(attachmentsBase ? { attachmentsBase } : {})}
            />
          </div>
        ) : gates ? (
          <>
            {/* Ruling 493: the header already says how the run ended and on
                which revision, and the table holds each gate with its log, so
                the note's own sentence is not said again. A run that could not
                execute keeps its reason. */}
            {gates.detail && (
              <div className="tl-text md-body">
                <Markdown
                  text={gates.detail}
                  headingBase={ENTRY_HEADING_BASE}
                  {...(taskLinks ? { taskLinks } : {})}
                />
              </div>
            )}
            {gates.rows.length > 0 && (
              <GateResults rows={gates.rows} attachmentsBase={attachmentsBase ?? null} openLog={lightbox} />
            )}
          </>
        ) : (
          <>
            {ev.title && (
              <div className="tl-text">
                <strong>{ev.title}</strong>
              </div>
            )}
            <div className="tl-text md-body">
              {/* Ruling 478(a) (F40-30): typed-event text is markdown too. Its
                  writers put the tool's own words in a fenced block ("What the
                  checkout reported", "What the push reported") and separate
                  paragraphs with blank lines; the inline-only RichText printed
                  the fence as literal backticks, ran the lines together and
                  let a long path widen the page on a phone. The GFM renderer
                  gives the block its own scroller and breaks inline code.
                  F20: mentions go through the SAME known-name filter the
                  comment bodies use — a bare `@nobody` in a system-written
                  line routes nowhere, so it must not look like a live tag. */}
              <Markdown
                text={ev.text}
                mentionNames={mentionNames}
                headingBase={ENTRY_HEADING_BASE}
                {...(taskLinks ? { taskLinks } : {})}
                {...(attachmentNames ? { attachmentNames } : {})}
                {...(attachmentsBase ? { attachmentsBase } : {})}
                onAttachmentOpen={lightbox}
              />
            </div>
            {/* Ruling 483 (F40-59): a proposal is a decision a person owes, and
                the project's Controller page is where it is promoted or
                dismissed and where its document opens. Ruling 497: a
                correction an agent wrote is reviewed and undone there; a
                person's undo (the one `kb_correction` a person writes) owes
                nothing. A plain string prop, never `useParams`: a router hook
                re-renders every memoised row on each router change (ruling
                457, CS-3). */}
            {knowledgeHref &&
              (ev.type === "proposal" || (ev.type === "kb_correction" && ev.actor.kind !== "human")) && (
                <Link
                  className="linkish tl-proposal-link"
                  to={`${knowledgeHref}#${ev.type === "proposal" ? "kb-proposals" : "kb-corrections"}`}
                >
                  {ev.type === "proposal" ? "Open proposals" : "Review or undo"}
                </Link>
              )}
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
                Any other file is the same tile, a page carrying its
                extension in the picture's place (owner ask 2026-09-25); the
                route serves whitelisted image types inline, sandboxed,
                member-only. */}
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
            {ev.attachments.filter((name) => !IMAGE_RE.test(name)).map((name) => {
              const ext = fileExtension(name);
              const label = ext.length > 0 && ext.length <= 5;
              return (
              // Ruling 105 (+ addendum): a text-typed file opens the in-app
              // read-only viewer; any other kind the no-preview card with
              // its Download button.
              <a
                key={name}
                className="tl-attach-file"
                href={`${attachmentsBase}/${encodeURIComponent(name)}`}
                target="_blank"
                rel="noreferrer"
                onClick={lightbox({
                  name,
                  url: `${attachmentsBase}/${encodeURIComponent(name)}`,
                })}
              >
                <span className="tl-attach-glyph" data-kind={fileFamily(name)} aria-hidden="true">
                  <Icon name={label ? "page" : "file"} />
                  {label && <span className="tl-attach-ext">{ext}</span>}
                </span>
                <span className="nm">{name}</span>
              </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});

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
  taskLinks,
  knowledgeHref,
}: {
  /** Newest-first bounded slice from the loader. */
  events: TimelineEventRender[];
  /** Rulings 483 and 497: the project's Controller page, which a `proposal` or
   *  `kb_correction` event links. */
  knowledgeHref?: string;
  /** U39-31: the other tasks the slice names, key to path (loader). */
  taskLinks?: TaskLinks;
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
  // Ruling 457 (CS-3 / TASK-4): every revalidation decodes new objects for
  // all of these; kept while their content is the same, so the memoised items
  // below re-render only for an event that changed.
  const rows = useStableRows(events, eventKeyOf);
  const directory = useStableValue(mentionables);
  const links = useStableValue(taskLinks);
  const fileNames = useStableValue(attachmentNames);
  // Known mentionable names — drives whole-name @mention highlighting in the
  // composer and in rendered comment bodies.
  const mentionNames = useMemo(() => mentionNamesFor(directory), [directory]);
  // R19-19: set-ify once per list — the per-token evidence lookup is O(1).
  const attachmentSet = useMemo(
    () => (fileNames?.length ? new Set(fileNames) : null),
    [fileNames],
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
  useFetcherResult(fetcher, (data) => {
    if (data.ok) {
      draftRef.current = "";
      // Clear the editor AND its undo history — ⌘Z must not resurrect a
      // posted comment. A failure runs neither: the draft stays as typed.
      composerRef.current?.clearAfterSuccess();
      if (data.toast) push(data.toast);
      // BUG 3: hand the grouped Agent-logs id up so the page selects + scrolls
      // to the mentioned agent's live output.
      if (data.logThreadId && onAgentLog) onAgentLog(data.logThreadId);
    }
  });

  const commentError =
    fetcher.state === "idle" && fetcher.data && !fetcher.data.ok
      ? fetcher.data.error
      : null;

  const items = useMemo(
    () =>
      rows.filter((e) =>
        f === "all" ? true : f === "comment" ? e.type === "comment" : e.type !== "comment",
      ),
    [rows, f],
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
  // Ruling 457 (CS-7): the composer is memoised, so what it is handed holds
  // still while nothing it draws changed: a revalidation or a fetcher state
  // re-renders this timeline, not the editor. ⌘↵ reaches the latest `send`
  // through a ref kept current in an effect.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  const submitDraft = useCallback(() => sendRef.current(), []);
  const keepDraft = useCallback((raw: string) => {
    draftRef.current = raw;
  }, []);
  const principal = useStableValue(runPrincipal);

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
                value stays exactly the trimmed plain draft. Loaded lazily
                behind a same-size stand-in (ruling 457). */}
            <CommentComposer
              ref={composerRef}
              mentionables={directory}
              runPrincipal={principal}
              onChange={keepDraft}
              onSubmit={submitDraft}
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
              {...(links ? { taskLinks: links } : {})}
              {...(knowledgeHref ? { knowledgeHref } : {})}
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
