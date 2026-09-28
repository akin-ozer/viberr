import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { splitFrontmatterMapping, toYaml } from "./frontmatter.server";

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

describe("splitFrontmatterMapping", () => {
  it("hands back the mapping, the body and the split's diagnostics", () => {
    const split = splitFrontmatterMapping("---\nname: Proj\n---\n\nBody\n");
    expect(split).toEqual({ data: { name: "Proj" }, body: "\nBody\n", diagnostics: [] });
  });

  it("reads frontmatter that is not a mapping as no fields, with a hard stop", () => {
    const split = splitFrontmatterMapping("---\n- a\n- b\n---\nBody\n");
    expect(split.data).toEqual({});
    expect(split.body).toBe("Body\n");
    expect(split.diagnostics).toEqual([
      {
        severity: "error",
        code: "frontmatter.not_a_map",
        message: "Frontmatter is not a YAML mapping; all fields fall back to defaults.",
        hardStop: true,
      },
    ]);
  });

  it("keeps the split's own diagnostics, and a missing block is not also 'not a map'", () => {
    const split = splitFrontmatterMapping("no fences here\n");
    expect(split.data).toEqual({});
    expect(split.diagnostics.map((d) => d.code)).toEqual(["frontmatter.missing"]);
  });
});
