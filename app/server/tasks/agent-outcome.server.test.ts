import { describe, expect, it } from "vitest";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
import {
  effectiveCollabMode,
  parseAgentOutcomeJson,
  resolveAgentCollab,
} from "./agent-outcome.server";

const grant = (capabilityId: string, mode: CapabilityGrant["mode"]): CapabilityGrant => ({
  capabilityId,
  mode,
});

describe("effectiveCollabMode — verdict gating (G2/R1/R2)", () => {
  it("a DELIVERING agent with a legacy `recommend` verdict grant stays OFF", () => {
    // main's seed gave the developer report-validation-verdict:recommend — a
    // decorative no-op there. It must NOT coerce to `direct` here (that would
    // arm verdict-veto on the builder against live pre-branch data — R1/R2).
    const grants = [grant("report-validation-verdict", "recommend")];
    expect(effectiveCollabMode(grants, "report-validation-verdict", true)).toBe("off");
    expect(resolveAgentCollab(grants, true).verdict).toBe(false);
  });

  it("a SUPPORTING agent with no verdict grant defaults ON (pre-branch reviewer)", () => {
    expect(effectiveCollabMode([], "report-validation-verdict", false)).toBe("direct");
    expect(resolveAgentCollab([], false).verdict).toBe(true);
  });

  it("a DELIVERING agent with no verdict grant stays OFF", () => {
    expect(effectiveCollabMode([], "report-validation-verdict", true)).toBe("off");
    expect(resolveAgentCollab([], true).verdict).toBe(false);
  });

  it("an EXPLICIT direct grant arms verdict even on a delivering agent", () => {
    const grants = [grant("report-validation-verdict", "direct")];
    expect(effectiveCollabMode(grants, "report-validation-verdict", true)).toBe("direct");
    expect(resolveAgentCollab(grants, true).verdict).toBe(true);
  });

  it("an EXPLICIT human/off grant disables verdict even on a supporting agent", () => {
    expect(
      effectiveCollabMode([grant("report-validation-verdict", "off")], "report-validation-verdict", false),
    ).toBe("off");
    expect(
      effectiveCollabMode([grant("report-validation-verdict", "human")], "report-validation-verdict", false),
    ).toBe("human");
  });
});

describe("parseAgentOutcomeJson — Codex envelope transport", () => {
  it("parses a bare envelope with verdict + summary", () => {
    const o = parseAgentOutcomeJson('{"summary":"Looks good.","verdict":"approve"}');
    expect(o).toEqual({ summary: "Looks good.", verdict: "approve" });
  });

  it("strips a ```json fence", () => {
    const o = parseAgentOutcomeJson('```json\n{"summary":"ok","verdict":"request_changes"}\n```');
    expect(o?.verdict).toBe("request_changes");
  });

  it("returns null for plain prose (not an envelope)", () => {
    expect(parseAgentOutcomeJson("The tests all pass, approving.")).toBeNull();
  });

  it("keeps a question with capped options", () => {
    const o = parseAgentOutcomeJson(
      JSON.stringify({
        summary: "Blocked.",
        question: {
          title: "Which DB?",
          options: [{ title: "Postgres" }, { title: "SQLite" }, { title: "a" }, { title: "b" }, { title: "c" }],
        },
      }),
    );
    expect(o?.question?.title).toBe("Which DB?");
    expect(o?.question?.options?.length).toBe(4);
  });
});
