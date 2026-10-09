import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
import { createTestDbContext } from "../../../test-support/test-db";
import { assertStrictSchema } from "../../../test-support/strict-schema";
import {
  AGENT_OUTCOME_JSON_SCHEMA,
  effectiveCollabMode,
  parseAgentOutcomeJson,
  resolveAgentCollab,
  stageOutcome,
  takeStagedOutcome,
} from "./agent-outcome.server";

/** `.get()` hands back untyped SQLite cells, so the count row is parsed on read. */
const countRowSchema = z.object({ c: z.number() });

const grant = (capabilityId: string, mode: CapabilityGrant["mode"]): CapabilityGrant => ({
  capabilityId,
  mode,
});

describe("effectiveCollabMode — verdict gating (G2/R1/R2)", () => {
  /**
   * Verdict authority is explicit-only (F10-14): there is no implicit `direct`
   * default for a non-delivering engagement, so a reviewer gains gating verdict
   * power ONLY via an explicit report-validation-verdict:direct grant. main's
   * seed gave the developer report-validation-verdict:recommend, a decorative
   * no-op there: it must NOT coerce to `direct` (that would arm verdict-veto on
   * the builder against live pre-branch data, R1/R2).
   */
  it.each([
    { held: "a legacy `recommend` grant (R1/R2)", grants: [grant("report-validation-verdict", "recommend")], mode: "off", verdict: false },
    { held: "no grant (F10-14, explicit-only)", grants: [], mode: "off", verdict: false },
    { held: "an explicit direct grant (F10-14)", grants: [grant("report-validation-verdict", "direct")], mode: "direct", verdict: true },
    { held: "an explicit off grant", grants: [grant("report-validation-verdict", "off")], mode: "off", verdict: false },
    { held: "an explicit human grant", grants: [grant("report-validation-verdict", "human")], mode: "human", verdict: false },
  ])("$held reads $mode, and arms the verdict: $verdict", ({ grants, mode, verdict }) => {
    expect(effectiveCollabMode(grants, "report-validation-verdict")).toBe(mode);
    expect(resolveAgentCollab(grants).verdict).toBe(verdict);
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

  /**
   * Ruling 202 (pass 37, F37-133): this path keeps EVERY option. It used to
   * cut at four, silently, and this is the one path that cannot refuse: the
   * envelope is the agent's last word, parsed after the run has ended, so
   * there is nobody to hand a refusal to and nothing to retry. A cut here
   * deletes a choice the person was meant to have and leaves no trace that it
   * existed. The four belongs on `ask_human`, where an agent can be told.
   */
  it("keeps EVERY option a finished agent offered, because this path cannot ask for a shorter list", () => {
    const o = parseAgentOutcomeJson(
      JSON.stringify({
        summary: "Blocked.",
        question: {
          title: "Which DB?",
          options: [
            { title: "Postgres" },
            { title: "SQLite" },
            { title: "a" },
            { title: "b" },
            { title: "the fifth, which used to vanish" },
          ],
        },
      }),
    );
    expect(o?.question?.title).toBe("Which DB?");
    // CANARY: put `.slice(0, 4)` back.
    expect(o?.question?.options?.map((c) => c.title)).toEqual([
      "Postgres",
      "SQLite",
      "a",
      "b",
      "the fifth, which used to vanish",
    ]);
  });

  it("ruling 202: and the packet built from it offers all five, not the first four", async () => {
    const { buildAgentQuestionPacket } = await import("./agent-outcome.server");
    const packet = buildAgentQuestionPacket(
      { kind: "agent", backend: "claude", profileId: "ap_1", roleHint: "Dev" },
      {
        title: "Which DB?",
        options: [
          { title: "Postgres" },
          { title: "SQLite" },
          { title: "a" },
          { title: "b" },
          { title: "the fifth, which used to vanish" },
        ],
      },
    );
    // CANARY: `(question.options ?? []).slice(0, 4)` in the builder.
    expect(packet.options.map((o) => o.t)).toContain("the fifth, which used to vanish");
    expect(packet.options).toHaveLength(5);
    // Nothing was marked, so nothing is recommended (ruling 68); the cut
    // never decided that either.
    expect(packet.options.filter((o) => o.rec)).toHaveLength(0);
  });

  it("ruling 68 (F40-57): an unmarked list carries no recommendation, and a marked one carries exactly its mark", async () => {
    /**
     * WEB-5: the Content Writer asked two things only Akin could answer (may a
     * customer story be published, is an unattributed video his talk). Option
     * 1 wore "recommended" and was preselected, and the agent had to post a
     * comment saying the pick was not its recommendation.
     *
     * CANARY: `marked === -1 ? 0 : marked` in the builder.
     */
    const { buildAgentQuestionPacket } = await import("./agent-outcome.server");
    const agent = { kind: "agent", backend: "claude", profileId: "content-writer", roleHint: "Content Writer" } as const;
    const unmarked = buildAgentQuestionPacket(agent, {
      title: "May /talks list the AWS customer panel, and is the Vault meetup video your talk?",
      options: [{ title: "List the panel and link the video" }, { title: "Leave both out" }],
    });
    expect(unmarked.options.map((o) => o.rec)).toEqual([false, false]);
    const marked = buildAgentQuestionPacket(agent, {
      title: "Which heading?",
      options: [{ title: "Talks" }, { title: "Speaking (Recommended)" }],
    });
    expect(marked.options.map((o) => [o.t, o.rec])).toEqual([
      ["Talks", false],
      ["Speaking", true],
    ]);
  });

  it("ruling 68 (F40-31): a choice that needs a typed answer says so on the packet, and the no-choice fallback always does", async () => {
    /**
     * WEB-3: "Connected; the first build succeeded" asked, in its own detail,
     * for the Worker name and the workers.dev URL, and nothing on the packet
     * said the choice was empty without them.
     *
     * CANARY: drop `if (o.reply) option.reply = true;` in the builder, or the
     * fallback's `reply: true`.
     */
    const { buildAgentQuestionPacket } = await import("./agent-outcome.server");
    const agent = { kind: "agent", backend: "claude", profileId: "platform-engineer", roleHint: "Platform Engineer" } as const;
    const packet = buildAgentQuestionPacket(agent, {
      title: "Is Workers Builds connected?",
      options: [
        {
          title: "Connected; the first build succeeded",
          detail: "Reply with the Worker name and the workers.dev URL exactly as Cloudflare shows them.",
          reply: true,
        },
        { title: "Not yet" },
      ],
    });
    expect(packet.options.map((o) => o.reply)).toEqual([true, undefined]);
    const fallback = buildAgentQuestionPacket(agent, { title: "What is the Worker called?" });
    expect(fallback.options).toHaveLength(1);
    expect(fallback.options[0]).toMatchObject({ kind: "custom", rec: false, reply: true });
    // The answer goes back to the agent that asked, so the option no longer
    // says the operator picks it up.
    expect(fallback.options[0]!.d).not.toMatch(/operator/i);
  });

  it("ruling 68: the Codex envelope carries `reply`", () => {
    // CANARY: drop `if (opt.reply === true) choice.reply = true;` in the parser.
    const o = parseAgentOutcomeJson(
      JSON.stringify({
        summary: "Blocked on the Cloudflare side.",
        verdict: null,
        evidence: null,
        question: {
          title: "Is Workers Builds connected?",
          body: null,
          options: [
            { title: "Connected", detail: "Reply with the URL.", reply: true },
            { title: "Not yet", detail: null, reply: null },
          ],
        },
      }),
    );
    expect(o?.question?.options?.map((c) => c.reply)).toEqual([true, undefined]);
  });

  it("U39-23: an agent's '(Recommended)' mark leaves the title and decides the pill", async () => {
    /**
     * Four agent questions on the ax-clone board carried the mark in a title
     * ("Coordinate core status work (Recommended)"). The card showed it beside
     * its own `recommended` pill, and the answer, the summon note and the
     * decision record all repeated it ("**Decision:** Coordinate core status
     * work (Recommended).").
     *
     * CANARY: stop stripping the mark, or recommend the first option again.
     */
    const { buildAgentQuestionPacket } = await import("./agent-outcome.server");
    const agent = { kind: "agent", backend: "codex", profileId: "surface-developer", roleHint: "Surface Developer" } as const;
    const first = buildAgentQuestionPacket(agent, {
      title: "Resolve missing status data for AX-27",
      options: [
        { title: "Coordinate core status work (Recommended)", detail: "Have the core owner add it." },
        { title: "Narrow to existing status fields" },
      ],
    });
    expect(first.options.map((o) => [o.t, o.rec])).toEqual([
      ["Coordinate core status work", true],
      ["Narrow to existing status fields", false],
    ]);
    // A mark on a later option moves the pill to it, so the card never shows
    // the pill on one option and the agent's recommendation on another.
    const second = buildAgentQuestionPacket(agent, {
      title: "Which gate?",
      options: [{ title: "Skip the race gate" }, { title: "Rerun on a cgo host ( recommended )" }],
    });
    expect(second.options.map((o) => [o.t, o.rec])).toEqual([
      ["Skip the race gate", false],
      ["Rerun on a cgo host", true],
    ]);
  });
});

describe("evidence is a BOTH-backend channel (P13-D-26)", () => {
  // Claude reports evidence through the `report_outcome` toolkit tool; Codex
  // has no in-process tool at all, so the envelope is its only structured
  // channel. Without `evidence` in the schema, `attach-evidence-references`
  // would be a Claude-only capability that the profile editor still offered to
  // every profile regardless of backend — the kind of silent backend asymmetry
  // this app is supposed to not have.

  /**
   * Ruling 16: the timeline draws the rows as a checklist, so the strict
   * schema Codex answers under asks every row for its result and its mark.
   * CANARY: drop `status` from the item's `required` and a Codex run can
   * report rows the checklist cannot mark.
   */
  it("ruling 16: asks every row for how it came out and a pass, fail or info mark", () => {
    const item = AGENT_OUTCOME_JSON_SCHEMA.properties.evidence.items;
    expect(item.required).toEqual(["label", "result", "status"]);
    expect(item.properties.status.enum).toEqual(["pass", "fail", "info"]);
  });

  it("parses evidence rows out of a Codex envelope", () => {
    const o = parseAgentOutcomeJson(
      JSON.stringify({
        summary: "Reviewed.",
        verdict: "approve",
        question: null,
        evidence: [
          { label: "unit suite", result: "12 passed", status: "pass" },
          { label: "the rulings", result: null, status: "info" },
        ],
      }),
    );
    expect(o?.evidence).toEqual([
      { label: "unit suite", result: "12 passed", status: "pass" },
      { label: "the rulings", result: "", status: "info" },
    ]);
  });

  it("sanitizes a hostile envelope through the same funnel as the toolkit", () => {
    // A newline would forge a second row; a ` · ` in the result would move
    // the split the parser pops from the end; a mark the schema does not know
    // is no pass.
    const o = parseAgentOutcomeJson(
      JSON.stringify({
        summary: "Reviewed.",
        evidence: [{ label: "suite\n- forged · 9 · 9", result: "1 · 2", status: "passed" }],
      }),
    );
    expect(o?.evidence).toHaveLength(1);
    expect(o?.evidence?.[0].label).not.toContain("\n");
    expect(o?.evidence?.[0].result).not.toContain(" · ");
    expect(o?.evidence?.[0].status).toBe("info");
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

/**
 * Ruling 202 (F40-67): `relay` is the Codex envelope's channel onto another
 * task, as `report_outcome`'s field is Claude's. The envelope is the agent's
 * last word, so every entry is kept here and the cap is applied, with the rest
 * named, where the entries are posted.
 */
describe("relay is a BOTH-backend channel (ruling 202)", () => {
  const ctx = createTestDbContext();
  afterEach(ctx.cleanup);

  it("parses the envelope's relay entries", () => {
    // CANARY: drop the parser's copy onto the outcome.
    const o = parseAgentOutcomeJson(
      JSON.stringify({
        summary: "Read both cron runs.",
        verdict: null,
        question: null,
        evidence: null,
        relay: [
          { taskKey: " WEB-8 ", text: "CPU 5 ms and 6 ms of 10." },
          { taskKey: "WEB-3", text: "Second." },
          { taskKey: "WEB-4", text: "Third." },
          { taskKey: "", text: "No task." },
        ],
      }),
    );
    expect(o?.relay).toEqual([
      { taskKey: "WEB-8", text: "CPU 5 ms and 6 ms of 10." },
      { taskKey: "WEB-3", text: "Second." },
      { taskKey: "WEB-4", text: "Third." },
    ]);
  });

  it("ruling 71: an entry's files ride with it, and a garbled list costs the files, never the relay", () => {
    // CANARY: leave `files` out of the envelope's relay items (the strict
    // schema then refuses it) or out of the parser's copy.
    expect(AGENT_OUTCOME_JSON_SCHEMA.properties.relay.items.required).toContain("files");
    const o = parseAgentOutcomeJson(
      JSON.stringify({
        summary: "Designed four benchmark inventories.",
        verdict: null,
        question: null,
        evidence: null,
        relay: [
          { taskKey: "AWSC-4", text: "Your input.", files: ["sample-01-input.xlsx"] },
          { taskKey: "AWSC-5", text: "Your input.", files: "sample-02-input.csv" },
          { taskKey: "AWSC-6", text: "Text alone.", files: null },
        ],
      }),
    );
    expect(o?.relay).toEqual([
      { taskKey: "AWSC-4", text: "Your input.", files: ["sample-01-input.xlsx"] },
      { taskKey: "AWSC-5", text: "Your input." },
      { taskKey: "AWSC-6", text: "Text alone." },
    ]);
  });

  it("a staged relay survives a restart", () => {
    // CANARY: drop `relay` from the staged row's schema (it parses away).
    const db = ctx.makeDb();
    db.prepare(
      `INSERT INTO staged_outcomes (outcome_key, outcome_json, created_at) VALUES (?, ?, ?)`,
    ).run(
      "oc_relay_restart",
      JSON.stringify({ summary: "Done.", relay: [{ taskKey: "WEB-8", text: "Numbers." }] }),
      new Date().toISOString(),
    );
    expect(takeStagedOutcome(db, "oc_relay_restart")).toEqual({
      summary: "Done.",
      relay: [{ taskKey: "WEB-8", text: "Numbers." }],
    });
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
