import { describe, expect, it } from "vitest";
import {
  buildCodexOperatorPrompt,
  buildOperatorTurnPrompt,
} from "./operator-run.server";
import type { OperatorTaskSnapshot } from "~/server/tasks/operator-actions.server";

/**
 * NEW-4: when a human addresses the operator directly, the turn instruction
 * must tell the operator to tag that person by @handle — a bare reply lands on
 * the timeline but the mention is what actually notifies them.
 */

const SNAPSHOT: OperatorTaskSnapshot = {
  key: "VIB-1",
  title: "Add the file listing",
  goal: "Ship the file-listing deliverable.",
  stage: "impl",
  stageName: "In Progress",
  readiness: "ready",
  waiting: "none",
  owner: null,
  specialist: null,
  reviewers: [],
  nextStages: [],
  stageIds: ["triage", "impl", "review", "done"],
  doneStageId: "done",
  reviewStageId: "review",
  workStageId: "impl",
  deployedSpecialists: [],
  openPacket: false,
  packet: null,
} as unknown as OperatorTaskSnapshot;

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

  it("Codex prompt carries the same tag directive", () => {
    const prompt = buildCodexOperatorPrompt(
      SNAPSHOT,
      "manual",
      comment,
      undefined,
      "Arda",
    );
    expect(prompt).toContain('tag them "@Arda"');
  });

  it("without a known commenter name, no tag clause is emitted (no '@undefined')", () => {
    const prompt = buildOperatorTurnPrompt(SNAPSHOT, "manual", comment);
    expect(prompt).toContain("A human addressed you directly");
    expect(prompt).not.toContain("@undefined");
    expect(prompt).not.toContain("tag them");
  });
});
