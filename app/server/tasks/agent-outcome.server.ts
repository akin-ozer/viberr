import { UNIFIED_CAP_CATALOG } from "~/shared/capabilities";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
import type {
  FileActorRef,
  PacketOption,
  TaskPacket,
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

export interface AgentOutcomeQuestion {
  title: string;
  body?: string;
  /** 2-4 answer choices; the packet renders them as `custom` options. */
  options?: { title: string; detail?: string }[];
}

export interface AgentOutcome {
  /** The prose report — becomes the agent's reply comment for envelope runs. */
  summary?: string;
  verdict?: "approve" | "request_changes";
  question?: AgentOutcomeQuestion;
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
  required: ["summary", "verdict", "question"],
  properties: {
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
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const outcome: AgentOutcome = {};
  if (typeof o.summary === "string" && o.summary.trim()) {
    outcome.summary = o.summary;
  }
  if (o.verdict === "approve" || o.verdict === "request_changes") {
    outcome.verdict = o.verdict;
  }
  if (typeof o.question === "object" && o.question !== null) {
    const q = o.question as Record<string, unknown>;
    if (typeof q.title === "string" && q.title.trim()) {
      outcome.question = {
        title: q.title.trim(),
        ...(typeof q.body === "string" && q.body.trim()
          ? { body: q.body }
          : {}),
        ...(Array.isArray(q.options)
          ? {
              options: q.options
                .filter(
                  (opt): opt is Record<string, unknown> =>
                    typeof opt === "object" && opt !== null,
                )
                .filter((opt) => typeof opt.title === "string" && !!opt.title)
                .slice(0, 4)
                .map((opt) => ({
                  title: String(opt.title),
                  ...(typeof opt.detail === "string"
                    ? { detail: opt.detail }
                    : {}),
                })),
            }
          : {}),
      };
    }
  }
  // An envelope with NOTHING usable is not an envelope.
  if (!outcome.summary && !outcome.verdict && !outcome.question) return null;
  return outcome;
}

// ------------------------------------------------------- staged outcomes

/** In-process staging for envelopes reported mid-run via the Claude toolkit's
 * `report_outcome` tool, keyed by the run's outcomeKey (generated at dispatch,
 * closed into the toolkit, threaded to the completion input). Lost on restart
 * — boot recovery still gets Codex envelopes (re-parsed from the stored reply)
 * and the prose fallback for verdict-granted Claude runs. */
const staged = new Map<string, AgentOutcome>();
const STAGED_MAX = 500;

export function stageOutcome(outcomeKey: string, outcome: AgentOutcome): void {
  if (staged.size >= STAGED_MAX && !staged.has(outcomeKey)) {
    const oldest = staged.keys().next().value;
    if (oldest !== undefined) staged.delete(oldest);
  }
  // Last write wins within a run — an agent revising its verdict mid-run is
  // reporting a newer judgment.
  staged.delete(outcomeKey);
  staged.set(outcomeKey, outcome);
}

export function takeStagedOutcome(outcomeKey: string): AgentOutcome | null {
  const outcome = staged.get(outcomeKey) ?? null;
  staged.delete(outcomeKey);
  return outcome;
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
  _delivers: boolean,
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

/** Resolve all three collaboration gates for one engagement. */
export function resolveAgentCollab(
  grants: readonly CapabilityGrant[],
  delivers: boolean,
): AgentCollab {
  return {
    comment: effectiveCollabMode(grants, "comment-on-task", delivers) === "direct",
    ask: effectiveCollabMode(grants, "ask-human", delivers) === "direct",
    verdict:
      effectiveCollabMode(grants, "report-validation-verdict", delivers) ===
      "direct",
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
  return {
    id: newId("pkt"), // F10-09: stable identity for concurrent-resolution safety
    type: "input",
    kind: "Agent question",
    from: encodeActorRef(actorRef),
    title: question.title.trim(),
    body: (question.body ?? "").trim(),
    observations: [],
    options,
  };
}
