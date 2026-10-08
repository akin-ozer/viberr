import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readKbDocForRun } from "~/server/files/kb-injection.server";
import { readTaskAttachment, writeTaskAttachment } from "~/server/files/task-attachments.server";
import { pageOfText } from "~/server/tasks/operator-repo-read.server";
import { pageEnd, READ_PAGE_BYTES } from "./read-page-budget.server";
import { createTempDirs } from "../../../test-support/temp-dirs";

/**
 * Ruling 624: one page of any agent read reaches a Codex code-mode run whole.
 * codex-cli 0.156 cuts what a code-mode `exec` call prints to 10,000 tokens,
 * counted as UTF-8 bytes / 4, from the middle; an agent usually prints a
 * tool's result as JSON. Live on AWSC-77 a 48,000-character knowledge-base page
 * arrived with its middle gone.
 */
const CODEX_TOOL_OUTPUT_TOKENS = 10_000;
/** Codex's count of what a call printed: UTF-8 bytes / 4. */
const codexTokens = (printed: string) => Buffer.byteLength(printed) / 4;
/** A tool's text result as an agent prints it: the result object, as JSON. */
const asToolResult = (text: string) => JSON.stringify({ content: [{ type: "text", text }] });

const temp = createTempDirs();
afterEach(temp.cleanup);

/** Tables, accents, dashes and an emoji: the text a knowledge base holds, at
 *  more bytes per character than ASCII. */
function mixedText(chars: number): string {
  const row = "| Azure SQL → RDS — “Multi-AZ” | çğış üö é | 🚀 x |\n";
  return row.repeat(Math.ceil(chars / row.length)).slice(0, chars);
}

describe("ruling 624: pageEnd", () => {
  it("fills the byte budget, never splits a character, and pages back into the whole", () => {
    // CANARY: count characters instead of bytes and the multibyte pages
    // overrun the budget.
    expect(pageEnd("a".repeat(READ_PAGE_BYTES + 10), 0)).toBe(READ_PAGE_BYTES);
    expect(pageEnd("é".repeat(READ_PAGE_BYTES), 0)).toBe(READ_PAGE_BYTES / 2);
    const text = mixedText(120_000);
    const pages: string[] = [];
    for (let at = 0; at < text.length; ) {
      const end = pageEnd(text, at);
      const page = text.slice(at, end);
      expect(Buffer.byteLength(page)).toBeLessThanOrEqual(READ_PAGE_BYTES);
      // A lone surrogate at either edge would mean a split emoji.
      expect(page).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      pages.push(page);
      at = end;
    }
    expect(pages.join("")).toBe(text);
    // A budget smaller than the first character still moves one character.
    expect(pageEnd("🚀🚀", 0, 2)).toBe(2);
    expect(pageEnd("abc", 3)).toBe(3);
  });
});

describe("ruling 624: one page of every agent read fits a Codex code-mode tool output", () => {
  it("a knowledge-base page, printed as its tool result", () => {
    // CANARY: put KB pages back at 48,000 characters.
    const dataRoot = temp.make("viberr-623-");
    const kbDir = path.join(dataRoot, "kb", "notes");
    mkdirSync(kbDir, { recursive: true });
    for (const [name, text] of [["ascii.md", "a".repeat(100_000)], ["mixed.md", mixedText(100_000)]] as const) {
      writeFileSync(path.join(kbDir, name), text, "utf8");
      const page = readKbDocForRun(["notes"], "notes", name, dataRoot);
      expect(page).toContain("read on with offset");
      expect(codexTokens(asToolResult(page))).toBeLessThanOrEqual(CODEX_TOOL_OUTPUT_TOKENS);
    }
  });

  it("a task attachment page, printed as the reader's JSON", () => {
    // CANARY: put attachment pages back at 40,000 characters.
    const root = temp.make("viberr-623-");
    for (const [name, text] of [["ascii.md", "a".repeat(100_000)], ["mixed.md", mixedText(100_000)]] as const) {
      writeTaskAttachment("p1", "VIB-1", name, new TextEncoder().encode(text), root);
      const read = readTaskAttachment("p1", "VIB-1", name, root);
      if (!read || !("text" in read)) throw new Error("expected a text page");
      expect(read.truncated).toBe(true);
      expect(codexTokens(asToolResult(JSON.stringify(read)))).toBeLessThanOrEqual(CODEX_TOOL_OUTPUT_TOKENS);
    }
  });

  it("a default-branch page, and a line longer than a page", () => {
    // CANARY: put branch pages back at 40,000 characters.
    const lines = mixedText(200_000);
    const page = pageOfText(lines);
    expect(page.ok && page.more).toBe(true);
    if (!page.ok) return;
    expect(codexTokens(asToolResult(page.text))).toBeLessThanOrEqual(CODEX_TOOL_OUTPUT_TOKENS);
    const long = pageOfText(`${"é".repeat(READ_PAGE_BYTES)}\nnext\n`);
    expect(long.ok && long.lineCut && long.text).toBe("é".repeat(READ_PAGE_BYTES / 2));
  });
});
