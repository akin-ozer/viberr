import { describe, expect, it } from "vitest";
import { endSentence } from "./sentence";

describe("endSentence", () => {
  it("adds a period to an unterminated clause", () => {
    expect(endSentence("the token expired")).toBe("the token expired.");
  });

  it("never doubles a terminator the text already carries (F34-12)", () => {
    expect(endSentence("The key was revoked.")).toBe("The key was revoked.");
    expect(endSentence("Why?")).toBe("Why?");
    expect(endSentence("Stop!")).toBe("Stop!");
    expect(endSentence("and then…")).toBe("and then…");
  });

  it("reads only the last character", () => {
    expect(endSentence("")).toBe(".");
    expect(endSentence("Done. ")).toBe("Done. .");
    expect(endSentence("(see above.)")).toBe("(see above.).");
  });
});
