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
/** Each visible row: its name, whether it is a checked/unchecked/create row. */
function rows(c: HTMLElement) {
  return [...c.querySelectorAll(".label-select .label-opt")].map((o) => ({
    name: o.querySelector(".label-opt-name")!.textContent,
    checked: o.querySelector(".lc-check")?.getAttribute("data-checked") ?? null,
    create: o.classList.contains("create"),
  }));
}
function rowNamed(c: HTMLElement, name: string): HTMLElement {
  return [...c.querySelectorAll<HTMLElement>(".label-select .label-opt")].find(
    (o) => o.querySelector(".label-opt-name")!.textContent === name,
  )!;
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

describe("LabelInput checkbox multi-select", () => {
  const suggestions = ["runtime", "regression", "docs", "flaky"];

  it("on focus, pins the chosen labels (checked) above the rest (unchecked)", () => {
    const { container } = render(
      <Harness initial={["docs"]} suggestions={suggestions} />,
    );
    fireEvent.focus(field(container));
    expect(rows(container)).toEqual([
      { name: "docs", checked: "true", create: false }, // chosen, pinned top
      { name: "runtime", checked: "false", create: false },
      { name: "regression", checked: "false", create: false },
      { name: "flaky", checked: "false", create: false },
    ]);
  });

  it("checking an unchosen row adds it; the list stays open across the blur", () => {
    const { container, getByTestId } = render(
      <Harness suggestions={suggestions} />,
    );
    fireEvent.focus(field(container));
    fireEvent.mouseDown(rowNamed(container, "flaky"));
    // A pointer press on a row blurs the input; the list must survive it so the
    // multi-select flow continues (this is the "show it immediately" fix).
    fireEvent.blur(field(container));
    expect(getByTestId("value").textContent).toBe("flaky");
    expect(container.querySelector(".label-select")).toBeTruthy();
    expect(rows(container)[0]).toEqual({ name: "flaky", checked: "true", create: false });
  });

  it("a row press does not bubble to the document (so an outside-press dismiss can't fire)", () => {
    // Adding a label re-renders the list; if the press reached a document-level
    // outside-press listener, it would see a now-detached target and close the
    // list. The row stops propagation to prevent exactly that.
    const { container } = render(<Harness suggestions={suggestions} />);
    fireEvent.focus(field(container));
    let documentSawPress = false;
    const onDoc = () => {
      documentSawPress = true;
    };
    document.addEventListener("mousedown", onDoc);
    fireEvent.mouseDown(rowNamed(container, "flaky"));
    document.removeEventListener("mousedown", onDoc);
    expect(documentSawPress).toBe(false);
  });

  it("unchecking a chosen row removes it", () => {
    const { container, getByTestId } = render(
      <Harness initial={["runtime", "docs"]} suggestions={suggestions} />,
    );
    fireEvent.focus(field(container));
    fireEvent.mouseDown(rowNamed(container, "runtime"));
    expect(getByTestId("value").textContent).toBe("docs");
  });

  it("offers a Create row for brand-new typed text and adds it", () => {
    const { container, getByTestId } = render(
      <Harness suggestions={suggestions} />,
    );
    fireEvent.change(field(container), { target: { value: "brand-new" } });
    const create = container.querySelector(".label-opt.create")!;
    expect(create).toBeTruthy();
    fireEvent.mouseDown(create);
    expect(getByTestId("value").textContent).toBe("brand-new");
  });

  it("filters the unchosen rows as you type", () => {
    const { container } = render(<Harness suggestions={suggestions} />);
    fireEvent.change(field(container), { target: { value: "re" } });
    // "re" is a substring of regression (not runtime), plus a Create row.
    expect(rows(container).map((r) => r.name)).toEqual(["regression", "re"]);
  });

  it("ArrowDown + Enter toggles the highlighted row", () => {
    const { container, getByTestId } = render(
      <Harness suggestions={suggestions} />,
    );
    fireEvent.focus(field(container));
    fireEvent.keyDown(field(container), { key: "ArrowDown" }); // -> runtime
    fireEvent.keyDown(field(container), { key: "ArrowDown" }); // -> regression
    fireEvent.keyDown(field(container), { key: "Enter" });
    expect(getByTestId("value").textContent).toBe("regression");
  });

  it("Escape closes the list without clearing the buffer", () => {
    const { container } = render(<Harness suggestions={suggestions} />);
    fireEvent.change(field(container), { target: { value: "re" } });
    expect(container.querySelector(".label-select")).toBeTruthy();
    fireEvent.keyDown(field(container), { key: "Escape" });
    expect(container.querySelector(".label-select")).toBeNull();
    expect(field(container).value).toBe("re");
  });

  it("at the 12-label cap, chosen rows stay (removable) but nothing can be added", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const { container } = render(
      <Harness initial={twelve} suggestions={["runtime"]} />,
    );
    fireEvent.change(field(container), { target: { value: "run" } });
    const r = rows(container);
    expect(r).toHaveLength(12); // only the 12 chosen, all checked
    expect(r.every((row) => row.checked === "true")).toBe(true);
  });
});
