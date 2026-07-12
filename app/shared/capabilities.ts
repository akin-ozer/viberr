/**
 * CAP_CATALOG — the shared, id-based agent capability catalog
 * (orchestrator ruling 2 / contracts §7 #7).
 *
 * Agent capability policy is stored as `{ capabilityId, mode }` against this
 * catalog; bespoke labels that have no catalog entry ride along as
 * display-only `extras` (`{ label, mode }`).
 *
 * ENFORCED-vs-advisory (honesty): a subset of these ids bind at the runtime tool
 * layer for Claude specialists (`specialist-tool-policy.ts` — branch/push/PR/
 * merge + `execute-code-or-write-repo`) or gate the operator toolkit
 * (`operator-actions.ts`). The remainder are advisory guidance injected into the
 * run persona. `capabilityEnforcement` reports both/claude-only/advisory so the
 * UI can label the difference rather than overstating authority.
 *
 * ALWAYS_HUMAN_CAPABILITY_IDS is the server-side invariant list — these are
 * never grantable to an agent in an actionable mode. Enforced at grant-persist
 * time: `grantsFor` (agent-profile-actions.server.ts) coerces any of these ids
 * to `human` mode whatever the submitted form says. The Done boundary is
 * additionally locked at the workflow layer (policy-actions.server.ts) and the
 * operator completion path (operator-actions.server.ts).
 */

export interface CapabilityDef {
  id: string;
  label: string;
}

export const CAP_CATALOG: readonly CapabilityDef[] = [
  // Operator coordination
  { id: "assign-primary-specialist", label: "Assign the primary specialist" },
  { id: "summon-reviewers", label: "Summon reviewer specialists" },
  { id: "generate-packets", label: "Generate decision & blocking packets" },
  { id: "append-typed-events", label: "Append typed important events" },
  { id: "stage-transitions", label: "Stage transitions" },
  { id: "completion-for-acceptance", label: "Completion for human acceptance" },
  { id: "execute-code-or-write-repo", label: "Execute code or write to the repo" },
  // Delivery
  { id: "create-task-branch", label: "Create the task-key branch" },
  { id: "commit-push-branch", label: "Commit & push to the branch" },
  { id: "run-unit-integration-validation", label: "Run unit & integration validation" },
  { id: "open-review-pr", label: "Open the review pull request" },
  { id: "move-task-to-review", label: "Move the task to Review" },
  { id: "report-validation-verdict", label: "Report a validation verdict" },
  // Review
  { id: "read-repo-diff", label: "Read the repository & diff" },
  { id: "run-validation-suites", label: "Run validation suites" },
  { id: "post-quality-flags", label: "Post quality-flag events" },
  { id: "comment-on-task", label: "Comment on the task" },
  { id: "approve-review", label: "Approve the review" },
  { id: "request-changes", label: "Request changes" },
  // Validation
  { id: "author-test-cases", label: "Author test cases" },
  { id: "attach-evidence-references", label: "Attach evidence references" },
  // Shared specialist actions
  { id: "read-task-repo", label: "Read the task & repository" },
  { id: "flag-underspecified-tasks", label: "Flag underspecified tasks" },
  // Always-human governed actions
  { id: "merge-pull-request", label: "Merge a pull request" },
  { id: "transition-to-done", label: "Transition a task to Done" },
  { id: "change-project-policy", label: "Change project policy" },
] as const;
// Removed 2026-07-12 (role-bindings prune): `edit-other-task-branch` (its broad
// `git checkout:*` deny defeated the granted create-task-branch and is moot under
// per-task workspace isolation — F11), `open-or-merge-pr` (dead deny rule, never
// granted; redundant with open-review-pr + merge-pull-request),
// `compress-timelines` (compaction is guardrail-driven, never gated by a
// capability), and `owner-reassignment` (never consumed at runtime).

/** Server-side invariant: these capabilities are human-only, always —
 * merge PR · transition to done · change project policy. */
export const ALWAYS_HUMAN_CAPABILITY_IDS: readonly string[] = [
  "merge-pull-request",
  "transition-to-done",
  "change-project-policy",
];

const byId = new Map(CAP_CATALOG.map((c) => [c.id, c]));
const byLabel = new Map(CAP_CATALOG.map((c) => [c.label, c]));

/**
 * The capabilities that BIND at runtime (real enforcement), vs. the advisory
 * ones injected as persona guidance. Used by the capability matrix so it never
 * claims authority that doesn't actually confine an agent. Kept next to the
 * catalog so it's obvious which ids are enforced:
 *   - specialist tool policy: create-task-branch, commit-push-branch,
 *     open-review-pr, merge-pull-request, execute-code-or-write-repo
 *   - operator toolkit gate: assign-primary-specialist, summon-reviewers,
 *     generate-packets, append-typed-events, stage-transitions,
 *     completion-for-acceptance
 *   - structural human-only: merge-pull-request, transition-to-done,
 *     change-project-policy (also ALWAYS_HUMAN)
 */
export const ENFORCED_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  "create-task-branch",
  "commit-push-branch",
  "open-review-pr",
  "merge-pull-request",
  "execute-code-or-write-repo",
  "assign-primary-specialist",
  "summon-reviewers",
  "generate-packets",
  "append-typed-events",
  "stage-transitions",
  "completion-for-acceptance",
  "transition-to-done",
  "change-project-policy",
]);

/**
 * Backend-asymmetric enforcement (S3, honest labeling).
 *
 * The SPECIALIST tool-denial capabilities bind only on Claude runs
 * (`disallowedTools` under the Claude Agent SDK); the Codex SDK ignores tool
 * allow/deny lists, so on a Codex specialist these are advisory-only. The
 * OPERATOR-gate + structural-human capabilities, by contrast, enforce on both
 * backends because the operator's actions route through the same gated server
 * functions regardless of the operator's engine.
 *
 * These ids are Claude-enforced / Codex-advisory (a specialist tool denylist):
 */
export const CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  "create-task-branch",
  "commit-push-branch",
  "open-review-pr",
  "merge-pull-request",
  "execute-code-or-write-repo",
]);

export type EnforcementScope = "both" | "claude-only" | "advisory";

/** How withholding `id` actually confines an agent at runtime. */
export function capabilityEnforcement(id: string): EnforcementScope {
  if (CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS.has(id)) return "claude-only";
  if (ENFORCED_CAPABILITY_IDS.has(id)) return "both";
  return "advisory";
}

/** True when withholding `id` genuinely confines the agent at runtime (not just
 *  advisory persona guidance). */
export function capabilityIsEnforced(id: string): boolean {
  return ENFORCED_CAPABILITY_IDS.has(id);
}

export function capabilityById(id: string): CapabilityDef | null {
  return byId.get(id) ?? null;
}

/** Exact-label lookup (used by the seed to normalize mock action strings). */
export function capabilityByLabel(label: string): CapabilityDef | null {
  return byLabel.get(label) ?? null;
}
