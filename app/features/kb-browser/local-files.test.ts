// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { entriesFromFileList } from "./local-files";

/**
 * P13-UI-08 residual: dot-prefixed paths are filtered client-side AND
 * server-side, and the collectors used to return only the survivors — so a
 * selection of nothing but hidden files came back empty and the caller returned
 * without a request, a toast or an error. The count of what was filtered has to
 * travel with the selection for the browser to be able to say anything.
 */

function file(name: string, relPath?: string): File {
  const f = new File(["x"], name, { type: "text/plain" });
  if (relPath) {
    Object.defineProperty(f, "webkitRelativePath", { value: relPath });
  }
  return f;
}

describe("entriesFromFileList", () => {
  it("reports how many files the dot-filter removed", () => {
    const sel = entriesFromFileList([
      file("notes.md"),
      file(".DS_Store"),
      file("ok.md", "docs/ok.md"),
      file("cfg", ".git/config"),
    ]);
    expect(sel.entries.map((e) => e.relPath)).toEqual(["notes.md", "docs/ok.md"]);
    expect(sel.skipped).toBe(2);
  });

  it("an empty picker is neither an upload nor a skip", () => {
    expect(entriesFromFileList([])).toEqual({ entries: [], skipped: 0 });
  });
});
