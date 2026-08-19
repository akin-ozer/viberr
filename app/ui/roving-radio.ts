import type { KeyboardEvent } from "react";

/**
 * UXA-7 — arrow-key traversal for a `role="radiogroup"`.
 *
 * A radiogroup PROMISES arrow-key navigation: assistive tech announces the
 * group and users press ←/→/↑/↓ to move between options. Declaring the role
 * without wiring the keys is a broken contract — the reader is told a thing
 * works and it does not.
 *
 * `decision-packet.tsx` solved this once (UI-44) with a ref array, because it
 * also needed to CHANGE selection as focus moves. The two Policy sheets
 * (member roles, transition boundaries) commit a change on activation instead,
 * so they only need focus to move; that can be done from the DOM without every
 * caller threading refs. Hence this helper, which any radiogroup can adopt:
 *
 *   <div role="radiogroup" onKeyDown={rovingRadioKeyDown}>
 *     <button role="radio" aria-checked={sel} tabIndex={sel ? 0 : -1} …/>
 *
 * Disabled options are skipped, and the ends wrap — both WAI-ARIA behaviours.
 */
export function rovingRadioKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
  const back = event.key === "ArrowUp" || event.key === "ArrowLeft";
  if (!forward && !back) return;

  const group = event.currentTarget;
  const options = [...group.querySelectorAll<HTMLElement>('[role="radio"]')]
    .filter(
      (el) =>
        el.getAttribute("aria-disabled") !== "true" &&
        !(el instanceof HTMLButtonElement && el.disabled),
    );
  if (options.length < 2) return;

  const active = document.activeElement;
  const current = options.findIndex((el) => el === active);
  // An unfocused group starts from the checked option, so the first arrow key
  // lands somewhere meaningful rather than always at index 0.
  const from =
    current >= 0
      ? current
      : Math.max(
          0,
          options.findIndex((el) => el.getAttribute("aria-checked") === "true"),
        );

  event.preventDefault();
  const next =
    (from + (forward ? 1 : -1) + options.length) % options.length;
  options[next]?.focus();
}
