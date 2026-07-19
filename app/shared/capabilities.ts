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

/** Which profile kinds a capability applies to. "agent" = every non-operator
 * profile (generic-agents plan G1: reviewer is no longer a kind). */
export type CapabilityKind = "operator" | "agent";

/**
 * Unified catalog entry (generic-agents plan, 2026-07-19): ONE catalog drives
 * the profile editors for BOTH kinds — the former CAP_MODAL_CATALOG /
 * OPERATOR_CAP_CATALOG split is now derived per-kind from `kinds` + `group`.
 *
 * `group: null` → not a toggle in any editor; the capability only surfaces
 * read-only in the capability matrix's "Other actions" group (the pass-4
 * ruling-7 "no fake toggles" stance for ids with no runtime consumer).
 *
 * `promotable: false` → autonomy promotion may NEVER escalate this capability
 * to `direct` (absorbs the former `completion-for-acceptance` string
 * special-case in operator gate()).
 */
export interface UnifiedCapabilityDef {
  id: string;
  label: string;
  kinds: readonly CapabilityKind[];
  /** Editor accordion group for the kinds above; null → matrix-only. */
  group: string | null;
  /** Mode seeded when a profile of an applicable kind is created. */
  defaultMode: "direct" | "recommend" | "human" | "off";
  promotable: boolean;
}

const cap = (
  id: string,
  label: string,
  kinds: readonly CapabilityKind[],
  group: string | null,
  defaultMode: UnifiedCapabilityDef["defaultMode"] = "direct",
  promotable = true,
): UnifiedCapabilityDef => ({ id, label, kinds, group, defaultMode, promotable });

export const UNIFIED_CAP_CATALOG: readonly UnifiedCapabilityDef[] = [
  // Operator coordination (operator editor toggles)
  cap("assign-primary-specialist", "Assign the primary specialist", ["operator"], "Assignment"),
  cap("summon-reviewers", "Summon reviewer specialists", ["operator"], "Assignment"),
  cap("generate-packets", "Generate decision & blocking packets", ["operator"], "Coordination"),
  cap("append-typed-events", "Append typed important events", ["operator"], "Coordination"),
  cap("stage-transitions", "Stage transitions", ["operator"], "Permissions", "recommend"),
  // Never autonomy-promoted to direct: acceptance stays human even under
  // `full` autonomy (formerly a string special-case in operator gate()).
  cap("completion-for-acceptance", "Completion for human acceptance", ["operator"], "Permissions", "recommend", false),
  // Agent repository/execution toggles (bind via the Claude tool denylist)
  cap("execute-code-or-write-repo", "Execute code or write to the repo", ["agent"], "Repository & execution"),
  cap("create-task-branch", "Create the task-key branch", ["agent"], "Repository & execution"),
  cap("commit-push-branch", "Commit & push to the branch", ["agent"], "Repository & execution"),
  cap("open-review-pr", "Open the review pull request", ["agent"], "Repository & execution"),
  // Agent collaboration toggles (generic-agents G3/G4: gate the agent toolkit —
  // post_comment / ask_human / report_outcome — wired in the pipeline phase).
  cap("comment-on-task", "Comment on the task", ["agent"], "Collaboration"),
  cap("ask-human", "Ask the human a question", ["agent"], "Collaboration"),
  // Verdicts gate acceptance (G2) — default OFF so a casually-created profile
  // never acquires acceptance-veto power; the seed grants it to the reviewer.
  cap("report-validation-verdict", "Report a validation verdict", ["agent"], "Collaboration", "off"),
  // Advisory persona guidance (no runtime consumer — matrix-only, no toggle)
  cap("run-unit-integration-validation", "Run unit & integration validation", ["agent"], null),
  cap("move-task-to-review", "Move the task to Review", ["agent"], null),
  cap("read-repo-diff", "Read the repository & diff", ["agent"], null),
  cap("run-validation-suites", "Run validation suites", ["agent"], null),
  cap("post-quality-flags", "Post quality-flag events", ["agent"], null),
  cap("approve-review", "Approve the review", ["agent"], null),
  cap("request-changes", "Request changes", ["agent"], null),
  cap("author-test-cases", "Author test cases", ["agent"], null),
  cap("attach-evidence-references", "Attach evidence references", ["agent"], null),
  cap("read-task-repo", "Read the task & repository", ["agent"], null),
  cap("flag-underspecified-tasks", "Flag underspecified tasks", ["agent"], null),
  // Always-human governed actions (structural locks, shown to agents)
  cap("merge-pull-request", "Merge a pull request", ["agent"], "Reserved for humans", "human", false),
  cap("transition-to-done", "Transition a task to Done", ["agent"], "Reserved for humans", "human", false),
  cap("change-project-policy", "Change project policy", ["agent"], "Reserved for humans", "human", false),
] as const;

/** Flat id+label view — the shape most consumers key on. */
export const CAP_CATALOG: readonly CapabilityDef[] = UNIFIED_CAP_CATALOG.map(
  ({ id, label }) => ({ id, label }),
);
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

const ALWAYS_HUMAN = new Set<string>(ALWAYS_HUMAN_CAPABILITY_IDS);

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
  // Generic-agent collaboration gates (real, both-backend enforcement): the
  // completion pipeline gates verdict-recording + the ask-human question packet
  // on these grants server-side, so withholding binds on Claude AND Codex.
  "report-validation-verdict",
  "ask-human",
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
 * These ids are Claude-enforced / Codex-advisory (a specialist tool denylist).
 * NOTE: `merge-pull-request` is deliberately NOT here — it is an ALWAYS_HUMAN
 * structural capability (never grantable to an agent in an actionable mode), so
 * its restriction holds on BOTH backends. Labeling it "advisory on Codex" would
 * understate the single most safety-critical row; it classifies as "both".
 */
export const CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  "create-task-branch",
  "commit-push-branch",
  "open-review-pr",
  "execute-code-or-write-repo",
  // The mid-run post_comment tool is mounted only on Claude (Codex has no
  // in-process comment channel at all — its final reply always posts), so
  // withholding comment-on-task binds on Claude and is advisory on Codex.
  "comment-on-task",
]);

export type EnforcementScope = "both" | "claude-only" | "advisory";

/** How withholding `id` actually confines an agent at runtime. */
export function capabilityEnforcement(id: string): EnforcementScope {
  // Structural always-human caps enforce on BOTH backends (an agent never holds
  // them in an actionable mode) — check them BEFORE the claude-only set so a cap
  // that is both (e.g. merge-pull-request) is never mislabeled "advisory on Codex".
  if (ALWAYS_HUMAN.has(id)) return "both";
  if (CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS.has(id)) return "claude-only";
  if (ENFORCED_CAPABILITY_IDS.has(id)) return "both";
  return "advisory";
}

/** True when withholding `id` genuinely confines the agent at runtime (not just
 *  advisory persona guidance). */
export function capabilityIsEnforced(id: string): boolean {
  return ENFORCED_CAPABILITY_IDS.has(id);
}

/**
 * R7-5 — specialist capability modes collapse to 3 HONEST values.
 *
 * `recommend` (propose a card a human applies) is an OPERATOR-only concept: at
 * runtime a specialist holding a cap in `recommend` mode simply performs the
 * action (identical to `direct`) — the specialist tool/prompt contract has no
 * "recommend" behavior (`isWithheld` in specialist-tool-policy.ts denies only
 * `human`/`off`; F7-CAP1 live proof: a Docs Writer with open-review-pr=recommend
 * opened the PR directly). So the specialist picker offers only Allowed
 * (`direct`) / Human-only (`human`) / Off (`off`), and any stored `recommend`
 * grant on a specialist coerces to `direct` ('Allowed') on read AND on persist —
 * no data migration needed. The OPERATOR keeps all 4 modes, where `recommend`
 * has real semantics. Generic over the mode-string type so both the modal's
 * `CapMode` and the schema's `CapabilityMode` pass through unchanged. */
export function coerceSpecialistCapabilityMode<M extends string>(mode: M): M {
  return (mode === "recommend" ? "direct" : mode) as M;
}

/** The fine-grained delivery capabilities that the headline
 * `execute-code-or-write-repo` gates in
 * `specialist-tool-policy.resolveDeliveryPermissions`. */
export const SCOPED_DELIVERY_CAPABILITY_IDS: readonly string[] = [
  "create-task-branch",
  "commit-push-branch",
  "open-review-pr",
];

/**
 * Repair a contradictory deliverer capability policy. `execute-code-or-write-repo`
 * is the MASTER GATE for all delivery — with it withheld (off/human/absent) the
 * fine-grained branch/commit/PR grants are vetoed and the profile silently
 * delivers nothing (the VIB-1 "no commits, no PR" class). Owner ruling
 * (2026-07-19): the headline stays the master switch, so whenever any scoped
 * delivery capability is actionable (direct/recommend) we also grant the headline
 * `direct`, so a deliverer actually delivers. Applied at grant-persist (create /
 * edit) and by the seed. Idempotent, and a no-op for non-deliverers (e.g. the
 * reviewer, whose scoped delivery caps are off/human). Generic over the
 * mode-string type so both the modal's `CapMode` and the schema's
 * `CapabilityMode` pass through unchanged. */
export function normalizeDeliveryGrants<
  G extends { capabilityId: string; mode: string },
>(grants: readonly G[]): G[] {
  const actionable = (m: string | undefined) =>
    m === "direct" || m === "recommend";
  const byCapId = new Map(grants.map((g) => [g.capabilityId, g.mode]));
  const deliversScoped = SCOPED_DELIVERY_CAPABILITY_IDS.some((id) =>
    actionable(byCapId.get(id)),
  );
  const headline = byCapId.get("execute-code-or-write-repo");
  // Repair ONLY the accidental contradiction — headline ABSENT or `off` (the
  // default an editor materialized, which produced VIB-1). An explicit `human`
  // is a DELIBERATE human-gate ("repo writes are human-only") and is respected,
  // not silently flipped to direct.
  if (
    !deliversScoped ||
    actionable(headline) ||
    headline === "human"
  ) {
    return grants.map((g) => ({ ...g }));
  }
  let found = false;
  const out = grants.map((g) => {
    if (g.capabilityId === "execute-code-or-write-repo") {
      found = true;
      return { ...g, mode: "direct" } as G;
    }
    return { ...g };
  });
  if (!found) {
    out.push({ capabilityId: "execute-code-or-write-repo", mode: "direct" } as G);
  }
  return out;
}

export function capabilityById(id: string): CapabilityDef | null {
  return byId.get(id) ?? null;
}

/** Exact-label lookup (used by the seed to normalize mock action strings). */
export function capabilityByLabel(label: string): CapabilityDef | null {
  return byLabel.get(label) ?? null;
}
