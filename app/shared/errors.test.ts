import { describe, expect, it } from "vitest";
import { errorMessage, toError } from "./errors";

class TaggedError extends Error {
  readonly tag = "tagged";
}

describe("toError", () => {
  it("hands back the same instance for an Error, subclasses included", () => {
    const plain = new Error("boom");
    const tagged = new TaggedError("tagged boom");
    expect(toError(plain)).toBe(plain);
    expect(toError(tagged)).toBe(tagged);
  });

  it("wraps anything else in an Error whose message is String(value)", () => {
    const cases = ["disk full", 42, null, undefined, Symbol("s"), { code: "EPERM" }];
    for (const value of cases) {
      const error = toError(value);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("Error");
      expect(error.message).toBe(String(value));
    }
  });

  it("starts the wrapper's stack at the caller, as an inline new Error would", () => {
    function catchSite() {
      return toError("thrown string");
    }
    const frames = catchSite().stack?.split("\n") ?? [];
    expect(frames[0]).toBe("Error: thrown string");
    expect(frames[1]).toContain("catchSite");
    expect(frames.some((frame) => frame.includes("toError"))).toBe(false);
  });
});

describe("errorMessage", () => {
  it("reads an Error's message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage(new TaggedError(""))).toBe("");
  });

  it("stringifies anything else", () => {
    expect(errorMessage("disk full")).toBe("disk full");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(Symbol("s"))).toBe("Symbol(s)");
    expect(errorMessage({ message: "not an Error" })).toBe("[object Object]");
  });
});
