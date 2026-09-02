import { DEFAULT_GUARDRAILS } from "./templates";

/**
 * E32-6 (pass 32, owner ruling): the anti-noise guardrails get an in-app
 * surface (Policy → Guardrails). The rows in project.md carry an `id` and a
 * `desc` sentence but no short name; these are the names the card, the toast
 * and the audit sentence share, so one row never reads three ways.
 */
const LABELS = new Map<string, string>([
  ["meaningful-comment", "Meaningful comments"],
  ["no-duplicate-summary", "No duplicate summaries"],
  ["compression-threshold", "Compression threshold"],
  ["evidence-separation", "Evidence separation"],
  // Managed on Settings → GitHub (R15-6); the Policy card shows it inert.
  ["delete-branch-after-merge", "Delete the task branch after merge"],
]);

export function guardrailLabel(id: string): string {
  return LABELS.get(id) ?? id;
}

/** The ids the runtime enforces (comment-guardrails.server.ts reads them). */
export const DEFAULT_GUARDRAIL_IDS: readonly string[] = DEFAULT_GUARDRAILS.map(
  (g) => g.id,
);

/** The branch-cleanup row lives in project.md's `guardrails` too but is owned
 *  by the GitHub settings card, so the Policy card never toggles it. */
export const GITHUB_MANAGED_GUARDRAIL_ID = "delete-branch-after-merge";

export type GuardrailKind = "default" | "github" | "unknown";

export function guardrailKind(id: string): GuardrailKind {
  if (DEFAULT_GUARDRAIL_IDS.includes(id)) return "default";
  if (id === GITHUB_MANAGED_GUARDRAIL_ID) return "github";
  return "unknown";
}
