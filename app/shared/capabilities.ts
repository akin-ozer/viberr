/**
 * CAP_CATALOG — the shared, id-based agent capability catalog
 * (orchestrator ruling 2 / contracts §7 #7).
 *
 * Agent capability policy is stored as `{ capabilityId, mode }` against this
 * catalog; bespoke labels that have no catalog entry ride along as
 * display-only `extras` (`{ label, mode }`). Known near-misses deliberately
 * kept as extras pending product sign-off:
 *   - Tester   "Run the validation suite"   (catalog: "Run validation suites")
 *   - Reviewer "Push commits to the branch" (catalog: "Commit & push to the branch")
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
  { id: "compress-timelines", label: "Compress long-running timelines" },
  { id: "stage-transitions", label: "Stage transitions" },
  { id: "completion-for-acceptance", label: "Completion for human acceptance" },
  { id: "owner-reassignment", label: "Owner re-assignment" },
  { id: "execute-code-or-write-repo", label: "Execute code or write to the repo" },
  // Delivery
  { id: "create-task-branch", label: "Create the task-key branch" },
  { id: "commit-push-branch", label: "Commit & push to the branch" },
  { id: "run-unit-integration-validation", label: "Run unit & integration validation" },
  { id: "open-review-pr", label: "Open the review pull request" },
  { id: "move-task-to-review", label: "Move the task to Review" },
  { id: "report-validation-verdict", label: "Report a validation verdict" },
  { id: "edit-other-task-branch", label: "Edit another task's branch" },
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
  { id: "validation-verdict", label: "Validation verdict" },
  { id: "hold-on-failing-checks", label: "Hold the task on failing checks" },
  // Advisory
  { id: "read-task-repo", label: "Read the task & repository" },
  { id: "comment-with-guidance", label: "Comment with guidance" },
  { id: "flag-underspecified-tasks", label: "Flag underspecified tasks" },
  { id: "write-to-repository", label: "Write to the repository" },
  { id: "open-or-merge-pr", label: "Open or merge a PR" },
  { id: "any-stage-transition", label: "Any stage transition" },
  // Always-human governed actions
  { id: "merge-pull-request", label: "Merge a pull request" },
  { id: "transition-to-done", label: "Transition a task to Done" },
  { id: "change-project-policy", label: "Change project policy" },
] as const;

/** Server-side invariant: these capabilities are human-only, always —
 * merge PR · transition to done · change project policy. */
export const ALWAYS_HUMAN_CAPABILITY_IDS: readonly string[] = [
  "merge-pull-request",
  "transition-to-done",
  "change-project-policy",
];

const byId = new Map(CAP_CATALOG.map((c) => [c.id, c]));
const byLabel = new Map(CAP_CATALOG.map((c) => [c.label, c]));

export function capabilityById(id: string): CapabilityDef | null {
  return byId.get(id) ?? null;
}

/** Exact-label lookup (used by the seed to normalize mock action strings). */
export function capabilityByLabel(label: string): CapabilityDef | null {
  return byLabel.get(label) ?? null;
}
