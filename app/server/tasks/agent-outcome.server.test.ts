import { describe, expect, it } from "vitest";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
import {
  AGENT_OUTCOME_JSON_SCHEMA,
  effectiveCollabMode,
  parseAgentOutcomeJson,
  resolveAgentCollab,
} from "./agent-outcome.server";

/** OpenAI strict structured-output invariant (the `codex_output_schema` rule
 * that failed every Codex agent run): every object node sets
 * additionalProperties:false AND lists EVERY property key in `required`. Walks
 * recursively so a nested `question`/`options` violation is caught too. */
function assertStrictSchema(node: unknown, path = "$"): string[] {
  const errs: string[] = [];
  if (!node || typeof node !== "object") return errs;
  const n = node as Record<string, unknown>;
  const types = Array.isArray(n.type) ? n.type : [n.type];
  if (types.includes("object")) {
    const props = (n.properties ?? {}) as Record<string, unknown>;
    const required = new Set((n.required as string[]) ?? []);
    if (n.additionalProperties !== false) errs.push(`${path}: additionalProperties must be false`);
    for (const key of Object.keys(props)) {
      if (!required.has(key)) errs.push(`${path}.${key}: not in required`);
      errs.push(...assertStrictSchema(props[key], `${path}.${key}`));
    }
  }
  if (types.includes("array") && n.items) {
    errs.push(...assertStrictSchema(n.items, `${path}[]`));
  }
  return errs;
}

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

  it("F10-14: a SUPPORTING agent with NO verdict grant is OFF (explicit-only)", () => {
    // Verdict authority is explicit-only now — there is no implicit `direct`
    // default for a non-delivering engagement. A reviewer gains gating verdict
    // power ONLY via an explicit report-validation-verdict:direct grant.
    expect(effectiveCollabMode([], "report-validation-verdict", false)).toBe("off");
    expect(resolveAgentCollab([], false).verdict).toBe(false);
  });

  it("F10-14: a SUPPORTING agent WITH an explicit direct grant is ON", () => {
    const grants = [grant("report-validation-verdict", "direct")];
    expect(effectiveCollabMode(grants, "report-validation-verdict", false)).toBe("direct");
    expect(resolveAgentCollab(grants, false).verdict).toBe(true);
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

describe("AGENT_OUTCOME_JSON_SCHEMA — Codex strict structured-output conformance", () => {
  it("every property is required + additionalProperties:false (recursively)", () => {
    // Regression: the envelope shipped with optional properties omitted from
    // `required`, so OpenAI rejected it (invalid_json_schema) and EVERY
    // verdict/ask-capable Codex agent run failed.
    expect(assertStrictSchema(AGENT_OUTCOME_JSON_SCHEMA)).toEqual([]);
  });

  it("optional fields are nullable, and the parser treats null as absent", () => {
    // A Codex reply that fills only summary (verdict/question null) parses to a
    // plain report with no verdict/question.
    const o = parseAgentOutcomeJson(
      JSON.stringify({ summary: "Done, no verdict needed.", verdict: null, question: null }),
    );
    expect(o).toEqual({ summary: "Done, no verdict needed." });
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
