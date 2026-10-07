import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { UNIFIED_CAP_CATALOG } from "~/shared/capabilities";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
import {
  EVIDENCE_STATUSES,
  normalizeEvidenceRows,
  type EvidenceRow,
  type FileActorRef,
  type PacketOption,
  type TaskPacket,
} from "~/schemas/task-file.schema";
import { encodeActorRef } from "~/server/files/actor-ref.server";
import { newId } from "~/shared/ids/new-id.server";
import { RELAY_MAX_ENTRIES, type RelayEntry } from "./task-relay.server";

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
 * The completion pipeline (agent-completion applyAgentCompletionEffects) resolves
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
  /** Ruling 478(e): choosing it needs the person's typed answer (a name, a
   *  URL, a value only they have), so the card asks for it and refuses the
   *  choice without it. */
  reply?: boolean;
}

/**
 * Ruling 478(e) (F40-57, F40-31): what an agent is told about marking its
 * pick and asking for a typed answer, on both transports (`ask_human`'s schema
 * and the Codex envelope's). An unmarked list carries no recommendation: the
 * first option used to be "presented as suggested" whether the agent had a
 * pick or not, and on WEB-5 a question only the owner could answer (may a
 * customer story be published, is a video his talk) showed option 1 as
 * "recommended" and one Confirm away.
 */
/**
 * Ruling 692(c): what a question to a person is for, in the words every asking
 * channel carries (the Claude tool, the Codex outcome field, the run's
 * collaboration notes). Live, a writer asked nine questions before drafting and
 * seven of them were its own choices to make (the reader, the length, the tone,
 * the call to action), each with a default the person was to approve.
 */
export const ASK_HUMAN_ONLY_NOTE =
  "Ask what only a person knows or may decide, and put all of it in one question. A choice " +
  "that is yours to make, make it and state it in your report as an assumption: never ask a " +
  "person to approve your own choices.";
export const ASK_HUMAN_RECOMMEND_NOTE =
  'End the title of the choice you recommend with "(Recommended)". Leave every title unmarked ' +
  "when you have no recommendation (a question only the human can answer): an unmarked list " +
  "carries none, and nothing is preselected.";
export const ASK_HUMAN_REPLY_NOTE =
  "true when choosing this option needs the human to type something back (a name, a URL, " +
  "a value only they have); the card then asks for that text and will not send the choice " +
  "without it.";

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
  /** Ruling 488: text to post on OTHER tasks of the same project, at most
   *  {@link RELAY_MAX_ENTRIES}. The completion pipeline posts each through
   *  the relay door with this agent as the author. Kept whole here: the cap
   *  is applied (and anything past it named) where the entries are posted. */
  relay?: RelayEntry[];
}

/**
 * Ruling 488 (F40-67): what an agent is told about `relay`, on both
 * transports (`report_outcome`'s schema and the Codex envelope's).
 */
export const RELAY_FIELD_NOTE =
  `Text to post on OTHER tasks in this project, at most ${RELAY_MAX_ENTRIES} entries: ` +
  "when your goal or directive says to post something on another task (results it depends on, " +
  "numbers it needs), put it here as {taskKey, text}. Viberr posts each on that task after you " +
  "finish, as your comment headed with this task's key, wakes that task's operator, and records " +
  "the relay on this task. Never write it to an attachment or a report for a person to copy there. " +
  "When that task needs a FILE you saved on this task (an input it works from, a file it is to judge), " +
  "name it in `files` (ruling 538): it lands on that task's attachments, where its agents read it. " +
  "Refused: a task in another project, this task, a missing or closed task, a file this task does not hold.";

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
  required: ["summary", "verdict", "question", "evidence", "relay"],
  properties: {
    // Ruling 488: Codex's channel for a relay, as `report_outcome` is Claude's.
    // The cap is stated, not declared: the completion pipeline posts the first
    // entries and names the rest, because an envelope is the agent's last word
    // and there is nobody left to refuse it to.
    relay: {
      type: ["array", "null"],
      description: `${RELAY_FIELD_NOTE} null otherwise.`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["taskKey", "text", "files"],
        properties: {
          taskKey: { type: "string" },
          text: { type: "string" },
          // Ruling 538: this task's attachments the relay carries; null for text alone.
          files: { type: ["array", "null"], items: { type: "string" } },
        },
      },
    },
    // P13-D-26: Codex's channel for evidence references. The Claude side gets
    // this through the `report_outcome` toolkit tool, which Codex has no
    // equivalent of — leaving it out of the envelope would have made
    // "attach-evidence-references" a Claude-only capability while the profile
    // editor offered it to every profile regardless of backend. The completion
    // pipeline already reads `outcome.evidence` for both backends and gates it
    // on the same grant, so this is the whole gap.
    // Ruling 526: what was checked, how it came out and whether it passed,
    // the fields `report_outcome` declares.
    evidence: {
      type: ["array", "null"],
      description:
        "ONLY when your role is to cite evidence: up to 8 short REFERENCES to what you checked (a suite, a file and line, a check, a source), each with how it came out and whether it passed. Never raw output; that lives in the run logs. null otherwise.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "result", "status"],
        properties: {
          label: { type: "string", description: "What you checked or cite, in a short phrase." },
          result: {
            type: ["string", "null"],
            description: "How it came out, in a few words ('102 passed, 0 failed'); null when the label says it all.",
          },
          status: {
            type: "string",
            enum: [...EVIDENCE_STATUSES],
            description:
              "pass for a check that passed, fail for a check that failed or a finding that blocks, info for a reference that is neither.",
          },
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
        `ONLY when you are blocked on a decision a human must make. ${ASK_HUMAN_ONLY_NOTE} null otherwise.`,
      properties: {
        title: { type: "string" },
        body: { type: ["string", "null"] },
        options: {
          type: ["array", "null"],
          // U39-23 / ruling 478(e): the same convention `ask_human` states to
          // a Claude agent.
          description: `2-4 concrete answer choices. ${ASK_HUMAN_RECOMMEND_NOTE}`,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "detail", "reply"],
            properties: {
              title: { type: "string" },
              detail: { type: ["string", "null"] },
              reply: {
                type: ["boolean", "null"],
                description: `${ASK_HUMAN_REPLY_NOTE} null otherwise.`,
              },
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
              reply: z.boolean().optional().catch(undefined),
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
          result: z.unknown().optional(),
          status: z.unknown().optional(),
        })
        .nullable()
        .catch(null),
    )
    .transform((rows) => rows.filter((row) => row !== null))
    .optional()
    .catch(undefined),
  // Ruling 488: a garbled entry costs that entry, never the report.
  relay: z
    .array(
      z
        .object({
          taskKey: envelopeProse,
          text: envelopeProse,
          // Ruling 538: a garbled list costs the files, never the relay.
          files: z.array(z.string()).nullable().optional().catch(null),
        })
        .nullable()
        .catch(null),
    )
    .transform((entries) => entries.filter((entry) => entry !== null))
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
      // Ruling 298: EVERY option the agent wrote. This used to cut at four,
      // silently, and this path has nobody to refuse to -- the envelope is the
      // agent's last word, parsed after the run is over, so a refusal here
      // costs the whole outcome and a cut destroys a choice the person was
      // meant to have. `ask_human` holds the four; this holds the truth.
      question.options = envelope.question.options.map((opt) => {
        const choice: AgentOutcomeChoice = { title: opt.title };
        if (opt.detail !== undefined) choice.detail = opt.detail;
        if (opt.reply === true) choice.reply = true;
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
  // Ruling 488: every entry the agent wrote; the cap is the poster's.
  if (envelope.relay !== undefined && envelope.relay.length > 0) {
    outcome.relay = envelope.relay.map((r) =>
      r.files?.length
        ? { taskKey: r.taskKey.trim(), text: r.text, files: r.files }
        : { taskKey: r.taskKey.trim(), text: r.text },
    );
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
/** Option D PR 4(b): per run, how many `report_outcome` calls were refused
 *  after the first staged. Bounded and consumed like `staged`. */
const duplicateCalls = new Map<string, number>();

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
    .array(z.object({ label: z.string(), result: z.string(), status: z.enum(EVIDENCE_STATUSES) }))
    .optional(),
  // Ruling 488: a restart between the run and its completion keeps the relay.
  relay: z
    .array(z.object({ taskKey: z.string(), text: z.string(), files: z.array(z.string()).optional() }))
    .optional(),
});

const runIdRowSchema = z.object({ id: z.string() });

/** The run an outcome key belongs to. `registerAgentCompletion` stamps the key
 *  on the run row as the run starts, so a mid-run tool call finds it; null
 *  before that, or when the lookup fails (an audit detail, never a gate). */
export function runIdForOutcomeKey(db: DatabaseSync, outcomeKey: string): string | null {
  try {
    const row = runIdRowSchema.safeParse(
      db.prepare(`SELECT id FROM agent_runs WHERE outcome_key = ?`).get(outcomeKey),
    );
    return row.success ? row.data.id : null;
  } catch {
    return null;
  }
}

/** What one `report_outcome` call did: staged the run's envelope, or found one
 *  already staged and changed nothing (the count is this run's refusals so far). */
export type StageOutcomeResult =
  | { staged: true }
  | { staged: false; duplicates: number };

/** An envelope is staged for this run, in memory or persisted by a process
 *  that restarted since. */
function alreadyStaged(db: DatabaseSync, outcomeKey: string): boolean {
  if (staged.has(outcomeKey)) return true;
  try {
    return stagedRowSchema.safeParse(
      db.prepare(`SELECT outcome_json FROM staged_outcomes WHERE outcome_key = ?`).get(outcomeKey),
    ).success;
  } catch {
    return false;
  }
}

/**
 * Stage a run's outcome ONCE (Option D PR 4(b)). `report_outcome` tells the
 * model to call it exactly once, and a second call used to replace the first
 * without a word, so whichever envelope came last became the run's verdict,
 * including one sent after the agent had moved on. The first envelope now
 * stands; a later call changes nothing and is counted, and the tool tells the
 * model so and audits it.
 */
export function stageOutcome(
  db: DatabaseSync,
  outcomeKey: string,
  outcome: AgentOutcome,
): StageOutcomeResult {
  if (alreadyStaged(db, outcomeKey)) {
    const duplicates = (duplicateCalls.get(outcomeKey) ?? 0) + 1;
    if (duplicateCalls.size >= STAGED_MAX && !duplicateCalls.has(outcomeKey)) {
      const oldest = duplicateCalls.keys().next().value;
      if (oldest !== undefined) duplicateCalls.delete(oldest);
    }
    duplicateCalls.set(outcomeKey, duplicates);
    return { staged: false, duplicates };
  }
  if (staged.size >= STAGED_MAX) {
    const oldest = staged.keys().next().value;
    if (oldest !== undefined) staged.delete(oldest);
  }
  staged.set(outcomeKey, outcome);
  try {
    db.prepare(
      `INSERT INTO staged_outcomes (outcome_key, outcome_json, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(outcome_key) DO NOTHING`,
    ).run(outcomeKey, JSON.stringify(outcome), new Date().toISOString());
    // Cheap orphan prune (runs that staged but never completed).
    db.prepare(`DELETE FROM staged_outcomes WHERE created_at < ?`).run(
      new Date(Date.now() - STAGED_TTL_MS).toISOString(),
    );
  } catch {
    // Persistence is best-effort — the in-process map still serves the common
    // (no-restart) path; a DB failure must never break a live run.
  }
  return { staged: true };
}

export function takeStagedOutcome(
  db: DatabaseSync,
  outcomeKey: string,
): AgentOutcome | null {
  const inMemory = staged.get(outcomeKey);
  staged.delete(outcomeKey);
  duplicateCalls.delete(outcomeKey);
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
 * Ruling 589: whether an engagement holds any collaboration grant. It is the
 * condition a Claude run's toolkit mounts `read_board` and `read_timeline_entry`
 * on, and a Codex run the gateway's board server: a profile with none reads no
 * more of the board than its own prompt holds (U11).
 */
export function holdsCollaborationGrant(collab: AgentCollab): boolean {
  return collab.comment || collab.ask || collab.verdict || collab.evidence || collab.githubRead;
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

/**
 * C9 (pass 31): the `kind` string every agent-question packet carries.
 *
 * `TaskPacket.kind` is free text (a display label), but THIS value is
 * load-bearing: packet resolution reads `packet.askedBy` and routes the human's
 * answer back to the asking agent only when the kind matches exactly
 * (`resolvePacket`, packet-resolution.server.ts). It was an untyped English literal
 * duplicated at the writer and the reader, so renaming the label here would
 * have silently re-routed every agent answer to the operator instead. Written
 * once, next to the writer that stamps it.
 */
export const AGENT_QUESTION_PACKET_KIND = "Agent question";

/** A trailing "(Recommended)" an agent writes on the option it recommends. */
const RECOMMENDED_MARK = /\s*\(\s*recommended\s*\)\s*$/i;

/**
 * Ruling 586: the entry that records a question when it is asked carries the
 * card itself: its body, its observations and its options, under `heading`.
 *
 * A packet leaves the task when it is answered. The entry for an agent's
 * question named only its title ("AWSC-22 Intake batch: accept the proposed
 * defaults, or change numbered items?"), the operator's only its title too,
 * and the decision records the option and the person's words, so the questions
 * themselves, twenty-five numbered items with their proposed defaults, were on
 * no record once answered. Live on AWSC-22 the Estimate Judge could not check
 * that each intake question asked one thing: "the card text, which is not on
 * the task". The entry is the asker's own, so the body stands as it wrote it.
 */
export function askedEntryText(
  heading: string,
  packet: Pick<TaskPacket, "body" | "observations" | "options">,
): string {
  const parts = [heading];
  const body = packet.body.trim();
  if (body) parts.push(body);
  if (packet.observations.length > 0) {
    parts.push(packet.observations.map((o) => `- **${o.k}:** ${o.code ? inlineCode(o.v) : o.v}`).join("\n"));
  }
  // One option is no choice: an agent that offered none gets "Answer the
  // question", which the entry does not need to say.
  if (packet.options.length > 1) {
    parts.push(`Options: ${packet.options.map((o) => (o.rec ? `${o.t} (recommended)` : o.t)).join(" · ")}`);
  }
  return parts.join("\n\n");
}

/** Inline code that holds its own backticks. */
function inlineCode(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const ticks = "`".repeat(longest + 1);
  return longest > 0 ? `${ticks} ${text} ${ticks}` : `${ticks}${text}${ticks}`;
}

/** The agent-question decision packet (ask-human, G3): type `input`, from =
 * the agent's own ref, choices as resolvable `custom` options. Shared by the
 * live Claude toolkit and the completion-time Codex envelope path. */
export function buildAgentQuestionPacket(
  actorRef: FileActorRef,
  question: AgentOutcomeQuestion,
): TaskPacket {
  // Ruling 298: no cut here either. The cap that belongs on an agent's live
  // question is declared on `ask_human`'s own schema, where exceeding it is
  // refused by name and the agent re-asks inside the same run.
  const choices = (question.options ?? []).map((o) => {
    const title = o.title.trim();
    const bare = title.replace(RECOMMENDED_MARK, "").trim();
    return { title: bare, detail: o.detail, marked: bare !== title, reply: o.reply === true };
  });
  // U39-23: agents mark their pick in the title ("Coordinate core status work
  // (Recommended)"), and the card already shows a `recommended` pill, so it
  // said so twice and carried the mark into the answer, the summon note and
  // the decision record. The mark says which option the agent recommends, so
  // it decides the pill. Ruling 478(e) (F40-57): with no mark there is no
  // pick. The first option used to get the pill regardless, and on WEB-5 the
  // agent had to post a comment disowning it.
  const recommended = choices.findIndex((c) => c.marked);
  const options: PacketOption[] = choices.length
    ? choices.map((o, i) => {
        const option: PacketOption = {
          kind: "custom" as const,
          t: o.title || `Option ${i + 1}`,
          d: (o.detail ?? "").trim(),
          rec: i === recommended,
        };
        if (o.reply) option.reply = true;
        return option;
      })
    : [
        // No choices: the answer IS the typed text, so it is required, and
        // nobody recommended anything. It goes back to the agent that asked
        // (the card's answer box says so by name); "the operator picks it up"
        // was not where it went (ruling 478(e), F40-31).
        {
          kind: "custom" as const,
          t: "Answer the question",
          d: "Write your answer in the box below.",
          rec: false,
          reply: true,
        },
      ];
  const packet: TaskPacket = {
    id: newId("pkt"), // F10-09: stable identity for concurrent-resolution safety
    type: "input",
    kind: AGENT_QUESTION_PACKET_KIND,
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
