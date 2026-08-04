import { describe, expect, it } from "vitest";
import { countLabel, pluralNoun } from "./plural";

describe("plural", () => {
  it("agrees at one and disagrees nowhere else", () => {
    expect(countLabel(0, "instance account")).toBe("0 instance accounts");
    expect(countLabel(1, "instance account")).toBe("1 instance account");
    expect(countLabel(2, "instance account")).toBe("2 instance accounts");
  });

  it("takes an explicit plural for irregular nouns", () => {
    expect(countLabel(1, "person", "people")).toBe("1 person");
    expect(countLabel(3, "person", "people")).toBe("3 people");
  });

  it("pluralNoun returns the noun alone (count rendered separately)", () => {
    expect(pluralNoun(1, "profile")).toBe("profile");
    expect(pluralNoun(0, "profile")).toBe("profiles");
  });

  // -1 is not a count any surface produces, but "n === 1" is the only branch —
  // anything else must take the plural rather than fall through to a bare noun.
  it("treats every non-one count as plural", () => {
    expect(countLabel(-1, "doc")).toBe("-1 docs");
  });
});
