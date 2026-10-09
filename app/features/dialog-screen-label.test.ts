import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ruling 287(e): every dialog carries `data-screen-label`, so tests and agents
 * can address it by name (docs/ui/surfaces.md §4). `ConfirmDialog` requires
 * one; a hand-written `<dialog>` has nothing to remind it, and the New task,
 * Add from library and Change repository dialogs shipped without. This reads
 * every component's opening `<dialog` tag instead.
 */
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function components(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...components(full));
    else if (name.endsWith(".tsx") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

/** Each JSX `<dialog …>` opening tag in a source, with its line. Comments are
 *  stripped first, keeping their newlines so lines still count; the tag ends
 *  at the first `>` outside braces that is not an arrow's. */
function dialogTags(source: string): { line: number; tag: string }[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const tags: { line: number; tag: string }[] = [];
  for (const m of code.matchAll(/<dialog(?=\s)/g)) {
    let i = m.index + m[0].length;
    let depth = 0;
    for (; i < code.length; i++) {
      const c = code[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0 && code[i - 1] !== "=") break;
    }
    tags.push({ line: code.slice(0, m.index).split("\n").length, tag: code.slice(m.index, i) });
  }
  return tags;
}

describe("ruling 287(e): every dialog carries a screen label", () => {
  it("finds data-screen-label on every <dialog> a component renders", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of components(APP)) {
      for (const { line, tag } of dialogTags(readFileSync(file, "utf8"))) {
        seen++;
        if (!tag.includes("data-screen-label")) offenders.push(`${path.relative(APP, file)}:${line}`);
      }
    }
    // A scan that reads nothing passes everything.
    expect(seen).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  it("reads a tag across lines, past an arrow, and not inside a comment", () => {
    const tags = dialogTags(
      [
        "// a native <dialog > in a comment",
        "<dialog",
        "  ref={ref}",
        "  onClose={() => close()}",
        '  aria-label="New task"',
        ">",
      ].join("\n"),
    );
    expect(tags).toHaveLength(1);
    expect(tags[0]!.line).toBe(2);
    expect(tags[0]!.tag).toContain('aria-label="New task"');
    expect(tags[0]!.tag).not.toContain("data-screen-label");
  });
});
