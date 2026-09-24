import { describe, expect, it } from "vitest";
import { initialsOf } from "./initials";

/* The one initials implementation, shared by the client and the server's actor
   mapping, so its edge cases are pinned here rather than through a caller. */
describe("initialsOf", () => {
  it('reads "?" for a missing or blank name', () => {
    expect(initialsOf(null)).toBe("?");
    expect(initialsOf(undefined)).toBe("?");
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
    expect(initialsOf("\t\n ")).toBe("?");
  });

  it("takes one letter from a one-word name", () => {
    expect(initialsOf("Ada")).toBe("A");
  });

  it("takes the first letters of the first two words", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("Ada King Lovelace")).toBe("AK");
    expect(initialsOf("Augusta Ada King Lovelace")).toBe("AA");
  });

  it("ignores leading, trailing and repeated whitespace of any kind", () => {
    expect(initialsOf("  Ada   Lovelace  ")).toBe("AL");
    expect(initialsOf("Ada\tLovelace")).toBe("AL");
    expect(initialsOf("Ada\n Lovelace")).toBe("AL");
  });

  it("uppercases lower-case names", () => {
    expect(initialsOf("ada lovelace")).toBe("AL");
    expect(initialsOf("ada")).toBe("A");
  });

  it("keeps a non-ASCII first letter, uppercased", () => {
    expect(initialsOf("Deniz Şahin")).toBe("DŞ");
    expect(initialsOf("élodie ünal")).toBe("ÉÜ");
    expect(initialsOf("Øystein")).toBe("Ø");
  });
});
