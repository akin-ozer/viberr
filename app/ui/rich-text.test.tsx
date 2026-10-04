// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { RichText } from "./rich-text";

afterEach(cleanup);

describe("RichText (THE shared micro-format renderer, ruling 14)", () => {
  it("renders **bold** and `code` from one pass", () => {
    const { container } = render(
      <RichText text="**Decision:** widen `pull_request:write` — ping @operator now" />,
    );
    const strong = container.querySelector("strong")!;
    expect(strong.textContent).toBe("Decision:");
    const code = container.querySelector("code.mono")!;
    expect(code.textContent).toBe("pull_request:write");
    expect(container.textContent).toBe(
      "Decision: widen pull_request:write — ping @operator now",
    );
  });

  it("U39-15: renders `code` inside a **bold** run instead of printing the backticks", () => {
    // The lease notice's headline, as operator-actions writes it. CANARY:
    // render the bold run's inner text as a plain string again.
    const { container } = render(
      <RichText text="**AX-22 now holds `internal/controller/task.go`, `task_test.go`** (leased)" />,
    );
    const strong = container.querySelector("strong")!;
    expect([...strong.querySelectorAll("code.mono")].map((c) => c.textContent)).toEqual([
      "internal/controller/task.go",
      "task_test.go",
    ]);
    expect(container.textContent).toBe("AX-22 now holds internal/controller/task.go, task_test.go (leased)");
    expect(container.textContent).not.toContain("`");
  });

  it("passes plain text through untouched", () => {
    const { container } = render(
      <RichText text="Branch work complete. Handing back to operator." />,
    );
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).toBe(
      "Branch work complete. Handing back to operator.",
    );
  });

  it("bold containing backticks is one strong token with the code inside it (U39-15)", () => {
    // This pinned the limitation: "a `b` c" printed its backticks inside the
    // strong. The one pass still takes the bold run whole (`[^*]+` crosses
    // backticks); the code is rendered inside it now.
    const { container } = render(<RichText text="**a `b` c**" />);
    expect(container.querySelector("strong")!.textContent).toBe("a b c");
    expect(container.querySelector("strong code.mono")!.textContent).toBe("b");
  });

  it("U39-31: links the task keys it was given, beside code, in the same tab", () => {
    // CANARY: push the prose unlinked (drop `pushLinked`'s key split).
    const { container } = render(
      <MemoryRouter>
        <RichText
          text={"Released: AX-32 is done. @operator, `AX-32` is code and AX-7 is not linked."}
          taskLinks={{ "AX-32": "/projects/ax-clone/tasks/AX-32" }}
        />
      </MemoryRouter>,
    );
    const refs = [...container.querySelectorAll("a.task-ref")];
    expect(refs.map((a) => [a.textContent, a.getAttribute("href"), a.hasAttribute("target")])).toEqual([
      ["AX-32", "/projects/ax-clone/tasks/AX-32", false],
    ]);
    expect(container.querySelector("code")!.textContent).toBe("AX-32");
    expect(container.textContent).toContain("AX-7 is not linked");
  });
});
