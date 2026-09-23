// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRefusalShake, type RefusalMark } from "./use-refusal-shake";

afterEach(cleanup);

/** A refusal box the way the app renders one: shown only while the field is
 *  invalid, keyed on the refusal, carrying `.refused` while its shake is due. */
function Box({ refusal, shown }: { refusal: RefusalMark; shown: boolean }) {
  const shake = useRefusalShake(refusal);
  return shown ? (
    <div
      key={`refused-${String(refusal)}`}
      data-testid="box"
      className={shake.shake ? "refused" : ""}
      onAnimationEnd={shake.onAnimationEnd}
    >
      <span data-testid="glyph" />
    </div>
  ) : null;
}

/**
 * Ruling 451(g): a refusal box shakes once per refusal. Two reviewers found
 * that a class tied to the mount shook on keystrokes: a field that turned valid
 * and then invalid again mounted the same refusal's box a second time.
 */
describe("useRefusalShake", () => {
  const box = () => document.querySelector("[data-testid=box]");

  it("shakes each new refusal once, and never a box that mounts again for the same one", () => {
    const { rerender, getByTestId } = render(<Box refusal={0} shown={false} />);
    rerender(<Box refusal={1} shown />);
    expect(box()!.classList.contains("refused")).toBe(true);
    // A descendant's animation bubbles up; it is not the box's shake.
    fireEvent.animationEnd(getByTestId("glyph"));
    expect(box()!.classList.contains("refused")).toBe(true);
    fireEvent.animationEnd(box()!);
    expect(box()!.classList.contains("refused")).toBe(false);
    // The keystroke case. CANARY: return `shake: Boolean(refusal)` and the
    // box that comes back for refusal 1 shakes again.
    rerender(<Box refusal={1} shown={false} />);
    rerender(<Box refusal={1} shown />);
    expect(box()!.classList.contains("refused")).toBe(false);
    // A second refused click is a new refusal.
    rerender(<Box refusal={2} shown />);
    expect(box()!.classList.contains("refused")).toBe(true);
  });

  it("starts over when the count resets, so the next first refusal shakes", () => {
    const { rerender } = render(<Box refusal={1} shown />);
    fireEvent.animationEnd(box()!);
    expect(box()!.classList.contains("refused")).toBe(false);
    // The editor closed and opened again: the counter went back to none.
    // CANARY: drop the reset and this refusal, numbered 1 again, stays still.
    rerender(<Box refusal={0} shown={false} />);
    rerender(<Box refusal={1} shown />);
    expect(box()!.classList.contains("refused")).toBe(true);
  });

  it("keeps the class until the shake has played, so a re-render cannot cut it short", () => {
    const { rerender } = render(<Box refusal="r-accept:1" shown />);
    rerender(<Box refusal="r-accept:1" shown />);
    expect(box()!.classList.contains("refused")).toBe(true);
  });
});
