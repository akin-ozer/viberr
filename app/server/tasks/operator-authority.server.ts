/**
 * What the operator may do on a project (ruling 656): its autonomy, clamped
 * by the deployment; its grants and the gates every operator action asks first
 * (`gate`, `deliverGate`, `dispatchGate`); and the result every action
 * answers with.
 */

import { projectRulingsKb, withProjectRulings } from "~/server/files/project-rulings.server";
import { repositoryAskState, type RepositoryAskState } from "~/server/org/repository-ruling.server";
import type { DatabaseSync } from "node:sqlite";
import type { AgentDeploymentDefinition, CapabilityMode } from "~/schemas/project-file.schema";
import { absentDeliverReviewPrMode } from "~/shared/capabilities";
import { humanGatesPreWorkAdvance } from "~/shared/workflow/stage-roles";
import {
  type AuditActor,
  type AuditEventInput,
  recordAudit,
  SYSTEM_ACTOR,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { effectiveProfileView, VIEW_WITHOUT_POLICY } from "~/features/agents/agents-query.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { defaultModelFor, resolveRunModel } from "~/server/runtimes/model-catalog.server";
import type { TaskMutationContext } from "./task-mutation.server";

/** Capability-gated task mutations used only by the in-process operator toolkit. */

export type OperatorAutonomy = "supervised" | "full";

/** The operator's resolved authority for a task's project. */
export interface OperatorAuthority {
  /** capabilityId → mode, from the project's operator deployment. */
  policy: Map<string, CapabilityMode>;
  /** Ruling 286: which of `kb` is the project's RULINGS knowledge base (ruling
   *  239), so its index can say it BINDS. A label; ruling 283 removed the
   *  budget this used to feed. On the authority because that is where `kb`
   *  already lives; null when `kb` holds none. */
  rulingsKb: string | null;
  /** The autonomy this run ACTUALLY holds — already clamped to
   *  {@link OperatorAuthority.configuredAutonomy}. Never above it (R19-A). */
  autonomy: OperatorAutonomy;
  /**
   * R19-A — the project deployment's CONFIGURED autonomy: the ceiling for any
   * run (`supervised` when no operator is deployed).
   */
  configuredAutonomy: OperatorAutonomy;
  /**
   * R19-A — non-null when THIS run asked for more autonomy than the project
   * allows and was reduced to the ceiling. Carries what was asked for, so the
   * reduction is named instead of silently happening: to people by the audit
   * row, and to the run by its prompt's autonomy line (ruling 67).
   */
  autonomyClampedFrom: OperatorAutonomy | null;
  backend: RealBackend;
  model: string;
  effort: string;
  /** Display name of the deployed operator profile. */
  name: string;
  /** The operator's declared skills (loaded into its system prompt at run). */
  skills: string[];
  /** The operator's declared knowledge bases (docs injected into its context). */
  kb: string[];
  /**
   * The operator's declared org MCP servers. P13-KM-03 wired them into the
   * Claude toolkit (they had reached NO run on either backend — `OperatorAuthority`
   * carried skills and kb only, and an operator granted `everything-mcp`
   * reported "MCP servers/tools I can call: none"); P14-RT-04 mounts them on the
   * Codex operator too, so the grant is real on both backends. On Codex the CLI
   * translation drops credentials (argv exposure) and stamps approve-mode, as it
   * does for specialists.
   */
  mcps: string[];
  /** The deployment's persona override (P11-21) — when a project edits the
   *  operator's persona in the UI, the run uses it in place of the shipped
   *  operator definition. `null` falls back to the shipped/baked persona. */
  persona: string | null;
  /** false when no operator profile is deployed in the project. */
  deployed: boolean;
  /**
   * R15-9 — true when this project human-gates every pre-work advance (the
   * `strict` preset's signature in the workflow graph). Used ONLY to resolve a
   * capability the deployment never persisted; an explicit grant always wins.
   */
  humanGatedBeforeWork: boolean;
  /**
   * Ruling 672: whether this run may ask a person to connect a repository.
   * `open` on a project with none, `declined` once a person decided the board
   * keeps none, null for a project that has one. It offers
   * `ask_for_repository` on both backends and words the run's workspace
   * section, so the tool and the sentence cannot disagree.
   */
  repositoryAsk: RepositoryAskState | null;
}

/** How a gated capability resolves for the current authority. */
type Gate = "direct" | "recommend" | "deny";

export interface OperatorActionResult {
  /**
   * done = performed · recommended = posted for a human ·
   * **denied = refused by AUTHORITY** (the capability policy withheld it, or
   * the action belongs to someone else — e.g. an agent's own packet) ·
   * **noop = nothing to do / the task's state ruled it out** (already Done, no
   * open packet, a target that is not engaged, a malformed step).
   *
   * That split is load-bearing, not cosmetic: `narrateRefusedActions` files a
   * refused plan step under "refused by its capability policy" or "did not
   * apply to the task's current state" purely on this field. A state conflict
   * returned as `denied` therefore tells the human the project's policy blocked
   * work it never blocked — the misblame class LV-03 exists to prevent.
   */
  outcome: "done" | "recommended" | "denied" | "noop";
  message: string;
  /**
   * Ruling 443: the step's outcome IS a decision packet it opened, as when a
   * base refresh meets a conflict. It tried what it could and left the choice
   * to a person, which is not a refusal: `outcome` stays `noop` (the state
   * split above), and a plan's narration does not file it as a step that "did
   * not apply". Ruling 430 already pauses the acting steps after it.
   */
  openedPacket?: true;
  /** Users the action's own watcher notification actually REACHED (routing
   *  prefs applied per recipient). Set by the packet writer so a caller that
   *  owes a fallback notice about the same event (T13) can dedupe per
   *  recipient instead of assuming the packet row reached everyone. */
  notifiedUserIds?: string[];
}

/**
 * Ruling 406: an operator that ACTED did not hold. Stamps the drive's
 * `carriedOutAction` when an action's result says it was carried out, `done`
 * or (ruling 443) a step whose outcome is the decision packet it opened,
 * whatever effect it had.
 *
 * Ruling 705: the ONE predicate both operator backends answer from. A Codex
 * plan's steps pass through `executeCodexPlan`'s `record` and a Claude drive's
 * governed tools reply through the toolkit's `resultText`, and each calls
 * this, so the next action shape counts on both the day it is added. The
 * stamp used to live in `record` alone, which covered one backend: a Claude
 * nudge whose one action was a comment, or a refresh of a branch already
 * current (AX-18's shape), was recorded as a deliberate hold where the same
 * plan on Codex was resumed.
 */
export function noteCarriedOutAction(
  ctx: TaskMutationContext,
  result: OperatorActionResult,
): void {
  if (ctx.operatorRun && (result.outcome === "done" || result.openedPacket)) {
    ctx.operatorRun.carriedOutAction = true;
  }
}

function readAutonomy(
  definition: AgentDeploymentDefinition | undefined,
): OperatorAutonomy {
  return definition?.autonomy === "full" ? "full" : "supervised";
}

/** Autonomy ordered low → high. A run may sit AT or BELOW the project's
 *  configured level; nothing may sit above it. */
const AUTONOMY_RANK = {
  supervised: 0,
  full: 1,
} satisfies Record<OperatorAutonomy, number>;

/** The audit fact recorded when a run asked for more autonomy than the project
 *  configured and was reduced to the ceiling (R19-A). The string is the
 *  contract: the activity feed's audit map and docs/domain/operator.md name it
 *  literally. */
const AUTONOMY_CLAMPED_AUDIT_ACTION = "task.operator.autonomy_clamped";

/**
 * R19-A (owner ruling, pass 19) — **a run may never exceed the project's
 * configured autonomy**.
 *
 * `resolveOperatorAuthority` used to return `overrides.autonomy ?? configured`
 * verbatim, so any `run-agents` role (maintainer+) could launch ONE turn at
 * `full` on a project whose operator is deployed `supervised` — promoting every
 * `recommend` capability (stage transitions, packets, typed events,
 * `deliver-review-pr`) to direct execution, with no confirm, no distinct audit
 * row, and only a toast. The Policy page presents operator autonomy as PROJECT
 * configuration (ruling 2); a per-run dropdown that silently outranks it makes
 * that page a lie.
 *
 * This is a CEILING, not a pin: choosing LESS autonomy for a single run stays
 * allowed and is not a clamp (a maintainer may always ask for more supervision
 * than the project demands). Omitting the override means "run at the configured
 * level", which is also not a clamp.
 */
interface ClampedAutonomy {
  /** The level the run actually gets — never above the ceiling. */
  autonomy: OperatorAutonomy;
  /** What the run asked for when the clamp BIT; null when nothing was reduced. */
  clampedFrom: OperatorAutonomy | null;
}

function clampAutonomy(
  requested: OperatorAutonomy | undefined,
  ceiling: OperatorAutonomy,
): ClampedAutonomy {
  if (requested === undefined) return { autonomy: ceiling, clampedFrom: null };
  if (AUTONOMY_RANK[requested] <= AUTONOMY_RANK[ceiling]) {
    return { autonomy: requested, clampedFrom: null };
  }
  return { autonomy: ceiling, clampedFrom: requested };
}

/**
 * R19-A — audit the clamp WHEN IT ACTUALLY BITES, so a silently-reduced run is
 * visible rather than mysterious.
 *
 * Deliberately not recorded when the run simply omitted an override, or asked
 * for LESS than the ceiling: those are not reductions and an audit row for
 * every operator resolve would bury the one event that matters. Recording is
 * skipped entirely when the caller passed no `db` — `resolveOperatorAuthority`
 * is also a pure READ on loader paths (the review page, the acceptance
 * authority probe), and a read must not write audit rows.
 */
function auditAutonomyClamp(
  overrides: OperatorAuthorityOverrides,
  projectSlug: string,
  clampedFrom: OperatorAutonomy,
  ceiling: OperatorAutonomy,
): void {
  if (!overrides.db) return;
  const event: AuditEventInput = {
    action: AUTONOMY_CLAMPED_AUDIT_ACTION,
    actor: overrides.actor ?? SYSTEM_ACTOR,
    subjectKind: "project",
    subjectId: projectSlug,
    projectSlug,
    details: { requested: clampedFrom, ranAt: ceiling, configured: ceiling },
  };
  // A project-level resolve carries no task; the audit row stays task-less
  // rather than pointing at an empty key.
  if (overrides.taskKey) event.taskKey = overrides.taskKey;
  recordAudit(overrides.db, event);
}

/** Per-run overrides + the optional audit context the clamp needs. */
export interface OperatorAuthorityOverrides {
  backend?: RealBackend;
  autonomy?: OperatorAutonomy;
  /**
   * R19-A — supply on RUN paths only. Present = "this resolve launches work",
   * so a clamp that bites is recorded; absent = a pure read, which stays silent.
   */
  db?: DatabaseSync;
  /** Task the run belongs to, for the clamp audit row. */
  taskKey?: string;
  /** The human who asked for the run — who the clamp audit names. */
  actor?: AuditActor;
}

/**
 * The ONE rule for "which backend does a deployment run on" (B-OP5): the first
 * declared real backend, Claude when nothing declares one. Both the standalone
 * lookup below and the authority resolver read it, so a change to the picking
 * rule cannot land in one place and miss the other.
 */
function deploymentBackend(view: { backends: readonly string[] }): RealBackend {
  return view.backends.find((b) => b === "claude" || b === "codex") === "codex"
    ? "codex"
    : "claude";
}

/**
 * The operator deployment's configured backend for a project (P11-76) — a cheap
 * read for the UI so the "Run operator" backend picker defaults to what the
 * operator actually runs on, not a hardcoded "claude". Falls back to "claude"
 * when no operator is deployed (the same default the run path uses).
 */
export function operatorBackendFor(
  ctx: TaskMutationContext,
  projectSlug: string,
): RealBackend {
  try {
    const file = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
    const deployment = file?.parsed.frontmatter.agents.find(
      (a) => effectiveProfileView(a, ctx.dataRoot, VIEW_WITHOUT_POLICY).kind === "operator",
    );
    if (!deployment) return "claude";
    return deploymentBackend(
      effectiveProfileView(deployment, ctx.dataRoot, VIEW_WITHOUT_POLICY),
    );
  } catch {
    return "claude";
  }
}

/**
 * F37-65: can the deployed operator ACCEPT COMPLETION itself, or does it only
 * file a card a person applies?
 *
 * Autonomy alone does not answer this and the task page's Execution caption
 * read it as though it did: "Full autonomy: this run can move the task and
 * accept completion itself." `gate()` keeps `completion-for-acceptance` at
 * `recommend` whatever the autonomy unless the grant is EXPLICITLY `direct`
 * (owner ruling Q1, 2026-07-11 — "an admin who configured `recommend`
 * expecting a human gate must never get a silent agent-close just because the
 * run was launched at full autonomy"). Live on shopify-clone-platform the
 * operator is `autonomy: full` with `completion-for-acceptance: recommend`, so
 * every task page on that board promised something the operator could not do,
 * and every acceptance in the pass was a person pressing the button.
 *
 * The predicate is `operatorAcceptCompletion`'s own recommend-branch condition
 * negated, character for character, so the caption cannot drift from the
 * behaviour it describes. No `deployed` check of its own: `gate` already answers
 * `deny` for an undeployed operator, and its comment asks to be the ONE place
 * both gates answer from — a second copy here is the drift this finding is
 * about. Falls back to `false` for an unreadable project, which is the honest
 * caption (a page that cannot resolve an operator cannot promise one acts).
 */
export function operatorAcceptsDirectly(
  ctx: TaskMutationContext,
  projectSlug: string,
): boolean {
  try {
    const authority = resolveOperatorAuthority(ctx, projectSlug);
    return (
      authority.autonomy === "full" &&
      gate(authority, "completion-for-acceptance") === "direct"
    );
  } catch {
    return false;
  }
}

/**
 * R19-A — the operator deployment's CONFIGURED autonomy for a project: the
 * ceiling every run is clamped to. The exact sibling of `operatorBackendFor`
 * (P11-76) and for the same reason — the run picker must offer the options that
 * will ACTUALLY run. A selector listing "Full autonomy" on a project configured
 * `supervised` is a control that lies: the server clamps it, the run is
 * supervised, and the only trace is an audit row the operator never reads.
 *
 * Falls back to `supervised` for an unreadable project / no operator deployed —
 * the same default the run path resolves to.
 */
export function operatorAutonomyFor(
  ctx: TaskMutationContext,
  projectSlug: string,
): OperatorAutonomy {
  try {
    const file = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
    const deployment = file?.parsed.frontmatter.agents.find(
      (a) => effectiveProfileView(a, ctx.dataRoot, VIEW_WITHOUT_POLICY).kind === "operator",
    );
    if (!deployment) return "supervised";
    return readAutonomy(deployment.definition);
  } catch {
    return "supervised";
  }
}

/**
 * Resolve the operator's authority for a project from its `agents:`
 * deployment. `overrides` lets a run pick the backend / autonomy for THIS run
 * (the task-detail operator panel) without rewriting the deployment.
 */
export function resolveOperatorAuthority(
  ctx: TaskMutationContext,
  projectSlug: string,
  overrides: OperatorAuthorityOverrides = {},
): OperatorAuthority {
  const file = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!file) throw AppError.notFound(`Project ${projectSlug} not found.`);

  // R15-9: read off the graph, not a stored preset — see humanGatesPreWorkAdvance.
  const humanGatedBeforeWork = humanGatesPreWorkAdvance(
    file.parsed.frontmatter.stages,
    file.parsed.frontmatter.workflow,
  );

  const deployment = file.parsed.frontmatter.agents.find((a) => {
    const view = effectiveProfileView(a, ctx.dataRoot, VIEW_WITHOUT_POLICY);
    return view.kind === "operator";
  });

  if (!deployment) {
    // R19-A: no deployment ⇒ nothing configured `full`, so the ceiling is
    // `supervised` here too. `deployed: false` already denies every capability,
    // but an authority that REPORTS "full" would still be a lie on the run
    // disclosure — and would hand a future default in this branch real power.
    const undeployed = clampAutonomy(overrides.autonomy, "supervised");
    if (undeployed.clampedFrom) {
      auditAutonomyClamp(overrides, projectSlug, undeployed.clampedFrom, "supervised");
    }
    return {
      policy: new Map(),
      autonomy: undeployed.autonomy,
      configuredAutonomy: "supervised",
      autonomyClampedFrom: undeployed.clampedFrom,
      backend: overrides.backend ?? "claude",
      model: defaultModelFor(overrides.backend ?? "claude"),
      effort: "",
      name: "Operator",
      skills: [],
      // Ruling 239: every run a project makes reads its rulings, and this one
      // still runs: `runOperator` refuses no undeployed operator (the Run
      // operator control, a schedule, boot recovery and the controller each
      // start one), so it plans from the rules the deployed branch reads.
      kb: withProjectRulings([], projectSlug, ctx),
      rulingsKb: projectRulingsKb(projectSlug, ctx),
      persona: null,
      mcps: [],
      deployed: false,
      humanGatedBeforeWork,
      repositoryAsk: repositoryAskState(file.parsed.frontmatter, ctx),
    };
  }

  const view = effectiveProfileView(deployment, ctx.dataRoot, VIEW_WITHOUT_POLICY);
  const policy = new Map<string, CapabilityMode>(
    deployment.capabilities.map((c) => [c.capabilityId, c.mode]),
  );
  const definition = deployment.definition;
  const declaredBackend = deploymentBackend(view);
  const backend: RealBackend = overrides.backend ?? declaredBackend;

  // The deployment's model is specific to its own backend (e.g. a Claude model).
  // When a run overrides to a DIFFERENT backend, the stored model is invalid for
  // it (Codex rejects a Claude model id) — fall back to that backend's default.
  // resolveRunModel also rejects display placeholders ("orchestration runtime")
  // and any other non-catalog value, so nothing invalid leaks into the run.
  const model =
    backend === declaredBackend
      ? resolveRunModel(backend, view.model)
      : defaultModelFor(backend);

  // R19-A: the deployment's configured autonomy is the CEILING for this run.
  const configuredAutonomy = readAutonomy(definition);
  const clamped = clampAutonomy(overrides.autonomy, configuredAutonomy);
  if (clamped.clampedFrom) {
    auditAutonomyClamp(overrides, projectSlug, clamped.clampedFrom, configuredAutonomy);
  }

  return {
    policy,
    autonomy: clamped.autonomy,
    configuredAutonomy,
    autonomyClampedFrom: clamped.clampedFrom,
    backend,
    model,
    effort: backend === declaredBackend ? view.effort || "" : "",
    name: view.name || "Operator",
    skills: view.resources.skills,
    // Ruling 239: the operator reads the project's rulings the same as every
    // agent it coordinates. It writes the packets and scoping notes those
    // agents work from, so an operator that had not read the project's settled
    // rules would re-open questions the project had closed.
    kb: withProjectRulings(view.resources.kb ?? [], projectSlug, ctx),
    // Ruling 286: which of those names binds. The operator writes the packets
    // and scoping notes every specialist works from, so it is the worst actor
    // on the board to be planning from rules it never opened.
    rulingsKb: projectRulingsKb(projectSlug, ctx),
    mcps: view.resources.mcps ?? [],
    persona: definition?.persona?.trim() || null,
    deployed: true,
    humanGatedBeforeWork,
    repositoryAsk: repositoryAskState(file.parsed.frontmatter, ctx),
  };
}

/**
 * F31-C2 — the ONE absent-polarity table. Four capabilities postdate live
 * operator deployments, and their canon resolves an ABSENT grant to a derived
 * default rather than "off" (each dedicated gate below documents why). That
 * split was a standing trap: every consumer that reached for the plain
 * `gate()` silently re-broke one of them — three separate call sites were
 * individually corrected for `dispatch-agents` alone, and a fourth added
 * later would have re-broken dispatching on every pre-rework project. The
 * table lives inside `gate()` itself, so any consumer may now resolve any
 * capability through it and get the same answer the dedicated gate gives.
 * Returns null for the ordinary absent-means-off family.
 */
function absentPolarityGate(
  authority: OperatorAuthority,
  capabilityId: string,
): Gate | null {
  switch (capabilityId) {
    case "deliver-review-pr":
      // R15-9: derived from the project's governance, not a constant — and
      // deliberately NOT promoted by full autonomy (only an explicit stored
      // mode rides the promotion in the mode arm below).
      return absentDeliverReviewPrMode(authority.humanGatedBeforeWork);
    case "dispatch-agents":
      // Ruling 98(b): dispatch IS the old assign/summon pair's default.
      return "direct";
    case "update-task-branch":
      // Bringing the branch up to date is delivery's sibling — absent
      // follows whatever delivery resolves to (update-branch-operator).
      return deliverGate(authority);
    case "use-web-search-fetch":
      // Catalog default `direct` — absent means granted; only an explicit
      // off/human withholds (operatorWebWithheld).
      return "direct";
    default:
      return null;
  }
}

/** Resolve one capability to direct / recommend / deny for this authority. */
export function gate(authority: OperatorAuthority, capabilityId: string): Gate {
  // A4: no operator deployed ⇒ no operator authority, full stop. The
  // no-deployment branch above already returns an EMPTY policy (so every
  // lookup falls to `off`), but stating the rule here makes it the ONE place
  // both gates answer from — a future default in that branch cannot quietly
  // hand a project that deployed no operator a working capability.
  if (!authority.deployed) return "deny";
  if (!authority.policy.has(capabilityId)) {
    // F31-C2: the absent-means-derived family resolves here for EVERY
    // consumer, not only the callers that knew to use a dedicated gate.
    const absent = absentPolarityGate(authority, capabilityId);
    if (absent !== null) return absent;
  }
  const mode = authority.policy.get(capabilityId) ?? "off";
  if (mode === "direct") return "direct";
  if (mode === "recommend") {
    // Full autonomy promotes recommend → direct — EXCEPT for acceptance-to-Done.
    // The human-only-Done invariant's single agent exception requires the
    // capability be EXPLICITLY `direct` (owner ruling Q1, 2026-07-11): an admin
    // who configured `recommend` expecting a human gate must never get a silent
    // agent-close just because the run was launched at full autonomy.
    if (capabilityId === "completion-for-acceptance") return "recommend";
    return authority.autonomy === "full" ? "direct" : "recommend";
  }
  // human (reserved for a human) and off (withheld) both mean "operator can't".
  return "deny";
}

/**
 * R15-2: the `deliver-review-pr` gate with ABSENT-means-granted polarity. The
 * capability postdates many live operator deployments (whose grant lists were
 * persisted at deploy time), and its catalog default is `direct` — an absent
 * grant must not silently kill delivery on every pre-R15-2 project. An explicit
 * mode goes through the normal gate (full autonomy promotes recommend→direct).
 * Same deliberate polarity as `use-web-search-fetch` (operatorWebWithheld).
 */
export function deliverGate(authority: OperatorAuthority): Gate {
  // A4: absent-means-granted is about DEPLOYMENTS that predate the capability
  // — never about a project with no operator deployed at all. `deliverGate`
  // could not return `deny` for such a project: the no-deployment authority
  // carries an empty policy, so `policy.has` was false and the fallback below
  // resolved to `direct` on any non-strict board. An undeployed operator
  // therefore built a toolkit of exactly `get_task` + `deliver_for_review` —
  // it could push a branch and open a PR with no operator configured anywhere.
  // Denied HERE rather than at the call sites, because four of the five
  // `runOperator` entry points (the Run-operator button, a schedule, boot
  // recovery, an `@operator` comment) never check `authority.deployed`; the
  // Claude toolkit, the Codex plan schema and `operatorDeliverForReview` all
  // resolve delivery through this one function.
  if (!authority.deployed) return "deny";
  if (authority.policy.has("deliver-review-pr")) {
    return gate(authority, "deliver-review-pr");
  }
  // R15-9 — `deliver-review-pr` postdates every deployment created before
  // R15-2, so an absent grant is the norm on existing projects, not an edge
  // case. Resolving it to a flat `direct` meant two projects with identical
  // governance behaved differently purely by creation date: a strict project
  // made today asks a human before pushing, while one made last week pushes on
  // its own. Derive the same answer the preset would have given instead, so the
  // rule is "what does this project's governance say", not "when was it made".
  // Shared with the policy surface so the two can never disagree (F15-20).
  // F31-C2: `gate()` now answers the absent case identically through
  // `absentPolarityGate`; this explicit arm stays because `absentPolarityGate`
  // calls THIS function for `update-task-branch` (avoiding the loop), and as
  // the documented front for delivery-specific reasoning.
  return absentDeliverReviewPrMode(authority.humanGatedBeforeWork);
}

/**
 * The `dispatch-agents` gate with ABSENT-means-granted polarity (dispatch-
 * rework bug hunt, 2026-08-29). Ruling 98(b) collapsed the persisted
 * `assign-primary-specialist` + `summon-reviewers` pair into this id, and the
 * canon (capabilities.ts, ruling 98) promised that an absent grant resolves to
 * the catalog default so existing operator deployments keep dispatching — but
 * every consumer went through the plain `gate()`, whose absent arm is `off` →
 * deny: on EVERY deployment persisted before the rework (which stores only the
 * retired ids) the operator silently lost the ability to put any agent to
 * work, while keeping transitions and delivery. Same shape as `deliverGate`:
 * an explicit stored mode wins; absent resolves to the catalog default
 * (`direct` — dispatch predates nothing governance-wise, it IS the old pair's
 * default); an undeployed operator stays denied (A4).
 */
export function dispatchGate(authority: OperatorAuthority): Gate {
  // F31-C2: the plain gate() carries the same absent polarity now; this
  // front remains as the named, documented resolver.
  return gate(authority, "dispatch-agents");
}
