import { describe, expect, it } from "vitest";
import {
  applyCommentGuardrails,
  commentOutcomeMessage,
  isMeaninglessComment,
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

/**
 * Owner ruling 2026-08-31: operator narration reaches the canonical record
 * UNTRUNCATED — the old operator-brevity cap destroyed the overflow at write
 * time ("the full narration is in the agent logs"), while the timeline already
 * collapses tall comments view-side behind a Show more toggle. Locks the
 * removal: a long narration passes through the guardrails verbatim.
 */
describe("operator narration is stored verbatim", () => {
  it("never truncates a long narration — length is a view concern", () => {
    const long =
      "Acceptance caveat the human must read in full. " + "detail ".repeat(2000);
    const result = applyCommentGuardrails({
      text: long,
      meaningful: true,
      evidence: true,
      noDuplicate: true,
    });
    expect(result.text).toBe(long);
    expect(result.dropped).toBeNull();
    expect(result.trimmedBy).toEqual([]);
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

  it("does NOT treat an inline ``` inside prose as the closing fence (#12)", () => {
    // An inline triple-backtick mid-line must not be mistaken for the closing
    // fence — the regex is anchored to line starts.
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const text = `Note: use \`\`\`lang for fences.\nThen the dump:\n\`\`\`\n${body}\n\`\`\`\nDone.`;
    const out = separateEvidence(text);
    expect(out).toContain("Done.");
    expect(out).toContain("Note: use");
  });
});

/**
 * B-FD8: the guardrails must SAY what they did. A model told "posted" about a
 * comment that was dropped goes on to reason about narration nobody can read.
 */
describe("applyCommentGuardrails + commentOutcomeMessage (B-FD8)", () => {
  const on = { meaningful: true, evidence: true, noDuplicate: true };

  it("reports a meaningful-comment DROP instead of a post", () => {
    const result = applyCommentGuardrails({ text: "ok", ...on });
    expect(result).toEqual({ text: null, dropped: "meaningless", trimmedBy: [] });
    const message = commentOutcomeMessage(result);
    expect(message).toContain("NOT posted");
    expect(message).toContain("meaningful-comment");
    expect(message).not.toContain("Comment posted to the timeline.");
  });

  it("reports a no-duplicate-summary DROP — the path that used to leave no trace at all", () => {
    const text = "Reviewer approved the current revision; moving to acceptance.";
    const result = applyCommentGuardrails({ text, previousText: text, ...on });
    expect(result.dropped).toBe("duplicate");
    expect(result.text).toBeNull();
    expect(commentOutcomeMessage(result)).toContain("identical to your previous comment");
  });

  it("compares the duplicate check against the POST-trim text", () => {
    const dump = ["```", ...Array.from({ length: 40 }, (_, i) => `line ${i}`), "```"].join("\n");
    const text = `Report:\n${dump}`;
    const trimmed = separateEvidence(text);
    // The stored previous comment is the evidence-separated form, so re-posting
    // the same raw dump is still a duplicate.
    expect(applyCommentGuardrails({ text, previousText: trimmed, ...on }).dropped).toBe(
      "duplicate",
    );
  });

  it("names the guardrails that TRIMMED a posted comment", () => {
    const dump = ["```", ...Array.from({ length: 40 }, (_, i) => `line ${i}`), "```"].join("\n");
    const result = applyCommentGuardrails({ text: `Report:\n${dump}`, ...on });
    expect(result.dropped).toBeNull();
    expect(result.trimmedBy).toContain("evidence-separation");
    const message = commentOutcomeMessage(result);
    expect(message).toContain("TRIMMED");
    expect(message).toContain("evidence-separation");
  });

  it("an untouched comment reports a plain post, and OFF guardrails never drop", () => {
    const plain = applyCommentGuardrails({ text: "Delivered on rev_1; PR #12 opened.", ...on });
    expect(plain).toEqual({
      text: "Delivered on rev_1; PR #12 opened.",
      dropped: null,
      trimmedBy: [],
    });
    expect(commentOutcomeMessage(plain)).toBe("Comment posted to the timeline.");
    // Every guardrail off: chatter and an exact repeat both go through.
    expect(applyCommentGuardrails({ text: "ok", previousText: "ok" })).toEqual({
      text: "ok",
      dropped: null,
      trimmedBy: [],
    });
  });
});
