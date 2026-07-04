// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { RichText } from "./rich-text";

afterEach(cleanup);

describe("RichText (THE shared micro-format renderer, ruling 14)", () => {
  it("renders **bold**, `code` and @mentions from one pass", () => {
    const { container } = render(
      <RichText text="**Decision:** widen `pull_request:write` — ping @operator now" />,
    );
    const strong = container.querySelector("strong")!;
    expect(strong.textContent).toBe("Decision:");
    const code = container.querySelector("code.mono")!;
    expect(code.textContent).toBe("pull_request:write");
    const mention = container.querySelector("span.mention")!;
    expect(mention.textContent).toBe("@operator");
    expect(container.textContent).toBe(
      "Decision: widen pull_request:write — ping @operator now",
    );
  });

  it("passes plain text through untouched", () => {
    const { container } = render(
      <RichText text="Branch work complete. Handing back to operator." />,
    );
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("code")).toBeNull();
    expect(container.querySelector(".mention")).toBeNull();
    expect(container.textContent).toBe(
      "Branch work complete. Handing back to operator.",
    );
  });

  it("mention grammar: letter start, then word chars/hyphens; not emails' domain-less digits", () => {
    const { container } = render(<RichText text="@a-1 @2no a@b" />);
    const mentions = [...container.querySelectorAll(".mention")].map(
      (m) => m.textContent,
    );
    // "@2no" doesn't start with a letter; "a@b" — the mock regex still
    // tokenizes the "@b" (no boundary assertion) — keep mock behavior.
    expect(mentions).toEqual(["@a-1", "@b"]);
  });

  it("mentions={false} (the RichA/activity variant) leaves @words plain", () => {
    const { container } = render(
      <RichText text="**bold** and @operator" mentions={false} />,
    );
    expect(container.querySelector("strong")!.textContent).toBe("bold");
    expect(container.querySelector(".mention")).toBeNull();
    expect(container.textContent).toBe("bold and @operator");
  });

  it("does not nest: bold containing backticks stays one strong token", () => {
    const { container } = render(<RichText text="**a `b` c**" />);
    // `[^*]+` matches across backticks — single strong, no inner code.
    expect(container.querySelector("strong")!.textContent).toBe("a `b` c");
    expect(container.querySelector("code")).toBeNull();
  });
});
