import { Avatar } from "~/ui/avatar";
import { AgentGlyph } from "~/ui/identity";
import {
  splitHighlight,
  type MentionSuggestion,
} from "./mention-autocomplete";

/**
 * The @-mention autocomplete dropdown for the comment composer. A listbox of
 * matching agents / reserved handles / users; the active row is highlighted
 * and the typed substring is wrapped in the shared `.mention` chip. Rendered
 * as a positioned overlay below the composer box (parent supplies the
 * `position: relative` wrapper). Selection is driven by the parent via
 * keyboard; each row is also clickable.
 *
 * Design-system only: reuses `.rsel-menu` / `.rsel-item` (the run-selector
 * menu) + `.mention` for the highlight; the AgentGlyph / Avatar match every
 * other identity surface. No new CSS, no inline hex.
 */

function RowGlyph({ s }: { s: MentionSuggestion }) {
  if (s.kind === "user") return <Avatar person={{ initials: s.initials }} />;
  if (s.operator) return <AgentGlyph op />;
  return <AgentGlyph backend={s.backend} />;
}

/** The primary label with the matched substring wrapped in `.mention`. */
function Highlighted({ label, query }: { label: string; query: string }) {
  const { before, match, after } = splitHighlight(label, query);
  if (!match) return <>{label}</>;
  return (
    <>
      {before}
      <span className="mention">{match}</span>
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
      className="rsel-menu mention-menu"
      role="listbox"
      id={id}
      aria-label="Mention suggestions"
      style={{
        position: "absolute",
        left: 0,
        right: "auto",
        top: "calc(100% + 6px)",
        minWidth: "260px",
        maxWidth: "360px",
      }}
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
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
