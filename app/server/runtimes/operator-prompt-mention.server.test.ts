import { describe, expect, it } from "vitest";
import { buildOperatorTurnPrompt } from "./operator-prompt.server";
import { operatorSnapshot } from "../../../test-support/operator-snapshot";

/**
 * NEW-4: when a human addresses the operator directly, the turn instruction
 * must tell the operator to tag that person by @handle — a bare reply lands on
 * the timeline but the mention is what actually notifies them.
 */

const SNAPSHOT = operatorSnapshot();

describe("operator turn instruction — @tag the human (NEW-4)", () => {
  const comment = "can you summarize what you did in this whole session?";

  it("Claude prompt tells the operator to tag the named commenter", () => {
    const prompt = buildOperatorTurnPrompt(
      SNAPSHOT,
      "manual",
      comment,
      undefined,
      "Arda",
    );
    expect(prompt).toContain('A human (Arda) addressed you directly');
    expect(prompt).toContain('tag them "@Arda"');
    expect(prompt.toLowerCase()).toContain("notified");
  });

  it("without a known commenter name, no tag clause is emitted (no '@undefined')", () => {
    const prompt = buildOperatorTurnPrompt(SNAPSHOT, "manual", comment);
    expect(prompt).toContain("A human addressed you directly");
    expect(prompt).not.toContain("@undefined");
    expect(prompt).not.toContain("tag them");
  });
});

/**
 * R20-9 (F20-31): a goal may delegate a clarifying question to the DELIVERING
 * agent's ask-human. The operator may gather that answer itself at triage so
 * work is not stalled, but the packet must DISCLOSE it is substituting for the
 * delegated agent ask. The triage-turn guidance carries that instruction.
 */
describe("operator triage gate — disclose a substituted delegated ask (R20-9)", () => {
  const TRIAGE = operatorSnapshot({ stage: "triage", stageName: "Triage" });

  it("Claude triage prompt tells the operator to disclose gathering on the agent's behalf", () => {
    const prompt = buildOperatorTurnPrompt(TRIAGE, "create");
    expect(prompt).toContain("DELEGATED a clarifying question to the delivering agent");
    expect(prompt).toContain("on the delivering agent's behalf");
  });
});

/**
 * Ruling 117 (pass 37, F37-120). The clip on an agent report was already
 * honest — the header said "first 4,000 chars" — and honesty about a dead end
 * is still a dead end. Live on SHOP-42 the operator raised a packet to a human
 * saying "the reviewer's report reached me truncated at '### Item 3 —', so I
 * have not read its cross-service audit conclusion; the full text is on the
 * timeline". It was right about every part of that, including that the text was
 * somewhere it could not go — and what it could not read named two unowned
 * defects the reviewer had gone looking for.
 */
describe("a clipped agent report names the way out (ruling 117)", () => {
  const long = `## Findings\n\n${"filler ".repeat(900)}\n\nSENTINEL-PAST-THE-CLIP`;

  it("a report past the clip is cut, says so, and names the tool that finishes it", () => {
    // Canary: drop the `more` string from `agentReportBlock` and the operator is
    // back to being told its report is cut with nowhere to go.
    const prompt = buildOperatorTurnPrompt(
      SNAPSHOT,
      "agent-reply",
      undefined,
      long,
    );
    expect(prompt).toContain("This report is CUT");
    expect(prompt).toContain("read_timeline_entry");
    expect(prompt).toContain("before you raise a packet about it");
    // The clip itself still holds — a prompt carrying every report in full is
    // the problem the clip exists to prevent.
    expect(prompt).not.toContain("SENTINEL-PAST-THE-CLIP");
  });

  it("a report that FITS says nothing about being cut", () => {
    const prompt = buildOperatorTurnPrompt(
      SNAPSHOT,
      "agent-reply",
      undefined,
      "Short report. SENTINEL-FITS.",
    );
    expect(prompt).toContain("SENTINEL-FITS");
    expect(prompt).not.toContain("This report is CUT");
    expect(prompt).not.toContain("read_timeline_entry");
  });
});
