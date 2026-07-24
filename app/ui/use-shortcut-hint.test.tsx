// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { useModifierHint } from "./use-shortcut-hint";

/**
 * P13-D-39 / UI-55: the hint must name the modifier the viewer's keyboard
 * actually has, and it must work for any key — the composer's shortcut is
 * ⌘/Ctrl+Enter, not ⌘K, which is exactly why it kept a hardcoded `⌘↵`.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe({ shortcutKey }: { shortcutKey?: string }) {
  return <span data-testid="hint">{useModifierHint(shortcutKey)}</span>;
}

/** navigator is read inside an effect, so the platform is stubbed before render. */
function renderOn(platform: string, shortcutKey?: string) {
  vi.stubGlobal("navigator", { userAgent: platform });
  const utils = render(<Probe shortcutKey={shortcutKey} />);
  return utils.getByTestId("hint").textContent;
}

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

describe("useModifierHint", () => {
  it("keeps the ⌘K / Ctrl K search-box contract when called with no argument", () => {
    expect(renderOn(MAC)).toBe("⌘K");
    cleanup();
    expect(renderOn(WINDOWS)).toBe("Ctrl K");
  });

  it("composes any key, so a ⌘/Ctrl+Enter hint is platform-aware too", () => {
    // The defect: `timeline.tsx` printed the literal "⌘↵ to send" to every
    // viewer while its handler accepted `metaKey || ctrlKey`.
    expect(renderOn(MAC, "↵")).toBe("⌘↵");
    cleanup();
    expect(renderOn(WINDOWS, "↵")).toBe("Ctrl ↵");
  });

  it("treats iPad/iPhone as Mac", () => {
    expect(renderOn("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", "↵")).toBe("⌘↵");
  });

  it("emits the Mac form on the server pass, then corrects on the client", () => {
    // The SSR contract the hook documents: the server has no navigator, so the
    // markup carries the historical Mac form and the first client effect swaps
    // it — which is why every call site needs `suppressHydrationWarning`.
    expect(renderToString(<Probe shortcutKey="↵" />)).toContain("⌘↵");
    expect(renderOn(WINDOWS, "↵")).toBe("Ctrl ↵");
  });
});
