import { Avatar } from "~/ui/avatar";
import { AgentGlyph } from "~/ui/identity";
import {
  splitHighlight,
  type MentionSuggestion,
} from "./mention-autocomplete";

/**
 * The @-mention autocomplete dropdown for the comment composer. A listbox of
 * matching agents / reserved handles / users; the active row is highlighted
 * and the typed substring is marked. Rendered as a positioned overlay below the
 * composer box (parent supplies the `position: relative` wrapper). Selection is
 * driven by the parent via keyboard; each row is also clickable.
 *
 * Design-system only: reuses `.rsel-menu` / `.rsel-item` (the run-selector
 * menu); the AgentGlyph / Avatar match every other identity surface. No inline
 * hex.
 */

function RowGlyph({ s }: { s: MentionSuggestion }) {
  if (s.kind === "user") return <Avatar person={{ initials: s.initials }} />;
  if (s.operator) return <AgentGlyph op />;
  return <AgentGlyph backend={s.backend} />;
}

/**
 * The label with the matched substring marked.
 *
 * This used to borrow `.mention`, the chip class the two renderers use to draw
 * a REAL mention. It is not one — it is "the part of this name that matched
 * what you typed", and the two carry different promises: `.mention` is being
 * given a screen-reader affordance (a visually-hidden "mention " prefix), which
 * would make an arbitrary matched substring in this dropdown announce itself as
 * a mention. It gets its own class.
 *
 * `<mark>` is the honest element for a search hit: the platform already means
 * "relevant to the user's current activity" by it, so the meaning does not
 * depend on a stylesheet rule landing.
 */
function Highlighted({ label, query }: { label: string; query: string }) {
  const { before, match, after } = splitHighlight(label, query);
  if (!match) return <>{label}</>;
  return (
    <>
      {before}
      <mark className="mention-match">{match}</mark>
      {after}
    </>
  );
}

export function MentionMenu({
  id,
  items,
  active,
  query,
  onPick,
  onHover,
}: {
  /** Listbox id (the textarea's aria-controls / aria-activedescendant root). */
  id: string;
  items: MentionSuggestion[];
  /** Index of the active (highlighted) row. */
  active: number;
  /** The typed query, for substring highlighting. */
  query: string;
  onPick: (s: MentionSuggestion) => void;
  onHover: (index: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div
      // `.mention-menu` is the left-anchored modifier on `.rsel-menu`'s chrome;
      // its geometry used to be an inline style object here and now lives in
      // the sheet (P16-UI-02).
      className="rsel-menu mention-menu"
      role="listbox"
      id={id}
      aria-label="Mention suggestions"
    >
      {items.map((s, i) => (
        <button
          type="button"
          key={s.kind + ":" + s.handle}
          id={`${id}-opt-${i}`}
          role="option"
          aria-selected={i === active}
          className={"rsel-item" + (i === active ? " on" : "")}
          // Keep the textarea focused: prevent the mousedown blur, insert on click.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(s)}
        >
          <RowGlyph s={s} />
          <span className="ri-txt">
            <span className="ri-nm">
              <Highlighted label={s.name} query={query} />
            </span>
            <span className="ri-sub">
              @<Highlighted label={s.handle} query={query} /> · {s.sub}
              {/* Ruling 121: a backend handle whose run the task owner cannot
                  pay for says so on the row, before the comment is written. */}
              {s.note ? ` · ${s.note}` : ""}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
