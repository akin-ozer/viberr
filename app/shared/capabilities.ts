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
  //
  // F19-12 — the id/label split here is DELIBERATE, not an oversight.
  // "primary specialist" is retired vocabulary (D9/Q17-5, INTENT §6.5): the
  // model is `engagements[]` with one `delivers: true`, and the UI has said
  // "delivering agent" since (execution-profile.tsx's "Assign delivering
  // agent" / "Delivering agent" header). The LABEL is rendered — on the agents
  // page, the capability-matrix modal and the policy page — so it moved. The
  // ID is not rendered anywhere: it is the persisted key in every project.md
  // `capabilities[].capabilityId`, so renaming it would be a data migration,
  // and this pass forbids migrations. It stays `assign-primary-specialist`.
  //
  // NOTE for whoever changes this label next: `app/server/seed/agent-catalog.server.ts`
  // spells the seeded operator's grants as catalog LABELS and resolves them
  // through `capabilityByLabel`. A label that drifts from that literal does not
  // error — the grant silently degrades to a display-only `extra` with no
  // runtime authority. `agents-route.server.test.ts` pins the mapping.
  cap("assign-primary-specialist", "Assign the delivering agent", ["operator"], "Assignment"),
  cap("summon-reviewers", "Summon reviewer specialists", ["operator"], "Assignment"),
  cap("generate-packets", "Generate decision & blocking packets", ["operator"], "Coordination"),
  cap("append-typed-events", "Append typed important events", ["operator"], "Coordination"),
  cap("stage-transitions", "Stage transitions", ["operator"], "Permissions", "recommend"),
  // P13-D-PRD-3: `promotable: false` means raising a project's autonomy never
  // silently upgrades this to `direct` — an admin must grant it deliberately.
  // It does NOT mean acceptance is human-only: with an explicit `direct` grant
  // AND `full` autonomy the operator moves the task to Done itself
  // (`operatorAcceptCompletion`, the one deliberate exception to the
  // human-only-Done invariant, owner ruling Q1). The old comment here claimed
  // the opposite and the old label ("Completion for human acceptance") read as
  // a guarantee it does not make.
  cap("completion-for-acceptance", "Accept completion into Done", ["operator"], "Permissions", "recommend", false),
  // R15-2 (owner ruling 2026-07-28): delivery — push the task branch + open the
  // review PR — is an OPERATOR decision, not a fixed stage side-effect. The
  // server still executes the mechanics (performDelivery); agents never push.
  // An ABSENT grant means granted (the catalog default is direct), so operator
  // deployments persisted before this capability existed keep delivering — the
  // same polarity `use-web-search-fetch` uses.
  cap("deliver-review-pr", "Deliver the branch & open the review PR", ["operator"], "Permissions"),
  // N19-9 (owner ruling): bringing a task branch up to date with its base is an
  // OPERATOR decision, like delivery. The server executes the merge+push; agents
  // never rebase or force-push. An absent grant follows the DELIVERY gate
  // (updateBranchGate) — the capability postdates every deployment.
  cap("update-task-branch", "Bring the task branch up to date", ["operator"], "Permissions"),
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
  // profile. Enforced on BOTH backends: tool denial on Claude (WebFetch/
  // WebSearch removed), `webSearchMode: "disabled"` on Codex (P14-RT-06 — the
  // "prompt-level on Codex" fallback this comment used to claim never existed;
  // no prompt anywhere mentioned web egress). `curl`/`wget` through Bash stay
  // reachable on both, for the same reason shell writes do: the specialist needs
  // Bash to run validation.
  cap("use-web-search-fetch", "Search & fetch from the web", ["agent", "operator"], "Collaboration"),
  // R19-19 (owner ruling): a REAL browser — navigate, click, read the page,
  // screenshot — mounted as a viberr-owned Playwright MCP server, per run.
  // Default OFF for the same reason report-validation-verdict is: a casually
  // created profile must not silently acquire a driven browser (JS execution,
  // sessions, arbitrary origins). Enforcement is the MOUNT itself — withheld ⇒
  // the server is never attached, on both backends — so unlike third-party org
  // MCPs this does NOT ride the P13-KM-04 instruction-only gap. The mount also
  // requires effective `use-web-search-fetch`: the browser IS network egress,
  // and a profile whose egress was revoked must not re-acquire it one row down
  // (`resolveBrowserMcp` in specialist-browser-mcp.server.ts enforces the pair).
  cap("use-browser", "Drive a live web browser", ["agent"], "Collaboration", "off"),
  // Verdicts gate acceptance (G2) — default OFF so a casually-created profile
  // never acquires acceptance-veto power; the seed grants it to the reviewer.
  cap("report-validation-verdict", "Report a validation verdict", ["agent"], "Collaboration", "off"),
  // P13-D-26: no longer advisory. Wiring the `evidence:` block gave this a real
  // runtime consumer — it declares the optional `evidence` field on the
  // `report_outcome` tool and gates the agent's own rows in the completion
  // pipeline — so it moves out of the matrix-only group below and becomes a
  // toggle an admin can actually set. Server-derived delivery rows are attached
  // regardless; this grant governs what the AGENT gets to assert.
  cap("attach-evidence-references", "Attach evidence references", ["agent"], "Collaboration"),
  // Advisory persona guidance (no runtime consumer — matrix-only, no toggle)
  cap("run-unit-integration-validation", "Run unit & integration validation", ["agent"], null),
  cap("move-task-to-review", "Move the task to Review", ["agent"], null),
  cap("read-repo-diff", "Read the repository & diff", ["agent"], null),
  cap("run-validation-suites", "Run validation suites", ["agent"], null),
  cap("post-quality-flags", "Post quality-flag events", ["agent"], null),
  cap("approve-review", "Approve the review", ["agent"], null),
  cap("request-changes", "Request changes", ["agent"], null),
  cap("author-test-cases", "Author test cases", ["agent"], null),
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
 *
 * F15-06: the review-verdict OUTCOMES start withheld for the same reason. Their
 * catalog default is `direct` (they describe what a reviewer does), so an org
 * template for a docs writer was created holding "Approve the review" and
 * "Request changes" while `report-validation-verdict` was `off` — an incoherent
 * pair the agents page rendered as granted authority.
 */
export function conservativeGrantsFor(
  kind: CapabilityKind,
): { capabilityId: string; mode: UnifiedCapabilityDef["defaultMode"] }[] {
  const withheld = new Set<string>([
    "execute-code-or-write-repo",
    ...SCOPED_DELIVERY_CAPABILITY_IDS,
    ...VERDICT_OUTCOME_CAPABILITY_IDS,
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
  // R15-2: the deliver_for_review tool + performDelivery gate on this grant
  // server-side, on both operator backends.
  "deliver-review-pr",
  "update-task-branch",
  "transition-to-done",
  "change-project-policy",
  // Generic-agent collaboration gates (real, both-backend enforcement): the
  // completion pipeline gates verdict-recording + the ask-human question packet
  // on these grants server-side, so withholding binds on Claude AND Codex.
  "report-validation-verdict",
  "ask-human",
  // P13-D-26: the agent's own evidence rows are gated server-side in the
  // completion pipeline, so withholding this binds on both backends.
  "attach-evidence-references",
  // P14-RT-06: withheld web egress binds on BOTH backends — WebFetch/WebSearch
  // denied on Claude, `webSearchMode: "disabled"` on Codex. It moved out of the
  // claude-only set below; without landing HERE it would read as "advisory",
  // understating the enforcement further than the label it replaced.
  "use-web-search-fetch",
  // R19-19: withheld ⇒ the browser MCP server is not mounted into the run, on
  // both backends — the strongest enforcement shape the runtime has (the tool
  // surface simply does not exist, no deny rule needed).
  "use-browser",
]);

/** Specialist tool-denial capabilities enforced by Claude but advisory on Codex.
 *
 * R22 (owner ruling 2026-08-21): `execute-code-or-write-repo` REJOINED this set.
 * P14-RT-03 had moved it out because P13-RT-02 gave a write-withheld Codex run
 * the read-only sandbox (real OS-level enforcement). R22 removed that sandbox
 * ("viberr itself is the sandbox"), so on Codex the repo-write withholding is
 * once again advisory — the server-owned delivery gate is the real boundary.
 * Claude keeps its tool-denylist enforcement, so the whole repo-write family is
 * claude-only now. (Web egress stays in the both-backend set: withholding it
 * still binds on Codex by forcing workspace-write + `webSearchMode: disabled`.) */
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

/**
 * The three advisory capabilities that are REVIEW-VERDICT OUTCOMES: they have no
 * runtime consumer of their own and are reachable only through
 * `report-validation-verdict`, which the completion pipeline gates server-side
 * (the engage-time `verdictCapable` snapshot).
 */
export const VERDICT_OUTCOME_CAPABILITY_IDS: readonly string[] = [
  "approve-review",
  "request-changes",
  "post-quality-flags",
];

const VERDICT_OUTCOMES = new Set<string>(VERDICT_OUTCOME_CAPABILITY_IDS);

/**
 * Read the stored grants the way the RUNTIME reads them before rendering them:
 * a verdict outcome is only as granted as the verdict capability that carries
 * it.
 *
 * F15-06 (live): every profile created in a surface with no capability UI is
 * seeded from the catalog defaults, which grant the advisory outcomes `direct`
 * while `report-validation-verdict` defaults to `off`. The agents page therefore
 * showed a freshly created docs-writer holding "Approve the review" and "Request
 * changes" under ACTS DIRECTLY — acceptance-veto authority the runtime would
 * refuse it, read by admins as policy truth. Withheld verdict ⇒ its outcomes
 * render as not granted, everywhere the buckets are rendered.
 */
export function applyVerdictOutcomeGate<
  G extends { capabilityId: string; mode: string },
>(grants: readonly G[]): G[] {
  const verdict = grants.find(
    (g) => g.capabilityId === "report-validation-verdict",
  )?.mode;
  // Same polarity as `effectiveCollabMode`: only an explicit `direct` carries
  // verdict authority (absent and `recommend` fall to the catalog default, off).
  if (verdict === "direct") return grants.map((g) => ({ ...g }));
  // SAFETY: the spread carries every other property of `g` through unchanged,
  // so the only claim the assertion makes is that `"off"` inhabits `G["mode"]`.
  // Every caller instantiates G with the full `CapabilityMode` union (or plain
  // `string` in the tests) — `off` is one of its four members, and a narrower
  // mode type would not survive the grant round-trip through project.md anyway.
  return grants.map((g) =>
    VERDICT_OUTCOMES.has(g.capabilityId) && g.mode !== "human"
      ? ({ ...g, mode: "off" } as G)
      : { ...g },
  );
}

/**
 * F20-21 / R20-6: a specialist only ever acts DIRECTLY or is WITHHELD — there is
 * no specialist `recommend`. This used to WIDEN a specialist `recommend` to
 * `direct` at every call site (the display/enforcement READ paths AND the
 * create/edit/deploy WRITE paths), so a stored `recommend` was rendered,
 * counted, and enforced as `direct` — the seeded canonical project.md ("Move the
 * task to Review: recommend") disagreeing with every rendered surface ("Acts
 * directly"), and widening is the dangerous direction.
 *
 * The seed is now honest (agent-catalog.server.ts writes `direct`, never
 * `recommend`, for a specialist). A stray `recommend` — a hand-edited project.md
 * or a hostile form submission — normalizes DOWN to `off` (withheld, the SAFE
 * direction), never up to `direct`, at both the write path and the `:285`
 * display read, so stored = enforced = displayed. Re-introducing a
 * `recommend → direct` transform here is the F20-21 regression.
 */
export function coerceSpecialistCapabilityMode<M extends string>(
  mode: M,
): M | "off" {
  return mode === "recommend" ? "off" : mode;
}

/** The fine-grained delivery capabilities that the headline
 * `execute-code-or-write-repo` gates in
 * `specialist-tool-policy.resolveDeliveryPermissions`. */
export const SCOPED_DELIVERY_CAPABILITY_IDS: readonly string[] = [
  "create-task-branch",
  "commit-push-branch",
  "open-review-pr",
];

/** What the save layer did — or deliberately did NOT do — with a pair of
 * grants that must agree (the delivery headline over its scoped steps, or web
 * egress under the browser). */
export interface GrantCouplingNotice {
  /** Which coupling rule decided. */
  rule: "delivery-headline" | "browser-egress";
  /** `repaired` = the missing half was materialized `direct`;
   *  `withheld` = an explicit withholding was respected, so the dependent
   *  grants cannot run. */
  kind: "repaired" | "withheld";
  /** The grants whose presence forced the decision. */
  scoped: string[];
  /** Human copy: what was written and why. */
  message: string;
}

/** The grants to persist, plus what one coupling rule decided — `notice` is
 *  null when the stored grants already agreed and nothing was decided. */
export interface RepairedGrants<G> {
  grants: G[];
  notice: GrantCouplingNotice | null;
}

/** The grants to persist after EVERY coupling rule ran, with each decision. */
export interface CoupledGrants<G> {
  grants: G[];
  notices: GrantCouplingNotice[];
}

/**
 * Materialize the delivery headline for a profile whose scoped delivery grants
 * are actionable but whose `execute-code-or-write-repo` grant is ABSENT.
 *
 * B-AG1 (2026-07-28): this used to repair an explicit `off` as well, so an admin
 * who set "Execute code or write to the repo: Off" while leaving
 * `commit-push-branch: Allowed` had the withholding flipped to `direct` on the
 * next save — silently, with no audit row, and in the opposite direction from
 * the ENFORCEMENT layer (`grantModes`, specialist-tool-policy), which honors the
 * explicit `off`. Two layers disagreeing about the same stored grants is the
 * P14-LV-01 polarity bug in mirror image: permission appearing from something
 * other than a grant. An explicit `off` (like an explicit `human`) is now
 * respected here too — the save layer only fills in what nobody ever set.
 *
 * The remaining repair is the real editor artifact (a form that submits scoped
 * grants and omits the headline — the shape that produced VIB-1), and it is
 * reported so the caller can audit it and tell the admin.
 */
export function repairDeliveryGrants<
  G extends { capabilityId: string; mode: string },
>(grants: readonly G[]): RepairedGrants<G> {
  const actionable = (m: string | undefined) =>
    m === "direct" || m === "recommend";
  const byCapId = new Map(grants.map((g) => [g.capabilityId, g.mode]));
  const scoped = SCOPED_DELIVERY_CAPABILITY_IDS.filter((id) =>
    actionable(byCapId.get(id)),
  );
  const headline = byCapId.get("execute-code-or-write-repo");
  if (scoped.length === 0 || actionable(headline)) {
    return { grants: grants.map((g) => ({ ...g })), notice: null };
  }
  const labels = scoped.map((id) => capabilityById(id)?.label ?? id).join(", ");
  // An EXPLICIT withholding stands. It leaves the profile contradictory — the
  // scoped steps are granted but the gate above them is shut — so the save says
  // so instead of resolving it behind the admin's back in either direction.
  if (headline !== undefined) {
    return {
      grants: grants.map((g) => ({ ...g })),
      notice: {
        rule: "delivery-headline",
        kind: "withheld",
        scoped: [...scoped],
        message:
          `${labels} stays granted but "Execute code or write to the repo" is ` +
          `${headline === "human" ? "human-only" : "off"}, so this profile cannot ` +
          `deliver until the headline capability is granted.`,
      },
    };
  }
  const out = grants.map((g) => ({ ...g }));
  // SAFETY: a grant IS the pair below — every caller instantiates G as
  // `{ capabilityId, mode }` (the record persisted to project.md's
  // `capabilities`, with `mode` the full `CapabilityMode` union), so the literal
  // is a complete G and `direct` inhabits its mode. A G carrying a third
  // property would make this an incomplete grant, which is why the constraint
  // above names both members.
  out.push({ capabilityId: "execute-code-or-write-repo", mode: "direct" } as G);
  return {
    grants: out,
    notice: {
      rule: "delivery-headline",
      kind: "repaired",
      scoped: [...scoped],
      message:
        `"Execute code or write to the repo" was granted to match ${labels}: ` +
        `the delivery steps above it cannot run without it.`,
    },
  };
}

/** The pair `resolveBrowserMcp` (specialist-browser-mcp.server.ts) enforces at
 *  mount time: the browser is network egress, so these two must agree. */
export const BROWSER_CAP_ID = "use-browser";
export const WEB_EGRESS_CAP_ID = "use-web-search-fetch";

/**
 * Owner ruling (2026-08-20): granting the browser IMPLIES granting web egress.
 *
 * `resolveBrowserMcp` refuses to mount a browser whose profile withholds
 * `use-web-search-fetch`. Before this rule the two rows were independently
 * editable, and the live failure shape was an admin granting "Drive a live web
 * browser", leaving "Search & fetch from the web" off, and getting run after
 * run that honestly reported "browser not mounted" against a matrix that said
 * Allowed.
 *
 * This deliberately diverges from B-AG1 (the delivery repair above respects an
 * explicit `off`): there the contradictory state is a real, enforceable
 * withholding — the scoped steps stay dead until the admin resolves it. Here
 * the contradiction expresses no policy at all: the mount fails closed either
 * way, so respecting the `off` preserves nothing but the trap. The capability
 * editor pins the egress row to Allowed while the browser is Allowed; this
 * repair is the save-layer guarantee for writes that never rendered that
 * editor. The runtime gate stays as the backstop for hand-edited files.
 */
export function repairBrowserEgressGrants<
  G extends { capabilityId: string; mode: string },
>(grants: readonly G[]): RepairedGrants<G> {
  const byCapId = new Map(grants.map((g) => [g.capabilityId, g.mode]));
  const egress = byCapId.get(WEB_EGRESS_CAP_ID);
  if (byCapId.get(BROWSER_CAP_ID) !== "direct" || egress === "direct") {
    return { grants: grants.map((g) => ({ ...g })), notice: null };
  }
  // SAFETY: same contract as the delivery repair above — every caller's G is
  // the persisted `{ capabilityId, mode }` pair, so a copy with `mode`
  // overridden (and the pushed literal) is a complete G whose `mode` the
  // `string` bound admits.
  const out = grants.map((g) =>
    g.capabilityId === WEB_EGRESS_CAP_ID
      ? ({ ...g, mode: "direct" } as G)
      : { ...g },
  );
  if (egress === undefined) {
    // SAFETY: same `{ capabilityId, mode }` contract as the comment above.
    out.push({ capabilityId: WEB_EGRESS_CAP_ID, mode: "direct" } as G);
  }
  return {
    grants: out,
    notice: {
      rule: "browser-egress",
      kind: "repaired",
      scoped: [BROWSER_CAP_ID],
      message:
        '"Search & fetch from the web" was granted to match "Drive a live web browser": the browser is web egress and cannot mount without it.',
    },
  };
}

/** Every cross-grant coupling the save layer maintains, in one pass: the
 *  delivery headline first (B-AG1 semantics), then browser→egress. */
export function applyGrantCouplings<
  G extends { capabilityId: string; mode: string },
>(grants: readonly G[]): CoupledGrants<G> {
  const delivery = repairDeliveryGrants(grants);
  const browser = repairBrowserEgressGrants(delivery.grants);
  return {
    grants: browser.grants,
    notices: [delivery.notice, browser.notice].filter(
      (n): n is GrantCouplingNotice => n !== null,
    ),
  };
}

/** Keep the delivery headline enabled whenever any scoped delivery grant is
 * active and nobody ever set the headline (repair detail dropped). */
export function normalizeDeliveryGrants<
  G extends { capabilityId: string; mode: string },
>(grants: readonly G[]): G[] {
  return repairDeliveryGrants(grants).grants;
}

export function capabilityById(id: string): CapabilityDef | null {
  return byId.get(id) ?? null;
}

/** Exact-label lookup (used by the seed to normalize mock action strings). */
export function capabilityByLabel(label: string): CapabilityDef | null {
  return byLabel.get(label) ?? null;
}

/**
 * R15-9 — the mode the runtime applies for `deliver-review-pr` when a
 * deployment persisted NO grant for it.
 *
 * The capability postdates R15-2, so an absent grant is the normal state on
 * every project that already existed, not an edge case. Resolving it to a flat
 * `direct` made two projects with identical governance behave differently by
 * creation date alone. Derived here from the one thing that IS stored — whether
 * the project human-gates advancement before work starts — so the runtime gate
 * (`deliverGate`) and the policy surface (`effectiveProfileView`) cannot drift
 * apart. They drifting apart is precisely what F15-20 was.
 */
export function absentDeliverReviewPrMode(
  humanGatedBeforeWork: boolean,
): "direct" | "recommend" {
  return humanGatedBeforeWork ? "recommend" : "direct";
}
