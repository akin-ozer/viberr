import { Icon } from "~/ui/icon";
import { useModifierHint } from "~/ui/use-shortcut-hint";

/**
 * The ⌘K palette trigger that stands in a header where a search field would
 * be (R15-5: everything typed here is answered by the palette, across every
 * project the viewer can open — so it is a BUTTON that keeps the field's
 * silhouette, not an input).
 *
 * ONE implementation, shared by the workspace `Topbar` and the standalone-page
 * `PageTopbar`: the two headers sit on different surfaces, and a viewer who
 * walks from a board into instance settings must not find the search moved,
 * renamed or missing. `.top-search` and its responsive tiers are unchanged —
 * this is the same markup the workspace topbar carried inline.
 */
export function PaletteTrigger({ onOpen }: { onOpen: () => void }) {
  const modifierHint = useModifierHint();
  return (
    <button
      type="button"
      className="top-search"
      aria-haspopup="dialog"
      aria-label="Search tasks, epics, branches, agents, projects"
      onClick={onOpen}
    >
      <Icon name="search" />
      <span className="top-search-label">Search…</span>
      {/* UI-55: the handler accepts Ctrl as well; show what the viewer's
          keyboard actually has. */}
      <span className="kbd" suppressHydrationWarning>
        {modifierHint}
      </span>
    </button>
  );
}
