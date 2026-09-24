// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DatePicker } from "./date-picker";
import { useDialog } from "./use-dialog";

afterEach(cleanup);

function Harness({ initial = null }: { initial?: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <div>
      <DatePicker label="Due date" value={value} onChange={setValue} />
      <output data-testid="value">{value ?? "none"}</output>
    </div>
  );
}

const trigger = (c: HTMLElement) =>
  c.querySelector<HTMLButtonElement>(".datepick-trigger")!;
const popover = () => document.querySelector(".datepick-pop");

describe("DatePicker", () => {
  it("shows a placeholder when empty and the formatted date when set", () => {
    const empty = render(
      <DatePicker label="Due date" value={null} onChange={() => {}} />,
    );
    expect(trigger(empty.container).textContent).toContain("Pick a date");
    cleanup();
    const set = render(
      <DatePicker label="Due date" value="2026-08-30" onChange={() => {}} />,
    );
    expect(trigger(set.container).textContent).toContain("Aug 30, 2026");
  });

  it("opens the calendar popover on click and picks a day", () => {
    const { container, getByTestId } = render(<Harness initial="2026-08-10" />);
    expect(popover()).toBeNull();
    fireEvent.click(trigger(container));
    expect(popover()).toBeTruthy();
    // Pick the 15th from the portaled calendar.
    fireEvent.click(popover()!.querySelector('.cal-day[data-iso="2026-08-15"]')!);
    expect(getByTestId("value").textContent).toBe("2026-08-15");
    // Selecting closes the popover.
    expect(popover()).toBeNull();
  });

  it("Escape closes the popover without changing the value", () => {
    const { container, getByTestId } = render(<Harness initial="2026-08-10" />);
    fireEvent.click(trigger(container));
    fireEvent.keyDown(popover()!, { key: "Escape" });
    expect(popover()).toBeNull();
    expect(getByTestId("value").textContent).toBe("2026-08-10");
  });

  it("the clear button resets to null", () => {
    const { getByLabelText, getByTestId } = render(<Harness initial="2026-08-10" />);
    fireEvent.click(getByLabelText("Clear date"));
    expect(getByTestId("value").textContent).toBe("none");
  });

  it("an outside press dismisses the popover", () => {
    const { container } = render(<Harness />);
    fireEvent.click(trigger(container));
    expect(popover()).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(popover()).toBeNull();
  });

  it("names the trigger by its label and its value (acce-16)", () => {
    // A label alone hid the picked date from screen readers; the button text
    // alone never said what the field is for.
    const empty = render(<Harness />);
    expect(trigger(empty.container).getAttribute("aria-label")).toBe(
      "Due date: not set",
    );

    cleanup();
    const { container } = render(<Harness initial="2026-08-10" />);
    expect(trigger(container).getAttribute("aria-label")).toBe(
      "Due date: Aug 10, 2026",
    );
    fireEvent.click(trigger(container));
    fireEvent.click(popover()!.querySelector('.cal-day[data-iso="2026-08-15"]')!);
    expect(trigger(container).getAttribute("aria-label")).toBe(
      "Due date: Aug 15, 2026",
    );
  });
});

/** The New task shape: a picker inside a native modal <dialog> run by useDialog. */
function DialogHarness({ onClose }: { onClose: () => void }) {
  const { ref } = useDialog(onClose);
  const [value, setValue] = useState<string | null>(null);
  return (
    <dialog ref={ref} aria-label="New task">
      <DatePicker label="Due date" value={value} onChange={setValue} />
    </dialog>
  );
}

/** Escape as a browser delivers it to a modal dialog: the keydown, then — as its
 *  default action, unless a listener prevented it — `cancel` on the dialog.
 *  jsdom implements the keydown only. */
function pressEscape(el: Element) {
  const proceed = fireEvent.keyDown(el, { key: "Escape" });
  if (proceed) {
    fireEvent(el.closest("dialog")!, new Event("cancel", { cancelable: true }));
  }
}

describe("DatePicker inside a dialog (acce-15)", () => {
  it("Escape on the open calendar closes only the calendar, not the dialog", () => {
    let closed = 0;
    const { container } = render(<DialogHarness onClose={() => closed++} />);
    fireEvent.click(trigger(container));
    expect(popover()).toBeTruthy();

    pressEscape(popover()!);
    expect(popover()).toBeNull();
    expect(closed).toBe(0);
    expect(document.activeElement).toBe(trigger(container));

    // With the calendar closed, Escape is the dialog's again.
    pressEscape(trigger(container));
    expect(closed).toBe(1);
  });
});
