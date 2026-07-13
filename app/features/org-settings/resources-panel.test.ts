import { describe, expect, it } from "vitest";
import { canonicalizeKbProfileRefs } from "./resources-panel";

describe("canonicalizeKbProfileRefs", () => {
  const kbs = [
    { id: "kb_arch", name: "Architecture notes", dir: "architecture-notes" },
    { id: "kb_run", name: "Runbooks", dir: "runbooks" },
  ];

  it("maps id/name/folder aliases to one removable canonical selection", () => {
    expect(
      canonicalizeKbProfileRefs(
        ["Architecture notes", "architecture-notes", "kb_arch", "Runbooks"],
        kbs,
      ),
    ).toEqual({
      selected: ["architecture-notes", "runbooks"],
      legacy: [],
    });
  });

  it("preserves only genuinely unknown legacy references", () => {
    expect(
      canonicalizeKbProfileRefs(
        ["old-private-index", "old-private-index", "kb_run"],
        kbs,
      ),
    ).toEqual({
      selected: ["runbooks"],
      legacy: ["old-private-index"],
    });
  });
});
