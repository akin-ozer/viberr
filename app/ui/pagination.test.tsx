// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Pagination } from "./pagination";

afterEach(cleanup);

/** What the pager draws, end to end: Previous, each slot's text, Next. */
function drawn(page: number, pages: number) {
  const { container } = render(
    <Pagination page={page} pages={pages} label="Pages" onPage={() => {}} />,
  );
  return [...container.querySelectorAll(".pager-list > li")].map((li) => li.textContent);
}

describe("Pagination (ruling 614)", () => {
  /**
   * shadcn's layout, at seven slots at most so the control keeps its width
   * while the reader pages: the first and last page, the current one and its
   * neighbours, and a gap for each skipped run. CANARY: drop the near-start
   * case and page 2 of 10 draws "1 … 1 2 3 … 10".
   */
  it.each([
    [1, 1, "1"],
    [1, 7, "1 2 3 4 5 6 7"],
    [2, 10, "1 2 3 4 5 … 10"],
    [5, 10, "1 … 4 5 6 … 10"],
    [9, 10, "1 … 6 7 8 9 10"],
  ])("page %i of %i draws %s", (page, pages, slots) => {
    expect(drawn(page, pages)).toEqual(["Previous", ...slots.split(" "), "Next"]);
  });

  /**
   * The ends refuse with `aria-disabled`, never `disabled`: a disabled button
   * drops the focus of the keyboard user whose press on Next just reached the
   * last page. CANARY: render the ends with `disabled`, or call `onPage` for
   * the page already on screen.
   */
  it("marks the current page, keeps a refused end focusable, and reports only a new page", () => {
    const asked: number[] = [];
    const { getByRole } = render(
      <Pagination page={1} pages={3} label="Pages" onPage={(p) => asked.push(p)} />,
    );
    expect(getByRole("navigation", { name: "Pages" })).toBeTruthy();
    expect(getByRole("button", { name: "Page 1" }).getAttribute("aria-current")).toBe("page");
    expect(getByRole("button", { name: "Page 2" }).hasAttribute("aria-current")).toBe(false);
    const previous = getByRole("button", { name: "Previous page" });
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    expect(previous.hasAttribute("disabled")).toBe(false);
    expect(getByRole("button", { name: "Next page" }).hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(previous);
    fireEvent.click(getByRole("button", { name: "Page 1" }));
    fireEvent.click(getByRole("button", { name: "Next page" }));
    fireEvent.click(getByRole("button", { name: "Page 3" }));
    expect(asked).toEqual([2, 3]);
  });
});
