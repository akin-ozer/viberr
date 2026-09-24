// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useDialog } from "./use-dialog";

afterEach(cleanup);

/** A dialog whose first field takes focus through React's own `autoFocus` — the
 *  New task, move-back and org-settings MiniModal shape. */
function AutoFocusDialog({ onClose }: { onClose: () => void }) {
  const { ref, close } = useDialog(onClose);
  return (
    <dialog ref={ref} aria-label="New task">
      <input aria-label="Title" autoFocus />
      <button type="button" onClick={close}>
        Cancel
      </button>
    </dialog>
  );
}

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        New task
      </button>
      {open && <AutoFocusDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/** Opens the dialog the way a keyboard user does: focus on the trigger, then
 *  activate it (fireEvent.click does not move focus by itself). */
function openFromTrigger(getByText: (text: string) => HTMLElement) {
  const trigger = getByText("New task");
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

/**
 * Interface review 2026-09-24 (acce-2). React applies `autoFocus` at commit,
 * before the hook's effect runs, so reading `document.activeElement` there
 * recorded the dialog's own field as the element to restore — and closing the
 * dialog left focus on <body>.
 */
describe("useDialog focus restore", () => {
  it("keeps the autoFocus field focused once the dialog opens", () => {
    const { getByText, getByLabelText } = render(<Host />);
    openFromTrigger(getByText);
    expect(document.activeElement).toBe(getByLabelText("Title"));
  });

  it("returns focus to the trigger when an autoFocus dialog closes", () => {
    const { getByText, queryByRole } = render(<Host />);
    const trigger = openFromTrigger(getByText);
    fireEvent.click(getByText("Cancel"));
    expect(queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the trigger when Escape cancels an autoFocus dialog", () => {
    const { getByText, getByRole, queryByRole } = render(<Host />);
    const trigger = openFromTrigger(getByText);
    // The browser's Escape default action on a modal dialog (jsdom has none).
    fireEvent(getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
