import { memo, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import type { TaskLinks } from "~/shared/task-key-links";
import { TASK_TIMELINE_ANCHOR, timelineEventAnchor } from "~/shared/page-anchors";
import type { GateNoteState } from "~/shared/project-gates";
import { Icon, type IconName } from "~/ui/icon";
import { FoldToggle, useFirstRow, type Hidden } from "~/ui/collapsible";
import { useAttachmentLightbox } from "./attachment-lightbox";
import { useModifierHint } from "~/ui/use-shortcut-hint";
import { AttachButton, AttachTray } from "~/ui/attach-files";
import { filesFromPaste, IMAGE_RE } from "~/ui/picked-files";
import { useStableRows, useStableValue } from "~/ui/use-stable-rows";
import type { VerdictNoteView } from "~/shared/verdict-note";
import { eventMeta } from "./event-meta";
import { citedFiles } from "./cited-files";
import type { Mentionables } from "~/server/tasks/mention-suggestions.server";
import type { TaskRunPrincipalView } from "./run-principal-view";
import { mentionNamesFor } from "./mention-autocomplete";
import { CommentComposer } from "./comment-composer-slot";
import { useCommentPost, useTimelineTab } from "./timeline-actions";
import { emptyTimelineText, shownBy } from "./timeline-derive";
import { TimelineEntryBody, TimelineEntryFiles, TimelineEntryMeta } from "./timeline-entry";

/**
 * Unified timeline — 1:1 port of Timeline/TimelineItem (task.jsx §4.6/§4.7):
 * filter tabs (All / Important events / Comments), comment composer with
 * ⌘↵ send + @agent routing (server-detected), newest-first event list with
 * the 9 typed-event renderings, evidence rows, guest pills, toagent tint.
 *
 * Real-app replacements: events carry UTC ISO `occurredAt` → the shared
 * ruling-293 formatter renders "9:41" / "Yesterday · 15:12" / "Mar 30 · 17:26";
 * posting goes through the route action (revalidation, no optimistic
 * governed state; failures keep the draft and show an inline error);
 * long histories are served as a bounded newest-first slice with a
 * "Show older" affordance driving the `?events=` param (progressive
 * disclosure — the first payload never ships the full history).
 *
 * Ruling 13(b) split the two components along the task page's recipe, a
 * pure structural refactor: the comment post and the filter tab with its
 * landing are hooks in `timeline-actions.ts`, called where their hooks always
 * ran; what the list reads off its tab is pure functions in
 * `timeline-derive.ts`; an entry's meta row, body and files are hook-free
 * parts in `timeline-entry.tsx`, while `TimelineItem` keeps its hooks and the
 * fold's state.
 */

const TL_FILTERS = [
  { id: "all", label: "All" },
  { id: "typed", label: "Important events" },
  { id: "comment", label: "Comments" },
] as const;

export type TimelineFilterId = (typeof TL_FILTERS)[number]["id"];

/**
 * Ruling 313: a gate run's note takes its ending's mark on the rail and its
 * word in the pill, in the PR card's colours (`gatesPill`). Beside the actor
 * the pill finishes the sentence: "Project gates passed".
 */
const GATE_NOTE_META = {
  passed: { node: "completion", icon: "check", label: "passed" },
  failed: { node: "blocked", icon: "x", label: "failed" },
  error: { node: "blocked", icon: "alert", label: "could not run" },
} as const satisfies Record<GateNoteState, { node: string; icon: IconName; label: string }>;

/**
 * Ruling 313: a verdict's mark on the rail is the reviewer's own verdict, as a
 * gate run's is its ending (ruling 313): the check on green for an approval
 * (ruling 315), the cross on red for changes requested. Its pill stays the
 * category; the card under it says the rest.
 */
const VERDICT_META = {
  approve: { node: "completion", icon: "check", label: "Review verdict" },
  request_changes: { node: "blocked", icon: "x", label: "Review verdict" },
} as const satisfies Record<VerdictNoteView["result"], { node: string; icon: IconName; label: string }>;

/** Row keys for `useStableRows` (stable, module-level). */
const eventKeyOf = (ev: TimelineEventRender) => String(ev.id);

/** A mention-free default that keeps its identity, so a bare render's memo
 *  compares equal (an inline `= []` is a new array on every call). */
const NO_NAMES: string[] = [];

/** An event's files as its strip draws them: the pictures, then the rest. */
function picturesFirst(names: string[]): string[] {
  return [...names.filter((name) => IMAGE_RE.test(name)), ...names.filter((name) => !IMAGE_RE.test(name))];
}

/** Ruling 314: what a folded strip hides, as its toggle counts it: images,
 *  or files once anything but a picture is among them. */
function hiddenFiles(names: string[]): Hidden | null {
  if (names.length === 0) return null;
  const noun = names.every((name) => IMAGE_RE.test(name)) ? "image" : "file";
  return { count: names.length, noun: names.length === 1 ? noun : `${noun}s` };
}

/**
 * Ruling 11 (CS-3 / TASK-4): memoised. Its props hold still while its event
 * does (the timeline shares the rows and the lookups it passes across
 * revalidations), so a send's fetcher states and a live event that brings
 * the same rows back re-render none of the items; each used to re-run its
 * Markdown, its hooks and its icons.
 */
export const TimelineItem = memo(function TimelineItem({
  ev,
  anchor,
  targeted = false,
  focusable = false,
  mentionNames = NO_NAMES,
  attachmentNames,
  attachmentsBase,
  taskLinks,
  knowledgeHref,
}: {
  ev: TimelineEventRender;
  /** Ruling 75: the id a link to this event names (`timelineEventAnchor`).
   *  Only the first of the events that share a time carries it. */
  anchor?: string;
  /** Ruling 302: the link that opened the page named this event. */
  targeted?: boolean;
  /** Ruling 302(c): that link focused this event, and it keeps the tabindex that
   *  let it once the mark ends; a focused element that loses it drops the focus
   *  to the body, and the keys that scroll `.detail` from it (G7) stop. */
  focusable?: boolean;
  /** U39-31: the other tasks the event names, key to path. */
  taskLinks?: TaskLinks;
  /** Rulings 267 and 210: the project's Controller page, whose Knowledge base
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
  const verdict = ev.verdict;
  const meta = gates
    ? GATE_NOTE_META[gates.state]
    : verdict
      ? VERDICT_META[verdict.result]
      : eventMeta(ev.type);
  const isTyped = ev.type !== "comment";
  // Image evidence pops the in-app lightbox on a plain click; the anchors stay
  // real links so modified clicks and no-provider renders keep the raw tab.
  const lightbox = useAttachmentLightbox();
  // Ruling 314: the files the event's run saved show their first row; the rest
  // fold with a comment's text, or behind their own toggle under a typed
  // event, and the toggle says how many it hides. Ruling 313: a typed event's
  // row that names a file already opens it, so a file that is not a picture
  // is not drawn a second time as a tile (a gate note's logs, ruling 313).
  const files = useMemo(() => {
    if (!ev.attachments || !attachmentsBase) return NO_NAMES;
    const cited = isTyped && ev.evidence && attachmentNames ? citedFiles(ev.evidence, attachmentNames) : null;
    const kept = cited ? ev.attachments.filter((name) => IMAGE_RE.test(name) || !cited.has(name)) : ev.attachments;
    return kept.length > 0 ? picturesFirst(kept) : NO_NAMES;
  }, [ev.attachments, ev.evidence, isTyped, attachmentNames, attachmentsBase]);
  const firstRow = useFirstRow(files.length);
  const [open, setOpen] = useState(false);
  const more = hiddenFiles(files.slice(firstRow.perRow));
  const shown = open ? files : files.slice(0, firstRow.perRow);
  return (
    <div
      className="tl-item"
      id={anchor}
      tabIndex={targeted || focusable ? -1 : undefined}
      data-targeted={targeted || undefined}
    >
      <div className="tl-rail">
        <div className={"tl-node " + meta.node}>
          <Icon name={meta.icon} />
        </div>
        <div className="tl-line" />
      </div>
      <div className="tl-body">
        <TimelineEntryMeta ev={ev} isTyped={isTyped} label={meta.label} />
        <TimelineEntryBody
          ev={ev}
          mentionNames={mentionNames}
          taskLinks={taskLinks}
          attachmentNames={attachmentNames}
          attachmentsBase={attachmentsBase}
          knowledgeHref={knowledgeHref}
          lightbox={lightbox}
          open={open}
          onOpenChange={setOpen}
          more={more}
        />
        {/* Files this event's run saved (attachments panel shows the same names
            with "added by …") — the producing message names its own files.
            Chips need the serving base; without it (bare renders, withheld
            lists) the names stay off rather than rendering dead links. */}
        {files.length > 0 && (
          <TimelineEntryFiles
            names={shown}
            attachmentsBase={attachmentsBase}
            rowRef={firstRow.ref}
            lightbox={lightbox}
          />
        )}
        {/* Ruling 314: a comment's toggle stands at the foot of its card; a
            typed event has no card, so its pictures' toggle follows them. */}
        {isTyped && more && <FoldToggle open={open} onOpenChange={setOpen} cut={false} more={more} />}
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
  landed = false,
  canAttach = false,
}: {
  /** Newest-first bounded slice from the loader. */
  events: TimelineEventRender[];
  /** Ruling 302: a link to a decision or to the recommendations landed here,
   *  because they are gone from the page (`regionPlace` in
   *  task-detail-actions.tsx). */
  landed?: boolean;
  /** Rulings 267 and 210: the project's Controller page, which a `proposal` or
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
  /** Ruling 137: the task owner whose accounts an `@claude` / `@codex` mention
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
   *  Ruling 152 exists so a healthy pre-run phase reads as healthy, and the
   *  no-events empty state below undid half of it: it declared "this task
   *  hasn't started its operator loop" while the strip above said "Preparing
   *  workspace · Cloning akin-ozer/viberr · 13%". Absent (bare renders) ⇒ the
   *  original copy, which is honest exactly when nothing is running. */
  runLive?: boolean;
  /** R19-19: the task's real attachment filenames — evidence labels citing one
   *  become links to the serving route. Absent ⇒ plain text (bare renders). */
  attachmentNames?: string[];
  attachmentsBase?: string;
  /** Ruling 76: the viewer may attach files to a comment (`attach-file`, a
   *  task not archived). Absent ⇒ the composer takes words only. */
  canAttach?: boolean;
}) {
  // P13-D-39: the send handler below accepts either modifier, so the hint has to
  // name the one the viewer's keyboard actually has (UI-55's rule).
  const sendHint = useModifierHint("↵");
  // Ruling 11 (CS-3 / TASK-4): every revalidation decodes new objects for
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
  const [, setSearchParams] = useSearchParams();
  // The comment the composer sends, its files and the "Ask operator" prefill
  // (`useCommentPost`, timeline-actions.ts).
  const {
    composerRef,
    composerBoxRef,
    busy,
    commentError,
    files,
    fileProblem,
    addFiles,
    removeFile,
    dropping,
    dropProps,
    send,
    submitDraft,
    keepDraft,
  } = useCommentPost({ ask, canAttach, onAgentLog });
  // The filter tab, which a link to an event opens to All (ruling 302), the
  // event it marks and, ruling 302(c), the one it keeps focusable
  // (`useTimelineTab`, timeline-actions.ts).
  const { f, setF, targeted, arrived } = useTimelineTab({ tlDefault, rows, hasMore, nextLimit });

  const items = useMemo(() => rows.filter((e) => shownBy(f, e)), [rows, f]);
  // Ruling 75: the first of the events that share a time is the one its
  // link names (they were written together, so they sit together).
  const anchors = useMemo(() => {
    const byEvent = new Map<number, string>();
    const taken = new Set<string>();
    for (const e of items) {
      if (taken.has(e.occurredAt)) continue;
      taken.add(e.occurredAt);
      byEvent.set(e.id, timelineEventAnchor(e.occurredAt));
    }
    return byEvent;
  }, [items]);

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
    <div
      className="panel"
      id={TASK_TIMELINE_ANCHOR}
      tabIndex={-1}
      data-targeted={landed || undefined}
    >
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
          <div className="fine">
            This task is closed. Comments are still recorded.
          </div>
        )}
        <div
          className="composer-box"
          data-dropping={dropping ? "" : undefined}
          {...(canAttach ? dropProps : {})}
        >
          {canAttach && (
            <AttachTray
              files={files}
              problem={fileProblem}
              disabled={busy}
              onRemove={removeFile}
            />
          )}
          <div
            className="composer-input"
            ref={composerBoxRef}
            onPasteCapture={(e) => {
              // Ruling 76: a bare screenshot joins the comment before the
              // editor sees the paste; copied text stays the editor's.
              if (!canAttach) return;
              const pasted = filesFromPaste(e.clipboardData, true, files);
              if (!pasted) return;
              e.preventDefault();
              e.stopPropagation();
              addFiles(pasted);
            }}
          >
            {/* Lexical plain-text editor: known @mentions highlight live as
                character-editable text (no backdrop mirroring); the posted
                value stays exactly the trimmed plain draft. Loaded lazily
                behind a same-size stand-in (ruling 300). */}
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
                sentence the task page's Permissions panel (since removed, ruling 308) had dropped
                under E1 ("false, and false on a surface whose whole job is
                stating what the server enforces"). Membership is the gate:
                R15-4 members-only was re-proven live this pass — a signed-in
                non-member 404s on the page and on the comment POST. Say what
                the server actually enforces, in the panel's own words. */}
            <span className="att-lead">
              {canAttach && <AttachButton onFiles={addFiles} disabled={busy} />}
              <span className="fine dim">
                Every project member can comment · @mentions route to agents
              </span>
            </span>
            {commentError && (
              <span className="composer-err" role="alert">
                {commentError}
              </span>
            )}
            {/* Ruling 319: the controller composer's hint, in its words and
                its class: the body face (a key hint is not code), and gone
                on a touch screen (ruling 321). */}
            <span className="fine dim push kbd-hint" suppressHydrationWarning>
              {sendHint} sends
            </span>
            {/* Ruling 313: the frame's one action, primary as the
                controller composer's Send is. */}
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

      <div className="timeline">
        {/* UI-40: `items` is the FILTERED view of an already-bounded slice, so
            "this task hasn't started" was printed for a task with plenty of
            history whenever the active tab matched nothing — with "Show older
            events · N more" rendered directly beneath it. */}
        {items.length === 0 ? (
          <div className="empty">{emptyTimelineText(events.length, runLive, f)}</div>
        ) : (
          items.map((ev) => (
            <TimelineItem
              key={ev.id}
              ev={ev}
              anchor={anchors.get(ev.id)}
              targeted={targeted !== null && anchors.get(ev.id) === targeted}
              focusable={arrived !== null && anchors.get(ev.id) === arrived}
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
