import { describe, expect, it } from "vitest";
import {
  countKbDirs,
  countKbFiles,
  flatten,
  type StoreNode,
} from "./tree";

const TREE: StoreNode[] = [
  {
    type: "dir",
    name: "decisions",
    children: [
      { type: "file", name: "adr-001.md", sizeBytes: 4300, mtime: "2026-03-30T10:00:00.000Z" },
      { type: "dir", name: "drafts", children: [
        { type: "file", name: "wip.md", sizeBytes: 100, mtime: "2026-06-01T10:00:00.000Z" },
      ] },
    ],
  },
  { type: "file", name: "overview.md", sizeBytes: 9100, mtime: "2026-07-01T10:00:00.000Z" },
];

describe("tree helpers", () => {
  it("counts files recursively and dirs recursively", () => {
    expect(countKbFiles(TREE)).toBe(3);
    expect(countKbDirs(TREE)).toBe(2);
    expect(countKbFiles(undefined)).toBe(0);
  });

  it("flatten: dirs before files, recursing only into expanded dirs", () => {
    const collapsed = flatten(TREE, [], 0, new Set(), []);
    expect(collapsed.map((r) => r.key)).toEqual(["decisions", "overview.md"]);

    const open = flatten(TREE, [], 0, new Set(["decisions"]), []);
    expect(open.map((r) => r.key)).toEqual([
      "decisions",
      "decisions/drafts",
      "decisions/adr-001.md",
      "overview.md",
    ]);
    expect(open[1]).toMatchObject({ depth: 1, open: false });

    const deep = flatten(TREE, [], 0, new Set(["decisions", "decisions/drafts"]), []);
    expect(deep.map((r) => r.key)).toContain("decisions/drafts/wip.md");
  });
});
