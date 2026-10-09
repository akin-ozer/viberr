import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ruling 321: no component renders a literal ⌘.
 *
 * UI-55 settled that a shortcut hint names the modifier the viewer's keyboard
 * has, and wrote `useModifierHint` for it; P13-D-39 applied it to the comment
 * composer and called that "the last user-visible ⌘ in `app/`". It was not: the
 * controller page and the controller dock both still printed "⌘↵ sends" over a
 * handler that accepts Ctrl, so every Windows and Linux user of the one surface
 * that talks to the controller was shown a key they do not have. A rule that
 * lives in a comment is re-broken by the next composer, so this reads every
 * component instead.
 *
 * Comments are stripped first (a `.tsx` file may DESCRIBE ⌘K freely); what is
 * left is code and JSX text, and neither may hold the glyph. The glyph belongs
 * to `useModifierHint` (a `.ts` file, out of this scan by design).
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

/** Block comments (JSX `{/* … *\/}` included) and line comments. Strings are
 *  not parsed: a `//` inside one only drops the rest of its line, which can
 *  hide a glyph from this scan but never invent one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("ruling 321: shortcut hints name the viewer's own modifier", () => {
  it("finds no literal ⌘ in any component's code or JSX text", () => {
    const offenders: string[] = [];
    const files = components(APP);
    // A scan that reads nothing passes everything.
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      stripComments(readFileSync(file, "utf8"))
        .split("\n")
        .forEach((line, i) => {
          if (line.includes("⌘")) offenders.push(`${path.relative(APP, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("would catch the controller's old hint (the scan is not vacuous)", () => {
    const old = `<span className="fine xs dim">Acts with your permissions · ⌘↵ sends</span>`;
    expect(stripComments(old)).toContain("⌘");
    expect(stripComments(`{/* the ⌘K palette */}`)).not.toContain("⌘");
    expect(stripComments(`// ⌘K opens the palette`)).not.toContain("⌘");
  });
});
