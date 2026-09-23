import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { toYaml } from "./frontmatter.server";

describe("toYaml", () => {
  /**
   * The live ax-clone store held 21 `capabilities[].mode: off` lines. Viberr
   * read them right (YAML 1.2 core), and PyYAML's `safe_load` read them as
   * `False` (YAML 1.1). Files are truth, and other tools read them.
   */
  it("quotes every string a YAML 1.1 reader takes for a boolean, and changes nothing else", () => {
    const value = {
      capabilities: [{ capabilityId: "approve-review", mode: "off" }],
      a: "on",
      b: "Yes",
      c: "offline",
      d: true,
      e: "direct",
      f: "n",
    };
    const text = toYaml(value);
    // CANARY: return `YAML.stringify(value, { lineWidth: 0 })` and a 1.1
    // reader gets `mode: false`.
    expect(YAML.parse(text, { version: "1.1" })).toEqual(value);
    expect(YAML.parse(text)).toEqual(value);
    expect(text).toContain('mode: "off"');
    expect(text).toContain("c: offline");
    expect(text).toContain("d: true");
    expect(text).toContain("e: direct");
  });
});
