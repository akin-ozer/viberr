// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { LabelInput } from "./label-input";

afterEach(cleanup);

/** A controlled host so the token list actually updates between events. */
function Harness({ initial = [] }: { initial?: string[] }) {
  const [labels, setLabels] = useState<string[]>(initial);
  return (
    <div>
      <LabelInput value={labels} onChange={setLabels} />
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
