import type { FileActorRef } from "~/schemas/task-file.schema";

/**
 * Actor-reference codec for the file store (contracts §3.1).
 *
 *   human    →  user:u_ab12cd34ef (Arda Kaya)      name snapshot optional
 *   agent    →  agent:codex/reviewer (Review & validation)
 *   operator →  operator
 *   system   →  system:policy-engine
 *
 * The userId / profileId is the identity (ruling 6 + generic-agents D7); the
 * parenthesized display snapshot is a human-readability fallback used when
 * the user row / profile is gone.
 *
 * AGENT REFS (D7): keyed by PROFILE ID, never by role string. The previous
 * `agent:<backend>/<role-slug>` form derived identity from prose — VIB-12:
 * the reviewer role "Review & validation" slugged to `review-&-validation`,
 * a strict `[A-Za-z][\w-]*` decoder rejected the `&`, decode returned null,
 * and the timeline parser silently DROPPED the reviewer's comment on every
 * re-parse. Legacy refs still decode (the slug becomes the profileId, role
 * hint null); `slugToRole` renders them exactly as before.
 *
 * DECODE NEVER RETURNS NULL: an unrecognized ref decodes to
 * `{ kind: "unknown", raw }` which re-encodes verbatim — a malformed or
 * future-format author can never cost an event again.
 */

const HUMAN_RE = /^user:(\S+)(?:\s+\((.+)\))?$/;
// profileId = one non-whitespace token after the backend; the optional
// parenthesized suffix is the role display snapshot. The token never contains
// the ` · ` heading separator (encode sanitizes), so matching is unambiguous.
const AGENT_RE = /^agent:(codex|claude)\/(\S+)(?:\s+\((.+)\))?$/;
const SYSTEM_RE = /^system:([A-Za-z][\w-]*)$/;

/** Slug-sanitize an id/role for the ref token: whitespace → `-`, never empty. */
function roleToSlug(role: string): string {
  return role.trim().toLowerCase().replace(/\s+/g, "-") || "agent";
}

export function slugToRole(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word, i) => (i === 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/** Display name for a system actor id: "policy-engine" → "Policy engine". */
export function systemIdToName(systemId: string): string {
  const words = systemId.split("-").filter(Boolean).join(" ");
  return words ? words[0]!.toUpperCase() + words.slice(1) : "System";
}

/** Display role for an agent ref: the stored snapshot, else the un-slugged
 * profileId (which renders LEGACY role-slug refs exactly as they always did:
 * `review-&-validation` → "Review & validation"). */
export function agentRoleDisplay(ref: {
  profileId: string;
  roleHint: string | null;
}): string {
  return ref.roleHint ?? slugToRole(ref.profileId);
}

/** A display hint must never contain a newline or the ` · ` heading separator
 * (either would corrupt the event heading it is embedded in). */
function sanitizeHint(hint: string): string {
  return hint.replace(/\s*·\s*/g, " - ").replace(/\s*\n\s*/g, " ").trim();
}

export function encodeActorRef(ref: FileActorRef): string {
  switch (ref.kind) {
    case "human":
      return ref.nameHint
        ? `user:${ref.userId} (${sanitizeHint(ref.nameHint)})`
        : `user:${ref.userId}`;
    case "agent": {
      const id = roleToSlug(ref.profileId);
      return ref.roleHint
        ? `agent:${ref.backend}/${id} (${sanitizeHint(ref.roleHint)})`
        : `agent:${ref.backend}/${id}`;
    }
    case "operator":
      return "operator";
    case "controller":
      return "controller";
    case "system":
      return `system:${ref.systemId}`;
    case "unknown":
      return ref.raw;
  }
}

/** Total: every input decodes; unrecognized refs become `unknown` (verbatim
 * round-trip) rather than null — the parser never drops an event over its
 * author again. */
export function decodeActorRef(raw: string): FileActorRef {
  const text = raw.trim();
  if (text === "operator") return { kind: "operator" };
  // Ruling 99: the instance controller, encoded like the operator's bare word.
  if (text === "controller") return { kind: "controller" };

  const human = HUMAN_RE.exec(text);
  if (human) {
    return { kind: "human", userId: human[1]!, nameHint: human[2] ?? null };
  }

  const agent = AGENT_RE.exec(text);
  if (agent) {
    return {
      kind: "agent",
      // The backend group is a two-way alternation, so this comparison is
      // total — the ref never reached here with a third backend.
      backend: agent[1] === "codex" ? "codex" : "claude",
      profileId: agent[2]!,
      roleHint: agent[3] ?? null,
    };
  }

  const system = SYSTEM_RE.exec(text);
  if (system) return { kind: "system", systemId: system[1]! };

  return { kind: "unknown", raw: text };
}
