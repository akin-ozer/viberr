import { useState, type ReactNode } from "react";
import type { TextSpan } from "~/shared/line-diff";
import { Icon } from "~/ui/icon";
import type { TodoSnapshot } from "./console-todos";
import { diffPreview, type DiffLine, type EditDiff } from "./edit-diff";

/**
 * Ruling 168: what an agent did, drawn the way agent tools draw it, inside
 * the run console's dark box: an edit as a diff, a to-do list as a list, a
 * wait as an orb. The to-do list, the orb and the console's thinking and code
 * blocks take their design from AICSS's free components (MIT, © 2026 AICSS;
 * THIRD_PARTY_NOTICES.md), redrawn in this sheet's console palette; the diff
 * is the app's own, the Changes panel's rows (ruling 246) in the console's
 * colours.
 */

/** A file path as the row prints it: the folder quiet, the name plain, and
 *  the path the call named on hover. */
export function FilePath({ path, shown }: { path: string; shown: string }) {
  const cut = shown.lastIndexOf("/") + 1;
  return (
    <span className="lc-path" title={path}>
      {cut > 0 ? <span className="lc-dir">{shown.slice(0, cut)}</span> : null}
      <span className="lc-base">{shown.slice(cut)}</span>
    </span>
  );
}

/** An edit's `+N −M`, or a written file's line count, beside its path. */
export function DiffStat({ diff }: { diff: EditDiff }) {
  if (diff.written !== null) {
    return (
      <span className="lc-stat">
        {diff.written} line{diff.written === 1 ? "" : "s"}
      </span>
    );
  }
  return (
    <span className="lc-stat">
      <span className="lc-add">+{diff.added}</span>
      <span className="vh"> added,</span> <span className="lc-del">−{diff.removed}</span>
      <span className="vh"> removed</span>
      {diff.everywhere ? <span className="lc-tag">every occurrence</span> : null}
    </span>
  );
}

/** A line's text with the changed words marked. */
function marked(text: string, spans: readonly TextSpan[] | null): ReactNode {
  if (text === "") return " ";
  if (!spans || spans.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of spans) {
    if (start > at) out.push(text.slice(at, start));
    out.push(
      <mark className="ld-w" key={start}>
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

const MARK = { add: "+", del: "−", ctx: " " };
const SAID = { add: "added: ", del: "removed: ", ctx: "" };

function DiffLineRow({ line, numbered }: { line: DiffLine; numbered: boolean }) {
  return (
    <span className="ld-row" data-kind={line.kind}>
      {numbered ? <span className="ld-num">{line.num}</span> : null}
      <span className="ld-mark" aria-hidden="true">
        {MARK[line.kind]}
      </span>
      <span className="ld-code">
        {SAID[line.kind] ? <span className="vh">{SAID[line.kind]}</span> : null}
        {marked(line.text, line.spans)}
      </span>
    </span>
  );
}

/**
 * The diff under an edit's row. The first `PREVIEW_ROWS` rows show; the rest
 * wait behind "Show N more lines", which is the row's own disclosure (`open`),
 * so it survives the console re-folding. An unchanged run opens in place.
 */
export function EditDiffBlock({
  diff,
  open,
  onToggle,
}: {
  diff: EditDiff;
  open: boolean;
  onToggle: () => void;
}) {
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(() => new Set());
  const { shown, more } = diffPreview(diff.rows);
  const numbered = diff.written !== null;
  const rows = open ? diff.rows : diff.rows.slice(0, shown);
  return (
    <span className="log-diff" data-numbered={numbered ? "true" : undefined}>
      <span className="ld-body">
        {rows.map((row, i) => {
          if (row.kind === "edit") {
            return (
              <span className="ld-edit" key={i}>
                edit {row.n} of {row.of}
                {row.everywhere ? " · every occurrence" : ""}
              </span>
            );
          }
          if (row.kind !== "fold") return <DiffLineRow line={row} numbered={numbered} key={i} />;
          if (unfolded.has(i)) {
            return row.lines.map((line, j) => (
              <DiffLineRow line={line} numbered={numbered} key={`${i}.${j}`} />
            ));
          }
          return (
            <button
              type="button"
              className="ld-fold"
              key={i}
              onClick={() => setUnfolded((prev) => new Set(prev).add(i))}
            >
              <span aria-hidden="true">⋯</span> {row.lines.length} unchanged lines
            </button>
          );
        })}
      </span>
      {more > 0 ? (
        <button type="button" className="ld-more" aria-expanded={open} onClick={onToggle}>
          <Icon name="chevron" />
          {open ? "Show less" : `Show ${more} more line${more === 1 ? "" : "s"}`}
        </button>
      ) : null}
    </span>
  );
}

const STATUS_WORD = { pending: "to do", in_progress: "in progress", completed: "done" };
const STATUS_ICON = { pending: "todo", in_progress: "todonow", completed: "checkcircle" } as const;

/** The list's progress, as a wedge inside a dotted ring (AICSS's header
 *  pie). Drawn with attributes, so the sheet keeps every style. */
function ProgressPie({ done, total }: { done: number; total: number }) {
  const share = Math.round((done / total) * 100);
  return (
    <svg className="td-pie" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        className="td-pie-ring"
        cx="8"
        cy="8"
        r="7"
        strokeWidth="1.5"
        strokeDasharray=".1 2.6"
        strokeLinecap="round"
      />
      <circle
        className="td-pie-fill"
        cx="8"
        cy="8"
        r="2.5"
        strokeWidth="5"
        pathLength={100}
        strokeDasharray={`${share} 100`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

/**
 * An agent's to-do list: its steps done, under way and waiting, and how far
 * along it is. The step under way shimmers while the run is live and this is
 * the list it last wrote (`live`); an older list, or a finished run's, holds
 * still. The header folds the list away.
 */
export function TodoCard({ todos, live }: { todos: TodoSnapshot; live: boolean }) {
  const [closed, setClosed] = useState(false);
  const total = todos.items.length;
  return (
    <span className="log-todo">
      <button
        type="button"
        className="td-head"
        aria-expanded={!closed}
        onClick={() => setClosed((c) => !c)}
      >
        <span className="td-state" aria-hidden="true">
          {todos.done === total ? (
            <Icon name="checkcircle" className="td-all" />
          ) : (
            <ProgressPie done={todos.done} total={total} />
          )}
          <Icon name="chevron" className="td-chev" />
        </span>
        <span className="td-title">To-dos</span>
        <span className="td-count">
          {todos.done}/{total}
          <span className="vh"> done</span>
        </span>
      </button>
      {closed ? null : (
        <span className="td-list" role="list">
          {todos.items.map((item, i) => (
            <span
              className="td-item"
              role="listitem"
              data-status={item.status}
              data-live={live && i === todos.current ? "true" : undefined}
              key={i}
            >
              <Icon name={STATUS_ICON[item.status]} />
              <span className="vh">{STATUS_WORD[item.status]}: </span>
              <span className="td-text" data-text={item.text}>
                {item.text}
              </span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * AICSS's lattice orb: nine dots on a 3×3 grid. A pulse radiates from the
 * centre while a tool runs (`wave`); a Viberr tool's comet runs the ring
 * instead (`ring`), the two motions ruling 168's orb told apart. Pure CSS: the
 * sheet stages each dot and holds the centre still under reduced motion.
 */
export function ConsoleOrb({ motion }: { motion: "wave" | "ring" }) {
  return (
    <span className="log-orb" data-orb={motion} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
