// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { pinLivePose } from "./live-pose";

/**
 * Ruling 453: a surface closed mid-entrance used to get no exit at all —
 * Chrome starts no transition on a property a running CSS animation drives.
 * jsdom has no animations, so the live pose is stubbed; the browser half was
 * measured in Chrome (opacity .50 → 0 with no transition before, a transition
 * from .50 after).
 */
describe("pinLivePose", () => {
  afterEach(() => vi.restoreAllMocks());

  it("holds the element at its live opacity and transform, entrance off, until released", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const live = document.createElement("div").style;
    live.opacity = "0.5";
    live.transform = "matrix(0.985, 0, 0, 0.985, 0, 6)";
    vi.spyOn(window, "getComputedStyle").mockReturnValue(live);
    const reads = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(0);

    const release = pinLivePose(el);
    expect(el.style.opacity).toBe("0.5");
    expect(el.style.transform).toBe("matrix(0.985, 0, 0, 0.985, 0, 6)");
    expect(el.style.animation).toBe("none");
    // The forced style pass is what makes the pinned pose the transition's start.
    expect(reads).toHaveBeenCalledTimes(1);

    release();
    expect(el.getAttribute("style") ?? "").toBe("");
    el.remove();
  });
});
