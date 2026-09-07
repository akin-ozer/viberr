import { describe, expect, it } from "vitest";
import { displayNameRefusal, normalizeDisplayName } from "./names";

/**
 * U35-1 (pass 35): a name is text a person reads. The controller stored
 * `Test &amp; CI Engineer` verbatim and every card printed the entity.
 */
describe("normalizeDisplayName", () => {
  it("decodes the five XML entities and numeric references once", () => {
    expect(normalizeDisplayName("Test &amp; CI Engineer")).toBe("Test & CI Engineer");
    expect(normalizeDisplayName("Rock &#39;n&#x27; Roll")).toBe("Rock 'n' Roll");
    expect(normalizeDisplayName("&quot;Quoted&quot;")).toBe('"Quoted"');
    // One pass only: a doubly escaped input decodes one layer, never two.
    expect(normalizeDisplayName("A &amp;amp; B")).toBe("A &amp; B");
    // An entity nothing here names is left as typed.
    expect(normalizeDisplayName("Tom &nbsp; Jerry")).toBe("Tom &nbsp; Jerry");
  });

  it("collapses whitespace and trims", () => {
    expect(normalizeDisplayName("  Security\t\n  Auditor  ")).toBe("Security Auditor");
  });
});

describe("displayNameRefusal", () => {
  it("refuses angle brackets and control characters, accepts the rest", () => {
    expect(displayNameRefusal("<b>x</b>")).toBe(
      "Names cannot contain < or > or control characters.",
    );
    expect(displayNameRefusal("Bad\u0007Name")).toBe(
      "Names cannot contain < or > or control characters.",
    );
    expect(displayNameRefusal("Test & CI Engineer")).toBeNull();
    // A decoded `&lt;` IS an angle bracket: the refusal reads the decoded text.
    expect(displayNameRefusal(normalizeDisplayName("&lt;script&gt;"))).not.toBeNull();
  });
});
