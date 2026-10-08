import { describe, expect, it } from "vitest";
import type { LogLine } from "./runtime-types";
import { diffPreview, editDiff, type DiffLine, type DiffRow } from "./edit-diff";

const W = "/data/projects/akinozer-com/tasks/WEB-3/workspace/website/";

function tool(name: string, input: LogLine["input"]): LogLine {
  return { t: "10:00:00", ev: "tool", tag: "tool_use", name, text: W + "docs/x.md", input };
}

/** A row as `kind text` (a line) or a fold's count, for compact assertions. */
function show(row: DiffRow): string {
  if (row.kind === "fold") return `fold ${row.lines.length}`;
  if (row.kind === "edit") return `edit ${row.n}/${row.of}${row.everywhere ? " all" : ""}`;
  return `${row.kind} ${row.text}`;
}

describe("ruling 499: an Edit reads as the lines it removed and added", () => {
  it("keeps the quoted context, removes then adds, and counts both", () => {
    const diff = editDiff(
      tool("Edit", {
        file_path: W + "docs/deploy-runbook.md",
        old_string: "## Step 1\n\n5. builds: on\ntail",
        new_string: "## Step 1\n\n5. builds: off\nnew line\ntail",
      }),
    )!;
    expect(diff.rows.map(show)).toEqual([
      "ctx ## Step 1",
      "ctx ",
      "del 5. builds: on",
      "add 5. builds: off",
      "add new line",
      "ctx tail",
    ]);
    expect([diff.added, diff.removed, diff.written]).toEqual([2, 1, null]);
    // The row prints the file repo-relative; the call's own path is kept.
    expect(diff.shown).toBe("docs/deploy-runbook.md");
    expect(diff.path).toBe(W + "docs/deploy-runbook.md");
    // What the diff shows in full is no longer cut from the row.
    expect(diff.drawn).toEqual(["old_string", "new_string"]);
  });

  it("marks the changed words of a paired line, and no words of an unpaired one", () => {
    const diff = editDiff(
      tool("Edit", {
        file_path: "/tmp/x.md",
        old_string: "5. Non-production branch builds: on",
        new_string: "5. Non-production branch builds: off\nIts write permissions are unmeasured.",
      }),
    )!;
    const [del, add, extra] = diff.rows.filter((r): r is DiffLine => r.kind !== "fold" && r.kind !== "edit");
    expect(del!.text.slice(...del!.spans![0]!)).toBe("on");
    expect(add!.text.slice(...add!.spans![0]!)).toBe("off");
    expect(extra!.spans).toBeNull();
    // A path outside any task checkout prints as it is.
    expect(diff.shown).toBe("/tmp/x.md");
  });

  it("folds unchanged runs past three lines of context, and never a single line", () => {
    // CANARY: set CONTEXT to 0 and every unchanged line folds away.
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const next = [...lines];
    next[9] = "line 10 changed";
    const diff = editDiff(
      tool("Edit", { file_path: "/tmp/a.ts", old_string: lines.join("\n"), new_string: next.join("\n") }),
    )!;
    expect(diff.rows.map(show)).toEqual([
      "fold 6",
      "ctx line 7",
      "ctx line 8",
      "ctx line 9",
      "del line 10",
      "add line 10 changed",
      "ctx line 11",
      "ctx line 12",
      "ctx line 13",
      "fold 7",
    ]);
    // Two changes seven lines apart: the run between them is shown whole.
    const close = [...lines];
    close[2] = "line 3 changed";
    close[10] = "line 11 changed";
    const near = editDiff(
      tool("Edit", { file_path: "/tmp/a.ts", old_string: lines.slice(0, 14).join("\n"), new_string: close.slice(0, 14).join("\n") }),
    )!;
    expect(near.rows.filter((r) => r.kind === "fold")).toHaveLength(0);
  });

  it("ignores the trailing newline both texts end with, and reads an empty text as no lines", () => {
    const diff = editDiff(tool("Edit", { file_path: "/tmp/a", old_string: "a\nb\n", new_string: "a\nc\n" }))!;
    expect(diff.rows.map(show)).toEqual(["ctx a", "del b", "add c"]);
    const added = editDiff(tool("Edit", { file_path: "/tmp/a", old_string: "", new_string: "first" }))!;
    expect(added.rows.map(show)).toEqual(["add first"]);
    expect([added.added, added.removed]).toEqual([1, 0]);
  });

  it("says when the edit replaces every occurrence", () => {
    const diff = editDiff(
      tool("Edit", { file_path: "/tmp/a", old_string: "x", new_string: "y", replace_all: true }),
    )!;
    expect(diff.everywhere).toBe(true);
  });

  it("draws nothing for an input that is not an edit's", () => {
    expect(editDiff(tool("Edit", { file_path: "/tmp/a", old_string: "x" }))).toBeNull();
    expect(editDiff(tool("Read", { file_path: "/tmp/a" }))).toBeNull();
    expect(editDiff({ t: "10:00:00", ev: "out", tag: "tool_result", text: "x", name: "Edit" })).toBeNull();
  });
});

describe("ruling 499: a MultiEdit marks each edit; a Write numbers the file it writes", () => {
  it("marks each of a MultiEdit's edits, with its own every-occurrence, and sums the counts", () => {
    const diff = editDiff(
      tool("MultiEdit", {
        file_path: W + "src/config.ts",
        edits: [
          { old_string: "PREVIEWS = true", new_string: "PREVIEWS = false" },
          { old_string: "a\nb", new_string: "a", replace_all: true },
        ],
      }),
    )!;
    expect(diff.rows.map(show)).toEqual([
      "edit 1/2",
      "del PREVIEWS = true",
      "add PREVIEWS = false",
      "edit 2/2 all",
      "ctx a",
      "del b",
    ]);
    expect([diff.added, diff.removed]).toEqual([1, 2]);
    expect(diff.everywhere).toBe(false);
    expect(diff.drawn).toEqual(["edits"]);
  });

  it("numbers a Write's lines and claims no +/−: the record holds no earlier file", () => {
    // CANARY: count a Write's lines as added and the row claims a +N the
    // record cannot support.
    const diff = editDiff(tool("Write", { file_path: W + "docs/new.md", content: "# New\n\nbody\n" }))!;
    expect(diff.rows.map((r) => (r.kind === "ctx" ? [r.num, r.text] : r.kind))).toEqual([
      [1, "# New"],
      [2, ""],
      [3, "body"],
    ]);
    expect([diff.added, diff.removed, diff.written]).toEqual([null, null, 3]);
    expect(diff.drawn).toEqual(["content"]);
  });
});

describe("ruling 499: a long diff shows its first ten rows and counts the rest", () => {
  const line = (n: number): DiffLine => ({ kind: "add", text: `l${n}`, spans: null, num: null });

  it("draws a diff of twelve rows whole", () => {
    const rows = Array.from({ length: 12 }, (_, i) => line(i));
    expect(diffPreview(rows)).toEqual({ shown: 12, more: 0 });
  });

  it("past twelve, draws ten and counts the lines behind them, a fold's lines included", () => {
    const rows: DiffRow[] = [
      ...Array.from({ length: 10 }, (_, i) => line(i)),
      { kind: "fold", lines: [line(100), line(101), line(102)] },
      { kind: "edit", n: 2, of: 2, everywhere: false },
      line(200),
      line(201),
    ];
    expect(diffPreview(rows)).toEqual({ shown: 10, more: 5 });
  });
});
