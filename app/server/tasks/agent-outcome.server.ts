import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { UNIFIED_CAP_CATALOG } from "~/shared/capabilities";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
import {
  normalizeEvidenceRows,
  type EvidenceRow,
  type FileActorRef,
  type PacketOption,
  type TaskPacket,
} from "~/schemas/task-file.schema";
import { encodeActorRef } from "~/server/files/actor-ref.server";
import { newId } from "~/shared/ids/new-id.server";

/**
 * The uniform agent OUTCOME ENVELOPE (generic-agents G4): one structured shape
 * every agent can emit, one server-side handler, two transports —
 *
 *   Claude → the in-process `report_outcome` toolkit tool stages the envelope
 *            mid-run (agent-toolkit.server.ts);
 *   Codex  → the run's `outputSchema` constrains the FINAL reply to this JSON
 *            (the codex SDK has no tool-deny/MCP-credential channel — same
 *            pattern as the operator's plan schema).
 *
 * The completion pipeline (task-actions applyAgentCompletionEffects) resolves
 * ONE envelope per finished run — staged tool call first, then a parsed Codex
 * reply — and applies it atomically with the agent's reply comment. A
 * verdict-GRANTED agent that emitted no envelope verdict falls back to the
 * prose classifier (G4: envelope + fallback; R1: the regex never runs on an
 * agent without the grant).
 */

/** One answer choice on an agent's question. */
export interface AgentOutcomeChoice {
  title: string;
  detail?: string;
}

export interface AgentOutcomeQuestion {
  title: string;
  body?: string;
  /** 2-4 answer choices; the packet renders them as `custom` options. */
  options?: AgentOutcomeChoice[];
}

export interface AgentOutcome {
  /** The prose report — becomes the agent's reply comment for envelope runs. */
  summary?: string;
  verdict?: "approve" | "request_changes";
  question?: AgentOutcomeQuestion;
  /** P13-D-26: evidence REFERENCES the agent attached (FR21/FR17) — recorded as
   *  the `evidence:` rows on the outcome event. Gated on the profile's
   *  `attach-evidence-references` grant at the tool layer; already normalized
   *  (`normalizeEvidenceRows`) before it is staged. */
  evidence?: EvidenceRow[];
}

/**
 * JSON schema for the Codex `outputSchema` transport. MUST satisfy OpenAI's
 * STRICT structured-output rules (the same ones OPERATOR_PLAN_SCHEMA follows,
 * enforced by `codex_output_schema`): EVERY property appears in `required`, and
 * optional fields are expressed as NULLABLE types (`["string","null"]`,
 * `enum:[…, null]`) — never by omission. Getting this wrong makes the API
 * reject the request with `invalid_json_schema`, which failed every Codex agent
 * run that mounted the envelope (verdict/ask-capable). The tolerant parser
 * (`parseAgentOutcomeJson`) already treats null/absent fields as "not present".
 */
export const AGENT_OUTCOME_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "verdict", "question", "evidence"],
  properties: {
    // P13-D-26: Codex's channel for evidence references. The Claude side gets
    // this through the `report_outcome` toolkit tool, which Codex has no
    // equivalent of — leaving it out of the envelope would have made
    // "attach-evidence-references" a Claude-only capability while the profile
    // editor offered it to every profile regardless of backend. The completion
    // pipeline already reads `outcome.evidence` for both backends and gates it
    // on the same grant, so this is the whole gap.
    evidence: {
      type: ["array", "null"],
      description:
        "ONLY when your role is to cite evidence: short REFERENCES to what you checked (a suite name, a file, a check) with two count columns. Never raw output — that lives in the run logs. null otherwise.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "add", "del"],
        properties: {
          label: { type: "string" },
          add: { type: ["string", "null"] },
          del: { type: ["string", "null"] },
        },
      },
    },
    summary: {
      type: "string",
      description:
        "Your report back to the task timeline: what you did/found, in markdown prose.",
    },
    verdict: {
      type: ["string", "null"],
      enum: ["approve", "request_changes", null],
      description:
        "ONLY when your role is to judge the work: approve, or request_changes. null otherwise.",
    },
    question: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["title", "body", "options"],
      description:
        "ONLY when you are blocked on a decision a human must make. null otherwise.",
      properties: {
        title: { type: "string" },
        body: { type: ["string", "null"] },
        options: {
          type: ["array", "null"],
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "detail"],
            properties: {
              title: { type: "string" },
              detail: { type: ["string", "null"] },
            },
          },
        },
      },
    },
  },
} as const;

/** Text a reader would treat as absent. The envelope's prose fields are kept
 *  VERBATIM (the timeline renders them as written), so the blankness test is a
 *  refinement rather than a `.trim()` transform. */
const envelopeProse = z.string().refine((s) => s.trim().length > 0);

/**
 * The envelope AS IT ARRIVES from Codex, before it becomes an `AgentOutcome`.
 *
 * Every field carries its own `.catch`, and every list its own per-member one:
 * the reply is model-written, so a garbled `question` must cost us the question
 * and nothing else — never the `summary` that came with it. The schema decides
 * only what is PRESENT and well-formed; the caller below decides what an
 * envelope means.
 */
const codexEnvelopeSchema = z.object({
  summary: envelopeProse.optional().catch(undefined),
  verdict: z.enum(["approve", "request_changes"]).optional().catch(undefined),
  question: z
    .object({
      title: envelopeProse,
      body: envelopeProse.optional().catch(undefined),
      options: z
        .array(
          z
            .object({
              title: z.string().min(1),
              detail: z.string().optional().catch(undefined),
            })
            .nullable()
            .catch(null),
        )
        .transform((opts) => opts.filter((opt) => opt !== null))
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
  // The row fields stay `unknown` on purpose: `normalizeEvidenceRows` is the
  // sanitizer, and it flattens whatever it is handed (a number count, a null
  // column) rather than dropping the row. All the schema owes it is a list of
  // row-shaped members.
  evidence: z
    .array(
      z
        .object({
          label: z.unknown().optional(),
          add: z.unknown().optional(),
          del: z.unknown().optional(),
        })
        .nullable()
        .catch(null),
    )
    .transform((rows) => rows.filter((row) => row !== null))
    .optional()
    .catch(undefined),
});

/**
 * Tolerant parse of a Codex envelope reply. The reply SHOULD be bare JSON
 * (outputSchema-constrained) but models occasionally fence it; strip one fence
 * before parsing. Returns null when the text is not an envelope — the caller
 * then treats the whole text as a prose reply.
 */
export function parseAgentOutcomeJson(text: string): AgentOutcome | null {
  const trimmed = text.trim();
  const unfenced =
    /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)?.[1] ?? trimmed;
  if (!unfenced.startsWith("{")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(unfenced);
  } catch {
    return null;
  }
  const parsed = codexEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return null;
  const envelope = parsed.data;
  const outcome: AgentOutcome = {};
  if (envelope.summary !== undefined) outcome.summary = envelope.summary;
  if (envelope.verdict !== undefined) outcome.verdict = envelope.verdict;
  if (envelope.question !== undefined) {
    const question: AgentOutcomeQuestion = {
      title: envelope.question.title.trim(),
    };
    if (envelope.question.body !== undefined) {
      question.body = envelope.question.body;
    }
    if (envelope.question.options !== undefined) {
      question.options = envelope.question.options
        .slice(0, 4)
        .map((opt) => {
          const choice: AgentOutcomeChoice = { title: opt.title };
          if (opt.detail !== undefined) choice.detail = opt.detail;
          return choice;
        });
    }
    outcome.question = question;
  }
  // P13-D-26: the Codex half of the evidence channel. Sanitized through the
  // same funnel the toolkit uses, so a hostile envelope cannot forge rows.
  if (envelope.evidence !== undefined) {
    const rows = normalizeEvidenceRows(envelope.evidence);
    if (rows) outcome.evidence = rows;
  }
  // An envelope with NOTHING usable is not an envelope. Evidence alone does not
  // qualify — rows with no report are a citation attached to nothing, and
  // treating them as an envelope would swallow the agent's prose reply.
  if (!outcome.summary && !outcome.verdict && !outcome.question) return null;
  return outcome;
}

// ------------------------------------------------------- staged outcomes

/**
 * Staging for envelopes reported mid-run via the Claude toolkit's
 * `report_outcome` tool, keyed by the run's outcomeKey (generated at dispatch,
 * closed into the toolkit, threaded to the completion input). Backed by BOTH an
 * in-process map (fast path) AND the `staged_outcomes` table (P11-28), so a
 * restart between the run finishing and its completion callback firing no longer
 * loses the structured verdict/question — boot recovery reads the persisted row
 * instead of falling back to the prose regex.
 */
const staged = new Map<string, AgentOutcome>();
const STAGED_MAX = 500;

/** Orphan prune horizon: a staged outcome whose run never completed. */
const STAGED_TTL_MS = 24 * 60 * 60 * 1000;

/** The persisted staging row (`stageOutcome` writes it, one column). */
const stagedRowSchema = z.object({ outcome_json: z.string() });

/**
 * `outcome_json` re-read as a domain outcome. This is our OWN writer's JSON, so
 * the schema mirrors {@link AgentOutcome} exactly — it is here so a truncated
 * or hand-edited row degrades to "nothing was staged" (the prose fallback) in
 * place of a half-decoded envelope carrying a forged verdict.
 */
const stagedOutcomeSchema = z.object({
  summary: z.string().optional(),
  verdict: z.enum(["approve", "request_changes"]).optional(),
  question: z
    .object({
      title: z.string(),
      body: z.string().optional(),
      options: z
        .array(z.object({ title: z.string(), detail: z.string().optional() }))
        .optional(),
    })
    .optional(),
  evidence: z
    .array(z.object({ label: z.string(), add: z.string(), del: z.string() }))
    .optional(),
});

export function stageOutcome(
  db: DatabaseSync,
  outcomeKey: string,
  outcome: AgentOutcome,
): void {
  if (staged.size >= STAGED_MAX && !staged.has(outcomeKey)) {
    const oldest = staged.keys().next().value;
    if (oldest !== undefined) staged.delete(oldest);
  }
  // Last write wins within a run — an agent revising its verdict mid-run is
  // reporting a newer judgment.
  staged.delete(outcomeKey);
  staged.set(outcomeKey, outcome);
  try {
    db.prepare(
      `INSERT INTO staged_outcomes (outcome_key, outcome_json, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(outcome_key) DO UPDATE SET
         outcome_json = excluded.outcome_json, created_at = excluded.created_at`,
    ).run(outcomeKey, JSON.stringify(outcome), new Date().toISOString());
    // Cheap orphan prune (runs that staged but never completed).
    db.prepare(`DELETE FROM staged_outcomes WHERE created_at < ?`).run(
      new Date(Date.now() - STAGED_TTL_MS).toISOString(),
    );
  } catch {
    // Persistence is best-effort — the in-process map still serves the common
    // (no-restart) path; a DB failure must never break a live run.
  }
}

export function takeStagedOutcome(
  db: DatabaseSync,
  outcomeKey: string,
): AgentOutcome | null {
  const inMemory = staged.get(outcomeKey);
  staged.delete(outcomeKey);
  // Always clear the persisted row too (it is consumed exactly once).
  let persisted: AgentOutcome | null = null;
  try {
    if (!inMemory) {
      const row = stagedRowSchema.safeParse(
        db
          .prepare(`SELECT outcome_json FROM staged_outcomes WHERE outcome_key = ?`)
          .get(outcomeKey),
      );
      if (row.success) {
        persisted = stagedOutcomeSchema.parse(JSON.parse(row.data.outcome_json));
      }
    }
    db.prepare(`DELETE FROM staged_outcomes WHERE outcome_key = ?`).run(outcomeKey);
  } catch {
    // Fall back to whatever the in-process map held.
  }
  return inMemory ?? persisted;
}

// ------------------------------------------------- capability resolution

const CATALOG_DEFAULTS = new Map(
  UNIFIED_CAP_CATALOG.map((c) => [c.id, c.defaultMode]),
);

/** The collaboration gates resolved for one engagement. */
export interface AgentCollab {
  /** May post mid-run comments (comment-on-task). */
  comment: boolean;
  /** May open ask-human question packets (ask-human). */
  ask: boolean;
  /** Verdicts recorded + validation gated (report-validation-verdict, G2). */
  verdict: boolean;
  /** P13-D-26: may attach evidence REFERENCES to its outcome
   *  (attach-evidence-references). Was a matrix-only capability with no runtime
   *  consumer; it now declares the `evidence` field on `report_outcome`. */
  evidence: boolean;
  /** F4: may read the task's own repo/PR data from the GitHub API through the
   *  in-process `github_read` tool (read-github-api). Claude-only — the tool is
   *  never mounted on Codex, so this gate is always false for a Codex run. */
  githubRead: boolean;
}

/**
 * Effective mode for a collaboration capability on one engagement.
 *
 * Explicit grant → its mode (specialist `recommend` coerces to `direct`,
 * R7-5). ABSENT grant → the catalog default.
 *
 * F10-14: verdict authority is EXPLICIT-ONLY. There is NO implicit rule that
 * gives a supporting engagement `report-validation-verdict: direct` by default
 * — a supporting agent gains acceptance-gating veto only when its profile
 * carries an explicit `direct` grant. Previously a non-delivering engagement
 * with no grant defaulted to `direct`, so any generic "supporting" assignment
 * silently held a gating verdict the profile/picker never disclosed. Now the
 * catalog default (`off`) applies, and the required-reviewer set is exactly the
 * engagements whose profile explicitly grants the verdict.
 */
export function effectiveCollabMode(
  grants: readonly CapabilityGrant[],
  capabilityId: string,
): "direct" | "human" | "off" {
  const grant = grants.find((g) => g.capabilityId === capabilityId);
  // An EXPLICIT direct/human/off grant is authoritative. `recommend` is NOT:
  // it is an operator-only mode with no agent runtime meaning, and on
  // pre-generic-agents data it was a DECORATIVE grant that did nothing (main's
  // seed gave the DELIVERING developer `report-validation-verdict: recommend`).
  // The R7-5 coercion (recommend → direct) would silently ARM verdict-veto
  // power on that delivering developer against live data — the exact R1/R2
  // hazard. So a `recommend` grant falls through to the default, same as absent.
  if (grant && grant.mode !== "recommend") {
    return grant.mode === "direct"
      ? "direct"
      : grant.mode === "human"
        ? "human"
        : "off";
  }
  const def = CATALOG_DEFAULTS.get(capabilityId) ?? "off";
  return def === "direct" ? "direct" : "off";
}

/** Resolve all three collaboration gates for one engagement. Grants alone
 *  decide (P11-31: the old `delivers` arg was vestigial — dead since F10-14
 *  removed the supporting-defaults-to-verdict rule). */
export function resolveAgentCollab(
  grants: readonly CapabilityGrant[],
): AgentCollab {
  return {
    comment: effectiveCollabMode(grants, "comment-on-task") === "direct",
    ask: effectiveCollabMode(grants, "ask-human") === "direct",
    verdict:
      effectiveCollabMode(grants, "report-validation-verdict") === "direct",
    evidence:
      effectiveCollabMode(grants, "attach-evidence-references") === "direct",
    githubRead:
      effectiveCollabMode(grants, "read-github-api") === "direct",
  };
}

// --------------------------------------------------- question packet shape

/** The agent-question decision packet (ask-human, G3): type `input`, from =
 * the agent's own ref, choices as resolvable `custom` options. Shared by the
 * live Claude toolkit and the completion-time Codex envelope path. */
export function buildAgentQuestionPacket(
  actorRef: FileActorRef,
  question: AgentOutcomeQuestion,
): TaskPacket {
  const choices = (question.options ?? []).slice(0, 4);
  const options: PacketOption[] = choices.length
    ? choices.map((o, i) => ({
        kind: "custom" as const,
        t: o.title.trim() || `Option ${i + 1}`,
        d: (o.detail ?? "").trim(),
        rec: i === 0,
      }))
    : [
        {
          kind: "custom" as const,
          t: "Answer the question",
          d: "Reply with your decision — the operator picks it up on its next turn.",
          rec: true,
        },
      ];
  const packet: TaskPacket = {
    id: newId("pkt"), // F10-09: stable identity for concurrent-resolution safety
    type: "input",
    kind: "Agent question",
    from: encodeActorRef(actorRef),
    title: question.title.trim(),
    body: (question.body ?? "").trim(),
    observations: [],
    options,
  };
  // R15-14: `from` is a DISPLAY string. The answer has to be routed back to a
  // specific agent, and parsing a rendered label to decide who gets resumed is
  // the kind of thing that works until someone renames a profile. Stamp the
  // profile id the router actually needs. Absent by design on operator packets:
  // anything without it simply falls back to the operator hand-off.
  if (actorRef.kind === "agent") packet.askedBy = actorRef.profileId;
  return packet;
}
