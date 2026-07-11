import { describe, expect, it } from "vitest";
import { normalizeEscapedNewlines } from "./model-prose.server";

/**
 * Finding #23: a real operator run posted a comment whose text carried literal
 * backslash-n sequences ("**Plan — ATL-1**\n\nObserved: …") because the model
 * double-escaped newlines inside its tool-call string. The normalizer repairs
 * exactly that shape while leaving deliberate backslashes alone.
 */

describe("normalizeEscapedNewlines", () => {
  it("converts literal \\n escapes in single-line prose to real newlines (the observed comment)", () => {
    const raw =
      "**Plan — ATL-1**\\n\\nObserved: the task was created in Triage with a clear goal.\\n\\nNext: prompting @dev to implement.";
    expect(normalizeEscapedNewlines(raw)).toBe(
      "**Plan — ATL-1**\n\nObserved: the task was created in Triage with a clear goal.\n\nNext: prompting @dev to implement.",
    );
  });

  it("converts single \\n list separators between prose characters", () => {
    expect(normalizeEscapedNewlines("Observed:\\n- branch pushed\\n- PR open")).toBe(
      "Observed:\n- branch pushed\n- PR open",
    );
  });

  it("converts a trailing \\n directly after prose", () => {
    expect(normalizeEscapedNewlines("Handing back to humans.\\n")).toBe(
      "Handing back to humans.\n",
    );
  });

  it("leaves text that already carries real newlines untouched (its \\n are content)", () => {
    const raw = "Line one\nsplit the file on \\n when parsing";
    expect(normalizeEscapedNewlines(raw)).toBe(raw);
  });

  it("leaves text containing a fenced code block untouched", () => {
    const raw = 'Run ```printf("a\\nb")``` and report the output.';
    expect(normalizeEscapedNewlines(raw)).toBe(raw);
  });

  it("does not split doubled backslashes (escaped-backslash + n)", () => {
    const raw = "Files land under C:\\\\network\\\\names on the runner.";
    expect(normalizeEscapedNewlines(raw)).toBe(raw);
  });

  it("leaves an inline `\\n` code span alone", () => {
    const raw = "Split records on `\\n` before hashing.";
    expect(normalizeEscapedNewlines(raw)).toBe(raw);
  });

  it("leaves a space-surrounded \\n alone (prose about the escape itself)", () => {
    const raw = "the model emitted \\n instead of a newline";
    expect(normalizeEscapedNewlines(raw)).toBe(raw);
  });

  it("leaves a Windows path separator alone (single \\n followed by a word char)", () => {
    // `\node`/`\network` are backslash-n path segments, NOT escaped newlines.
    expect(normalizeEscapedNewlines("Build output lands in C:\\node_modules on the runner.")).toBe(
      "Build output lands in C:\\node_modules on the runner.",
    );
    expect(normalizeEscapedNewlines("Mounted at \\network\\share for the job.")).toBe(
      "Mounted at \\network\\share for the job.",
    );
  });

  it("still converts a double \\n\\n paragraph break even before a word char", () => {
    // The observed real failure: a paragraph break whose next line starts with
    // a letter — the 2+ run is unambiguous, so it must still convert.
    expect(normalizeEscapedNewlines("Done.\\n\\nNext step follows.")).toBe(
      "Done.\n\nNext step follows.",
    );
  });

  it("returns escape-free strings unchanged", () => {
    expect(normalizeEscapedNewlines("A plain comment.")).toBe("A plain comment.");
    expect(normalizeEscapedNewlines("")).toBe("");
  });
});
