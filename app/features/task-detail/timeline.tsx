import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher, useLocation, useNavigate, useSearchParams } from "react-router";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import type { TaskLinks } from "~/shared/task-key-links";
import {
  hashTarget,
  KB_CORRECTIONS_ANCHOR,
  KB_PROPOSALS_ANCHOR,
  TASK_TIMELINE_ANCHOR,
  timelineEventAnchor,
  timelineEventTime,
} from "~/shared/page-anchors";
import { useHashTarget } from "~/ui/use-hash-target";
import { useCsrfToken } from "~/ui/csrf-input";
import { gatesPill } from "~/features/github/github-pills";
import type { GateNoteState } from "~/shared/project-gates";
import { Icon, type IconName } from "~/ui/icon";
import { LocalDayDotTime, useHydrated } from "~/ui/local-time";
import { Markdown } from "~/ui/markdown";
import { Collapsible, FoldToggle, useFirstRow, type Hidden } from "~/ui/collapsible";
import { AttachmentThumb } from "./attachment-image";
import { GateResults } from "./gate-results";
import { fileExtension, fileFamily, IMAGE_RE } from "./attachment-kind";
import { useAttachmentLightbox } from "./attachment-lightbox";
import { Pill } from "~/ui/pill";
import { useModifierHint } from "~/ui/use-shortcut-hint";
import { useToast } from "~/ui/toast";
import { useFetcherResult } from "~/ui/use-fetcher-result";
import { AttachButton, AttachTray, useFileDrop } from "~/ui/attach-files";
import { addPickedFiles, filesFromPaste } from "~/ui/picked-files";
import { MESSAGE_BATCH } from "~/shared/attachment-kinds";
import { useStableRows, useStableValue } from "~/ui/use-stable-rows";
import type { VerdictNoteView } from "~/shared/verdict-note";
import { eventMeta, typedKind } from "./event-meta";
import { citedFiles, EvidenceList, VerdictCard } from "./evidence-list";
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

/** Whether the filter tab `f` shows `ev`. */
function shownBy(f: TimelineFilterId, ev: Pick<TimelineEventRender, "type">): boolean {
  return f === "all" ? true : f === "comment" ? ev.type === "comment" : ev.type !== "comment";
}

/** Ruling 497: a notification about an event links to it (`#event-<time>`). */
function isEventAnchor(id: string): boolean {
  return timelineEventTime(id) !== null;
}

/**
 * Ruling 478(f) (F40-35): every entry sits under the Timeline's own h2, so the
 * top heading its author wrote renders one level below it, and deeper levels
 * follow (`~/ui/markdown.tsx`).
 */
const ENTRY_HEADING_BASE = 3;

/**
 * A comment body that clamps when it's very tall (long agent replies) so a
 * single answer can't dominate the timeline: `Collapsible` (`~/ui/collapsible`)
 * measures it and folds it behind Show more / Show less, the fold the
 * attachments panel shares (ruling 510). Ruling 522: the pictures under the
 * card fold with it, so the item holds the fold's state and says what they
 * hide (`more`).
 */
function CollapsibleComment({
  text,
  mentionNames,
  attachmentNames,
  attachmentsBase,
  taskLinks,
  open,
  onOpenChange,
  more,
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
  open: boolean;
  onOpenChange: (open: boolean) => void;
  more: Hidden | null;
}) {
  // Embedded attachment images in the body open the same lightbox the
  // thumbnail strip uses (no provider ⇒ the factory is inert, embeds stay
  // plain images).
  const lightbox = useAttachmentLightbox();
  return (
    <Collapsible
      className="tl-text md-body"
      contentKey={text}
      open={open}
      onOpenChange={onOpenChange}
      more={more}
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
    </Collapsible>
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

/**
 * Ruling 526: a verdict's mark on the rail is the reviewer's own verdict, as a
 * gate run's is its ending (ruling 493): the check on green for an approval
 * (ruling 491), the cross on red for changes requested. Its pill stays the
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

/** Ruling 522: what a folded strip hides, as its toggle counts it: images,
 *  or files once anything but a picture is among them. */
function hiddenFiles(names: string[]): Hidden | null {
  if (names.length === 0) return null;
  const noun = names.every((name) => IMAGE_RE.test(name)) ? "image" : "file";
  return { count: names.length, noun: names.length === 1 ? noun : `${noun}s` };
}

/**
 * Ruling 457 (CS-3 / TASK-4): memoised. Its props hold still while its event
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
  /** Ruling 497: the id a link to this event names (`timelineEventAnchor`).
   *  Only the first of the events that share a time carries it. */
  anchor?: string;
  /** Ruling 497: the link that opened the page named this event. */
  targeted?: boolean;
  /** Ruling 523: that link focused this event, and it keeps the tabindex that
   *  let it once the mark ends; a focused element that loses it drops the focus
   *  to the body, and the keys that scroll `.detail` from it (G7) stop. */
  focusable?: boolean;
  /** U39-31: the other tasks the event names, key to path. */
  taskLinks?: TaskLinks;
  /** Rulings 483 and 498: the project's Controller page, whose Knowledge base
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
  const actor = ev.actor;
  const isTyped = ev.type !== "comment";
  const guest = actor.kind === "human" && "guest" in actor && actor.guest;
  // Image evidence pops the in-app lightbox on a plain click; the anchors stay
  // real links so modified clicks and no-provider renders keep the raw tab.
  const lightbox = useAttachmentLightbox();
  // Ruling 522: the files the event's run saved show their first row; the rest
  // fold with a comment's text, or behind their own toggle under a typed
  // event, and the toggle says how many it hides. Ruling 526: a typed event's
  // row that names a file already opens it, so a file that is not a picture
  // is not drawn a second time as a tile (a gate note's logs, ruling 493).
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
              open={open}
              onOpenChange={setOpen}
              more={more}
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
        ) : verdict ? (
          <VerdictCard
            title={ev.title ?? ""}
            verdict={verdict}
            rows={ev.evidence}
            attachments={attachmentNames}
            base={attachmentsBase}
            openFile={lightbox}
            mentionNames={mentionNames}
            headingBase={ENTRY_HEADING_BASE}
            {...(taskLinks ? { taskLinks } : {})}
          />
        ) : (
          <>
            {ev.title && (
              <div className="tl-text">
                <strong>{ev.title}</strong>
              </div>
            )}
            {/* Ruling 586: a long entry folds like a comment, behind its own
                Show more (a decision now carries the card it answered). */}
            <Collapsible className="tl-text md-body" contentKey={ev.text}>
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
            </Collapsible>
            {/* Ruling 483 (F40-59): a proposal is a decision a person owes, and
                the project's Controller page is where it is promoted or
                dismissed and where its document opens. Ruling 498: a
                correction an agent wrote is reviewed and undone there; a
                person's undo (the one `kb_correction` a person writes) owes
                nothing. A plain string prop, never `useParams`: a router hook
                re-renders every memoised row on each router change (ruling
                457, CS-3). */}
            {knowledgeHref &&
              (ev.type === "proposal" || (ev.type === "kb_correction" && ev.actor.kind !== "human")) && (
                <Link
                  className="linkish tl-proposal-link"
                  to={`${knowledgeHref}#${ev.type === "proposal" ? KB_PROPOSALS_ANCHOR : KB_CORRECTIONS_ANCHOR}`}
                >
                  {ev.type === "proposal" ? "Open proposals" : "Review or undo"}
                </Link>
              )}
            {ev.evidence && (
              <EvidenceList
                rows={ev.evidence}
                attachments={attachmentNames}
                base={attachmentsBase}
                openFile={lightbox}
              />
            )}
          </>
        )}
        {/* Files this event's run saved (attachments panel shows the same names
            with "added by …") — the producing message names its own files.
            Chips need the serving base; without it (bare renders, withheld
            lists) the names stay off rather than rendering dead links. */}
        {files.length > 0 && (
          <div className="tl-attach" ref={firstRow.ref}>
            {/* An image the run captured IS the deliverable on a screenshot
                task — it renders as the picture, right on the producing
                message (the owner's ask, 2026-08-20: chips alone made the
                human open the side panel to see what the agent "posted").
                Any other file is the same tile, a page carrying its
                extension in the picture's place (owner ask 2026-09-25); the
                route serves whitelisted image types inline, sandboxed,
                member-only. */}
            {shown.map((name) => {
              const href = `${attachmentsBase}/${encodeURIComponent(name)}`;
              if (IMAGE_RE.test(name)) {
                return (
                  <AttachmentThumb
                    key={name}
                    variant="timeline"
                    href={href}
                    name={name}
                    openLabel={`Open attachment ${name}`}
                    onOpen={lightbox({ name, url: href })}
                  >
                    <span className="nm">{name}</span>
                  </AttachmentThumb>
                );
              }
              const ext = fileExtension(name);
              const label = ext.length > 0 && ext.length <= 5;
              return (
                // Ruling 105 (+ addendum): a text-typed file opens the in-app
                // read-only viewer; any other kind the no-preview card with
                // its Download button.
                <a
                  key={name}
                  className="tl-attach-file"
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={lightbox({ name, url: href })}
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
        {/* Ruling 522: a comment's toggle stands at the foot of its card; a
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
  /** Ruling 547: a link to a decision or to the recommendations landed here,
   *  because they are gone from the page (the task page's `regionPlace`). */
  landed?: boolean;
  /** Rulings 483 and 498: the project's Controller page, which a `proposal` or
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
  /** Ruling 573: the viewer may attach files to a comment (`attach-file`, a
   *  task not archived). Absent ⇒ the composer takes words only. */
  canAttach?: boolean;
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
  // Ruling 573: the files going with the comment, and the first refused.
  const [files, setFiles] = useState<File[]>([]);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  // Stable, so the memoised paperclip and tray skip a revalidation's render
  // (ruling 457); the ref holds the picks the next add builds on.
  const filesNow = useRef<File[]>(files);
  filesNow.current = files;
  const addFiles = useCallback((incoming: File[]) => {
    const next = addPickedFiles(filesNow.current, incoming, MESSAGE_BATCH);
    filesNow.current = next.files;
    setFiles(next.files);
    setFileProblem(next.problem);
  }, []);
  const removeFile = useCallback((name: string) => {
    setFiles((cur) => cur.filter((file) => file.name !== name));
    setFileProblem(null);
  }, []);
  const { dropping, dropProps } = useFileDrop(addFiles, !canAttach);
  const pendingFiles = useRef<readonly File[]>([]);
  useFetcherResult(fetcher, (data) => {
    const sentFiles = pendingFiles.current;
    pendingFiles.current = [];
    if (data.ok) {
      // Ruling 573: the files that went out leave the tray; a failure keeps them.
      setFiles((cur) => cur.filter((file) => !sentFiles.includes(file)));
      setFileProblem(null);
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

  const items = useMemo(() => rows.filter((e) => shownBy(f, e)), [rows, f]);
  // Ruling 497: the first of the events that share a time is the one its
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

  // Ruling 497: a notification about an event opens it here. A filter tab that
  // hides it opens to All, older events load until it is among them, and it
  // comes into view, marked (`useHashTarget`). Each step happens once for the
  // navigation that named the event, so the person can switch tabs after.
  const location = useLocation();
  const navigate = useNavigate();
  // After hydration only, as `useHashTarget` reads it: the server never sees it.
  const targetTime = useHydrated() ? timelineEventTime(hashTarget(location.hash)) : null;
  const target = targetTime ? (rows.find((e) => e.occurredAt === targetTime) ?? null) : null;
  const targeted = useHashTarget(isEventAnchor, target !== null && shownBy(f, target));
  // Ruling 523: the event the latest link named, still focusable after the
  // person's next press ends its mark.
  const [arrived, setArrived] = useState<string | null>(null);
  if (targeted !== null && targeted !== arrived) setArrived(targeted);
  const steppedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!targetTime || steppedFor.current === location.key) return;
    if (target) {
      if (shownBy(f, target)) return;
      steppedFor.current = location.key;
      setF("all");
      return;
    }
    // Newest first: when the oldest event loaded is older than the target,
    // the target would be among them, so this timeline no longer holds it.
    const oldest = rows.at(-1);
    if (!hasMore || (oldest && oldest.occurredAt < targetTime)) return;
    steppedFor.current = location.key;
    const search = new URLSearchParams(location.search);
    search.set("events", String(nextLimit));
    void navigate(
      { pathname: location.pathname, search: `?${search}`, hash: location.hash },
      { replace: true, preventScrollReset: true },
    );
  }, [targetTime, target, f, rows, hasMore, nextLimit, location, navigate]);

  const send = () => {
    const text = draftRef.current.trim();
    // Ruling 573: files alone are a comment.
    if ((!text && files.length === 0) || busy) return;
    const fd = new FormData();
    fd.set("_csrf", csrf);
    fd.set("intent", "comment");
    fd.set("text", text);
    for (const file of files) fd.append("files", file);
    pendingFiles.current = files;
    fetcher.submit(fd, files.length > 0 ? { method: "post", encType: "multipart/form-data" } : { method: "post" });
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
              // Ruling 573: a bare screenshot joins the comment before the
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
            {/* Ruling 625: the controller composer's hint, in its words and
                its class: the body face (a key hint is not code), and gone
                on a touch screen (ruling 419(d)). */}
            <span className="fine dim push kbd-hint" suppressHydrationWarning>
              {sendHint} sends
            </span>
            {/* Ruling 500: the frame's one action, primary as the
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
