// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { LabelInput } from "./label-input";

afterEach(cleanup);

/** A controlled host so the token list actually updates between events. */
function Harness({
  initial = [],
  suggestions,
}: {
  initial?: string[];
  suggestions?: string[];
}) {
  const [labels, setLabels] = useState<string[]>(initial);
  return (
    <div>
      <LabelInput value={labels} onChange={setLabels} suggestions={suggestions} />
      <output data-testid="value">{labels.join("|")}</output>
    </div>
  );
}

function field(c: HTMLElement): HTMLInputElement {
  return c.querySelector<HTMLInputElement>(".label-input-field")!;
}
function tokens(c: HTMLElement): string[] {
  return [...c.querySelectorAll(".label-token")].map((t) => t.textContent!.replace(/\s+$/, ""));
}
function options(c: HTMLElement): string[] {
  return [...c.querySelectorAll(".label-opt .label-opt-name")].map((o) => o.textContent!);
}

describe("LabelInput", () => {
  it("commits a chip on Enter, trimmed", () => {
    const { container, getByTestId } = render(<Harness />);
    fireEvent.change(field(container), { target: { value: "  runtime  " } });
    fireEvent.keyDown(field(container), { key: "Enter" });
    expect(getByTestId("value").textContent).toBe("runtime");
    expect(field(container).value).toBe(""); // buffer cleared
  });

  it("commits on comma and de-dupes case-insensitively", () => {
    const { container, getByTestId } = render(<Harness />);
    fireEvent.change(field(container), { target: { value: "Bug," } });
    expect(getByTestId("value").textContent).toBe("Bug");
    // Typing "bug" again is a no-op (dup), buffer cleared.
    fireEvent.change(field(container), { target: { value: "bug" } });
    fireEvent.keyDown(field(container), { key: "Enter" });
    expect(getByTestId("value").textContent).toBe("Bug");
  });

  it("Backspace on an empty field removes the last chip", () => {
    const { container, getByTestId } = render(<Harness initial={["a", "b"]} />);
    fireEvent.keyDown(field(container), { key: "Backspace" });
    expect(getByTestId("value").textContent).toBe("a");
  });

  it("a chip's named Remove button removes it", () => {
    const { getByLabelText, getByTestId } = render(
      <Harness initial={["runtime", "github"]} />,
    );
    fireEvent.click(getByLabelText("Remove label runtime"));
    expect(getByTestId("value").textContent).toBe("github");
  });

  it("caps at 12 labels and 32 chars", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const { container, getByTestId } = render(<Harness initial={twelve} />);
    fireEvent.change(field(container), { target: { value: "overflow" } });
    fireEvent.keyDown(field(container), { key: "Enter" });
    expect(getByTestId("value").textContent).toBe(twelve.join("|")); // rejected
    expect(tokens(container)).toHaveLength(12);

    cleanup();
    const long = render(<Harness />);
    const v = "x".repeat(40);
    fireEvent.change(field(long.container), { target: { value: v } });
    fireEvent.keyDown(field(long.container), { key: "Enter" });
    expect(long.getByTestId("value").textContent).toHaveLength(32); // truncated
  });

  it("splits a pasted/typed comma list into multiple chips", () => {
    const { container, getByTestId } = render(<Harness />);
    fireEvent.change(field(container), { target: { value: "a, b, c" } });
    // "a" and "b" commit; "c" stays in the buffer until its own commit.
    expect(getByTestId("value").textContent).toBe("a|b");
    fireEvent.keyDown(field(container), { key: "Enter" });
    expect(getByTestId("value").textContent).toBe("a|b|c");
  });
});

describe("LabelInput autocomplete", () => {
  const suggestions = ["runtime", "regression", "docs", "flaky"];

  it("offers matching project labels on focus and filters as you type", () => {
    const { container } = render(<Harness suggestions={suggestions} />);
    fireEvent.focus(field(container));
    // Focus with an empty buffer shows all suggestions.
    expect(options(container)).toEqual(suggestions);
    fireEvent.change(field(container), { target: { value: "re" } });
    // "re" is a substring of regression (not runtime), plus a Create row.
    expect(options(container)).toEqual(["regression", "re"]);
  });

  it("already-picked labels drop out of the suggestion list", () => {
    const { container } = render(
      <Harness initial={["runtime"]} suggestions={suggestions} />,
    );
    fireEvent.focus(field(container));
    expect(options(container)).toEqual(["regression", "docs", "flaky"]);
  });

  it("ArrowDown + Enter takes the highlighted suggestion, not the typed text", () => {
    const { container, getByTestId } = render(
      <Harness suggestions={suggestions} />,
    );
    fireEvent.focus(field(container));
    fireEvent.change(field(container), { target: { value: "d" } });
    // Options: docs (match) + Create "d". Arrow to the first, commit it.
    fireEvent.keyDown(field(container), { key: "ArrowDown" });
    fireEvent.keyDown(field(container), { key: "Enter" });
    expect(getByTestId("value").textContent).toBe("docs");
    expect(field(container).value).toBe("");
  });

  it("clicking a suggestion adds it", () => {
    const { container, getByTestId } = render(
      <Harness suggestions={suggestions} />,
    );
    fireEvent.focus(field(container));
    const flaky = [...container.querySelectorAll(".label-opt")].find(
      (o) => o.textContent === "flaky",
    )!;
    fireEvent.mouseDown(flaky);
    expect(getByTestId("value").textContent).toBe("flaky");
  });

  it("offers a Create row for a brand-new label", () => {
    const { container, getByTestId } = render(
      <Harness suggestions={suggestions} />,
    );
    fireEvent.focus(field(container));
    fireEvent.change(field(container), { target: { value: "brand-new" } });
    const create = container.querySelector(".label-opt.create")!;
    expect(create).toBeTruthy();
    fireEvent.mouseDown(create);
    expect(getByTestId("value").textContent).toBe("brand-new");
  });

  it("Enter with nothing highlighted commits the typed text over a match", () => {
    const { container, getByTestId } = render(
      <Harness suggestions={suggestions} />,
    );
    fireEvent.focus(field(container));
    fireEvent.change(field(container), { target: { value: "runtime" } });
    // A match is listed, but without arrowing to it Enter commits the buffer.
    fireEvent.keyDown(field(container), { key: "Enter" });
    expect(getByTestId("value").textContent).toBe("runtime");
  });

  it("Escape closes the suggestion popover without clearing the buffer", () => {
    const { container } = render(<Harness suggestions={suggestions} />);
    fireEvent.focus(field(container));
    fireEvent.change(field(container), { target: { value: "re" } });
    expect(container.querySelector(".label-suggest")).toBeTruthy();
    fireEvent.keyDown(field(container), { key: "Escape" });
    expect(container.querySelector(".label-suggest")).toBeNull();
    expect(field(container).value).toBe("re"); // buffer intact
  });

  it("offers nothing once the label set is full", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const { container } = render(
      <Harness initial={twelve} suggestions={["runtime"]} />,
    );
    fireEvent.focus(field(container));
    fireEvent.change(field(container), { target: { value: "run" } });
    expect(container.querySelector(".label-suggest")).toBeNull();
  });
});
