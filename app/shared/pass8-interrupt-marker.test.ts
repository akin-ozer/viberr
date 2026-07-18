import { describe, expect, it } from "vitest";
import { PASS8_INTERRUPT } from "./pass8-interrupt-marker";

describe("PASS8_INTERRUPT", () => {
  it("marks the pass-8 interrupt path", () => {
    expect(PASS8_INTERRUPT).toBe(true);
  });
});
