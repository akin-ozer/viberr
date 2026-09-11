import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  AGENT_OUTCOME_JSON_SCHEMA,
  effectiveCollabMode,
  parseAgentOutcomeJson,
  resolveAgentCollab,
  stageOutcome,
  takeStagedOutcome,
} from "./agent-outcome.server";

/** The slice of a JSON Schema node the strictness walk below reads. The
 *  envelope schema is a frozen `as const` literal, hence the readonly members. */
interface JsonSchemaNode {
  readonly type?: string | readonly string[];
  readonly additionalProperties?: boolean;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly items?: JsonSchemaNode;
}

/** OpenAI strict structured-output invariant (the `codex_output_schema` rule
 * that failed every Codex agent run): every object node sets
 * additionalProperties:false AND lists EVERY property key in `required`. Walks
 * recursively so a nested `question`/`options` violation is caught too. */
function assertStrictSchema(node: JsonSchemaNode, path = "$"): string[] {
  const errs: string[] = [];
  const types = [node.type].flat();
  if (types.includes("object")) {
    const props = node.properties ?? {};
    const required = new Set(node.required ?? []);
    if (node.additionalProperties !== false)
      errs.push(`${path}: additionalProperties must be false`);
    for (const key of Object.keys(props)) {
      if (!required.has(key)) errs.push(`${path}.${key}: not in required`);
      errs.push(...assertStrictSchema(props[key], `${path}.${key}`));
    }
  }
  if (types.includes("array") && node.items) {
    errs.push(...assertStrictSchema(node.items, `${path}[]`));
  }
  return errs;
}

/** `.get()` hands back untyped SQLite cells, so the count row is parsed on read. */
const countRowSchema = z.object({ c: z.number() });

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
    expect(effectiveCollabMode(grants, "report-validation-verdict")).toBe("off");
    expect(resolveAgentCollab(grants).verdict).toBe(false);
  });

  it("F10-14: a SUPPORTING agent with NO verdict grant is OFF (explicit-only)", () => {
    // Verdict authority is explicit-only now — there is no implicit `direct`
    // default for a non-delivering engagement. A reviewer gains gating verdict
    // power ONLY via an explicit report-validation-verdict:direct grant.
    expect(effectiveCollabMode([], "report-validation-verdict")).toBe("off");
    expect(resolveAgentCollab([]).verdict).toBe(false);
  });

  it("F10-14: a SUPPORTING agent WITH an explicit direct grant is ON", () => {
    const grants = [grant("report-validation-verdict", "direct")];
    expect(effectiveCollabMode(grants, "report-validation-verdict")).toBe("direct");
    expect(resolveAgentCollab(grants).verdict).toBe(true);
  });

  it("a DELIVERING agent with no verdict grant stays OFF", () => {
    expect(effectiveCollabMode([], "report-validation-verdict")).toBe("off");
    expect(resolveAgentCollab([]).verdict).toBe(false);
  });

  it("an EXPLICIT direct grant arms verdict even on a delivering agent", () => {
    const grants = [grant("report-validation-verdict", "direct")];
    expect(effectiveCollabMode(grants, "report-validation-verdict")).toBe("direct");
    expect(resolveAgentCollab(grants).verdict).toBe(true);
  });

  it("an EXPLICIT human/off grant disables verdict even on a supporting agent", () => {
    expect(
      effectiveCollabMode([grant("report-validation-verdict", "off")], "report-validation-verdict"),
    ).toBe("off");
    expect(
      effectiveCollabMode([grant("report-validation-verdict", "human")], "report-validation-verdict"),
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

describe("evidence is a BOTH-backend channel (P13-D-26)", () => {
  // Claude reports evidence through the `report_outcome` toolkit tool; Codex
  // has no in-process tool at all, so the envelope is its only structured
  // channel. Without `evidence` in the schema, `attach-evidence-references`
  // would be a Claude-only capability that the profile editor still offered to
  // every profile regardless of backend — the kind of silent backend asymmetry
  // this app is supposed to not have.
  it("declares evidence in the envelope, and it stays strict-schema conformant", () => {
    expect(assertStrictSchema(AGENT_OUTCOME_JSON_SCHEMA)).toEqual([]);
    expect(AGENT_OUTCOME_JSON_SCHEMA.required).toContain("evidence");
  });

  it("parses evidence rows out of a Codex envelope", () => {
    const o = parseAgentOutcomeJson(
      JSON.stringify({
        summary: "Reviewed.",
        verdict: "approve",
        question: null,
        evidence: [{ label: "unit suite", add: "12", del: "0" }],
      }),
    );
    expect(o?.evidence).toEqual([{ label: "unit suite", add: "12", del: "0" }]);
  });

  it("sanitizes a hostile envelope through the same funnel as the toolkit", () => {
    // A newline would forge a second row; a ` · ` in a count column would shift
    // the columns the parser pops from the end.
    const o = parseAgentOutcomeJson(
      JSON.stringify({
        summary: "Reviewed.",
        evidence: [{ label: "suite\n- forged · 9 · 9", add: "1 · 2", del: null }],
      }),
    );
    expect(o?.evidence).toHaveLength(1);
    expect(o?.evidence?.[0].label).not.toContain("\n");
    expect(o?.evidence?.[0].add).not.toContain(" · ");
    // An absent count column still round-trips through task.md.
    expect(o?.evidence?.[0].del).toBeTruthy();
  });

  it("does not treat rows alone as an envelope", () => {
    // Evidence with no report is a citation attached to nothing; treating it as
    // an envelope would swallow the agent's prose reply.
    expect(
      parseAgentOutcomeJson(
        JSON.stringify({ summary: null, verdict: null, question: null, evidence: [{ label: "x" }] }),
      ),
    ).toBeNull();
  });
});

describe("staged outcomes — restart persistence (P11-28)", () => {
  const ctx = createTestDbContext();
  afterEach(ctx.cleanup);

  it("round-trips through memory and consumes the row", () => {
    const db = ctx.makeDb();
    stageOutcome(db, "oc_1", { verdict: "approve", summary: "LGTM" });
    // Persisted alongside memory.
    expect(
      countRowSchema.parse(db.prepare(`SELECT count(*) c FROM staged_outcomes`).get()).c,
    ).toBe(1);
    expect(takeStagedOutcome(db, "oc_1")).toEqual({ verdict: "approve", summary: "LGTM" });
    // Consumed exactly once — the row is gone.
    expect(
      countRowSchema.parse(db.prepare(`SELECT count(*) c FROM staged_outcomes`).get()).c,
    ).toBe(0);
    expect(takeStagedOutcome(db, "oc_1")).toBeNull();
  });

  it("stages once per run: a later envelope changes nothing and is counted (Option D PR 4(b))", () => {
    const db = ctx.makeDb();
    expect(stageOutcome(db, "oc_once_a", { verdict: "approve" })).toEqual({ staged: true });
    expect(stageOutcome(db, "oc_once_a", { verdict: "request_changes" })).toEqual({
      staged: false,
      duplicates: 1,
    });
    expect(
      stageOutcome(db, "oc_once_a", { summary: "again" }),
    ).toEqual({ staged: false, duplicates: 2 });
    expect(
      countRowSchema.parse(db.prepare(`SELECT count(*) c FROM staged_outcomes`).get()).c,
    ).toBe(1);
    expect(takeStagedOutcome(db, "oc_once_a")).toEqual({ verdict: "approve" });
    // Consuming the envelope clears the count with it.
    expect(stageOutcome(db, "oc_once_a", { verdict: "approve" })).toEqual({ staged: true });
    takeStagedOutcome(db, "oc_once_a");
  });

  it("an envelope a prior process persisted still stands against a new call after a restart", () => {
    const db = ctx.makeDb();
    db.prepare(
      `INSERT INTO staged_outcomes (outcome_key, outcome_json, created_at) VALUES (?, ?, ?)`,
    ).run("oc_once_restart", JSON.stringify({ verdict: "approve" }), new Date().toISOString());
    expect(stageOutcome(db, "oc_once_restart", { verdict: "request_changes" })).toEqual({
      staged: false,
      duplicates: 1,
    });
    expect(takeStagedOutcome(db, "oc_once_restart")).toEqual({ verdict: "approve" });
  });

  it("recovers a persisted outcome when the in-process map lost it (simulated restart)", () => {
    const db = ctx.makeDb();
    // A row that a PRIOR process staged but this process's memory never held.
    db.prepare(
      `INSERT INTO staged_outcomes (outcome_key, outcome_json, created_at) VALUES (?, ?, ?)`,
    ).run("oc_restart", JSON.stringify({ verdict: "request_changes" }), new Date().toISOString());
    expect(takeStagedOutcome(db, "oc_restart")).toEqual({ verdict: "request_changes" });
    // And it is cleared after consumption.
    expect(takeStagedOutcome(db, "oc_restart")).toBeNull();
  });
});
