// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ConfirmDialog } from "./confirm-dialog";

/**
 * Ruling 458(f) moved the hand-written plain confirms onto `ConfirmDialog`. Two
 * of them needed what the shared card did not carry: the KB browser's confirms
 * stack over the browser's own dialog (`over-modal`), and the agent profile
 * delete shows a glyph in its confirm button. Both are optional props, so the
 * call sites that pass neither render exactly what they did before.
 */

afterEach(cleanup);

function renderDialog(
  extra: Partial<Parameters<typeof ConfirmDialog>[0]> = {},
) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const view = render(
    <ConfirmDialog
      screenLabel="Test confirm dialog"
      title="Remove the thing?"
      body="The thing goes away."
      confirmLabel="Remove thing"
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...extra}
    />,
  );
  return { ...view, onCancel, onConfirm };
}

describe("ConfirmDialog", () => {
  it("names itself by its title and carries its screen label", () => {
    const { getByRole } = renderDialog();
    const dialog = getByRole("alertdialog", { name: "Remove the thing?" });
    expect(dialog.getAttribute("data-screen-label")).toBe("Test confirm dialog");
    expect(dialog.className).toBe("confirm-card");
  });

  it("is described by its body (ruling 458(k))", () => {
    const { getByRole, getByText } = renderDialog();
    const dialog = getByRole("alertdialog", { name: "Remove the thing?" });
    const body = getByText("The thing goes away.");
    expect(body.id).not.toBe("");
    expect(dialog.getAttribute("aria-describedby")).toBe(body.id);
  });

  it("gives each open confirm its own description id", () => {
    const first = renderDialog();
    const second = renderDialog({ title: "Remove the other thing?" });
    const ids = [first.container, second.container].map((c) =>
      c.querySelector("dialog")!.getAttribute("aria-describedby"),
    );
    expect(new Set(ids).size).toBe(2);
  });

  it("appends a caller's className to the card", () => {
    const { getByRole } = renderDialog({ className: "over-modal" });
    expect(getByRole("alertdialog").className).toBe("confirm-card over-modal");
  });

  it("puts confirmIcon's glyph before the confirm label, and none without it", () => {
    const plain = renderDialog();
    const plainButton = plain.getByText("Remove thing").closest("button")!;
    expect(plainButton.querySelector("svg")).toBeNull();
    plain.unmount();

    const { getByText, onConfirm } = renderDialog({ confirmIcon: "x" });
    const button = getByText("Remove thing").closest("button")!;
    expect(button.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(button.textContent).toBe("Remove thing");
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("renders children under the body, before the actions", () => {
    const { getByRole } = renderDialog({ children: <p>Second paragraph.</p> });
    const paragraphs = Array.from(getByRole("alertdialog").querySelectorAll("p"));
    expect(paragraphs.map((p) => p.textContent)).toEqual([
      "The thing goes away.",
      "Second paragraph.",
    ]);
  });
});
