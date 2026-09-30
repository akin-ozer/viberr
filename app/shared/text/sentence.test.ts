import { describe, expect, it } from "vitest";
import { endSentence, indefiniteArticle } from "./sentence";

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

describe("indefiniteArticle", () => {
  it("takes \"an\" before a vowel letter, in either case, and \"a\" otherwise", () => {
    // Live on AWSC-66 the schedule note read "a **Estimate Judge** run".
    // CANARY: return "a" always and the first row goes red.
    expect(indefiniteArticle("Estimate Judge")).toBe("an");
    expect(indefiniteArticle("inventory-analyst")).toBe("an");
    expect(indefiniteArticle("Calculator Builder")).toBe("a");
    expect(indefiniteArticle("dev")).toBe("a");
  });
});
