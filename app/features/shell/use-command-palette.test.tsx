// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useCommandPaletteShortcut } from "./use-command-palette";

/**
 * UI-C (inventory rough edge #8) — ⌘K used to be bound twice, by two
 * hand-written copies of the same effect (one in `topbar.tsx`, one in
 * `home-page.tsx`). A shortcut that behaves differently depending on
 * which surface you happen to be standing on is worse than no shortcut, so
 * there is one implementation and both surfaces call it.
 */

afterEach(cleanup);

function Probe({ onOpen }: { onOpen: () => void }) {
  useCommandPaletteShortcut(onOpen);
  return <p>probe</p>;
}

describe("useCommandPaletteShortcut", () => {
  it("fires once on ⌘K and once on Ctrl-K", () => {
    let opened = 0;
    render(<Probe onOpen={() => (opened += 1)} />);

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(opened).toBe(1);
    fireEvent.keyDown(window, { key: "K", ctrlKey: true });
    expect(opened).toBe(2);
  });

  it("swallows the browser default so ⌘K cannot also focus the URL bar", () => {
    render(<Probe onOpen={() => {}} />);
    const delivered = fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(delivered).toBe(false); // preventDefault()ed
  });

  it("leaves bare k and modifier combinations the app does not own alone", () => {
    let opened = 0;
    render(<Probe onOpen={() => (opened += 1)} />);

    fireEvent.keyDown(window, { key: "k" });
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    // ⌥⌘K / Ctrl-Alt-K are OS- and IDE-level combinations.
    fireEvent.keyDown(window, { key: "k", metaKey: true, altKey: true });
    expect(opened).toBe(0);
  });

  it("re-reads the callback without re-subscribing", () => {
    const seen: string[] = [];
    function Host() {
      const [label, setLabel] = useState("first");
      useCommandPaletteShortcut(() => seen.push(label));
      return (
        <button type="button" onClick={() => setLabel("second")}>
          relabel
        </button>
      );
    }
    const { getByText } = render(<Host />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(getByText("relabel"));
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    // A stale closure would push "first" twice; a re-subscribing effect would
    // leave two listeners and push three entries.
    expect(seen).toEqual(["first", "second"]);
  });

  it("detaches its listener on unmount", () => {
    let opened = 0;
    const { unmount } = render(<Probe onOpen={() => (opened += 1)} />);
    unmount();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(opened).toBe(0);
  });
});
