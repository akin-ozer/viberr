import type { ReactNode } from "react";
import { ToggleGroup } from "radix-ui";

/**
 * A single-select option group: arrow-key traversal, roving tabindex, Home/End
 * and RTL from Radix, styled entirely with viberr's own classes.
 *
 * Ruling 166: `radix-ui` ships behaviour, not appearance. Nothing here passes a
 * utility class, and the primitive lands behind this boundary so a revert is
 * one file.
 *
 * WHY `ToggleGroup` AND NOT `RadioGroup`, which is the obvious pick:
 * Radix's `RadioGroup` implements the WAI-ARIA radio pattern faithfully, and
 * that pattern moves selection with focus — `react-radio-group/dist/index.mjs`
 * calls `ref.current.click()` from the item's `onFocus` whenever an arrow key
 * put it there. The groups this was built for commit a SERVER MUTATION on
 * selection (a member's project role, a transition's authorization boundary),
 * so arrowing from `viewer` to `admin` would have committed `reviewer` and
 * `contributor` on the way past — three role changes and three audit entries
 * where the person meant one. `ToggleGroup` has no focus handler at all: it
 * moves focus and commits on activation, which is the behaviour
 * `rovingRadioKeyDown` hand-rolled and the reason that helper existed.
 *
 * With `type="single"` the roles are the same ones the markup already carried:
 * `role="radiogroup"` on the root, `role="radio"` + `aria-checked` on each
 * item. So this is the same accessible contract, with the keyboard behaviour
 * it always promised.
 */
export function RadioSeg({
  value,
  onChange,
  label,
  className,
  title,
  children,
}: {
  /** The selected option's id. */
  value: string;
  /** Never called with an empty string — see the deselect note below. */
  onChange: (next: string) => void;
  /** The group's accessible name. */
  label?: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  // `className` / `title` / `aria-label` are passed through a props object
  // rather than written as attributes. app.css.test.ts harvests every
  // `className=` in app/ and checks it against the stylesheet; a pass-through
  // wrapper has no class of its own, so writing the attribute here would make
  // the gate read the PROP NAME as an orphan class. Spreading keeps the gate
  // pointed at the call sites, which is where the real class names live.
  const rootProps = { className, title, "aria-label": label };
  return (
    <ToggleGroup.Root
      type="single"
      {...rootProps}
      value={value}
      // A toggle group lets you press the active item to clear the selection
      // (`onItemDeactivate` sets ""), which a radio group must never do: these
      // groups always hold exactly one value. The group is controlled, so
      // swallowing the empty change is the whole guard — React re-renders from
      // `value` and the pressed item stays pressed.
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
    >
      {children}
    </ToggleGroup.Root>
  );
}

/** One option. Renders the `<button type="button" role="radio">` the markup
 *  already used; `className` stays viberr's. */
export function RadioSegOption({
  value,
  className,
  disabled,
  children,
}: {
  value: string;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  // Same pass-through reasoning as RadioSeg above.
  return (
    <ToggleGroup.Item value={value} {...{ className }} disabled={disabled}>
      {children}
    </ToggleGroup.Item>
  );
}
