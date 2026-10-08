// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ConfirmDialog } from "./confirm-dialog";
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

/** A confirm whose action takes its own opener away before the exit (ruling
 *  459) ends: it `disables` the opener until the request lands (the knowledge
 *  panel's Undo and Dismiss), `replaces` it with text once the revalidation
 *  has landed (Undo's "Undone by …"), or `deletes` its whole row. It sits in a
 *  focusable <main>, as Home's skip-link target is; `inRow` puts the opener in
 *  a focusable list row. */
function BusyHost({ inRow, does }: { inRow: boolean; does: "disables" | "replaces" | "deletes" }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const opener =
    done && does === "replaces" ? (
      <span>Undone by Ada</span>
    ) : (
      <button type="button" disabled={done} onClick={() => setOpen(true)}>
        Undo
      </button>
    );
  return (
    <main tabIndex={-1}>
      {inRow ? (
        <ul>{!(done && does === "deletes") && <li tabIndex={-1}>{opener}</li>}</ul>
      ) : (
        opener
      )}
      {open && (
        <ConfirmDialog
          screenLabel="Undo dialog"
          title="Undo it?"
          body="It goes back."
          confirmLabel="Undo it"
          onCancel={() => setOpen(false)}
          onConfirm={() => setDone(true)}
        />
      )}
    </main>
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

  // A disabled button takes no focus, and neither does one the action took
  // off the page. The list row it sat in takes it while that row is still
  // there, so the keyboard user keeps their place; anywhere else (no row, or
  // the row deleted too) it stays on <body>, never a region or landmark
  // around the opener, whose focus reads the whole page out and sends the
  // next Tab to its top.
  // CANARY (disabled, in a list row): drop the hook's `:disabled` check and
  // the focus falls to <body>.
  // CANARY (disabled, no row): widen the row lookup to any `[tabindex]`
  // ancestor and the focus lands on <main>.
  // CANARY (replaced, its row stays): look the row up from the opener when
  // the dialog unmounts instead of when it opens, and the detached opener
  // has no row around it: the focus falls to <body>.
  // CANARY (deleted with its row): hand a deleted row's focus to the
  // focusable container around it and the focus lands on <main>.
  it.each([
    { opener: "a disabled opener", where: "in a list row, the row takes the focus", inRow: true, does: "disables", lands: "LI" },
    { opener: "a disabled opener", where: "with no row, the focus stays on <body>, not the <main> around it", inRow: false, does: "disables", lands: "BODY" },
    { opener: "an opener replaced by text", where: "in a list row that stays, the row takes the focus", inRow: true, does: "replaces", lands: "LI" },
    { opener: "an opener deleted with its row,", where: "the focus stays on <body>, not the <main> around it", inRow: true, does: "deletes", lands: "BODY" },
  ] as const)("when the exit ends on $opener $where", ({ inRow, does, lands }) => {
    const { container, getByRole } = render(<BusyHost inRow={inRow} does={does} />);
    const opener = getByRole("button", { name: "Undo" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = container.querySelector("dialog")!;
    slow(dialog);
    // The keyboard user's Enter on the confirm (jsdom's showModal moves no
    // focus into the dialog).
    const confirm = getByRole("button", { name: "Undo it" });
    confirm.focus();
    fireEvent.click(confirm);
    // The opener can no longer take the focus back: disabled where the row
    // disables it, gone where it replaces or deletes it, so each row runs the
    // path its title names.
    expect(opener.isConnected).toBe(does === "disables");
    if (does === "disables") expect(opener).toHaveProperty("disabled", true);
    fireEvent.transitionEnd(dialog);
    expect(dialog.isConnected).toBe(false);
    expect(document.activeElement?.tagName).toBe(lands);
  });
});

/**
 * Ruling 459: a dialog's primary action leaves the way Cancel, Escape and a
 * backdrop click do. `useDialog`'s `commit(fn)` runs fn once, then the same
 * animated close, which calls the dialog's onClose/onCancel to unmount it.
 * jsdom has no stylesheet, so the close is synchronous unless a test gives
 * the dialog a transition-duration of its own (`slow`), as the sheet's
 * `dialog[data-closing]` does in a browser.
 */

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
