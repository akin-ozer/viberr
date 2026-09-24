import { describe, expect, it } from "vitest";
import { slugify } from "~/shared/ids/slugify";
import { projectNameFromRepo } from "./project-name";

describe("slugify (repo default of the linked name↔repo pair)", () => {
  it("kebab-cases a multi-word name", () => {
    expect(slugify("Payments Gateway")).toBe("payments-gateway");
  });

  it("collapses runs of non-alphanumerics and trims edge dashes", () => {
    expect(slugify("  Core -- API!  ")).toBe("core-api");
  });

  it("drops a trailing separator while a word is being typed", () => {
    expect(slugify("Payments ")).toBe("payments");
  });

  it("is empty for an empty/blank name", () => {
    expect(slugify("   ")).toBe("");
  });
});

describe("projectNameFromRepo", () => {
  it("title-cases kebab-separated repo names", () => {
    expect(projectNameFromRepo("payments-gateway")).toBe("Payments Gateway");
  });

  it("treats snake and dot separators as word breaks too", () => {
    expect(projectNameFromRepo("core_api.v2")).toBe("Core Api V2");
  });

  it("round-trips with slugify", () => {
    expect(slugify(projectNameFromRepo("payments-gateway"))).toBe(
      "payments-gateway",
    );
  });
});
