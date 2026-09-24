import { describe, expect, it } from "vitest";
import { wholeThousands } from "./thousands";

describe("wholeThousands", () => {
  it("rounds to whole thousands with a lowercase k", () => {
    expect(wholeThousands(112_400)).toBe("112k");
    expect(wholeThousands(1_499)).toBe("1k");
    expect(wholeThousands(1_500)).toBe("2k");
  });

  it("prints a size under 500 as 0k, never an empty string", () => {
    expect(wholeThousands(400)).toBe("0k");
    expect(wholeThousands(0)).toBe("0k");
  });
});
