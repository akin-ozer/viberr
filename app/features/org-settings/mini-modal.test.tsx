// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MiniModal } from "./mini-modal";

/**
 * Ruling 287: a MiniModal whose save lands leaves through the exit Cancel
 * plays (`done`), rather than being unmounted by its caller in one frame.
 * jsdom reads no stylesheet, so the test gives the dialog the sheet's closing
 * clock; the exit then waits for the dialog's own transitionend.
 */

afterEach(cleanup);

function modal(done: boolean, log: string[]) {
  return (
    <MiniModal
      icon={null}
      title="New connection"
      canSave
      saveLabel="Save"
      done={done}
      onClose={() => log.push("close")}
      onSave={() => log.push("save")}
    >
      <input aria-label="Owner" defaultValue="acme" />
    </MiniModal>
  );
}

describe("ruling 287: a save that lands plays the modal's exit", () => {
  it("done plays the exit, and onClose unmounts it only when the exit ends", () => {
    // CANARY: drop MiniModal's `done` effect and nothing is marked closing,
    // so every caller's success would have to unmount it in one frame again.
    const log: string[] = [];
    const { container, rerender } = render(modal(false, log));
    const dialog = container.querySelector("dialog")!;
    dialog.style.transitionDuration = "0.15s";
    expect(dialog.hasAttribute("data-closing")).toBe(false);
    rerender(modal(true, log));
    expect(dialog.hasAttribute("data-closing")).toBe(true);
    expect(log).toEqual([]);
    fireEvent.transitionEnd(dialog);
    expect(log).toEqual(["close"]);
  });

  it("a save that landed is not sent again from the leaving modal", () => {
    // CANARY: drop `|| done` from MiniModal's save guard.
    const log: string[] = [];
    const { container, rerender, getByText } = render(modal(false, log));
    const dialog = container.querySelector("dialog")!;
    dialog.style.transitionDuration = "0.15s";
    fireEvent.click(getByText("Save"));
    expect(log).toEqual(["save"]);
    rerender(modal(true, log));
    fireEvent.click(getByText("Save"));
    expect(log).toEqual(["save"]);
    fireEvent.transitionEnd(dialog);
    expect(log).toEqual(["save", "close"]);
  });
});
