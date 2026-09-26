import { Link } from "react-router";
import type { EpicColor, EpicStatus } from "~/schemas/epic-file.schema";

/** What a surface needs to draw an epic beside a task (ruling 503). */
export interface EpicChipView {
  id: string;
  title: string;
  color: EpicColor;
}

/** An epic as a menu or a filter offers it: its chip, and whether it is open. */
export interface EpicOption extends EpicChipView {
  status: EpicStatus;
}

/**
 * Ruling 503: an epic, named beside a task. Its colour is a dot and its title
 * the text, outlined rather than filled: an epic describes the work rather
 * than saying what it waits for, so it never wears a status tint (ruling 365).
 * A person reads "Checkout revamp"; the id is the pointer's extra, and a
 * screen reader hears "Epic" first so the name is not taken for a label.
 *
 * `to` makes it a link (the task page's Epic, read-only); inside the Epic
 * row's own button it stays a span, and says no "Epic" of its own: the
 * button is named by the row's label and its value, so it would read
 * "Epic Epic Checkout revamp".
 */
export function EpicChip({
  epic,
  to,
  inLabelledControl = false,
}: {
  epic: EpicChipView;
  to?: string;
  /** Sits in a control whose name already says "Epic". */
  inLabelledControl?: boolean;
}) {
  const body = (
    <>
      <span className="epic-dot" aria-hidden="true" />
      {!inLabelledControl && <span className="vh">Epic </span>}
      <span className="epic-chip-title">{epic.title}</span>
    </>
  );
  return to ? (
    <Link className="epic-chip" data-stage-color={epic.color} to={to} title={`${epic.id} · ${epic.title}`}>
      {body}
    </Link>
  ) : (
    <span className="epic-chip" data-stage-color={epic.color} title={`${epic.id} · ${epic.title}`}>
      {body}
    </span>
  );
}
