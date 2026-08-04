// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { RichText } from "./rich-text";

afterEach(cleanup);

/** What a sighted reader sees: everything except the visually-hidden AT-only
 *  labels (P16-UI-20). */
function visibleText(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  for (const vh of clone.querySelectorAll(".mention-vh")) vh.remove();
  return clone.textContent ?? "";
}

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
    expect(visibleText(container)).toBe(
      "Decision: widen pull_request:write — ping @operator now",
    );
  });

  it("gives every mention chip a visually-hidden label (P16-UI-20)", () => {
    // The chip's only distinction from the prose around it is colour +
    // background, so a screen reader read "@Selin" exactly like the word
    // "Selin". The label sits BESIDE the chip so `.mention`'s own text stays
    // the literal mention the shared matcher produced.
    const { container } = render(
      <RichText text="ping @operator and @Selin" names={["Selin"]} />,
    );
    const labels = [...container.querySelectorAll(".mention-vh")].map(
      (n) => n.textContent,
    );
    expect(labels).toEqual(["mention ", "mention "]);
    expect(container.textContent).toBe("ping mention @operator and mention @Selin");
    // ...and it changes nothing on screen.
    expect(visibleText(container)).toBe("ping @operator and @Selin");
    for (const label of container.querySelectorAll(".mention-vh")) {
      expect(label.nextElementSibling!.className).toBe("mention");
    }
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

  it("F20: only KNOWN names chip — an unknown @word stays prose", () => {
    // The old private regex chipped any `@word`, so `@nobody` looked like a
    // live tag on a typed event while routing to nobody at all.
    const { container } = render(
      <RichText text="ping @nobody and @a-1 and @2no" names={["Selin"]} />,
    );
    expect(container.querySelectorAll(".mention")).toHaveLength(0);
    expect(container.textContent).toBe("ping @nobody and @a-1 and @2no");
  });

  it("F20: a known MULTI-WORD name chips whole, not just its first token", () => {
    // The old regex stopped at the space, so "@Arda Kaya" chipped "@Arda" —
    // a different (possibly nonexistent) handle from the one the server routes.
    const { container } = render(
      <RichText text="handing to @Arda Kaya today" names={["Arda Kaya", "Arda"]} />,
    );
    const mentions = [...container.querySelectorAll(".mention")].map(
      (m) => m.textContent,
    );
    expect(mentions).toEqual(["@Arda Kaya"]);
    expect(visibleText(container)).toBe("handing to @Arda Kaya today");
  });

  it("F20: a known single-word name chips even though it is not a reserved handle", () => {
    const { container } = render(<RichText text="@Selin owns it" names={["Selin"]} />);
    expect(container.querySelector(".mention")!.textContent).toBe("@Selin");
  });

  it("a @name inside `code` stays literal", () => {
    // Bold/code own the first pass, so a mention grammar hit inside a code
    // sample is never re-read as a chip — same rule the markdown renderer uses.
    const { container } = render(
      <RichText text="run `notify @Selin` first" names={["Selin"]} />,
    );
    expect(container.querySelector("code.mono")!.textContent).toBe("notify @Selin");
    expect(container.querySelector(".mention")).toBeNull();
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
