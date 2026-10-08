import { describe, expect, it } from "vitest";
import { readableStep } from "./readable-step";

/**
 * U39-9: a run's live step as a person reads it. Both surfaces that show one
 * render it through `readableStep`: the controller's working row (`TurnStep`;
 * controller-page.test.tsx renders a raw step there and reads the words) and
 * the Live run strip. This is the reading itself, owned beside it.
 */
describe("readableStep", () => {
  it("U39-9: a step reads as words: no server prefix, no underscores, a flat input as its values", () => {
    // CANARY: drop the `mcp__<server>__` replacement.
    expect(readableStep("composing · mcp__viberr_controller__read_default_branch_file · internal/client/client.go answered")).toBe(
      "composing · read default branch file · internal/client/client.go answered",
    );
    expect(readableStep('mcp__viberr_ops__read_run_log · {"runId":"run_x","tail":40}')).toBe("read run log · run_x, 40");
    // A payload the 120-character cap cut short is not JSON, so it stays as stored.
    expect(readableStep('mcp__viberr_controller__update_epic · {"epicId":"epic-6","addTasks…')).toBe(
      'update epic · {"epicId":"epic-6","addTasks…',
    );
    // Built-in tools and their inputs are already words.
    expect(readableStep("Bash · npm test")).toBe("Bash · npm test");
  });

  it("U39-28: the run loading its tools says so, with their names", () => {
    // Live on ax-clone, the first step of a controller turn. CANARY: drop the
    // two ToolSearch replacements.
    expect(
      readableStep(
        "composing · ToolSearch · query: select:mcp__viberr_controller__get_task,mcp__viberr_controller__list_decisions… answered",
      ),
    ).toBe("composing · loading tools · get task, list decisions… answered");
    expect(readableStep("ToolSearch · query: slack send")).toBe("looking up tools · slack send");
    // Live after the deploy: the cap cut the second id before its tool name.
    // CANARY: drop the truncated-id replacement.
    expect(
      readableStep(
        "composing · ToolSearch · query: select:mcp__viberr_controller__read_knowledge_base_doc,mcp__viberr_controller_… answered",
      ),
    ).toBe("composing · loading tools · read knowledge base doc, … answered");
  });
});
