import { KeyboardSensor, PointerSensor } from "@dnd-kit/react";
import { PointerActivationConstraints } from "@dnd-kit/dom";

/**
 * The one drag language (pass 16), for the board's cards and the settings
 * page's stage rows alike: the whole card or row is the drag surface, with no
 * grip handle. The sensor's default refuses to lift from inside interactive
 * elements, which would demand a grip, so only real controls (a StageMenu
 * button, a rename button, a Move menu, a remove ✕) opt out. Mouse is
 * distance-only: the default's hold-to-lift delay would swallow a slow
 * press-and-release on the card's link or the row's name, which must stay a
 * click. Touch keeps a short press, so scrolling a column is never hijacked.
 * Escape cancels a lifted drag.
 */
export const DRAG_SENSORS = [
  PointerSensor.configure({
    preventActivation: (event: PointerEvent) => {
      const target = event.target;
      return (
        target instanceof Element &&
        Boolean(target.closest("button, input, select, textarea"))
      );
    },
    activationConstraints: (event: PointerEvent) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 5 })],
  }),
  KeyboardSensor,
];
