/** Shared capability catalog with honest runtime-enforcement metadata. */

export interface CapabilityDef {
  id: string;
  label: string;
}

/** Which profile kinds a capability applies to. "agent" = every non-operator
 * profile (generic-agents plan G1: reviewer is no longer a kind). */
export type CapabilityKind = "operator" | "agent";

/** `group: null` is matrix-only; non-promotable capabilities never become direct. */
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
  // P11-29: this gates EXTRA mid-run commentary (the Claude `post_comment`
  // tool), NOT whether the agent can reply — its final report always posts on
  // both backends via the completion pipeline. Labelled precisely so withholding
  // it doesn't read as "silences the agent".
  cap("comment-on-task", "Post mid-run comments", ["agent"], "Collaboration"),
  cap("ask-human", "Ask the human a question", ["agent"], "Collaboration"),
  // P13-LV-18 (owner ruling): network egress used to be invisible — EVERY run,
  // including a "read-only" reviewer with all repository capabilities Off, could
  // WebFetch/WebSearch arbitrary URLs. It is now a real capability: granted by
  // default (nothing regresses), visible in the matrix, and revocable per
  // profile. Enforced with tool denial on Claude; prompt-level on Codex, whose
  // built-in web tools have no denylist channel.
  cap("use-web-search-fetch", "Search & fetch from the web", ["agent", "operator"], "Collaboration"),
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

/**
 * The explicit default grant list for a profile of `kind` — every capability
 * the catalog offers that kind, at its documented default mode.
 *
 * P13-AP-06: `capabilities: []` does NOT mean "no powers" — the tool policy
 * treats an unspecified capability as GRANTED, so a profile persisted with an
 * empty list silently carried full repo-write authority. Every creation path
 * persists explicit grants instead.
 */
export function defaultGrantsFor(
  kind: CapabilityKind,
): { capabilityId: string; mode: UnifiedCapabilityDef["defaultMode"] }[] {
  return UNIFIED_CAP_CATALOG.filter((c) => c.kinds.includes(kind)).map((c) => ({
    capabilityId: c.id,
    mode: c.defaultMode,
  }));
}

/**
 * The starting grants for a profile created in a surface that CANNOT set
 * capability policy — today the org-level template editor, which has no
 * capability UI because policy is a per-project decision (the two-layer model).
 *
 * P13: `defaultGrantsFor("agent")` grants all four delivery capabilities at
 * `direct`, so a template described as "writes documentation, never touches app
 * code" was created — and adopted into projects — holding full repo-write. It
 * was visible rather than silent (an improvement on `capabilities: []`), but a
 * dangerous default is still a dangerous default. Delivery starts WITHHELD; the
 * project-level editor, which does have the capability matrix, opens it up.
 */
export function conservativeGrantsFor(
  kind: CapabilityKind,
): { capabilityId: string; mode: UnifiedCapabilityDef["defaultMode"] }[] {
  const withheld = new Set<string>([
    "execute-code-or-write-repo",
    ...SCOPED_DELIVERY_CAPABILITY_IDS,
  ]);
  return defaultGrantsFor(kind).map((g) =>
    withheld.has(g.capabilityId) ? { ...g, mode: "off" as const } : g,
  );
}

/** Flat id+label view — the shape most consumers key on. */
export const CAP_CATALOG: readonly CapabilityDef[] = UNIFIED_CAP_CATALOG.map(
  ({ id, label }) => ({ id, label }),
);
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

/** Capabilities whose absence actually constrains runtime behavior. */
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

/** Specialist tool-denial capabilities enforced by Claude but advisory on Codex. */
export const CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  "create-task-branch",
  "commit-push-branch",
  "open-review-pr",
  "execute-code-or-write-repo",
  // The mid-run post_comment tool is mounted only on Claude (Codex has no
  // in-process comment channel at all — its final reply always posts), so
  // withholding comment-on-task binds on Claude and is advisory on Codex.
  "comment-on-task",
  // Web egress: real tool denial on Claude (WebFetch/WebSearch removed);
  // prompt-level only on Codex, which has no per-tool denylist.
  "use-web-search-fetch",
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

/** Specialists have no recommend mode; coerce it to the equivalent direct mode. */
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

/** Keep the delivery headline enabled whenever any scoped delivery grant is active. */
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
