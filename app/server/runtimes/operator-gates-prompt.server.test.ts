import { describe, expect, it } from "vitest";
import { buildCodexOperatorPrompt, buildOperatorTurnPrompt } from "./operator-prompt.server";
import { operatorSnapshot } from "../../../test-support/operator-snapshot";

/**
 * Ruling 482 (pass 40, F40-52): the operator reads the project's gates from
 * Viberr's own record, and a failing gate reaches it as a turn of its own.
 *
 * Live on akinozer-com every directive re-typed the gate commands from the
 * rulings KB ("Run `pnpm build` (the only settled gate). Also run the gates
 * proposed under WEB-1 … Report each exit code honestly"), and what came back
 * was an agent's sentence about four exit codes.
 */

const SNAPSHOT = operatorSnapshot({
  key: "WEB-4",
  title: "Ship the contact page",
  goal: "Ship the contact page.",
  stage: "review",
  stageName: "Review",
  validation: "healthy",
  specialist: { profileId: "developer", role: "Developer", backend: "claude" },
  branch: "web-4",
  gates: {
    line: "Gates on a95c337: 3/4 exit 0 (run by Viberr)",
    state: "failed",
    failed: [
      {
        name: "build",
        command: "pnpm build",
        outcome: "exit 1",
        log: "gate-a95c337-03-build-20260925T101500Z.log",
      },
    ],
    error: null,
  },
});

describe("the operator and the project's gates (ruling 482)", () => {
  it("a gates-failed turn names the failing gate, its log and the rework, and forbids a report of the gates", () => {
    // CANARY: drop the `gates-failed` branch of operatorTurnDoctrine and this
    // turn falls through to the ordinary stage rule.
    const prompt = buildOperatorTurnPrompt(SNAPSHOT, "gates-failed");
    expect(prompt).toContain("Viberr ran the project's gates itself on the revision under review: Gates on a95c337: 3/4 exit 0 (run by Viberr).");
    expect(prompt).toContain("`build` (`pnpm build`) exit 1; its full log is the task attachment `gate-a95c337-03-build-20260925T101500Z.log`");
    expect(prompt).toContain("`run_agent` the delivering profile");
    expect(prompt).toContain("Do NOT ask an agent to re-run the gates to report them");
    expect(buildCodexOperatorPrompt(SNAPSHOT, "gates-failed")).toContain("Failed: `build`");
  });

  it("every ordinary turn carries the gate rule while gates are declared, and none without them", () => {
    // CANARY: drop `projectGatesRule` from stageRule.
    const prompt = buildOperatorTurnPrompt(SNAPSHOT, "manual");
    expect(prompt).toContain("Project gates (ruling 482): Gates on a95c337: 3/4 exit 0 (run by Viberr).");
    expect(prompt).toContain("never offer or perform `accept_completion` while `gates.state` is not `passed`");
    const without = buildOperatorTurnPrompt({ ...SNAPSHOT, gates: null }, "manual");
    expect(without).not.toContain("Project gates (ruling 482)");
  });
});
