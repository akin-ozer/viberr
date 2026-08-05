// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { KeyboardEvent } from "react";
import { rovingRadioKeyDown } from "./roving-radio";

/**
 * UXA-7 — the Policy sheets declared `role="radiogroup"` with `role="radio"`
 * children and never wired arrow keys, so the ARIA contract promised traversal
 * the markup could not honour. These pin the behaviour the promise implies.
 */

function group(options: { checked?: boolean; disabled?: boolean }[]) {
  const el = document.createElement("div");
  el.setAttribute("role", "radiogroup");
  for (const o of options) {
    const b = document.createElement("button");
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", o.checked ? "true" : "false");
    if (o.disabled) b.disabled = true;
    b.tabIndex = o.checked ? 0 : -1;
    el.appendChild(b);
  }
  document.body.appendChild(el);
  return { el, radios: [...el.querySelectorAll("button")] };
}

/** The two fields `rovingRadioKeyDown` actually reads off the React event. */
const press = (el: HTMLElement, key: string) => {
  let prevented = false;
  rovingRadioKeyDown({
    key,
    currentTarget: el,
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as KeyboardEvent<HTMLElement>);
  return prevented;
};

describe("rovingRadioKeyDown", () => {
  it("moves focus forward and backward, and claims the key", () => {
    const { el, radios } = group([{ checked: true }, {}, {}]);
    radios[0]!.focus();
    expect(press(el, "ArrowRight")).toBe(true);
    expect(document.activeElement).toBe(radios[1]);
    press(el, "ArrowDown");
    expect(document.activeElement).toBe(radios[2]);
    press(el, "ArrowLeft");
    expect(document.activeElement).toBe(radios[1]);
  });

  it("wraps at both ends", () => {
    const { el, radios } = group([{ checked: true }, {}, {}]);
    radios[2]!.focus();
    press(el, "ArrowRight");
    expect(document.activeElement).toBe(radios[0]);
    press(el, "ArrowLeft");
    expect(document.activeElement).toBe(radios[2]);
  });

  it("skips disabled options — a dead control is never a focus stop", () => {
    const { el, radios } = group([{ checked: true }, { disabled: true }, {}]);
    radios[0]!.focus();
    press(el, "ArrowRight");
    expect(document.activeElement).toBe(radios[2]);
  });

  it("starts from the CHECKED option when focus is outside the group", () => {
    const { el, radios } = group([{}, { checked: true }, {}]);
    (document.activeElement as HTMLElement | null)?.blur();
    press(el, "ArrowRight");
    expect(document.activeElement).toBe(radios[2]);
  });

  it("ignores keys it does not own, so typing still reaches the page", () => {
    const { el, radios } = group([{ checked: true }, {}]);
    radios[0]!.focus();
    expect(press(el, "Enter")).toBe(false);
    expect(press(el, "a")).toBe(false);
    expect(document.activeElement).toBe(radios[0]);
  });
});
