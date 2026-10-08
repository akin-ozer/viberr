import { afterEach, describe, expect, it } from "vitest";
import type { RunInputs, RunKind } from "~/features/runtime/runtime-types";
import { createTestDbContext } from "../../../test-support/test-db";
import { recordRunInputs } from "./run-inputs.server";
import { listRunLines, upsertRun } from "./run-store.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const inputs = (
  over: { delivers?: boolean; anchor?: string; mcp?: RunInputs["mcp"] } = {},
): RunInputs => {
  const base: RunInputs = {
    cwd: null,
    repo: null,
    cloned: false,
    delivers: false,
    personaChars: 1200,
    promptChars: 300,
    anchor: null,
    skills: { granted: [], native: [], injected: [] },
    knowledge: ["rulings"],
    mcp: { mounted: [], unresolved: [], unhealthy: [], writeToolsDenied: [] },
    unresolvedResources: [],
    tools: { denied: [], toolkit: [] },
    directive: null,
  };
  if (over.delivers !== undefined) base.delivers = over.delivers;
  if (over.anchor !== undefined) base.anchor = over.anchor;
  if (over.mcp) base.mcp = over.mcp;
  return base;
};

/** The headline `recordRunInputs` writes at the head of a fresh run's console:
 *  the line a person reads. `kind` absent is how a specialist's run records it. */
function headline(given: RunInputs, kind?: RunKind): string {
  const db = ctx.makeDb();
  upsertRun(db, {
    id: "run_inputs",
    projectSlug: "viberr-core",
    taskKey: "VIB-1",
    threadId: "primary",
    role: "developer",
    kind: kind ?? "primary",
    backend: "claude",
    model: "sonnet",
    sdk: "Claude Agent SDK",
    agentProfileId: "dev",
    state: "running",
  });
  const input: Parameters<typeof recordRunInputs>[1] = {
    runId: "run_inputs",
    projectSlug: "viberr-core",
    taskKey: "VIB-1",
    threadId: "primary",
    backend: "claude",
    inputs: given,
    dataRoot: ctx.makeTempDir(),
  };
  if (kind) input.kind = kind;
  recordRunInputs(db, input);
  return listRunLines(db, "run_inputs")[0]!.display.text;
}

describe("U39-25: the run-inputs headline names the kind of run", () => {
  it("a specialist keeps the engagement wording, and a missing anchor is still loud", () => {
    // A specialist with no canonical block really is missing something.
    expect(headline(inputs({ delivers: true, anchor: "stage: build" }))).toBe(
      "Run inputs: delivering engagement · canonical anchor 12 chars · persona 1200 chars · prompt 300 chars · 0 skills · 1 knowledge base · 0 MCP servers",
    );
    expect(headline(inputs())).toContain("supporting engagement · NO canonical anchor");
  });

  it("an operator drive and a controller turn say what they are, and never flag the anchor they are not given", () => {
    // CANARY: push the anchor bit for every kind again.
    expect(headline(inputs(), "operator")).toBe(
      "Run inputs: operator drive · persona 1200 chars · prompt 300 chars · 0 skills · 1 knowledge base · 0 MCP servers",
    );
    const controller = headline(
      inputs({ mcp: { mounted: ["viberr_controller", "viberr_ops"], unresolved: [], unhealthy: [], writeToolsDenied: [] } }),
      "controller",
    );
    expect(controller).toBe(
      "Run inputs: controller turn · persona 1200 chars · prompt 300 chars · 0 skills · 1 knowledge base · 2 MCP servers",
    );
  });
});
