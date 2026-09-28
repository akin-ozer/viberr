import type { DependencyRender, DependencyState } from "~/shared/dependencies";
import { Icon, type IconName } from "~/ui/icon";

/** An entry's state as a status ring, the family ruling 499's to-do steps
 *  draw: waiting, done, or a wait that can never complete (ruling 355). */
const WAIT_GLYPH = {
  open: "todo",
  done: "checkcircle",
  failed: "ban",
  missing: "ban",
} satisfies Record<DependencyState, IconName>;

/** One entry of the wait: its status ring, its label and, once it is not
 *  simply open, the word for where it stands. Ruling 548: `onRemove` adds the
 *  Owner row's release cross; `removing` says the save it started is in
 *  flight (ruling 368), the cross spinning and still focusable. */
export function WaitChip({
  entry,
  onRemove,
  removing = false,
}: {
  entry: DependencyRender;
  onRemove?: () => void;
  removing?: boolean;
}) {
  return (
    <span
      className="label-chip wait-chip"
      data-wait-state={entry.state}
      title={`${entry.label} · ${entry.state}`}
    >
      <Icon name={WAIT_GLYPH[entry.state]} />
      {entry.label}
      {entry.state !== "open" ? ` · ${entry.state === "failed" ? "archived" : entry.state}` : ""}
      {onRemove && (
        <button
          type="button"
          className="own-x"
          aria-label={`Remove ${entry.label}`}
          title={`Remove ${entry.label}`}
          aria-busy={removing || undefined}
          onClick={onRemove}
        >
          {removing ? <Icon name="loader" className="spin" /> : <Icon name="x" />}
        </button>
      )}
    </span>
  );
}
