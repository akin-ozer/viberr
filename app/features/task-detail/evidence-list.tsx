import { useId, useLayoutEffect, useRef, useState } from "react";
import type { EvidenceStatus } from "~/schemas/task-file.schema";
import type { EvidenceRowRender } from "~/shared/mapping/task-event.server";
import type { TaskLinks } from "~/shared/task-key-links";
import type { VerdictNoteView } from "~/shared/verdict-note";
import { Icon, type IconName } from "~/ui/icon";
import { Markdown } from "~/ui/markdown";
import type { useAttachmentLightbox } from "./attachment-lightbox";
import { citedName } from "./cited-files";

/**
 * Ruling 313: an outcome's evidence as a checklist, and a reviewer's verdict
 * as a card around it.
 *
 * A row is its mark, what was checked and how it came out. The marks are the
 * circle family ruling 315 gave the PR card's status rows: a check for a
 * pass, a cross for a failure, a plain ring for a reference that is neither.
 * Failures come first and are tinted, as a failing gate's row is (ruling
 * 313), so what blocks is read before what passed; the file keeps the order
 * the agent wrote.
 */

const MARK = {
  pass: "checkcircle",
  fail: "xcircle",
  info: "ring",
} as const satisfies Record<EvidenceStatus, IconName>;

/** What a screen reader hears for the mark; a reference has none. */
const MARK_WORD = { pass: "Passed: ", fail: "Failed: ", info: "" } as const satisfies Record<EvidenceStatus, string>;

const ORDER = { fail: 0, pass: 1, info: 2 } as const satisfies Record<EvidenceStatus, number>;

/** "2 of 4 checks failed", "4 checks passed", or null when no row is a check. */
function evidenceTally(rows: readonly EvidenceRowRender[]): string | null {
  const failed = rows.filter((row) => row.status === "fail").length;
  const checks = failed + rows.filter((row) => row.status === "pass").length;
  if (checks === 0) return null;
  const noun = checks === 1 ? "check" : "checks";
  return failed > 0 ? `${failed} of ${checks} ${noun} failed` : `${checks} ${noun} passed`;
}

/**
 * R19-19: a label whose token names a REAL attachment links it. Agents are
 * told to "cite the exact filename" when a file backs a claim; when a token
 * (backticks, quotes and trailing punctuation stripped) matches a file the
 * task has, it opens in the in-app card on a plain click (owner request
 * 2026-08-21, widened by the ruling-317 addendum to every kind), and modified
 * clicks keep the raw-file tab. Ruling 313: a span in backticks is code, as
 * it is in the event's text. Nothing else is guessed at.
 */
function EvidenceLabel({
  label,
  attachments,
  base,
  openFile,
}: {
  label: string;
  attachments?: ReadonlySet<string>;
  base?: string;
  openFile: ReturnType<typeof useAttachmentLightbox>;
}) {
  const link = (name: string, key: number, code: boolean) => {
    const url = `${base}/${encodeURIComponent(name)}`;
    return (
      <a key={key} className="ev-file" href={url} target="_blank" rel="noreferrer" onClick={openFile({ name, url })}>
        {code ? <code className="mono">{name}</code> : name}
      </a>
    );
  };
  const files = attachments && attachments.size > 0 && base ? attachments : null;
  return label.split(/(`[^`]+`)/).map((part, i) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      const code = part.slice(1, -1);
      return files?.has(code) ? link(code, i, true) : <code key={i} className="mono">{code}</code>;
    }
    if (!files) return part;
    return (
      <span key={i}>
        {part.split(/(\s+)/).map((token, j) => {
          const name = citedName(token, files);
          if (!name) return token;
          const at = token.indexOf(name);
          return (
            <span key={j}>
              {token.slice(0, at)}
              {link(name, j, false)}
              {token.slice(at + name.length)}
            </span>
          );
        })}
      </span>
    );
  });
}

/** A result's words, with a diff's counts in its colours ("+412 −87"). */
function Result({ text }: { text: string }) {
  return text.split(/(\s+)/).map((token, i) =>
    /^\+\d+$/.test(token) ? (
      <span key={i} className="ev-add">
        {token}
      </span>
    ) : /^[−-]\d+$/.test(token) ? (
      <span key={i} className="ev-del">
        {token}
      </span>
    ) : (
      token
    ),
  );
}

/**
 * Ruling 313: a result rests on one line and opens in place.
 *
 * A result that fits beside its label keeps the row's end; a longer one drops
 * under the label and is cut there with an ellipsis, so a verdict's rows stay
 * one look each. A result the line actually cuts becomes the control that
 * opens it (`aria-expanded`, a chevron after the cut), and opening wraps the
 * whole sentence under the label. The text is always all in the DOM, so a
 * screen reader hears it whole either way. Measured after layout, as
 * `Collapsible` measures its height: a result that fits stays plain text.
 */
function EvidenceResult({ text }: { text: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = textRef.current;
    // An open result wraps, so it measures whole; it stays the control.
    if (!el || open) return;
    const measure = () => setCut(el.scrollWidth > el.clientWidth);
    measure();
    // The first measure is the whole contract where there is no
    // ResizeObserver (jsdom); only the re-measure on resize is lost.
    if (!("ResizeObserver" in globalThis)) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open, cut]);
  const words = (
    <span ref={textRef} className="ev-result-text">
      <Result text={text} />
    </span>
  );
  if (!cut) return <span className="ev-result">{words}</span>;
  return (
    <button type="button" className="ev-result" aria-expanded={open} onClick={() => setOpen(!open)}>
      {words}
      <Icon name="chevron" className="disc-chev" />
    </button>
  );
}

export function EvidenceList({
  rows,
  attachments,
  base,
  openFile,
}: {
  rows: readonly EvidenceRowRender[];
  /** The task's real attachment names; absent ⇒ plain labels. */
  attachments?: ReadonlySet<string>;
  /** The attachment route base; absent (bare renders) ⇒ plain labels. */
  base?: string;
  /** The caller's `useAttachmentLightbox()`. */
  openFile: ReturnType<typeof useAttachmentLightbox>;
}) {
  const sorted = [...rows].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  return (
    <ul className="ev-list" aria-label="Evidence">
      {sorted.map((row, i) => (
        <li key={i} className="ev-item" data-status={row.status}>
          <span className="ev-mark">
            <Icon name={MARK[row.status]} />
          </span>
          {/* The result sits at the row's end, and under the label when the
              two do not fit side by side. */}
          <span className="ev-body">
            <span className="ev-label">
              {MARK_WORD[row.status] ? <span className="vh">{MARK_WORD[row.status]}</span> : null}
              <EvidenceLabel label={row.label} attachments={attachments} base={base} openFile={openFile} />
            </span>
            {row.result ? <EvidenceResult text={row.result} /> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Ruling 313: a reviewer's verdict. The head is the note's title (Changes
 * requested, Review passed, Approval noted …) with the tally of its checks
 * under it and the revision it judged at its end; what the note's sentence
 * adds follows (who else must review, why there is nothing to deliver); then
 * the checklist. The note's plain opening ("Reviewer requested changes on
 * `a91f7c200000`.") and its "Validation:" lead are not said again: the title
 * says the one and the actor, the revision and the title the other.
 */
export function VerdictCard({
  title,
  verdict,
  rows,
  attachments,
  base,
  openFile,
  mentionNames,
  taskLinks,
  headingBase,
}: {
  title: string;
  verdict: VerdictNoteView;
  rows: readonly EvidenceRowRender[] | null;
  attachments?: ReadonlySet<string>;
  base?: string;
  openFile: ReturnType<typeof useAttachmentLightbox>;
  mentionNames?: string[];
  taskLinks?: TaskLinks;
  /** The level the note's own headings start at. */
  headingBase: number;
}) {
  const id = useId();
  const tally = rows ? evidenceTally(rows) : null;
  return (
    <div className="vd-card" data-result={verdict.result} role="group" aria-labelledby={`${id}-t`}>
      <div className="vd-head">
        <div className="vd-head-main">
          <p id={`${id}-t`} className="vd-title">
            {title}
          </p>
          {tally ? <p className="vd-tally">{tally}</p> : null}
        </div>
        {verdict.sha ? (
          <span className="vd-rev mono">
            <span className="vh">on revision </span>
            {verdict.sha}
          </span>
        ) : null}
      </div>
      {verdict.detail ? (
        <div className="vd-detail md-body">
          <Markdown
            text={verdict.detail}
            mentionNames={mentionNames}
            headingBase={headingBase}
            {...(taskLinks ? { taskLinks } : {})}
          />
        </div>
      ) : null}
      {rows && rows.length > 0 ? (
        <EvidenceList rows={rows} attachments={attachments} base={base} openFile={openFile} />
      ) : null}
    </div>
  );
}
