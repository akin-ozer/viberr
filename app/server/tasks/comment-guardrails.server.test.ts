import { describe, expect, it } from "vitest";
import {
  enforceOperatorBrevity,
  isMeaninglessComment,
  OPERATOR_BREVITY_MAX_CHARS,
  separateEvidence,
  EVIDENCE_MAX_FENCE_LINES,
} from "./comment-guardrails.server";

describe("meaningful-comment guardrail", () => {
  it("flags trivial status chatter", () => {
    for (const t of ["ok", "Done.", "on it", "working on it", "👍", "+1", "  Noted "]) {
      expect(isMeaninglessComment(t)).toBe(true);
    }
  });
  it("keeps real content", () => {
    expect(
      isMeaninglessComment("Done — implemented the retry and added a boundary test."),
    ).toBe(false);
    expect(isMeaninglessComment("The migration fails on empty input.")).toBe(false);
  });
  it("treats empty/null as meaningless", () => {
    expect(isMeaninglessComment("")).toBe(true);
    expect(isMeaninglessComment(null)).toBe(true);
    expect(isMeaninglessComment(undefined)).toBe(true);
  });
});

describe("operator-brevity guardrail", () => {
  it("leaves a short narration untouched", () => {
    const t = "Prompted @dev; waiting for the report.";
    expect(enforceOperatorBrevity(t)).toBe(t);
  });
  it("trims an over-long narration with a marker", () => {
    const long = "x".repeat(OPERATOR_BREVITY_MAX_CHARS + 500);
    const out = enforceOperatorBrevity(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain("operator-brevity guardrail");
  });
});

describe("evidence-separation guardrail", () => {
  it("leaves short fenced blocks inline", () => {
    const text = "Report:\n```\nline1\nline2\n```\ndone";
    expect(separateEvidence(text)).toBe(text);
  });
  it("replaces long dumps with a head + truthful reference", () => {
    const body = Array.from(
      { length: EVIDENCE_MAX_FENCE_LINES + 20 },
      (_, i) => `log line ${i}`,
    ).join("\n");
    const text = `Here is the output:\n\`\`\`\n${body}\n\`\`\`\nEnd.`;
    const out = separateEvidence(text);
    expect(out).toContain("evidence-separation guardrail");
    expect(out).toContain("log line 0");
    expect(out).not.toContain("log line 25");
    expect(out.length).toBeLessThan(text.length);
  });
  it("preserves surrounding prose", () => {
    const body = Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n");
    const text = `Intro paragraph.\n\`\`\`js\n${body}\n\`\`\`\nClosing note.`;
    const out = separateEvidence(text);
    expect(out).toContain("Intro paragraph.");
    expect(out).toContain("Closing note.");
  });
});
