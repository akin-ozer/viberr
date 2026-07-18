import type { FileActorRef } from "~/schemas/task-file.schema";

/**
 * Actor-reference codec for the file store (contracts §3.1).
 *
 *   human    →  user:u_ab12cd34ef (Arda Kaya)     name snapshot optional
 *   agent    →  agent:codex/developer             backend "/" role-slug
 *   operator →  operator
 *   system   →  system:policy-engine
 *
 * The userId is the identity (ruling 6); the parenthesized display name is a
 * human-readability snapshot used as fallback when the user row is gone.
 */

const HUMAN_RE = /^user:(\S+)(?:\s+\((.+)\))?$/;
// The role slug is whatever roleToSlug emits: a whitespace-collapsed lowercase
// string that CAN legitimately contain punctuation (the `reviewer` profile's
// role is "Review & validation" → "review-&-validation"). Decode must accept
// the whole slug up to end-of-ref — a strict `[A-Za-z][\w-]*` rejected the `&`,
// so decodeActorRef returned null and the timeline parser SKIPPED (dropped) the
// event. A reviewer's reply comment vanished on every re-parse (VIB-12): its
// serialized `agent:claude/review-&-validation` header failed to decode, so the
// next read-modify-write's base — and the projected timeline — lost it. The
// slug never contains the ` · ` field separator (whitespace is collapsed to
// `-`), so matching to `$` is unambiguous.
const AGENT_RE = /^agent:(codex|claude)\/(.+)$/;
const SYSTEM_RE = /^system:([A-Za-z][\w-]*)$/;

export function roleToSlug(role: string): string {
  // Never empty — an empty slug would serialize to `agent:codex/` and fail to
  // decode (the event would then be dropped as an unrecognized actor).
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

export function encodeActorRef(ref: FileActorRef): string {
  switch (ref.kind) {
    case "human":
      return ref.nameHint
        ? `user:${ref.userId} (${ref.nameHint})`
        : `user:${ref.userId}`;
    case "agent":
      return `agent:${ref.backend}/${roleToSlug(ref.role)}`;
    case "operator":
      return "operator";
    case "system":
      return `system:${ref.systemId}`;
  }
}

/** Returns null for unrecognized refs (caller records a diagnostic). */
export function decodeActorRef(raw: string): FileActorRef | null {
  const text = raw.trim();
  if (text === "operator") return { kind: "operator" };

  const human = HUMAN_RE.exec(text);
  if (human) {
    return { kind: "human", userId: human[1]!, nameHint: human[2] ?? null };
  }

  const agent = AGENT_RE.exec(text);
  if (agent) {
    return {
      kind: "agent",
      backend: agent[1] as "codex" | "claude",
      role: slugToRole(agent[2]!),
    };
  }

  const system = SYSTEM_RE.exec(text);
  if (system) return { kind: "system", systemId: system[1]! };

  return null;
}

/** Backend → display name (mock contract: Codex / Claude Code). */
export function agentBackendName(backend: "codex" | "claude"): string {
  return backend === "codex" ? "Codex" : "Claude Code";
}
