import type { RefObject } from "react";
import { Link } from "react-router";
import type { TimelineEventRender } from "~/shared/mapping/task-event.server";
import type { TaskLinks } from "~/shared/task-key-links";
import { KB_CORRECTIONS_ANCHOR, KB_PROPOSALS_ANCHOR } from "~/shared/page-anchors";
import { gatesPill } from "~/features/github/github-pills";
import { Icon } from "~/ui/icon";
import { LocalDayDotTime } from "~/ui/local-time";
import { Markdown } from "~/ui/markdown";
import { Collapsible, type Hidden } from "~/ui/collapsible";
import { Pill } from "~/ui/pill";
import { IMAGE_RE } from "~/ui/picked-files";
import { AttachmentThumb } from "./attachment-image";
import { GateResults } from "./gate-results";
import { fileExtension, fileFamily } from "./attachment-kind";
import { useAttachmentLightbox } from "./attachment-lightbox";
import { typedKind } from "./event-meta";
import { EvidenceList, VerdictCard } from "./evidence-list";

/**
 * The parts of one timeline entry (ruling 700(e), the split of `timeline.tsx`
 * along the task page's recipe): its meta row, its body (a comment's card, a
 * gate run's table, a verdict's card or a typed event's text and evidence)
 * and the strip of files its run saved. `TimelineItem` keeps the entry's
 * hooks, the fold's state among them, and hands each part what it draws; the
 * parts call no hook but `CollapsibleComment`'s own, which it always had.
 */

/** The lightbox opener `TimelineItem` reads once and hands its parts. */
type OpenAttachment = ReturnType<typeof useAttachmentLightbox>;

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

/** What an entry's body is handed: its event, the lookups the timeline shares
 *  across its rows, and the fold its pictures share with a comment's text. */
interface EntryBodyProps {
  ev: TimelineEventRender;
  mentionNames: string[];
  taskLinks: TaskLinks | undefined;
  attachmentNames: ReadonlySet<string> | undefined;
  attachmentsBase: string | undefined;
  knowledgeHref: string | undefined;
  lightbox: OpenAttachment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  more: Hidden | null;
}

/** The entry's meta row: who, the category pill, a gate run's revision, the
 *  agent and former-member badges, and when. */
export function TimelineEntryMeta({
  ev,
  isTyped,
  label,
}: {
  ev: TimelineEventRender;
  isTyped: boolean;
  /** The rail mark's word: the category, or how a gate run ended. */
  label: string;
}) {
  const gates = ev.gates;
  const actor = ev.actor;
  const guest = actor.kind === "human" && "guest" in actor && actor.guest;
  return (
    <div className="tl-meta">
      {/* Identity is the actor's NAME only — for agents that is the
          agent's own name (e.g. "Reviewer"), never the runtime label or a
          trailing role. */}
      <span className="tl-actor">{actor.name}</span>
      {isTyped && (
        <Pill kind={gates ? gatesPill(gates.state).kind : typedKind(ev.type)} sm>
          {label}
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
  );
}

/** The entry's body: a comment's card, a gate run's note (ruling 493), a
 *  reviewer's verdict (ruling 526), or any other typed event. */
export function TimelineEntryBody({
  ev,
  mentionNames,
  taskLinks,
  attachmentNames,
  attachmentsBase,
  knowledgeHref,
  lightbox,
  open,
  onOpenChange,
  more,
}: EntryBodyProps) {
  if (ev.type === "comment") {
    return (
      <div className={"comment-card" + (ev.toAgent ? " toagent" : "")}>
        {/* Comments (agent replies AND user comments) are real multi-line
            markdown — render with the GFM renderer. Long replies clamp
            behind a Show more toggle so one answer can't swallow the
            timeline. */}
        <CollapsibleComment
          text={ev.text}
          mentionNames={mentionNames}
          taskLinks={taskLinks}
          attachmentNames={attachmentNames}
          attachmentsBase={attachmentsBase}
          open={open}
          onOpenChange={onOpenChange}
          more={more}
        />
      </div>
    );
  }
  if (ev.gates) {
    return (
      <GateNoteBody
        gates={ev.gates}
        taskLinks={taskLinks}
        attachmentsBase={attachmentsBase}
        lightbox={lightbox}
      />
    );
  }
  if (ev.verdict) {
    return (
      <VerdictCard
        title={ev.title ?? ""}
        verdict={ev.verdict}
        rows={ev.evidence}
        attachments={attachmentNames}
        base={attachmentsBase}
        openFile={lightbox}
        mentionNames={mentionNames}
        headingBase={ENTRY_HEADING_BASE}
        {...(taskLinks ? { taskLinks } : {})}
      />
    );
  }
  return (
    <TypedEventBody
      ev={ev}
      mentionNames={mentionNames}
      taskLinks={taskLinks}
      attachmentNames={attachmentNames}
      attachmentsBase={attachmentsBase}
      knowledgeHref={knowledgeHref}
      lightbox={lightbox}
    />
  );
}

function GateNoteBody({
  gates,
  taskLinks,
  attachmentsBase,
  lightbox,
}: {
  gates: NonNullable<TimelineEventRender["gates"]>;
  taskLinks: TaskLinks | undefined;
  attachmentsBase: string | undefined;
  lightbox: OpenAttachment;
}) {
  return (
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
  );
}

function TypedEventBody({
  ev,
  mentionNames,
  taskLinks,
  attachmentNames,
  attachmentsBase,
  knowledgeHref,
  lightbox,
}: Omit<EntryBodyProps, "open" | "onOpenChange" | "more">) {
  return (
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
  );
}

/** The files the entry's run saved, as `TimelineItem` shows them now: the
 *  first row, or all of them once its fold is open (ruling 522). */
export function TimelineEntryFiles({
  names,
  attachmentsBase,
  rowRef,
  lightbox,
}: {
  names: string[];
  attachmentsBase: string | undefined;
  /** `useFirstRow`'s strip, which it measures. */
  rowRef: RefObject<HTMLDivElement | null>;
  lightbox: OpenAttachment;
}) {
  return (
    <div className="tl-attach" ref={rowRef}>
      {/* An image the run captured IS the deliverable on a screenshot
          task — it renders as the picture, right on the producing
          message (the owner's ask, 2026-08-20: chips alone made the
          human open the side panel to see what the agent "posted").
          Any other file is the same tile, a page carrying its
          extension in the picture's place (owner ask 2026-09-25); the
          route serves whitelisted image types inline, sandboxed,
          member-only. */}
      {names.map((name) => {
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
  );
}
