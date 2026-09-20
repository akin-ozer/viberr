// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { toToken } from "./code-highlight";
import { CodeView } from "./code-view";

afterEach(cleanup);

/* Ruling 363: the code reader. Plain, numbered lines first; the grammar's
   tokens arrive later and replace them in place, text intact. */
describe("CodeView (ruling 363)", () => {
  it("renders every line numbered and plain first, then the grammar's tokens as classes", async () => {
    const { container } = render(
      <CodeView text={"const x = 1;\n// two\n"} language="javascript" />,
    );
    const pre = container.querySelector("pre.code-view")!;
    expect(pre).toBeTruthy();
    const lines = pre.querySelectorAll(".line");
    // The trailing newline ends line 2 — it does not open an empty third.
    expect(lines).toHaveLength(2);
    expect(pre.getAttribute("data-digits")).toBe("1");
    expect(lines[0]!.textContent).toBe("const x = 1;");
    expect(lines[1]!.textContent).toBe("// two");
    expect(pre.getAttribute("data-highlighted")).toBe("false");
    await waitFor(() =>
      expect(pre.getAttribute("data-highlighted")).toBe("true"),
    );
    expect(pre.querySelector(".tk-keyword")!.textContent).toBe("const");
    expect(pre.querySelector(".tk-comment")!.textContent).toBe("// two");
    // Tokenizing never changes what the reader says.
    expect(lines[0]!.textContent).toBe("const x = 1;");
    expect(pre.querySelectorAll(".line")).toHaveLength(2);
  });

  it("leaves an unmapped language plain: same lines, no classes, no highlighted flag", async () => {
    const { container } = render(
      <CodeView text={"line one\nline two"} language="text" />,
    );
    const pre = container.querySelector("pre.code-view")!;
    expect(pre.querySelectorAll(".line")).toHaveLength(2);
    // Give a would-be highlighter every chance to run before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pre.getAttribute("data-highlighted")).toBe("false");
    expect(pre.querySelector("[class^='tk-']")).toBeNull();
  });

  it("sizes the gutter to the digit count", () => {
    const { container } = render(
      <CodeView
        text={Array.from({ length: 1200 }, () => "x").join("\n")}
        language="text"
      />,
    );
    expect(container.querySelector("pre")!.getAttribute("data-digits")).toBe("4");
  });

  it("toToken: the foreground is a bare text node; scope families and font styles become classes", () => {
    expect(
      toToken({ content: "x", offset: 0, color: "var(--shiki-foreground)" }),
    ).toEqual({ text: "x", className: undefined });
    expect(
      toToken({ content: "if", offset: 0, color: "var(--shiki-token-keyword)" }),
    ).toEqual({ text: "if", className: "tk-keyword" });
    expect(
      toToken({
        content: "# c",
        offset: 0,
        color: "var(--shiki-token-comment)",
        fontStyle: 1,
      }),
    ).toEqual({ text: "# c", className: "tk-comment tk-i" });
    expect(toToken({ content: "b", offset: 0, fontStyle: 2 })).toEqual({
      text: "b",
      className: "tk-b",
    });
  });
});
