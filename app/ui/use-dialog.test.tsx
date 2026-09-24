// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { ConfirmDialog } from "./confirm-dialog";

/**
 * Ruling 459: a dialog's primary action leaves the way Cancel, Escape and a
 * backdrop click do. `useDialog`'s `commit(fn)` runs fn once, then the same
 * animated close, which calls the dialog's onClose/onCancel to unmount it.
 * jsdom has no stylesheet, so the close is synchronous unless a test gives
 * the dialog a transition-duration of its own (`slow`), as the sheet's
 * `dialog[data-closing]` does in a browser.
 */

afterEach(cleanup);

/** A parent that owns the dialog's mount, as every caller does. */
function Harness({ log }: { log: string[] }) {
  const [open, setOpen] = useState(true);
  return open ? (
    <ConfirmDialog
      screenLabel="Test dialog"
      title="Remove it?"
      body="It goes."
      confirmLabel="Remove it"
      onCancel={() => {
        log.push("cancel");
        setOpen(false);
      }}
      onConfirm={() => log.push("confirm")}
    />
  ) : (
    <p>closed</p>
  );
}

/** The sheet's closing clock, which jsdom would otherwise read as nothing. */
function slow(dialog: HTMLDialogElement) {
  dialog.style.transitionDuration = "0.15s";
}

describe("ruling 459: a confirm leaves through the same exit as Cancel", () => {
  it("runs the confirm, plays the exit, and unmounts only when the exit ends", () => {
    // CANARY: put ConfirmDialog's primary back on `onClick={onConfirm}` (with
    // the caller's own unmount, the card vanished in one frame) and nothing
    // here is marked closing.
    const log: string[] = [];
    const { container, getByText, queryByText } = render(<Harness log={log} />);
    const dialog = container.querySelector("dialog")!;
    slow(dialog);
    fireEvent.click(getByText("Remove it"));
    expect(log).toEqual(["confirm"]);
    // Still on screen, leaving: the exit Cancel plays.
    expect(dialog.isConnected).toBe(true);
    expect(dialog.hasAttribute("data-closing")).toBe(true);
    fireEvent.transitionEnd(dialog);
    expect(log).toEqual(["confirm", "cancel"]);
    expect(queryByText("closed")).not.toBeNull();
  });

  it("drops a second commit during the exit (a second Enter on the focused button)", () => {
    // CANARY: drop `commit`'s data-closing guard and the second click posts
    // the removal twice; the old synchronous unmount had ruled that out.
    const log: string[] = [];
    const { container, getByText } = render(<Harness log={log} />);
    const dialog = container.querySelector("dialog")!;
    slow(dialog);
    fireEvent.click(getByText("Remove it"));
    fireEvent.click(getByText("Remove it"));
    expect(log).toEqual(["confirm"]);
    fireEvent.transitionEnd(dialog);
    expect(log).toEqual(["confirm", "cancel"]);
  });

  it("with no closing clock, confirms and then unmounts at once", () => {
    const log: string[] = [];
    const { getByText, queryByText } = render(<Harness log={log} />);
    fireEvent.click(getByText("Remove it"));
    expect(log).toEqual(["confirm", "cancel"]);
    expect(queryByText("closed")).not.toBeNull();
  });

  it("Cancel plays the same exit, and never confirms", () => {
    const log: string[] = [];
    const { container, getByText } = render(<Harness log={log} />);
    const dialog = container.querySelector("dialog")!;
    slow(dialog);
    fireEvent.click(getByText("Cancel"));
    expect(dialog.hasAttribute("data-closing")).toBe(true);
    fireEvent.transitionEnd(dialog);
    expect(log).toEqual(["cancel"]);
  });
});
