import { OPERATOR_NOTIFY_FROM } from "~/server/tasks/task-mutation.server";
import {
  projectRulingsKb,
  withProjectRulings,
} from "~/server/files/project-rulings.server";
import {
  describeRevisionDrift,
  type RevisionDrift,
} from "~/shared/revision-drift";
import { closureRefusal, taskClosure } from "./task-closure.server";
import { resolveDependencies } from "~/server/projections/dependencies.server";
import {
  misdirectedOptionPromise,
  misdirectedPromiseRefusal,
  moveStagePromiseMismatch,
  moveStageTarget,
} from "~/shared/workflow/packet-options";
import { setTaskDependencies } from "./dependencies.server";
import type { TaskActor } from "./task-mutation.server";
import {
  recordRecommendationWithdrawal,
  terminalStageIdFor,
  withdrawAcceptanceOffers,
  type OfferWithdrawalSlot,
  type OfferWithdrawalCause,
} from "./task-mutation.server";
import type { DependencyRender } from "~/shared/dependencies";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  AgentDeploymentDefinition,
  CapabilityGrant,
  CapabilityMode,
} from "~/schemas/project-file.schema";
import { withheldAgentGrants } from "~/features/agents/capability-catalog";
import { effectiveCollabMode } from "./agent-outcome.server";
import {
  currentVerdicts,
  deliveringEngagement,
  deriveValidation,
  supportingEngagements,
  type Engagement,
  type PacketOption,
  type PrMergeable,
  type PrState,
  type PacketOptionKind,
  type Recommendation,
  type RecommendationKind,
  type TaskFileEvent,
  type TaskPacket,
  unpushedRevisionOf,
  type UnpushedRevision,
} from "~/schemas/task-file.schema";
import {
  activeWorkRevision,
  consecutiveRequestChanges,
  PACKET_OPTION_KINDS,
  revisionLeftWorkspace,
  type ForeignBranchHead,
  type RevisionDeparture,
  unpushedRevisionBlockedReason,
} from "~/schemas/task-file.schema";
import {
  compactTimelineEvents,
  DEFAULT_COMPACTION,
} from "./timeline-compaction.server";
import {
  applyCommentGuardrails,
  COMMENT_DROPPED_AUDIT_ACTION,
  commentOutcomeMessage,
  type CommentGuardrailResult,
  guardrailOn,
  guardrailValue,
} from "./comment-guardrails.server";
import { absentDeliverReviewPrMode } from "~/shared/capabilities";
import {
  humanGatesPreWorkAdvance,
  resolveStageRoles,
  stageName,
} from "~/shared/workflow/stage-roles";
import { verdictStageFor } from "~/shared/workflow/verdict-stage";
import { newId } from "~/shared/ids/new-id.server";
import {
  recordAudit,
  SYSTEM_ACTOR,
  type AuditActor,
  type AuditEventInput,
} from "~/server/audit/audit-recorder.server";
import { backendDispatchHold } from "~/server/runtimes/backend-quota.server";
import { AppError } from "~/server/errors/app-error.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import {
  effectiveProfileView,
  VIEW_WITHOUT_POLICY,
} from "~/features/agents/agents-query.server";
import { logger } from "~/server/logging/logger.server";
import { createReconcileBehindByLookup } from "~/server/provenance/provenance-query.server";
import { storeRelativePath } from "~/server/files/file-store-root.server";
import {
  notifyMentionedUsers,
  withAmbiguityDisclosure,
  stampNotifiedRecipients,
} from "./mention-notify.server";
import type { RealBackend } from "~/server/runtimes/runtime-registry.server";
import { isBackendAvailableFor } from "~/server/runtimes/backend-credentials.server";
import {
  defaultModelFor,
  resolveRunModel,
} from "~/server/runtimes/model-catalog.server";
import {
  DEFAULT_GOAL,
  OPERATOR_AUDIT_ACTOR,
  OPERATOR_TASK_ACTOR,
  RECOMMENDATION_DISMISSED_AUDIT_ACTION,
  acceptanceRefusalFor,
  acceptanceTerminallyBlocked,
  mergeReadinessRefusal,
  applyAcceptanceWrite,
  notifyTaskWatchers,
  operatorPromptAgent,
  performDelivery,
  revisionDriftNote,
  transitionStage,
  type TaskMutationContext,
} from "./task-actions.server";
import {
  acceptanceNoChangeCheck,
  noChangeApplies,
  noChangeCandidate,
  noChangeCompletionEvent,
} from "./no-change-completion.server";
import {
  isDispatchHeld,
  listDeployedSpecialists,
  projectBoard,
  runEligibilityFor,
  startAgentRun,
  type DeployedSpecialistView,
  type DispatchHeldError,
} from "./specialist-run.server";
import {
  acceptanceOfferBasis,
  readRequiredReviewers,
  resolveRequiredReviewers,
  type RequiredReviewerView,
} from "./required-reviewers.server";
import { markTaskPacketApprovalRead } from "~/server/projections/notifications.server";
import {
  listKnowledgeBaseNames,
  listMcpServerNames,
  listSkillNames,
} from "~/server/org/resources.server";

/** Capability-gated task mutations used only by the in-process operator toolkit. */

export type OperatorAutonomy = "supervised" | "full";

/** The operator's resolved authority for a task's project. */
export interface OperatorAuthority {
  /** capabilityId → mode, from the project's operator deployment. */
  policy: Map<string, CapabilityMode>;
  /** Ruling 286: which of `kb` is the project's RULINGS knowledge base (ruling
   *  239), so its index can say it BINDS. A label; ruling 283 removed the
   *  budget this used to feed. On the authority because that is where `kb`
   *  already lives, and hand-built test literals may omit it. */
  rulingsKb?: string | null;
  /** The autonomy this run ACTUALLY holds — already clamped to
   *  {@link OperatorAuthority.configuredAutonomy}. Never above it (R19-A). */
  autonomy: OperatorAutonomy;
  /**
   * R19-A — the project deployment's CONFIGURED autonomy: the ceiling for any
   * run. Optional on the interface only so the handful of hand-built authority
   * literals in tests keep compiling; `resolveOperatorAuthority` always sets it.
   */
  configuredAutonomy?: OperatorAutonomy;
  /**
   * R19-A — non-null when THIS run asked for more autonomy than the project
   * allows and was reduced to the ceiling. Carries what was asked for, so the
   * reduction can be named (audit row, run disclosure) instead of silently
   * happening.
   */
  autonomyClampedFrom?: OperatorAutonomy | null;
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
  /** Users the action's own watcher notification actually REACHED (routing
   *  prefs applied per recipient). Set by the packet writer so a caller that
   *  owes a fallback notice about the same event (T13) can dedupe per
   *  recipient instead of assuming the packet row reached everyone. */
  notifiedUserIds?: string[];
}

// ------------------------------------------------------------- authority

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
 *  configured and was reduced to the ceiling (R19-A). Exported so the audit
 *  panel's whitelist and the tests name the same string. */
export const AUTONOMY_CLAMPED_AUDIT_ACTION = "task.operator.autonomy_clamped";

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
 *
 * Pure and exported so the clamp can be unit-asserted, and so the UI can offer
 * exactly the options that will actually run.
 */
export interface ClampedAutonomy {
  /** The level the run actually gets — never above the ceiling. */
  autonomy: OperatorAutonomy;
  /** What the run asked for when the clamp BIT; null when nothing was reduced. */
  clampedFrom: OperatorAutonomy | null;
}

export function clampAutonomy(
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
 * Resolve the operator's authority for a project from its `agents:`
 * deployment. `overrides` lets a run pick the backend / autonomy for THIS run
 * (the task-detail operator panel) without rewriting the deployment.
 */
/**
 * The operator deployment's configured backend for a project (P11-76) — a cheap
 * read for the UI so the "Run operator" backend picker defaults to what the
 * operator actually runs on, not a hardcoded "claude". Falls back to "claude"
 * when no operator is deployed (the same default the run path uses).
 */
/**
 * The ONE rule for "which backend does a deployment run on" (B-OP5): the first
 * declared real backend, Claude when nothing declares one. Both the standalone
 * lookup below and the authority resolver read it, so a change to the picking
 * rule cannot land in one place and miss the other.
 */
export function deploymentBackend(view: { backends: readonly string[] }): RealBackend {
  return view.backends.find((b) => b === "claude" || b === "codex") === "codex"
    ? "codex"
    : "claude";
}

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
      kb: [],
      persona: null,
      mcps: [],
      deployed: false,
      humanGatedBeforeWork,
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

// ------------------------------------------------------------- helpers

function taskRef(ctx: TaskMutationContext, projectSlug: string, taskKey: string) {
  return {
    projectSlug,
    taskKey,
    dataRoot: ctx.dataRoot,
  };
}

function reproject(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): void {
  rebuildPath(db, resolveTaskFilePath(taskRef(ctx, projectSlug, taskKey)), {
    dataRoot: ctx.dataRoot,
  });
}

/** The operator mutation context — carries the operator-authorized flag so
 *  the shared mutations skip human RBAC and attribute to the operator. */
function opCtx(ctx: TaskMutationContext): TaskMutationContext {
  return { ...ctx, operatorAuthorized: true };
}


/**
 * Append an operator-authored `comment` timeline event, reproject, audit —
 * and REPORT what the anti-noise guardrails actually did (G1/B-FD8). `variant`
 * distinguishes a plain narration comment from a recommendation (kept as
 * literal audit actions so the static audit-coverage sweep can parse every
 * call site).
 *
 * Returns the {@link CommentGuardrailResult} so the caller can hand the model
 * the truth. This function used to be `Promise<void>` and silently early-return
 * on a meaningful/duplicate drop, so `operatorPostComment` reported
 * "Comment posted to the timeline." for a comment nobody would ever see — the
 * model then built on narration that did not exist and, on Codex, settled the
 * task to `waiting:human` with no packet or note (a silent strand).
 */
async function writeOperatorComment(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  text: string,
  variant: "comment" | "recommend",
): Promise<CommentGuardrailResult> {
  // Anti-noise guardrails — ALL enforced for real (owner ruling Q3):
  //  · meaningful-comment: trivial chatter never reaches the canonical record;
  //  · evidence-separation: raw output dumps are trimmed to a head + reference;
  //  · no-duplicate-summary: an exact restatement of the last operator comment
  //    is dropped;
  //  · compression-threshold: long timelines compact at the CONFIGURED value.
  // Operator narration is stored VERBATIM (owner ruling 2026-08-31) — the old
  // operator-brevity hard cap destroyed the overflow in the canonical record;
  // the timeline clamps long comments view-side behind a Show more toggle.
  //
  // The meaningful/evidence pair runs through the shared
  // `applyCommentGuardrails` so the outcome is a value, not a void early-return.
  // The no-duplicate check stays timeline-based (compares against the LAST
  // operator comment inside the write transaction) rather than a passed-in
  // previous text, so it is handled below instead of by the shared helper.
  const guardrail = applyCommentGuardrails({
    text,
    meaningful: guardrailOn(ctx, projectSlug, "meaningful-comment"),
    evidence: guardrailOn(ctx, projectSlug, "evidence-separation"),
  });
  if (guardrail.dropped === "meaningless") {
    logger.info("operator comment dropped by the meaningful-comment guardrail", {
      taskKey,
    });
    recordCommentDrop(db, projectSlug, taskKey, variant, "meaningless");
    return guardrail;
  }
  // S5-G3: the operator is instructed to tag the human it answers, so a handle
  // that matches two people is a NEW-4 failure the operator cannot fix on its
  // own — the comment discloses the non-delivery instead of dropping it in
  // silence. Applied after the guardrails so it rides the text actually written.
  const text2 = withAmbiguityDisclosure(db, guardrail.text ?? text);
  // Ruling 214 (F37-34): the same principle, one audience over. The operator's
  // own doctrine used to tell it to put the completeness question to a reviewer
  // "in ONE comment", and live on SHOP-10 it did — "@Code Reviewer, name
  // everything you would still block on" — to an audience that does not exist.
  // `post_comment` writes a timeline line and starts nothing, so no reviewer
  // ever read it; then the stranded backstop, which counts a transition, a
  // dispatch, a delivery or a packet as progress and a comment as none,
  // recorded a deliberate hold and paused coordination on the task five others
  // were waiting behind. The doctrine now names `run_agent`. This is the
  // backstop for when it tags an agent anyway: the record says plainly that
  // nothing was sent, instead of the tag going nowhere in silence.
  // Ruling 252: the sentence itself now lives beside the resolver, because the
  // controller and a mid-run agent needed the same one.
  // Ruling 262: all of them, in one sentence, from the disclosure resolver.
  const { unreachedAgents, unreachedAgentNote } = await import("./agent-reply.server");
  const note = unreachedAgentNote(
    unreachedAgents(ctx, projectSlug, taskKey, text2),
    "operator",
  );
  const text3 = note ? `${text2}\n\n${note}` : text2;
  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "comment",
    actor: { kind: "operator" },
    title: null,
    text: text3,
    toAgent: false,
    evidence: null,
  };
  const dedupeOn = guardrailOn(ctx, projectSlug, "no-duplicate-summary");
  const compactOn = guardrailOn(ctx, projectSlug, "compression-threshold");
  const compactAt = guardrailValue(ctx, projectSlug, "compression-threshold");
  let suppressed = false;
  await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
    if (dedupeOn) {
      const lastOperator = parsed.timeline.find(
        (e) => e.type === "comment" && e.actor.kind === "operator",
      );
      if (lastOperator && lastOperator.text.trim() === text3.trim()) {
        suppressed = true;
        return;
      }
    }
    parsed.timeline.unshift(event);
    // Timeline compaction (F5/FR17): once a long-running task crosses the
    // compression threshold, collapse OLD routine comments into a marker while
    // keeping every typed governance event, so the canonical file the agents
    // re-anchor on stays readable. The guardrail's CONFIGURED value drives the
    // threshold (it used to be ignored — the settings row advertised 40 while
    // the code hardcoded 60).
    if (compactOn) {
      parsed.timeline = compactTimelineEvents(
        parsed.timeline,
        compactAt != null
          ? {
              threshold: compactAt,
              keepRecent: Math.min(
                DEFAULT_COMPACTION.keepRecent,
                Math.max(4, Math.floor(compactAt / 2)),
              ),
            }
          : DEFAULT_COMPACTION,
      );
    }
  });
  if (suppressed) {
    recordCommentDrop(db, projectSlug, taskKey, variant, "duplicate");
    return { text: null, dropped: "duplicate", trimmedBy: guardrail.trimmedBy };
  }
  reproject(db, ctx, projectSlug, taskKey);
  // NEW-4: the operator is instructed to tag the person it answers ("@Arda …");
  // the tag must actually notify them — same fan-out as every other comment.
  // B-FD8b: scan the caller's ORIGINAL text, not the stored post-trim form — a
  // handle inside a fenced block that evidence-separation cut away must still
  // notify (the record lost the line; the ping must not be lost with it).
  // Ruling 382: and the event records who it reached, so compaction keeps it.
  await stampNotifiedRecipients(
    taskRef(ctx, projectSlug, taskKey),
    event.occurredAt,
    notifyMentionedUsers(db, {
      text,
      projectSlug,
      taskKey,
      from: { kind: "agent", name: "Operator" },
      occurredAt: event.occurredAt,
    }),
  );
  if (variant === "recommend") {
    recordAudit(db, {
      action: "task.operator.recommended",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug,
      taskKey,
      details: {},
    });
  } else {
    recordAudit(db, {
      action: "task.operator.commented",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: taskKey,
      projectSlug,
      taskKey,
      details: {},
    });
  }
  return { text: text3, dropped: null, trimmedBy: guardrail.trimmedBy };
}

/**
 * Record the audit row for a guardrail-dropped operator comment (G1/B-FD8).
 * The operator path used to leave NO trace on a drop — a maintainer asking
 * "why is there no narration for this turn?" had nothing to read. Same action
 * for every silent drop, with the reason in the details.
 */
function recordCommentDrop(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
  variant: "comment" | "recommend",
  reason: "meaningless" | "duplicate",
): void {
  recordAudit(db, {
    action: COMMENT_DROPPED_AUDIT_ACTION,
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: taskKey,
    projectSlug,
    taskKey,
    details: { reason, variant },
  });
}

/**
 * Append a structured, ACTIONABLE operator recommendation to the task (rendered
 * as a one-click Apply/Dismiss card) AND post the operator's reasoning as a
 * comment. Sets waiting=human. Idempotent per (kind, target). This is what a
 * SUPERVISED operator does instead of performing a governed action itself.
 */
interface RecommendationInput {
  kind: RecommendationKind;
  profileId?: string;
  prompt?: string;
  delivers?: boolean;
  toStageId?: string;
  label: string;
  /** accept_completion — ruling 137: the work revision the offer binds to. */
  forHeadSha?: string;
}

async function addRecommendation(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  rec: RecommendationInput,
  reasoning: string,
): Promise<void> {
  const recommendation: Recommendation = {
    id: newId("rec"),
    kind: rec.kind,
    label: rec.label,
    detail: reasoning,
  };
  // A recommendation carries only the targets its kind has — the dedupe below
  // and the card renderer both read these keys' presence.
  if (rec.profileId) recommendation.profileId = rec.profileId;
  if (rec.prompt) recommendation.prompt = rec.prompt;
  if (rec.delivers !== undefined) recommendation.delivers = rec.delivers;
  if (rec.toStageId) recommendation.toStageId = rec.toStageId;
  if (rec.forHeadSha) recommendation.forHeadSha = rec.forHeadSha;
  // Same disclosure the narration path carries (S5-G3): the reasoning is
  // operator prose and can tag a human, so an ambiguous handle must not vanish.
  const commentText = withAmbiguityDisclosure(
    db,
    `**Recommendation:** ${rec.label}. ${reasoning}`,
  );
  let wasNew = false;
  const reasoningAt = new Date().toISOString();
  await updateTaskFile(taskRef(ctx, projectSlug, taskKey), (parsed) => {
    const existing = parsed.frontmatter.recommendations.find(
      (r) =>
        r.kind === rec.kind &&
        r.profileId === rec.profileId &&
        r.toStageId === rec.toStageId,
    );
    if (!existing) {
      parsed.frontmatter.recommendations.push(recommendation);
      wasNew = true;
    } else if (
      existing.prompt !== recommendation.prompt ||
      existing.delivers !== recommendation.delivers ||
      existing.label !== recommendation.label ||
      existing.forHeadSha !== recommendation.forHeadSha
    ) {
      // Hunt 2026-08-29: the per-target dedupe predates `prompt`/`delivers`
      // on run_agent cards, so a NEWER directive for the same agent was
      // silently discarded — the operator narrated Y while Apply dispatched
      // the stale X. A changed directive REPLACES the pending card's content
      // in place (same id, so nothing dangles) and counts as new — it is a
      // fresh decision the supervisors should be pinged about. An identical
      // re-recommendation stays the quiet no-op it always was.
      existing.label = recommendation.label;
      existing.detail = recommendation.detail;
      if (recommendation.prompt !== undefined) existing.prompt = recommendation.prompt;
      else delete existing.prompt;
      if (recommendation.delivers !== undefined) {
        existing.delivers = recommendation.delivers;
      } else {
        delete existing.delivers;
      }
      // Ruling 137: a re-recommended acceptance re-binds to the revision it
      // was authored against, or the card keeps a stale binding.
      if (recommendation.forHeadSha !== undefined) {
        existing.forHeadSha = recommendation.forHeadSha;
      } else {
        delete existing.forHeadSha;
      }
      wasNew = true;
    }
    parsed.frontmatter.waiting = "human";
    parsed.timeline.unshift({
      occurredAt: reasoningAt,
      type: "comment",
      actor: { kind: "operator" },
      title: null,
      text: commentText,
      toAgent: false,
      evidence: null,
    });
  });
  reproject(db, ctx, projectSlug, taskKey);
  recordAudit(db, {
    action: "task.operator.recommended",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: taskKey,
    projectSlug,
    taskKey,
    details: { kind: rec.kind },
  });
  // NEW-4: recommendation reasoning that tags a person pings them too.
  // Ruling 382: and the event records who it reached, so compaction keeps it.
  await stampNotifiedRecipients(
    taskRef(ctx, projectSlug, taskKey),
    reasoningAt,
    notifyMentionedUsers(db, {
      text: commentText,
      projectSlug,
      taskKey,
      occurredAt: reasoningAt,
      from: { kind: "agent", name: "Operator" },
    }),
  );
  // Ping the supervisors: a supervised operator recommendation is a decision
  // waiting on a human. Without this, the recommendation card only appears if
  // someone happens to open the task — the bell and "Waiting on you" inbox stay
  // dark. (Journey 2: blocked tasks must reach a human decision quickly.) Only
  // on a NEW recommendation, so a re-running operator doesn't re-notify the same
  // pending decision every cycle.
  if (wasNew) {
    notifyTaskWatchers(
      db,
      {
        projectSlug,
        taskKey,
        kind: "approval",
        ptype: "input",
        // Ruling 361: the operator's own recommendation, named as such.
        from: OPERATOR_NOTIFY_FROM,
        title: `Operator recommends: ${rec.label}`,
        text: reasoning,
      },
      ctx,
    );
  }
}

/** One option the operator offers on a decision/blocking packet. */
/** Ruling 138: the longest `goalDraft` an option may carry into task.md. */
export const GOAL_DRAFT_MAX_CHARS = 4000;

export interface OperatorPacketOptionInput {
  kind: PacketOptionKind;
  title: string;
  detail?: string;
  recommended?: boolean;
  /** Pre-authored timeline text written when a human chooses this option. */
  ev?: string;
  /** retry_other_backend — the backend to re-run the failed agent on. */
  backend?: "codex" | "claude";
  /** retry_other_backend — a reviewer retry names its profile. Ruling 237:
   *  question_reviewer names the reviewer the question is put to. */
  profileId?: string;
  /** archive_task — also delete the task's remote branch (discard the work). */
  deleteBranch?: boolean;
  /** redirect — ruling 163: the resolution returns the task to the review
   *  stage when it stands at or past it (the branch-conflict packet sets it). */
  rework?: boolean;
  /** move_stage only — ruling 164: the stage id the resolution moves the task
   *  to. Required on the kind and refused on every other one. */
  toStage?: string;
  /** edit_goal only — ruling 138: the proposed goal text itself, what the goal
   *  editor opens with when the human confirms. Refused on any other kind. */
  goalDraft?: string;
  /** wait_for_window only — ruling 224: the provider's own reset instant, ISO.
   *  The resolution schedules the agent's re-dispatch just after it. */
  dueAt?: string;
  /** block_on_dependencies only — ruling 230: the tasks or goal links this one
   *  waits on. The resolution writes them through `setTaskDependencies`, so
   *  Viberr releases the task when the last entry finishes. */
  blockedBy?: string[];
  /** create_task only — ruling 269: the task the resolution creates. Required
   *  on the kind and refused on every other one. */
  newTask?: {
    title: string;
    goal: string;
    /** What the NEW task waits on — not this one. */
    blockedBy?: string[];
    /** Ruling 287: the EXISTING tasks that must wait on the new one. */
    blocks?: string[];
    labels?: string[];
  };
}

export interface OperatorOpenPacketInput {
  projectSlug: string;
  taskKey: string;
  /** input = a decision the human should make; blocked = work is stuck. */
  packetType: "input" | "blocked";
  title: string;
  body?: string;
  observations?: { k: string; v: string; code?: boolean }[];
  options: OperatorPacketOptionInput[];
  /** Ruling 315: the account-level cause that raised this, when the cause is
   *  bigger than the task. Packets sharing it are resolved together. */
  cause?: string;
}

const PACKET_KIND_SET = new Set<string>(PACKET_OPTION_KINDS);

/** `agent_runs.backend` is NOT NULL with a CHECK; `agent_profile_id` is read
 *  as nullable because a row that names no profile must not sink the lookup. */
const lastAgentRunSchema = z.object({
  backend: z.string(),
  agent_profile_id: z.string().nullable(),
});

interface RetryBackendDefaults {
  /** The backend to retry on — the OTHER one from the failure. */
  backend: RealBackend;
  /** The agent to re-run, when one can be identified. */
  profileId?: string;
}

/**
 * B1 — what a `retry_other_backend` option retries ON, when the operator did
 * not say.
 *
 * `resolvePacket` starts the retry with `option.backend ?? "claude"`, so an
 * option written without one ALWAYS re-ran on Claude — including when Claude
 * is exactly what just failed, which makes the recommended recovery path from
 * a Claude quota/auth failure a re-run of the same dead backend. Only the
 * completion pipeline stamped the field; the operator's own authoring
 * surfaces now expose it too, and an option that still arrives without one is
 * stamped here with the SAME rule the completion pipeline uses: the other
 * backend than the one that failed.
 *
 * "The one that failed" is the task's most recent AGENT run (the run a retry
 * re-runs), then the delivering engagement's backend, then the operator's own
 * — a packet authored before any agent ran still names a real target.
 */
function retryOtherBackendDefaults(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
  frontmatter: { engagements: Engagement[] },
  authority: OperatorAuthority,
): RetryBackendDefaults {
  const row = lastAgentRunSchema.safeParse(
    db
      .prepare(
        `SELECT backend, agent_profile_id FROM agent_runs
       WHERE project_slug = ? AND task_key = ? AND kind IN ('primary', 'reviewer')
       ORDER BY rowid DESC LIMIT 1`,
      )
      .get(projectSlug, taskKey),
  );
  const lastAgentRun = row.success ? row.data : null;
  const delivering = deliveringEngagement(frontmatter);
  const failed = lastAgentRun?.backend ?? delivering?.backend ?? authority.backend;
  const profileId = lastAgentRun?.agent_profile_id ?? delivering?.profileId;
  const defaults: RetryBackendDefaults = {
    backend: failed === "codex" ? "claude" : "codex",
  };
  // Stamped so the retry re-runs the agent that failed rather than falling
  // back to the delivering one, and so `withdrawSupersededStuckPacket` joins
  // the packet to the right agent's success.
  if (profileId) defaults.profileId = profileId;
  return defaults;
}

/** Open a typed human-decision packet and notify the task's supervisors. */
/**
 * Ruling 161: the one sentence naming why a `discard_branch` option cannot be
 * offered, from the fact that says the revision left the workspace.
 */
export function revisionDepartureSentence(
  departure: RevisionDeparture,
  taskKey: string,
  branch: string | null,
): string {
  const name = branch ? `\`${branch}\`` : "the task branch";
  switch (departure.kind) {
    case "pr":
      return `PR #${departure.number} tracks ${name}, so it is no longer a local-only branch.`;
    case "unowned_pr":
      return `an unowned PR #${departure.number} stands on the branch name ${name}, so the local/remote framing would mislead.`;
    case "pushed":
      return `${taskKey}'s revision \`${departure.headSha.slice(0, 7)}\` was pushed to origin at ${departure.at}, so discarding the local branch would not remove it.`;
    default: {
      const exhaustive: never = departure;
      return exhaustive;
    }
  }
}

export async function operatorOpenPacket(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: OperatorOpenPacketInput,
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "generate-packets") === "deny") {
    return {
      outcome: "denied",
      message: "The operator cannot open decision packets in this project.",
    };
  }
  const title = input.title.trim();
  if (!title) {
    return { outcome: "noop", message: "A packet needs a title." };
  }
  const rawOptions = input.options ?? [];
  if (rawOptions.length === 0) {
    return { outcome: "noop", message: "A packet needs at least one option." };
  }
  for (const o of rawOptions) {
    if (!PACKET_KIND_SET.has(o.kind)) {
      return {
        // `noop`, not `denied`: nothing about the operator's POLICY refused
        // this — the option was malformed. `denied` is reserved for authority
        // refusals so the plan narration can name the real reason.
        outcome: "noop",
        message: `Unknown packet option kind "${o.kind}". Valid kinds: ${PACKET_OPTION_KINDS.join(", ")}.`,
      };
    }
  }

  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) {
    return { outcome: "noop", message: `Task ${input.taskKey} not found.` };
  }
  // Ruling 177 (pass 36, F36-5): no decision packet on a closed task. The
  // operator that outlives an acceptance (its turn started before the human
  // accepted) reaches this writer with a plan authored for an open task; the
  // packet it wants would ask a person to decide something about a task that
  // is already Shipped or archived.
  {
    const packetProject = readProjectFile({ projectSlug: input.projectSlug, dataRoot: ctx.dataRoot });
    const closure = packetProject
      ? taskClosure(existing.parsed.frontmatter, packetProject.parsed.frontmatter.stages)
      : ({ closed: false } as const);
    if (closure.closed && packetProject) {
      return {
        outcome: "noop",
        message: closureRefusal(
          input.taskKey,
          closure,
          packetProject.parsed.frontmatter.stages,
          "opening a decision packet on it",
        ),
      };
    }
  }
  // F31-6: option/semantics coherence, checked where the option is AUTHORED.
  // `discard_branch` deletes the LOCAL, never-pushed branch and destroys its
  // commits — offered on a task whose revision has LEFT the workspace (a PR
  // tracks the branch, a stranger's PR stands on the name, or a delivery push
  // published the head), the human's confirm ceremony would truthfully promise
  // the opposite of the option's text (live-caught: an operator authored
  // "delete the conflicting REMOTE branch and push this task's commit fresh"
  // onto a discard_branch option — confirming it would have destroyed the
  // delivery it promised to push). Refuse the authoring and name the verb that
  // fits.
  //
  // Ruling 161 (pass 35, G35-6): the gate keys on `revisionLeftWorkspace`, not
  // on `workRevision !== null`. The revision registry writes a revision when
  // the agent's completion report lands, before any push, so "has a revision"
  // refused the discard on exactly the branch it exists for (KNC-21: reported
  // 18:56Z, push refused 19:10Z, discard refused 19:3xZ, and the only door left
  // was archiving the task). A reported head that never reached origin is the
  // task's local draft; the refusal names the real reason when one applies.
  if (rawOptions.some((o) => o.kind === "discard_branch")) {
    const fm = existing.parsed.frontmatter;
    const departure = revisionLeftWorkspace(fm);
    if (departure) {
      return {
        outcome: "noop",
        message:
          `discard_branch only fits a branch whose revision never left the workspace (ruling 161): ` +
          `${revisionDepartureSentence(departure, input.taskKey, fm.branch)} ` +
          "For a task-key branch collision (an unrelated remote branch or unowned PR under this task's branch name), offer resolve_remote_collision: the human's confirm closes the unowned PR, deletes the stale remote branch, and re-delivers this task's local work. To abandon pushed or tracked work entirely, offer archive_task with deleteBranch.",
      };
    }
  }
  // Owner ruling (pass 32): an `accept_completion` option is only coherent at
  // the acceptance boundary with a healthy verdict — everywhere else the
  // acceptance gate refuses the very decision the option offers (ruling 20:
  // verdict-gated; ruling 62: a no-change completion needs one too), and the
  // human is left confirming a card that cannot succeed. Live (VIB-3): a triage
  // packet offered "Accept as complete now" on a task at Triage with no
  // verdict. Refuse the authoring, name the verbs that fit; the admin's own
  // force-accept exists for "just close it".
  if (rawOptions.some((o) => o.kind === "accept_completion")) {
    const fm = existing.parsed.frontmatter;
    const projectFile = readProjectFile({
      projectSlug: input.projectSlug,
      dataRoot: ctx.dataRoot,
    });
    const stages = projectFile?.parsed.frontmatter.stages ?? [];
    const boundaryStageId = stages.length >= 2 ? stages[stages.length - 2]!.id : null;
    const atBoundary = boundaryStageId !== null && fm.stage === boundaryStageId;
    const verdictHealthy = fm.validation === "healthy";
    if (!atBoundary || !verdictHealthy) {
      return {
        outcome: "noop",
        message:
          "accept_completion only fits a task AT the acceptance boundary with a healthy verdict — " +
          (!atBoundary
            ? `${input.taskKey} is at stage ${fm.stage}, not the stage before Done. `
            : "its validation is not healthy, so acceptance would be refused. ") +
          "Offer archive_task to close a task that needs no work, edit_goal to scope real work, or transition_stage / run_agent to move it toward review. Only a human admin can force-accept from here.",
      };
    }
  }
  // Ruling 244 (pass 37, F37-73): the same rule the `accept_completion` arm
  // above applies, applied to its sibling. `resolve_remote_collision` clears a
  // FOREIGN remote — ruling 122's case, an unrelated branch or an unowned PR
  // squatting this task's branch name — and V19 put `unownedPr` in the
  // operator's own snapshot precisely so it can tell. With no collision
  // recorded, the resolution takes ruling 136(b)'s `own_pr_open` arm, answers
  // "No collision to clear: PR #N on `branch` is TASK's own review PR", and
  // leaves the block exactly where it was.
  //
  // Live on SHOP-11: a rebase diverged the branch from its own PR #15, the
  // operator offered this as the RECOMMENDED option promising to close PR #15
  // and delete the remote, a person confirmed it through the destructive-action
  // ceremony that names deleting a branch, and the answer was "The block
  // stays." The decision was spent, the packet was gone, and nothing had
  // happened — which is what the accept_completion refusal exists to prevent:
  // "the human is left confirming a card that cannot succeed."
  if (rawOptions.some((o) => o.kind === "resolve_remote_collision")) {
    const fm = existing.parsed.frontmatter;
    const unowned = fm.github?.unownedPr ?? null;
    if (unowned === null) {
      const own = fm.pr?.number ? `its own review PR #${fm.pr.number}` : "no unowned PR";
      return {
        outcome: "noop",
        message:
          `resolve_remote_collision only fits a FOREIGN remote under ${input.taskKey}'s branch name ` +
          `(an unrelated branch, or a pull request this task does not own). ` +
          `${input.taskKey} records no collision — the branch carries ${own} — so the resolution ` +
          `would answer "no collision to clear" and leave the block where it is. ` +
          "For a branch whose history diverged from its own PR, a person resolves the history: " +
          "offer custom naming what they must do, or archive_task with deleteBranch to abandon it.",
      };
    }
  }
  // B3: one open decision at a time, the same refusal every sibling packet
  // writer makes (`openStuckLoopPacket`, `openAgentQuestionPacket`). This
  // writer alone assigned `parsed.packet` unconditionally, so a second packet
  // REPLACED the open one: a human mid-answer got "this decision was replaced
  // by a newer one" and the question they were answering vanished — and an
  // agent's own `ask_human` packet could be overwritten by an operator turn
  // that never read it. Prompt text asked the model not to; nothing enforced
  // it. Withdraw the open packet first (`resolve_decision_packet`) when it is
  // genuinely moot.
  if (existing.parsed.packet) {
    return {
      outcome: "noop",
      message:
        `A decision packet is already open on ${input.taskKey} ("${existing.parsed.packet.title}"). ` +
        "Answer from it, or withdraw it with resolve_decision_packet if it is moot, before opening another.",
    };
  }

  // Ruling 164 (pass 35, F35-14): an option TITLE is a promise the resolution
  // keeps, and the send-back kinds (custom / redirect / request_edit) keep no
  // promise but "the agent side hears about it". KNC-3's custom "Force-accept
  // as admin without a fresh verdict" re-ran the operator into a no-op behind
  // the verdict gate; KNC-16's redirect "Move KNC-16 back to Review" moved
  // nothing. Refuse the authoring where the option is written and name the kind
  // that performs the act. The stage list is this project's own, so the move
  // detector recognises the board's real stage names.
  {
    const projectStages = readProjectFile({
      projectSlug: input.projectSlug,
      dataRoot: ctx.dataRoot,
    })?.parsed.frontmatter.stages ?? [];
    for (const o of rawOptions) {
      const promise = misdirectedOptionPromise(
        {
          kind: o.kind,
          title: o.title,
          detail: o.detail ?? "",
          // Ruling 163: the branch-conflict packet's rework redirect really
          // does return the task to the review stage, and says so.
          rework: o.rework === true,
        },
        projectStages,
      );
      if (promise) {
        return {
          outcome: "noop",
          message: misdirectedPromiseRefusal(promise, o, input.taskKey),
        };
      }
    }
    // `move_stage` names the stage it moves to, and only that kind carries the
    // field: the same two refusals `resolvePacket` makes, made here so the
    // option is never written in a shape the confirm would refuse.
    // Ruling 269: `create_task` carries the task it will create, and only that
    // kind reads it — the same two refusals `move_stage` gets, for the same
    // reason: an option must never be written in a shape the confirm refuses.
    // Ruling 273 (pass 37, F37-106): a retry onto a backend the instance
    // ALREADY knows is spent. The same rule the `accept_completion` and
    // `resolve_remote_collision` guards apply — "the human is left confirming
    // a card that cannot succeed" — on the kind whose whole job is recovery.
    // Live on SHOP-37: Codex had been recorded exhausted for the owner's
    // credential since 03:26 ("try again at Sep 19th"), the operator
    // recommended "Re-run the Integration Verifier on the Codex backend" at
    // 09:0x, a person confirmed it, and the answer was "The retry could not
    // start: Held: Codex is out of quota until Sep 19… scheduled for then."
    // Nothing lied and nothing was lost — the hold is ruling 152(c) working —
    // but the decision was spent on a four-day park that was knowable when the
    // option was written. `wait_for_window` is the honest kind for that, and
    // ruling 224 built it for exactly this fact.
    if (rawOptions.some((o) => o.kind === "retry_other_backend")) {
      const ownerId = existing.parsed.frontmatter.ownerUserId;
      const retryTargets = rawOptions
        .filter((o) => o.kind === "retry_other_backend")
        .map((o) => ({ option: o, backend: o.backend ?? null }));
      for (const target of retryTargets) {
        const backend = target.backend;
        if (!backend || !ownerId) continue;
        const hold = backendDispatchHold(db, backend, { credentialUserId: ownerId });
        if (!hold) continue;
        const label = backend === "codex" ? "Codex" : "Claude";
        const until = hold.until
          ? ` until ${new Date(hold.until).toISOString()}`
          : "";
        return {
          outcome: "noop",
          message:
            `"${target.option.title}" retries on ${label}, and this instance already recorded ` +
            `${label} as out of quota for ${input.taskKey}'s owner${until} — the dispatch would ` +
            `be HELD and re-scheduled rather than run, so the person would spend a decision on a ` +
            `wait. Offer the OTHER backend, or offer wait_for_window with dueAt set to the reopen ` +
            `instant, which resumes by itself and says so.`,
        };
      }
    }
    const strayNewTask = rawOptions.find(
      (o) => o.kind !== "create_task" && o.newTask !== undefined,
    );
    if (strayNewTask) {
      return {
        outcome: "noop",
        message:
          `newTask only fits a create_task option. "${strayNewTask.title}" is ` +
          `${strayNewTask.kind}, and its resolution creates nothing.`,
      };
    }
    const emptyNewTask = rawOptions.find(
      (o) =>
        o.kind === "create_task" &&
        ((o.newTask?.title ?? "").trim() === "" || (o.newTask?.goal ?? "").trim() === ""),
    );
    if (emptyNewTask) {
      return {
        outcome: "noop",
        message:
          `"${emptyNewTask.title}" is a create_task option with no task on it. ` +
          "Give newTask a title and a goal — the goal is the contract the new task is " +
          "worked to, so write it as one (deliverable plus acceptance criteria). " +
          "Without them the confirm would create nothing.",
      };
    }
    // Ruling 288 (F37-123): a goal too long to carry is REFUSED, never cut. Both
    // of these texts become a task's CONTRACT — the one document every future
    // run on it re-anchors on (ruling 189) — and both were a bare
    // `.slice(0, GOAL_DRAFT_MAX_CHARS)`, so an over-long draft was committed
    // ending mid-sentence with nothing anywhere saying it had been cut.
    //
    // Live on SHOP-29 this afternoon: a person's decision asked the operator to
    // write the REASONING into a corrected acceptance criterion, precisely so a
    // later reader would not "fix" it back. The draft came out at 4,000
    // characters exactly, ending "…a 403 there would be", and the sentence
    // carrying the reason was gone. The editor showed it as ordinary text. Only
    // counting the characters revealed it, and the operator's own words were
    // unrecoverable by then — the slice happened at write time, so what was cut
    // was never stored anywhere.
    //
    // Refusing is ruling 139's rule applied to prose: check before anything is
    // written, name what is wrong, and write nothing. The operator can shorten
    // and re-offer inside the same turn; a truncated contract cannot be
    // repaired by anyone who does not already know what it said.
    const tooLong = rawOptions.find(
      (o) =>
        (o.goalDraft ?? "").trim().length > GOAL_DRAFT_MAX_CHARS ||
        (o.newTask?.goal ?? "").trim().length > GOAL_DRAFT_MAX_CHARS,
    );
    if (tooLong) {
      const draftLen = (tooLong.goalDraft ?? "").trim().length;
      const which =
        draftLen > GOAL_DRAFT_MAX_CHARS
          ? { field: "goalDraft", len: draftLen }
          : { field: "newTask.goal", len: (tooLong.newTask?.goal ?? "").trim().length };
      return {
        outcome: "noop",
        message:
          `"${tooLong.title}" carries a ${which.field} of ${which.len.toLocaleString("en-US")} ` +
          `characters and the limit is ${GOAL_DRAFT_MAX_CHARS.toLocaleString("en-US")}. ` +
          `Nothing was written. A goal is the contract every future run on the task ` +
          `re-anchors on, so Viberr will not commit one that stops mid-sentence — shorten ` +
          `it and offer the option again. Cut narrative and worked examples before you cut ` +
          `a deliverable or an acceptance criterion; detail that does not fit belongs in ` +
          `the packet's own text or a comment, which have no such limit.`,
      };
    }
    const strayStage = rawOptions.find(
      (o) => o.kind !== "move_stage" && (o.toStage ?? "").trim() !== "",
    );
    if (strayStage) {
      return {
        outcome: "noop",
        message:
          `toStage only fits a move_stage option. "${strayStage.title}" is ${strayStage.kind}, ` +
          "and its resolution reads no stage.",
      };
    }
    for (const o of rawOptions) {
      if (o.kind !== "move_stage") continue;
      const target = moveStageTarget(o, projectStages, input.taskKey);
      if (!target.ok) {
        return { outcome: "noop", message: target.refusal };
      }
      if (target.stage.id === existing.parsed.frontmatter.stage) {
        return {
          outcome: "noop",
          message:
            `${input.taskKey} already stands at ${target.stage.name}, so "${o.title}" would move ` +
            "nothing. Offer the stage the work should be shown at, or a kind that acts on the task.",
        };
      }
      // Ruling 164 again, on the kind that carries BOTH a title and a target:
      // the card shows the words and the resolution reads the id, so a title
      // naming another stage is the same broken promise the send-back guard
      // above refuses — invisible to the person confirming it.
      const mismatch = moveStagePromiseMismatch(o, target.stage, projectStages, input.taskKey);
      if (mismatch) return { outcome: "noop", message: mismatch };
    }
    // `force_accept` is the admin override of a WEDGED gate. A pull request a
    // person closed unmerged is not wedged, it is decided (R16-3), and the
    // force path refuses it: an option offered there promises a close the
    // confirm cannot perform.
    const forceOption = rawOptions.find((o) => o.kind === "force_accept");
    if (forceOption && acceptanceTerminallyBlocked(existing.parsed.frontmatter)) {
      return {
        outcome: "noop",
        message:
          `force_accept cannot close ${input.taskKey}: its pull request was closed without ` +
          "merging, which no override can undo. Offer archive_task (with deleteBranch to " +
          "discard the work) or a redirect that delivers again.",
      };
    }
  }

  // Ruling 138: `goalDraft` is the goal editor's prefill, which only an
  // `edit_goal` option opens — on any other kind it is a claim nothing reads,
  // so the authoring is refused by name (the ruling-115 precedent above).
  const strayDraft = rawOptions.find(
    (o) => o.kind !== "edit_goal" && (o.goalDraft ?? "").trim() !== "",
  );
  if (strayDraft) {
    return {
      outcome: "noop",
      message:
        `goalDraft only fits an edit_goal option — "${strayDraft.title}" is ${strayDraft.kind}. ` +
        "Put the proposed goal text on the edit_goal option, or drop it.",
    };
  }

  // Ruling 224: a wait_for_window with no instant resolves into a schedule
  // with no due time, so it is refused by name like every other option whose
  // payload its kind requires.
  const strayWait = rawOptions.find(
    (o) => o.kind === "wait_for_window" && !(o.dueAt ?? "").trim(),
  );
  if (strayWait) {
    return {
      outcome: "noop",
      message:
        `A wait_for_window option needs the instant the window reopens — "${strayWait.title}" carries none. ` +
        "Pass dueAt as an ISO timestamp, or offer a different recovery.",
    };
  }
  const strayDue = rawOptions.find(
    (o) => o.kind !== "wait_for_window" && (o.dueAt ?? "").trim() !== "",
  );
  if (strayDue) {
    return {
      outcome: "noop",
      message:
        `dueAt only fits a wait_for_window option — "${strayDue.title}" is ${strayDue.kind}. ` +
        "Drop it, or offer the wait as its own option.",
    };
  }

  // Ruling 237 (F37-57): a question_reviewer names the reviewer it questions,
  // and that reviewer must be one this task actually has. Without the check the
  // resolution would promise "ask X" and then either dispatch nobody or, worse,
  // start the DELIVERER with a prompt telling it not to review — and the person
  // who chose the option would read a card that said otherwise.
  const strayQuestion = rawOptions.find(
    (o) => o.kind === "question_reviewer" && !(o.profileId ?? "").trim(),
  );
  if (strayQuestion) {
    return {
      outcome: "noop",
      message:
        `A question_reviewer option needs the reviewer it asks — "${strayQuestion.title}" names none. ` +
        "Pass profileId, or put the question in a comment instead.",
    };
  }
  const wrongQuestion = rawOptions.find(
    (o) =>
      o.kind === "question_reviewer" &&
      !existing.parsed.frontmatter.engagements.some(
        (e) => e.profileId === o.profileId && !e.delivers,
      ),
  );
  if (wrongQuestion) {
    return {
      outcome: "noop",
      message:
        `"${wrongQuestion.profileId}" is not a reviewer engaged on ${input.taskKey}, so a question_reviewer ` +
        `option cannot put a question to it — "${wrongQuestion.title}". ` +
        "Name an engaged non-delivering agent, or engage one first.",
    };
  }

  // Ruling 230: a hold that names nothing to wait on resolves into a hold that
  // releases on nothing — the task would sit with no dependencies, no run and
  // no owner. Refused by name like every other option whose payload its kind
  // requires.
  const strayHold = rawOptions.find(
    (o) =>
      o.kind === "block_on_dependencies" &&
      (o.blockedBy ?? []).filter((e) => e.trim() !== "").length === 0,
  );
  if (strayHold) {
    return {
      outcome: "noop",
      message:
        `A block_on_dependencies option needs the work it waits on — "${strayHold.title}" names none. ` +
        "Pass blockedBy as task keys or goal links, or offer a different hold.",
    };
  }
  const strayBlockedBy = rawOptions.find(
    (o) => o.kind !== "block_on_dependencies" && (o.blockedBy ?? []).length > 0,
  );
  if (strayBlockedBy) {
    return {
      outcome: "noop",
      message:
        `blockedBy only fits a block_on_dependencies option — "${strayBlockedBy.title}" is ${strayBlockedBy.kind}. ` +
        "Drop it, or offer the hold as its own option.",
    };
  }

  // Ruling 226: the head-check override is the policy engine's to offer and
  // nobody else's. It is granted against a triple the gate read live at the
  // moment it refused, so an operator authoring it from a stale board would be
  // offering a waiver over facts it never checked — and the thing being waived
  // is the last guard between a review and the base branch.
  const strayWaiver = rawOptions.find((o) => o.kind === "accept_unverified_head");
  if (strayWaiver) {
    return {
      outcome: "noop",
      message:
        `accept_unverified_head is not an option you can offer — "${strayWaiver.title}". ` +
        "The acceptance gate writes it itself when GitHub refuses the head comparison, " +
        "pinned to the shas it read at that moment.",
    };
  }

  // Exactly one recommended option (the parser expects this): honour the first
  // one the operator marked, else default to the first option.
  let recSeen = false;
  const retryDefaults = rawOptions.some((o) => o.kind === "retry_other_backend")
    ? retryOtherBackendDefaults(
        db,
        input.projectSlug,
        input.taskKey,
        existing.parsed.frontmatter,
        authority,
      )
    : null;
  const options: PacketOption[] = rawOptions.map((o) => {
    const rec = !recSeen && o.recommended === true;
    if (rec) recSeen = true;
    // B1: a retry option ALWAYS names the backend it retries on — an unnamed
    // one silently resolved to Claude, i.e. a re-run of whatever just failed.
    const retry = o.kind === "retry_other_backend" ? retryDefaults : null;
    const backend = o.backend ?? retry?.backend;
    const profileId = o.profileId ?? retry?.profileId;
    const option: PacketOption = {
      kind: o.kind,
      t: o.title.trim() || o.kind,
      d: (o.detail ?? "").trim(),
      rec,
    };
    // Each of these exists on the stored option ONLY when it was supplied —
    // `resolvePacket` branches on their presence.
    if (o.ev) option.ev = o.ev;
    if (backend) option.backend = backend;
    if (profileId) option.profileId = profileId;
    // U36-2 (pass 36): a branchless task has no branch to delete — the option
    // must not promise it, and the card's recovery paragraph keys on it.
    if (o.deleteBranch && existing.parsed.frontmatter.branch) option.deleteBranch = true;
    // Ruling 163: only a redirect returns the task to the review stage.
    if (o.rework && o.kind === "redirect") option.rework = true;
    // Ruling 164: the stage a move_stage resolution moves to, validated above.
    if (o.kind === "move_stage" && o.toStage) option.toStage = o.toStage.trim();
    // Ruling 224: only a wait_for_window carries the reset instant, and it is
    // useless without one — an option promising to resume "when the window
    // reopens" with no instant would resolve into a schedule with no due time.
    if (o.kind === "wait_for_window" && o.dueAt) option.dueAt = o.dueAt;
    if (o.kind === "block_on_dependencies" && o.blockedBy?.length) {
      option.blockedBy = [...o.blockedBy];
    }
    // Ruling 269: the task the create_task resolution will make, validated
    // above. Trimmed here, the one chokepoint both operator backends reach.
    if (o.kind === "create_task" && o.newTask) {
      const newTask: NonNullable<PacketOption["newTask"]> = {
        title: o.newTask.title.trim(),
        // Ruling 288: within the cap by construction — an over-long goal was
        // refused above, with nothing written.
        goal: o.newTask.goal.trim(),
      };
      if (o.newTask.blockedBy?.length) newTask.blockedBy = [...o.newTask.blockedBy];
      // Ruling 287: the reverse edge reaches the stored option, which is the
      // only place the resolver can read it from.
      if (o.newTask.blocks?.length) newTask.blocks = [...o.newTask.blocks];
      if (o.newTask.labels?.length) newTask.labels = [...o.newTask.labels];
      option.newTask = newTask;
    }
    // Ruling 138: the draft is model-authored prose bound for task.md — capped
    // here, the one chokepoint both operator backends reach.
    const goalDraft = o.goalDraft?.trim();
    // Ruling 288: within the cap by construction (refused above). It was a
    // silent `.slice` here, which is how a contract came to end mid-sentence.
    if (goalDraft) option.goalDraft = goalDraft;
    return option;
  });
  if (!recSeen && options[0]) options[0].rec = true;

  const packet: TaskPacket = {
    id: newId("pkt"), // F10-09: stable identity for concurrent-resolution safety
    type: input.packetType,
    kind: input.packetType === "blocked" ? "Blocked decision" : "Decision required",
    from: "operator",
    title,
    body: (input.body ?? "").trim(),
    observations: (input.observations ?? []).map((o) => ({
      k: o.k,
      v: o.v,
      code: o.code ?? false,
    })),
    options,
  };
  // Ruling 315: an account-level cause travels onto the packet, so a sibling
  // raised by the same failure can be found when this one is answered.
  if (input.cause) packet.cause = input.cause;

  let opened = false;
  // Ruling 137: a packet pauses coordination, so the standing acceptance
  // offers (and the terminal transition cards, acceptances too) are withdrawn
  // on the record inside the same locked write.
  const packetCause: OfferWithdrawalCause = { kind: "packet", title };
  const terminalStageId = terminalStageIdFor(ctx, input.projectSlug);
  const packetWithdrawal: OfferWithdrawalSlot = { offers: null };
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    // Re-check inside the locked write — the read above raced other writers
    // (the same guard `openAgentQuestionPacket` makes).
    if (parsed.packet) return;
    parsed.packet = packet;
    opened = true;
    packetWithdrawal.offers = withdrawAcceptanceOffers(parsed, terminalStageId, packetCause, {
      kind: "operator",
    });
    parsed.frontmatter.waiting = "human";
    if (input.packetType === "blocked") {
      // Blocked-ness lives on `readiness` alone (F7-VAL1). It used to ALSO set
      // validation="failing", but `validation` is REVIEW health — only a
      // reviewer verdict or an acceptance owns it. A blocked packet from an
      // unrelated cause (e.g. a commit was denied, a run crashed) then made the
      // acceptance gate refuse with "the latest review is failing — rework and
      // re-review", which is nonsense when no review ever ran. The readiness
      // flag already gates the board; validation stays whatever review left it.
      parsed.frontmatter.readiness = "blocked";
    }
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: input.packetType === "blocked" ? "blocked" : "comment",
      actor: { kind: "operator" },
      title,
      text:
        input.packetType === "blocked"
          ? `**Blocked:** ${title}. Opened a decision packet for the owner to resolve.`
          : `**Decision packet:** ${title}. Awaiting a human decision.`,
      toAgent: false,
      evidence: null,
    });
  });
  if (!opened) {
    return {
      outcome: "noop",
      message: `Another decision packet was opened on ${input.taskKey} first; this one was not written.`,
    };
  }
  reproject(db, ctx, input.projectSlug, input.taskKey);
  if (packetWithdrawal.offers) {
    recordRecommendationWithdrawal(db, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      withdrawal: packetWithdrawal.offers,
      cause: packetCause,
      actor: OPERATOR_AUDIT_ACTOR,
    });
  }
  recordAudit(db, {
    action: "task.operator.packet_opened",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { type: input.packetType },
  });
  const notifiedUserIds = notifyTaskWatchers(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      kind: "packet",
      ptype: input.packetType,
      // Ruling 361: the operator's own packet.
      from: OPERATOR_NOTIFY_FROM,
      title:
        input.packetType === "blocked"
          ? `Blocked, decision needed: ${title}`
          : `Decision needed: ${title}`,
      text: packet.body || title,
    },
    ctx,
  );
  return {
    outcome: "done",
    notifiedUserIds,
    message: `Opened a ${input.packetType === "blocked" ? "blocking" : "decision"} packet with ${options.length} option(s).`,
  };
}

/**
 * WITHDRAW the task's open decision packet — the operator's own cleanup for a
 * packet that has become moot (the input it asked for was provided out-of-band,
 * e.g. a human edited the goal instead of clicking an option). Same authority
 * as opening one (generate-packets). Restores `readiness` when the packet was
 * the thing that blocked it, and writes a typed timeline note so the decision
 * log shows WHY the packet disappeared. No-op when no packet is open.
 */
export async function operatorResolvePacket(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "generate-packets") === "deny") {
    return {
      outcome: "denied",
      message: "The operator cannot manage decision packets in this project.",
    };
  }
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) {
    return { outcome: "noop", message: `Task ${input.taskKey} not found.` };
  }
  const packet = existing.parsed.packet;
  if (!packet) {
    return { outcome: "noop", message: "No open decision packet to resolve." };
  }
  // B2: withdraw only what the OPERATOR raised. `generate-packets` + "a packet
  // exists" was the whole check, so the operator could silently withdraw an
  // agent's `ask_human` question — the agent stays blocked on an answer that
  // now has no surface, and the R15-14 `askedBy` resume (which fires from the
  // human's resolution) never runs. `from` is stamped by the writer:
  // "operator" here, the agent's actor ref in `buildAgentQuestionPacket`.
  if (packet.from !== "operator" || packet.askedBy) {
    // F39-10: `noop` — WHO raised the open packet is task state, the same kind
    // of fact as "no open decision packet to resolve" one branch above, which
    // has always been a noop. `generate-packets` is granted either way.
    return {
      outcome: "noop",
      message:
        `The open packet "${packet.title}" was raised by ${packet.from}, not by you. ` +
        "Only a human can resolve an agent's question. Answer it in a comment or leave it standing.",
    };
  }
  const reason =
    (input.reason ?? "").trim() ||
    "The input it asked for has since been provided.";
  let withdrawn = false;
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    // Re-check inside the locked write — the read above raced other writers.
    // Both halves matter: the packet standing NOW must still be the operator's
    // (never an agent question that landed in the window), and it must be the
    // same packet this decision was made about (F10-09 ids).
    const current = parsed.packet;
    if (!current || current.from !== "operator" || current.askedBy) return;
    if (packet.id && current.id !== packet.id) return;
    parsed.packet = null;
    withdrawn = true;
    // A blocked packet set readiness=blocked when it opened — withdrawing the
    // packet lifts that (a genuine standing block would re-assert itself).
    if (packet.type === "blocked" && parsed.frontmatter.readiness === "blocked") {
      parsed.frontmatter.readiness = "ready";
    }
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "transition",
      actor: { kind: "operator" },
      title: null,
      text: `**Packet withdrawn:** ${packet.title}. ${reason}`,
      toAgent: false,
      evidence: null,
    });
  });
  if (!withdrawn) {
    return {
      outcome: "noop",
      message: `The open packet on ${input.taskKey} changed before it could be withdrawn; nothing was removed.`,
    };
  }
  reproject(db, ctx, input.projectSlug, input.taskKey);
  markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.operator.packet_withdrawn",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { title: packet.title, reason },
  });
  return { outcome: "done", message: `Withdrew the packet "${packet.title}".` };
}

// ------------------------------------------------- KB-vs-repository conflict

/** R19-2 — the timeline title a context conflict always carries. */
export const CONTEXT_CONFLICT_TITLE =
  "Knowledge base disagrees with the repository";

export interface ContextConflict {
  /** The knowledge-base document that disagrees. */
  kbSource: string;
  /** The repository file that is authoritative. */
  repoSource: string;
  /** One or two sentences: what each says, and what was followed. */
  detail: string;
}

/**
 * R19-2 (ruling 56) — a KB-vs-repo disagreement is a `quality` flag on the
 * timeline. The existing type carries exactly this meaning: nothing was
 * violated (`policy`) and nothing is stuck (`blocked`), but a human must see
 * that two sources of convention disagree about the same repository. It already
 * renders as "Quality flag" and is already a notification kind, so no new
 * timeline type is added — `TIMELINE_EVENT_TYPES` is untouched.
 *
 * The event states the RULING as its first words, because the record is also
 * what the next agent re-anchors on: the repository won, and here is what lost.
 */
export function contextConflictEvent(
  actor: TaskFileEvent["actor"],
  conflict: ContextConflict,
): TaskFileEvent {
  return {
    occurredAt: new Date().toISOString(),
    type: "quality",
    actor,
    title: CONTEXT_CONFLICT_TITLE,
    text:
      `**The repository wins:** \`${conflict.repoSource}\` is authoritative; the knowledge base ` +
      `\`${conflict.kbSource}\` says otherwise. ${conflict.detail}`,
    toAgent: false,
    evidence: null,
  };
}

// -------------------------------------------------- propose a ruling change

export const RULING_PROPOSAL_TITLE = "Ruling contradicted by evidence";

/** The heading every proposal is filed under, in the settled document itself.
 *  One constant so the writer and the reader cannot disagree about it. */
export const PROPOSED_RULINGS_HEADING = "## Proposed (not binding)";

export interface RulingProposal {
  /** Document path inside the project's rulings knowledge base. */
  doc: string;
  /** What should change, in the operator's own words. */
  text: string;
  /** What proves it: the command and its output, a run id, a verdict. */
  evidence: string;
}

/**
 * F39-1/F39-7 (pass 39, owner ruling): the operator may PROPOSE a change to the
 * project's settled rulings, in the rulings document itself, and nothing more.
 *
 * Before this, nothing inside the delivery loop could write the rulings KB. The
 * operator's toolkit had no KB write, specialists have none, and the controller
 * only runs when a human talks to it — so a ruling that turned out to be FALSE
 * kept being injected into every run as binding truth. Live in pass 39 the
 * rulings demanded `go test -race ./...`; the host has `CGO_ENABLED=0` and no C
 * compiler; the delivering agent proved it, the reviewer re-proved it
 * independently, the operator wrote "the ruling is contradicted by evidence,
 * remedy: update the ruling" — as a COMMENT, because that was the only surface
 * it had — and the false requirement went on propagating into every goal the
 * operator drafted afterwards.
 *
 * The proposal is appended under {@link PROPOSED_RULINGS_HEADING} in the named
 * document. It never edits a settled line and never removes one: promotion is a
 * human or controller edit, exactly as before. What changes is that the fact now
 * lands where the rule lives, next to the rule it contradicts, and every run
 * reads it with the rule.
 */
export async function operatorProposeRuling(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string } & RulingProposal,
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const doc = input.doc.trim();
  const text = input.text.trim();
  // Both surfaces label the field themselves ("Evidence: …"), and a model that
  // writes the label into the VALUE is not wrong — it is answering a field
  // called `evidence`. Strip one leading label rather than printing
  // "Evidence: Evidence:" into the rulings document and the timeline, which is
  // what the first live proposal did.
  const evidence = input.evidence.trim().replace(/^evidence\s*:\s*/i, "").trim();
  if (!doc || !text || !evidence) {
    return {
      outcome: "noop",
      message:
        "A proposal needs all three: the rulings document to amend, what should change, and the evidence that proves it. Nothing was written.",
    };
  }
  if (gate(authority, "append-typed-events") === "deny") {
    return {
      outcome: "denied",
      message: "The operator cannot post events in this project.",
    };
  }
  const { listKnowledgeBases, resolveStoreTarget } = await import(
    "~/server/org/resources.server"
  );
  const { writeStoreDoc } = await import("~/server/org/store-files.server");
  const project = readProjectFile({
    projectSlug: input.projectSlug,
    dataRoot: ctx.dataRoot,
  });
  const rulingsDir = project?.parsed.frontmatter.rulingsKb ?? null;
  if (!rulingsDir) {
    return {
      outcome: "noop",
      message:
        `${input.projectSlug} names no rulings knowledge base, so there is no settled document to amend. ` +
        "Say what you found on the timeline instead, and an org admin can set one (Org settings, or ask the controller).",
    };
  }
  const seedCtx = ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {};
  const kb =
    listKnowledgeBases(db, seedCtx).find((row) => row.dir === rulingsDir) ?? null;
  const target = kb ? resolveStoreTarget(db, "kb", kb.id, seedCtx) : null;
  if (!target) {
    return {
      outcome: "noop",
      message: `The rulings knowledge base "${rulingsDir}" is named by ${input.projectSlug} but no longer resolves in the store. Nothing was written.`,
    };
  }
  // The document has to be one the KB really holds: a typo would otherwise
  // CREATE a settled-looking document nobody asked for.
  const name = doc.replace(/^\/+/, "").split("/").pop() ?? doc;
  const abs = path.join(target.rootAbs, name);
  let existing: string;
  try {
    existing = readFileSync(abs, "utf8");
  } catch {
    const held = readdirSync(target.rootAbs)
      .filter((f) => !f.startsWith("."))
      .sort();
    return {
      outcome: "noop",
      message:
        `"${name}" is not a document in the rulings knowledge base ${rulingsDir}. Nothing was written. ` +
        (held.length > 0
          ? `It holds: ${held.join(", ")}.`
          : "It holds no documents."),
    };
  }
  const entry =
    `- **[${input.taskKey}, ${new Date().toISOString().slice(0, 10)}]** ${text}\n` +
    `  Evidence: ${evidence}\n`;
  const body = existing.includes(PROPOSED_RULINGS_HEADING)
    ? existing.replace(
        PROPOSED_RULINGS_HEADING,
        `${PROPOSED_RULINGS_HEADING}\n\n${entry.trimEnd()}`,
      )
    : `${existing.trimEnd()}\n\n${PROPOSED_RULINGS_HEADING}\n\n` +
      "Raised by an operator from evidence on a task. **Nothing here is binding.** " +
      "A human or the controller promotes an entry into the settled text above, or deletes it.\n\n" +
      entry;
  writeStoreDoc(db, target, [], name, body, OPERATOR_AUDIT_ACTOR, {
    overwrite: true,
  });
  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "quality",
    actor: { kind: "operator" },
    title: RULING_PROPOSAL_TITLE,
    text:
      `**Proposed, not binding:** ${text} ` +
      `Filed under "${PROPOSED_RULINGS_HEADING.replace(/^#+ /, "")}" in \`${rulingsDir}/${name}\`, ` +
      `which every run on this project reads. Evidence: ${evidence}`,
    toAgent: false,
    evidence: null,
  };
  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.timeline.unshift(event);
    },
  );
  reproject(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.operator.ruling_proposed",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { rulingsKb: rulingsDir, doc: name, bytes: entry.length },
  });
  // A settled ruling is a human's to change; the proposal is worth nothing if
  // it only exists in a document nobody re-reads.
  notifyTaskWatchers(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      kind: "quality",
      title: RULING_PROPOSAL_TITLE,
      text: event.text,
      occurredAt: event.occurredAt,
      from: OPERATOR_NOTIFY_FROM,
    },
    ctx,
  );
  return {
    outcome: "done",
    message: `Proposed against \`${rulingsDir}/${name}\`. It is NOT binding: a human promotes or deletes it.`,
  };
}

// ------------------------------------------------------------- snapshot

export interface OperatorTaskSnapshot {
  key: string;
  title: string;
  goal: string;
  /** R26-1 (owner ruling): the human triage metadata, surfaced to the OPERATOR
   *  (not the delivering agent) so it can factor urgency and deadlines into how it
   *  sequences work and what it recommends. Purely informational — it changes no
   *  gate and grants no authority. `priority: "normal"`, an empty label set and a
   *  null due date are the unremarkable defaults. */
  priority: string;
  labels: string[];
  dueDate: string | null;
  /** Ruling 131(d): what the task waits on, each entry with its live state.
   *  Non-empty means the task is HELD: the doctrine replaces the stage rule. */
  blockedBy: DependencyRender[];
  stage: string;
  stageName: string;
  /** Dynamic-dispatch rework (2026-08-29): where the task CAME from — the
   *  durable `previousStageId` frontmatter fact, named so the agent choice can
   *  weigh it (a task back in the work stage from Review is rework for the
   *  same builder; a fresh arrival wants a first hand-off). Null until the
   *  task's first transition. */
  previousStage: { id: string; name: string } | null;
  readiness: string;
  waiting: string;
  /** F27-O5: the DERIVED review outcome on the current revision — `healthy`
   *  (every required reviewer approved), `failing` (a required reviewer requested
   *  changes), `changed` (a revision under review, verdicts pending), or `none`
   *  (nothing delivered). The operator used to infer this from the timeline
   *  window alone; naming it here makes review state explicit and robust to a
   *  long/noisy timeline. Advisory context, not authority — acceptance is still
   *  gated server-side. */
  validation: string;
  owner: string | null;
  specialist: { profileId: string; role: string; backend: string } | null;
  /** `verdict` is each reviewer's OWN verdict on the current revision (F27-O5):
   *  `approve` | `request_changes`, or `null` when it has not weighed in yet. */
  reviewers: {
    profileId: string;
    role: string;
    backend: string;
    verdict: "approve" | "request_changes" | null;
    /** Ruling 193: successive delivered revisions this reviewer has requested
     *  changes on, counted back from its newest verdict and stopping at its
     *  first `approve`. `0` when its newest verdict is an approval or it has
     *  not weighed in. Two or more means the same objection survived a rework,
     *  which is when re-prompting the deliverer stops being the move. Optional
     *  so hand-built fixtures need not restate it; `operatorSnapshot` always
     *  sets it. */
    consecutiveRequestChanges?: number;
  }[];
  /** Ruling 178: the reviewers the PROJECT requires, per review stage,
   *  resolved to the names the acceptance gate prints. Each must hold an
   *  `approve` verdict on the delivered revision before acceptance, engaged
   *  or not — `reviewers` above lists only who the operator has engaged.
   *  Optional so hand-built fixtures need not restate it; `operatorSnapshot`
   *  always sets it. */
  requiredReviewers?: RequiredReviewerView[];
  /** Stages the task may move to next (declared workflow boundaries). */
  nextStages: { id: string; name: string; boundary: string }[];
  /** R7-4 rework routing, made VISIBLE. The governed workflow graph is
   *  forward-only, so `nextStages` never contains an earlier stage — and an
   *  operator reading only that field concludes it cannot send failed work
   *  back, which is exactly what happened live: a reviewer requested changes,
   *  the operator reported "there is no Review → In Progress transition
   *  available to me" and parked the task on a human, while the move was
   *  legal all along. These are the earlier stages the operator MAY move the
   *  task to directly, no human and no recommendation. Non-empty only while
   *  the latest review is `failing` — the same gate `transitionStage` vets. */
  reworkStages: { id: string; name: string }[];
  /** All stage ids in workflow order (first → done). Lets a coordinator tell a
   *  pre-work stage from the implementation stage from the review stage. */
  stageIds: string[];
  /** The last stage id — reached only via accept_completion. */
  doneStageId: string | null;
  /** The review stage id (edge into Done) — resolved from the workflow graph,
   *  NOT positionally, so custom/lightweight boards classify correctly. */
  reviewStageId: string | null;
  /** The implementation ("work") stage id (edge into review). */
  workStageId: string | null;
  deployedSpecialists: (DeployedSpecialistView & {
    /** Whether this profile may RUN the task at its CURRENT stage: its
     *  declared eligibility, or (ruling 133) it is the task's engaged
     *  deliverer, which runs at every stage. Declared eligibility alone is
     *  where a profile may be NEWLY engaged. */
    eligibleForCurrentStage: boolean;
    /** Ruling 133: this profile is the task's delivering engagement. */
    engagedAsDeliverer: boolean;
    /** F21-16: the specialist's OWN capabilities, resolved live from its
     *  deployment grants — the right place to look when a human asks whether an
     *  agent's grant took effect. `DeployedSpecialistView.capabilities` already
     *  carries `browser`; `web` (`use-web-search-fetch`) is added here because
     *  it is the row the operator misattributed to itself. */
    capabilities: DeployedSpecialistView["capabilities"] & { web: boolean };
  })[];
  openPacket: boolean;
  /** The open decision packet's CONTENT (null when none) — the operator needs
   *  it to judge whether the packet is now moot (resolve_decision_packet)
   *  rather than only knowing "a packet exists". */
  packet: {
    type: "input" | "blocked";
    title: string;
    body: string;
    options: string[];
    /** Ruling 138: `goal_edit` once an edit_goal option was confirmed — the
     *  packet is decided and waits for the edited goal, so do not re-ask. */
    awaiting: "goal_edit" | null;
  } | null;
  recentTimeline: OperatorTimelineRow[];
  /** Ruling 302: how many entries this task's timeline HAS, against the
   *  `recentTimeline.length` shown. Present always, so a coordinator never has
   *  to infer from a full-looking window that it saw everything. */
  timelineTotal: number;
  /** Ruling 302: present ONLY when entries were left out, naming the count and
   *  the way to reach them. */
  timelineOlder?: string;
  /** [1] The coordinator's OWN proposals — what it already asked for, and what a
   *  human already refused. Without this the supervised loop spins: a supervisor
   *  declines "move to Review", the next drive cannot see the refusal (the
   *  dismissal clears the card, and `addRecommendation`'s duplicate guard
   *  compares only against still-PENDING cards), so it proposes the identical
   *  thing and re-pings the same supervisors.
   *
   *  BOUNDED on purpose — the whole snapshot is JSON-embedded in the operator
   *  prompt (buildCodexOperatorPrompt) and returned verbatim by `get_task`: at
   *  most MAX_SNAPSHOT_RECOMMENDATIONS entries per list, each label capped at
   *  RECOMMENDATION_LABEL_CAP characters.
   *
   *  `declined` reads the `task.recommendation.dismissed` audit rows — which had
   *  no reader anywhere in the product before this — so this list is bounded by
   *  the 90-day audit retention. The DURABLE trace of a refusal is the typed
   *  timeline event `dismissRecommendation` writes
   *  (RECOMMENDATION_DECLINED_TITLE); that one lives in task.md for good and is
   *  what the operator re-reads through `recentTimeline`.
   *
   *  Optional only so hand-built test fixtures need not restate it (same reason
   *  as `repo`/`noChanges`); `operatorSnapshot` always sets it. */
  recommendations?: {
    /** Still awaiting a human — do NOT re-propose these. */
    pending: {
      id: string;
      kind: string;
      label: string;
      /** Target profile id (assign/run recommendations), when the kind has one. */
      profileId: string | null;
      /** transition target stage id, when the kind carries one. */
      toStageId: string | null;
    }[];
    /** Already REFUSED by a human, newest first. Re-proposing one of these is
     *  the loop this field exists to stop. */
    declined: { kind: string; label: string; at: string }[];
  };
  /** P13-D-4: the review PR, or null. The operator used to be structurally
   *  blind to it — no `pr` field anywhere in the snapshot — so it could neither
   *  see that a human had CLOSED the PR on GitHub (an out-of-band rejection)
   *  nor reason about it before recommending/accepting completion. `state` is
   *  the task-file cache vocabulary: review | merged | closed | accepted.
   *
   *  F21-17: `revisionDrift` is the same fact the acceptance ceremony discloses
   *  (R17-1) — commits pushed to the PR head AFTER the last reviewed revision.
   *  The operator was structurally blind to it, so its PR-closed recovery packet
   *  could say "the review before closure was clean (Approve)" while an
   *  unreviewed out-of-band commit the reconciler had already seen went
   *  unmentioned. Null when the head equals the reviewed revision.
   *
   *  Ruling 132 (pass 34, F34-14): the WHOLE record, plus the canonical
   *  sentence (`describeRevisionDrift`) the accept dialog prints, so the
   *  operator's read and the ceremony can never say two different things. */
  pr:
    | {
        number: number;
        state: PrState;
        title: string;
        revisionDrift: RevisionDrift | null;
        /** `describeRevisionDrift(revisionDrift).sentence`, empty for none. */
        revisionDriftSentence: string;
        /** Ruling 135 (pass 34, F34-11): the PR head as last read, the CURRENT
         *  unpushed record (null when the delivered revision is on the PR or
         *  the fact was never measured), and the sentence the acceptance gate
         *  refuses with ("" when none). An unpushed revision reaches its PR
         *  through `deliver_for_review`; it is never a person's push. */
        headSha: string | null;
        unpushedRevision: UnpushedRevision | null;
        unpushedRevisionSentence: string;
        /** Ruling 162 (pass 35, F35-12): GitHub's mergeability as the
         *  reconciler last read it (`conflicting` is the fact the acceptance
         *  gate refuses on); null when never read or settled. Optional only so
         *  hand-built fixtures need not restate it; the producer always sets it. */
        mergeable?: PrMergeable | null;
      }
    | null;
  /** Ruling 162 (pass 35, F35-12): the acceptance gate's own refusal, computed
   *  by the SAME function every acceptance surface reads
   *  (`acceptanceRefusalFor`), or null when the task could be accepted now.
   *  A PR the gate would refuse cannot be recommended for acceptance and the
   *  task cannot be moved into the acceptance stage; open the conflict packet
   *  (or deliver the unpushed revision) instead. Optional only so hand-built
   *  fixtures need not restate it; `operatorSnapshot` always sets it. */
  notAcceptableReason?: string | null;
  /** The task's delivery branch (null before any delivery). Lets recovery
   *  packets name the branch a `deleteBranch` archive option would remove. */
  branch: string | null;
  /** V19: an unrelated PR squatting this task's branch name (R15-15 collision,
   *  recorded by the reconciler as `github.unownedPr`). The operator was
   *  structurally blind to the collision at the exact moment it must author a
   *  `resolve_remote_collision` packet — the Collision card row and the
   *  refusal notes rendered it for humans only, so the model had to guess from
   *  timeline prose. Null when no collision is recorded.
   *
   *  Optional only so hand-built test fixtures need not restate it; the real
   *  producer (`operatorSnapshot`) always sets it. */
  unownedPr?: number | null;
  /** Ruling 161 (pass 35, U35-8): origin's copy of the task branch carries
   *  commits this task did not author, as the reconciler last recorded it
   *  (`github.foreignHead`): the head sha when GitHub named one and the
   *  unowned PR when one stands. Name it in an `archive_task` option's text
   *  when offering `deleteBranch`: deleting the branch removes those commits
   *  too. Null when the head is this task's or was never read. Optional only
   *  so hand-built fixtures need not restate it; `operatorSnapshot` sets it. */
  foreignHead?: ForeignBranchHead | null;
  /** F37-11 (pass 37): how many commits the BASE is ahead of this task's
   *  branch, from the reconciler's last compare — the same reading the GitHub
   *  page's sync pill renders. `0` = level with the base, `null` = no pass has
   *  compared this task yet. Informational: a stale or absent reading must
   *  never stop an update, it only stops the step being planned blind. */
  baseBehindBy?: number | null;
  /** R19-1: the project's repository ("owner/name"), or null when none is
   *  attached. The coordinator used to be blind to it — it could not even NAME
   *  the repository it operates on, which is part of how it came to call its own
   *  task folder "the repo" (F19-4). It now works inside a read-only checkout of
   *  that repository (owner ruling 2026-08-06), so naming it is table stakes.
   *
   *  Optional only so hand-built test fixtures need not restate it (same
   *  reason as `noChanges`); `operatorSnapshot` always sets it. */
  repo?: string | null;
  /** R19-8: this task is a no-change completion — nothing was delivered and
   *  there is nothing to merge. Accept it with `accept_completion`; do NOT call
   *  `deliver_for_review` and do NOT open a decision packet asking a human how
   *  to close it out. The operator used to be structurally blind to the shape,
   *  which is how VC-5 became a "how do we close this out?" packet whose
   *  recommended option was "Manually mark Done" (F19-21).
   *
   *  Optional only so hand-built test fixtures need not restate it; the real
   *  producer (`operatorSnapshot`) always sets it. */
  noChanges?: boolean;
  /** Queued/running agent runs on THIS task — the ONLY truth for "a run is
   *  in flight". Live-caught: the operator inferred an in-flight deliverer
   *  from `waiting: "agent"` (a board display flag) plus its own directive
   *  comment, when the prompt's run had actually REFUSED to start — so the
   *  rework never resumed. An empty list here means nothing is running,
   *  whatever the timeline or `waiting` suggest. */
  liveRuns: {
    kind: "operator" | "primary" | "reviewer";
    profileId: string | null;
    state: "queued" | "running";
  }[];
  autonomy: OperatorAutonomy;
  /**
   * F21-16 — the operator's OWN capability policy, LABELLED as its own.
   *
   * This used to be a bare `policy: Record<string, string>` sitting next to
   * `deployedSpecialists`, with nothing in the payload saying whose policy it
   * was. Live (VIB-5): a human granted the Web Verifier profile web + browser,
   * the operator read `use-web-search-fetch: off` out of THIS map — its own
   * egress row, withheld from the coordinator on purpose — and generated a
   * "Web egress grant did not take effect" packet about the specialist. The
   * specialist's next run mounted the browser fine. A model cannot be blamed
   * for reading an unlabelled map as the only policy in the payload, so the
   * payload now names the scope and points at the right place for the other
   * one (`deployedSpecialists[].capabilities`).
   */
  operatorPolicy: {
    /** Always `"operator"` — whose capabilities these are. */
    scope: "operator";
    /** One line the model reads before it quotes a row at anybody. */
    note: string;
    /** capabilityId → mode the OPERATOR holds (the RBAC its own tools honor). */
    capabilities: Record<string, string>;
  };
  /**
   * F31-3 — the INSTANCE resource catalog, names only. Every other field here
   * is project-scoped, so a goal citing a knowledge base that existed at the
   * org level but was granted to no deployed profile read as "does not exist"
   * in a live packet headline. These lists answer the EXISTENCE half: a name
   * here but under no `deployedSpecialists[].resources` means "exists, not
   * granted on this project" — the remedy is granting it from the project's
   * Agents surface, never re-creating it. Names only, bounded by the org
   * catalog's own size; optional so hand-built fixtures need not restate it
   * (`operatorSnapshot` always sets it).
   */
  orgResources?: { kbs: string[]; skills: string[]; mcps: string[] };
}

/** [1] Hard bound on `snapshot.recommendations`: the whole snapshot is
 *  JSON-embedded in the operator prompt, so neither list may grow with the
 *  task's age. Five is enough to stop a re-proposal loop — the operator only
 *  needs to recognise the card it is about to raise. */
const MAX_SNAPSHOT_RECOMMENDATIONS = 5;
/** Labels are model-authored prose; cap them so five entries stay small. */
const RECOMMENDATION_LABEL_CAP = 160;

function capRecommendationLabel(label: string): string {
  return label.length > RECOMMENDATION_LABEL_CAP
    ? label.slice(0, RECOMMENDATION_LABEL_CAP - 1) + "…"
    : label;
}

/** One refused recommendation, as the snapshot states it. */
interface DeclinedRecommendation {
  kind: string;
  label: string;
  /** When the human refused it (the audit row's `occurred_at`). */
  at: string;
}

/** `audit_events.occurred_at` is TEXT NOT NULL; `details_json` is nullable. */
const dismissalRowsSchema = z.array(
  z.object({ occurred_at: z.string(), details_json: z.string().nullable() }),
);

/** A dismissal's details. A row that cannot name WHAT was declined is worse
 *  than silent — it would tell the model "something was refused" with nothing
 *  to match on — so `label` is required and a junk `kind` degrades instead. */
const dismissalDetailsSchema = z.object({
  kind: z.string().catch("unknown"),
  label: z.string().min(1),
});

/**
 * [1] The recommendations a human already REFUSED on this task, newest first.
 *
 * Reads the audit rows `dismissRecommendation` writes — the structured
 * kind+label pair, rather than re-parsing the prose of the timeline event. This
 * also gives `task.recommendation.dismissed` its first reader anywhere in the
 * product. Bounded by the 90-day audit retention; the durable refusal record is
 * the timeline event (RECOMMENDATION_DECLINED_TITLE), not this list.
 */
function declinedRecommendations(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): DeclinedRecommendation[] {
  const rows = dismissalRowsSchema.parse(
    db
      .prepare(
        `SELECT occurred_at, details_json FROM audit_events
        WHERE project_slug = ? AND task_key = ? AND action = ?
        ORDER BY occurred_at DESC, rowid DESC
        LIMIT ?`,
      )
      .all(
        projectSlug,
        taskKey,
        RECOMMENDATION_DISMISSED_AUDIT_ACTION,
        MAX_SNAPSHOT_RECOMMENDATIONS,
      ),
  );
  return rows.flatMap((row) => {
    if (!row.details_json) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(row.details_json);
    } catch {
      return [];
    }
    const details = dismissalDetailsSchema.safeParse(raw);
    if (!details.success) return [];
    return [
      {
        kind: details.data.kind,
        label: capRecommendationLabel(details.data.label),
        at: row.occurred_at,
      },
    ];
  });
}

/**
 * F21-16 — the sentence that stops the operator quoting its own policy at a
 * specialist. It ships INSIDE the payload (not only in the manual) because the
 * misread happened while the model was reading this exact object.
 *
 * Also carries the F21-14 acceptance exception: the same live operator that
 * misread the scope of this map also read `transition-to-done: human` off it and
 * posted "I can't accept completion myself", then accepted 60 seconds later.
 * `transition-to-done` is the RAW stage transition; acceptance is
 * `completion-for-acceptance`, and the two rows answer different questions.
 */
export const OPERATOR_POLICY_SCOPE_NOTE =
  "These capabilities are YOURS, the operator's, and nobody else's. They say NOTHING about what a " +
  "specialist agent may do: an agent's own grants are in `deployedSpecialists[].capabilities` " +
  "(delivery / verdict / askHuman / browser / web), resolved live from its profile. Never quote a " +
  "row from here as evidence about an agent — e.g. `use-web-search-fetch: off` here means YOUR web " +
  "egress is withheld, not that a specialist's web grant failed to take effect. " +
  "Acceptance: `completion-for-acceptance: direct` plus task autonomy `full` IS the sanctioned " +
  "route to Done — call `accept_completion` and say so plainly. `transition-to-done: human` is the " +
  "RAW stage transition (`transition_stage` into the terminal stage), which stays human-only; it is " +
  "not a bar on the acceptance action, so never narrate that you cannot accept while you hold that grant.";

/**
 * F21-16 — does this deployed specialist actually hold web egress?
 *
 * Resolved from the deployment's own grants, with the same polarity the run path
 * uses (`deploymentGrants` + `effectiveCollabMode`): an EMPTY grant list is not
 * "no opinion" but a fully WITHHELD profile (P13-AP-06), so it must not fall
 * through to the catalog's granted-by-default egress.
 */
function specialistWebGranted(
  deployments: readonly { profileId: string; capabilities: CapabilityGrant[] }[],
  profileId: string,
): boolean {
  const deployment = deployments.find((d) => d.profileId === profileId);
  if (!deployment) return false;
  const grants =
    deployment.capabilities.length > 0
      ? deployment.capabilities
      : withheldAgentGrants();
  return effectiveCollabMode(grants, "use-web-search-fetch") === "direct";
}

/** `users.name` is TEXT NOT NULL; a missing row simply has no owner name. */
const userNameSchema = z.object({ name: z.string() });

/** `agent_runs.kind` and `state` are NOT NULL under CHECK constraints, and the
 *  query narrows `state` further to the two live values. */
const liveRunRowsSchema = z.array(
  z.object({
    kind: z.enum(["operator", "primary", "reviewer"]),
    agent_profile_id: z.string().nullable(),
    state: z.enum(["queued", "running"]),
  }),
);

/** Read-only task snapshot for the operator's `get_task` tool. */
/**
 * Ruling 302: how many timeline entries `get_task` returns by default, and the
 * most it will return when asked. The controller's own `get_task` has taken an
 * `events` count (1..50, default 12) for as long as it has existed; the
 * operator's took no arguments at all and returned six.
 */
export const OPERATOR_TIMELINE_DEFAULT = 6;
export const OPERATOR_TIMELINE_MAX = 50;

/** One row of {@link OperatorTaskSnapshot.recentTimeline} — the shape the
 *  snapshot builder writes and the operator reads. Named rather than inline so
 *  the builder and the contract cannot drift over what `clipped` means. */
export interface OperatorTimelineRow {
  /** Ruling 285: the ADDRESS `read_timeline_entry` takes. */
  occurredAt: string;
  type: string;
  actor: string;
  text: string;
  /** Ruling 285: present ONLY when the text was cut, naming the tool that
   *  returns it whole. */
  clipped?: string;
}

export function operatorSnapshot(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  authority: OperatorAuthority,
  events: number = OPERATOR_TIMELINE_DEFAULT,
): OperatorTaskSnapshot {
  const file = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!file) throw AppError.notFound(`Task ${taskKey} not found.`);
  const project = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!project) throw AppError.notFound(`Project ${projectSlug} not found.`);

  const fm = file.parsed.frontmatter;
  // F37-11: the reconciler's own last compare, read the same way the GitHub
  // page's sync pill reads it.
  const behindByLookup = createReconcileBehindByLookup(db);
  // Ruling 302: the window, clamped the way the controller's own `events` is.
  const timelineWindow = Math.min(
    Math.max(Math.trunc(events), 1),
    OPERATOR_TIMELINE_MAX,
  );
  const orgCtx: { dataRoot?: string } = ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {};
  const stages = project.parsed.frontmatter.stages;
  const workflow = project.parsed.frontmatter.workflow;
  const stageName = (id: string) => stages.find((s) => s.id === id)?.name ?? id;
  const roles = resolveStageRoles(stages, workflow);
  const doneStageId = roles.terminalId;

  const nextStages = workflow.flatMap((w) =>
    w.from === fm.stage
      ? [{ id: w.to, name: stageName(w.to), boundary: w.boundary }]
      : [],
  );
  // R7-4: the rework license, listed rather than left to be inferred. Same
  // predicate `isReworkMove` vets on the way in (backward + validation
  // failing), so what this offers is exactly what transition_stage accepts.
  // Ruling 163 (pass 35, F35-13): a revision that CHANGED after a verdict is
  // rework by definition, so a task past the review stage with `validation:
  // changed` may go back to the review stage (and only there) for its
  // re-verdict; `failing` keeps the whole backward license.
  const currentStageIndex = stages.findIndex((s) => s.id === fm.stage);
  const changedTarget =
    fm.validation === "changed"
      ? verdictStageFor({ stages, workflow }, fm, listDeployedSpecialists(projectSlug, ctx))
      : null;
  const reworkStages =
    fm.validation === "failing" && currentStageIndex > 0
      ? stages
          .slice(0, currentStageIndex)
          .map((s) => ({ id: s.id, name: s.name }))
      : changedTarget !== null
        ? stages
            .filter((s) => s.id === changedTarget)
            .map((s) => ({ id: s.id, name: s.name }))
        : [];

  const ownerName = fm.ownerUserId
    ? (userNameSchema.safeParse(
        db.prepare(`SELECT name FROM users WHERE id = ?`).get(fm.ownerUserId),
      ).data?.name ?? null)
    : null;

  const snapshot: OperatorTaskSnapshot = {
    key: fm.key,
    title: fm.title,
    goal: file.parsed.goal,
    // R26-1: surface the human triage metadata to the operator.
    priority: fm.priority,
    labels: fm.labels,
    dueDate: fm.dueDate,
    blockedBy: resolveDependencies(db, projectSlug, fm.blockedBy),
    stage: fm.stage,
    stageName: stageName(fm.stage),
    previousStage: fm.previousStageId
      ? { id: fm.previousStageId, name: stageName(fm.previousStageId) }
      : null,
    readiness: fm.readiness,
    waiting: fm.waiting,
    // F27-O5: the explicit derived review outcome, so review state does not have
    // to be reconstructed from the timeline window alone.
    validation: deriveValidation(fm),
    owner: ownerName,
    specialist: (() => {
      const delivering = deliveringEngagement(fm);
      return delivering
        ? {
            profileId: delivering.profileId,
            role: delivering.role,
            backend: delivering.backend,
          }
        : null;
    })(),
    reviewers: (() => {
      const cur = currentVerdicts(fm);
      const verdictOf = (
        profileId: string,
      ): "approve" | "request_changes" | null => {
        const r = cur.find((v) => v.profileId === profileId)?.result;
        return r === "approve" || r === "request_changes" ? r : null;
      };
      return supportingEngagements(fm).map((r) => ({
        profileId: r.profileId,
        role: r.role,
        backend: r.backend,
        verdict: verdictOf(r.profileId),
        // Ruling 193: how many successive DELIVERED REVISIONS this reviewer
        // has requested changes on. One is ordinary review. A run of them on
        // revisions that keep changing is the shape of an objection the work
        // cannot satisfy, and the operator could not see it: the snapshot
        // showed only the current revision's verdict, so every round looked
        // like the first.
        consecutiveRequestChanges: consecutiveRequestChanges(fm, r.profileId),
      }));
    })(),
    // Ruling 178: from the project file, resolved the way the gate prints it.
    requiredReviewers: resolveRequiredReviewers(project.parsed.frontmatter, ctx.dataRoot),
    nextStages,
    reworkStages,
    stageIds: stages.map((s) => s.id),
    doneStageId,
    reviewStageId: roles.reviewId,
    workStageId: roles.workId,
    deployedSpecialists: listDeployedSpecialists(projectSlug, ctx).map((s) => ({
      ...s,
      // Ruling 133: may this profile RUN here (declared, or the engaged
      // deliverer), not only "may it be newly engaged here".
      eligibleForCurrentStage: runEligibilityFor(
        s,
        file.parsed.frontmatter.engagements,
        s.id,
        file.parsed.frontmatter.stage,
        { stages, workflow },
      ).ok,
      engagedAsDeliverer: file.parsed.frontmatter.engagements.some(
        (e) => e.profileId === s.id && e.delivers,
      ),
      // F21-16: the specialist's own egress row, so the operator has somewhere
      // TRUE to look when it is asked whether an agent's web grant took effect.
      capabilities: {
        ...s.capabilities,
        web: specialistWebGranted(project.parsed.frontmatter.agents, s.id),
      },
    })),
    openPacket: !!file.parsed.packet,
    packet: file.parsed.packet
      ? {
          type: file.parsed.packet.type,
          title: file.parsed.packet.title,
          body: file.parsed.packet.body,
          options: file.parsed.packet.options.map((o) => o.t),
          awaiting: file.parsed.packet.awaiting ?? null,
        }
      : null,
    timelineTotal: file.parsed.timeline.length,
    recentTimeline: file.parsed.timeline.slice(0, timelineWindow).map((e) => {
      // Timeline comments store the agent's FULL report (no 1,200-char cap
      // since 2026-07-17) — cap here so six entries can't balloon the prompt.
      //
      // Ruling 285 (F37-120): the cap stays and the ADDRESS ships with it. The
      // stamp is what `read_timeline_entry` takes, and a clipped entry says it
      // is clipped — an entry that ends mid-sentence with a "…" and no way to
      // ask for the rest is how a coordinator states half a report as the whole
      // of it, which it did, live, on SHOP-42.
      const clipped = e.text.length > 1500;
      const row: OperatorTimelineRow = {
        occurredAt: e.occurredAt,
        type: e.type,
        actor:
          e.actor.kind === "human"
            ? (e.actor.nameHint ?? "human")
            : e.actor.kind,
        text: clipped ? e.text.slice(0, 1497) + "…" : e.text,
      };
      if (clipped) {
        row.clipped =
          "cut at 1,500 chars — read_timeline_entry with this occurredAt returns it whole";
      }
      return row;
    }),
    // [1] What this coordinator already proposed, and what a human already
    // refused — the two facts it needed to stop re-proposing a declined move.
    recommendations: {
      pending: fm.recommendations
        .slice(0, MAX_SNAPSHOT_RECOMMENDATIONS)
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          label: capRecommendationLabel(r.label),
          profileId: r.profileId ?? null,
          toStageId: r.toStageId ?? null,
        })),
      declined: declinedRecommendations(db, projectSlug, taskKey),
    },
    // P13-D-4: expose the review PR. `state: "closed"` means a human closed it
    // on GitHub WITHOUT merging — an out-of-band rejection the operator must
    // not paper over by recommending or accepting completion.
    pr: fm.pr
      ? {
          number: fm.pr.number,
          state: fm.pr.state,
          title: fm.pr.title,
          // F21-17 / ruling 132: the drift record verbatim from the same field
          // the acceptance ceremony reads, and the same sentence it prints.
          revisionDrift:
            describeRevisionDrift(fm.pr.revisionDrift).kind !== "none"
              ? (fm.pr.revisionDrift ?? null)
              : null,
          revisionDriftSentence: describeRevisionDrift(fm.pr.revisionDrift).sentence,
          headSha: fm.pr.headSha ?? null,
          unpushedRevision: unpushedRevisionOf(
            fm.pr,
            activeWorkRevision(fm.workRevision)?.headSha ?? null,
          ),
          unpushedRevisionSentence:
            unpushedRevisionBlockedReason(
              fm.pr,
              activeWorkRevision(fm.workRevision)?.headSha ?? null,
              taskKey,
            ) ?? "",
          // Ruling 162: the fact the acceptance gate refuses on, exposed as the
          // reconciler recorded it (settled PRs carry none).
          mergeable:
            fm.pr.state === "review" || fm.pr.state === "accepted"
              ? (fm.pr.mergeable ?? null)
              : null,
        }
      : null,
    // Ruling 162 (pass 35, F35-12): the acceptance gate's verdict, from the ONE
    // function every acceptance surface reads. KNC-6 and KNC-20 were
    // recommended for acceptance with `pr.mergeable: conflicting` already on
    // the file; the operator's snapshot simply did not carry the fact.
    notAcceptableReason: acceptanceRefusalFor({ projectSlug, taskKey }, ctx),
    // The task branch, so recovery copy can NAME what an `archive_task`
    // option with `deleteBranch: true` would delete instead of gesturing at
    // "the branch".
    branch: fm.branch ?? null,
    // V19: the recorded branch-name collision, so the operator can author
    // `resolve_remote_collision` from a fact instead of timeline prose.
    unownedPr: fm.github?.unownedPr ?? null,
    // Ruling 161: what origin's branch holds when it is not this task's work.
    foreignHead: fm.github?.foreignHead ?? null,
    // F37-11 (pass 37): how the branch stands against the base, read from the
    // reconciler's own last compare — the same row the GitHub page's sync pill
    // renders. Without it the operator planned `update_branch_from_base` on
    // EVERY delivery and the server answered "already up to date" every time:
    // eight of the pass's nine "plan was not carried out in full" notes were
    // this one step. `null` means no pass has compared this task yet, which is
    // "unknown" and never an excuse to skip the call.
    baseBehindBy: behindByLookup(
      storeRelativePath(
        resolveTaskFilePath(taskRef(ctx, projectSlug, taskKey)),
        ctx.dataRoot,
      ),
    ),
    // R19-1: name the repository the read-only view reads.
    repo: project.parsed.frontmatter.repo ?? null,
    // R19-8: the "nothing to deliver" shape, stated outright.
    noChanges: noChangeApplies(fm),
    liveRuns: liveRunRowsSchema
      .parse(
        db
          .prepare(
            `SELECT kind, agent_profile_id, state FROM agent_runs
           WHERE project_slug = ? AND task_key = ?
             AND state IN ('queued', 'running')
           ORDER BY rowid`,
          )
          .all(projectSlug, taskKey),
      )
      .map((r) => ({
        kind: r.kind,
        profileId: r.agent_profile_id,
        state: r.state,
      })),
    autonomy: authority.autonomy,
    operatorPolicy: {
      scope: "operator",
      note: OPERATOR_POLICY_SCOPE_NOTE,
      capabilities: Object.fromEntries(authority.policy),
    },
    // F31-3: instance catalog names, so "does not exist" claims are checkable.
    // Names-only readers (V12): the snapshot backs `get_task`, the operator's
    // most-called tool — the full view builders walk every KB/skill store
    // directory and read every SKILL.md body, all discarded for `.name`.
    orgResources: {
      kbs: listKnowledgeBaseNames(db, orgCtx),
      skills: listSkillNames(db, orgCtx),
      mcps: listMcpServerNames(db),
    },
  };
  if (snapshot.timelineTotal > snapshot.recentTimeline.length) {
    // Ruling 302: the same rule the per-ENTRY clip beside it already follows.
    // A window that does not say it is a window is how a coordinator states
    // part of a history as the whole of it.
    const older = snapshot.timelineTotal - snapshot.recentTimeline.length;
    snapshot.timelineOlder =
      `${older} older ${older === 1 ? "entry is" : "entries are"} not shown, newest first. ` +
      `Call get_task with events up to ${OPERATOR_TIMELINE_MAX} to widen this window, ` +
      "and read_timeline_entry with an occurredAt for one in full.";
  }
  return snapshot;
}

// ------------------------------------------------------------- actions

/** Post an operator comment (governed by append-typed-events). */
export async function operatorPostComment(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; text: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const text = input.text.trim();
  if (!text) return { outcome: "noop", message: "Empty comment ignored." };
  if (gate(authority, "append-typed-events") === "deny") {
    return { outcome: "denied", message: "The operator cannot post events in this project." };
  }
  const result = await writeOperatorComment(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
    text,
    "comment",
  );
  // G1/B-FD8: report the REAL outcome. A guardrail drop returns `noop` (a
  // task-state refusal, not an authority one) so the Codex plan executor's
  // `record()` — which captures denied/noop — narrates it instead of the run
  // settling to `waiting:human` with no trace; the SDK path gets the honest
  // message so the model can rephrase rather than build on narration nobody saw.
  if (result.dropped) {
    return { outcome: "noop", message: commentOutcomeMessage(result) };
  }
  return { outcome: "done", message: commentOutcomeMessage(result) };
}

/**
 * R19-2 — record a KB-vs-repository conflict as a typed `quality` event.
 *
 * The ruling has two halves and this is the second: the repository wins, AND
 * the disagreement is never settled quietly. Live (Q19-2) a KB-granted Codex
 * developer followed the knowledge base's pass-note format while a KB-less
 * Claude writer followed `qa/smoke/README.md` and flagged the KB-shaped files
 * as non-conforming — two agents, one repo, two house styles, and nothing on
 * the timeline said why. A precedence rule with no visible record just moves
 * the silence.
 *
 * Gated on `append-typed-events` — this writes to the canonical record, so it
 * answers to the same capability as every other operator-authored event.
 */
export async function operatorFlagContextConflict(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string } & ContextConflict,
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const kbSource = input.kbSource.trim();
  const repoSource = input.repoSource.trim();
  const detail = input.detail.trim();
  if (!kbSource || !repoSource) {
    return {
      outcome: "noop",
      message:
        "A conflict needs BOTH sources named: the knowledge-base document and the repository file it disagrees with.",
    };
  }
  if (gate(authority, "append-typed-events") === "deny") {
    return {
      outcome: "denied",
      message: "The operator cannot post events in this project.",
    };
  }
  const event = contextConflictEvent(
    { kind: "operator" },
    { kbSource, repoSource, detail },
  );
  await updateTaskFile(
    taskRef(ctx, input.projectSlug, input.taskKey),
    (parsed) => {
      parsed.timeline.unshift(event);
    },
  );
  reproject(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.operator.context_conflict",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { kbSource, repoSource },
  });
  // A convention conflict is a judgement call a human owns; the flag is worth
  // nothing if it only exists on a page nobody opens.
  notifyTaskWatchers(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      kind: "quality",
      title: CONTEXT_CONFLICT_TITLE,
      text: event.text,
      occurredAt: event.occurredAt,
      // Ruling 361: the operator flagged the conflict (the event's own actor).
      from: OPERATOR_NOTIFY_FROM,
    },
    ctx,
  );
  return {
    outcome: "done",
    message: `Recorded: \`${repoSource}\` wins; a human will settle it.`,
  };
}

/** The in-process actor the operator's writes are attributed to when a task
 *  writer wants one; RBAC is skipped under `operatorAuthorized`. */
const OPERATOR_WRITE_ACTOR: TaskActor = { userId: "operator", label: "operator" };

/**
 * Ruling 131(b) (pass 34): the operator records what a task WAITS ON with a
 * tool of its own instead of a hold packet (JC-9's "standing token"). Gated
 * like packets (`generate-packets`: the wait is the packet's replacement, so
 * it reuses the packet's own grant rather than minting a catalog id for one
 * tool). A validator refusal is a `noop` carrying the validator's own
 * sentence: the task's state ruled it out, not the project's policy (the
 * LV-03 misblame rule); an unchanged list is a `noop`; success is `done`.
 */
export async function operatorSetDependencies(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; blockedBy: readonly string[]; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "generate-packets") === "deny") {
    return {
      outcome: "denied",
      message: "The operator cannot record what a task waits on in this project (the generate-packets grant is withheld).",
    };
  }
  try {
    const result = await setTaskDependencies(
      db,
      { projectSlug: input.projectSlug, taskKey: input.taskKey, blockedBy: input.blockedBy },
      OPERATOR_WRITE_ACTOR,
      { ...ctx, operatorAuthorized: true },
    );
    const list = result.blockedBy.join(", ");
    if (!result.changed) {
      return {
        outcome: "noop",
        message: list
          ? `Unchanged: ${input.taskKey} already waits on ${list}.`
          : `Unchanged: ${input.taskKey} waits on nothing.`,
      };
    }
    const why = input.reason?.trim() ? ` Reason: ${input.reason.trim()}` : "";
    return {
      outcome: "done",
      message: list
        ? `Recorded: ${input.taskKey} waits on ${list}. Viberr holds it and releases it when every entry is done.${why}`
        : `Recorded: ${input.taskKey} no longer waits on other work.${why}`,
    };
  } catch (error) {
    // The validator's refusal names the reference and the reason: a fact about
    // the store, never a policy block.
    if (error instanceof AppError && error.status === 400) {
      return { outcome: "noop", message: error.userMessage };
    }
    throw error;
  }
}

/** Fill only an unspecified goal; established scope remains human-controlled. */
export async function operatorSetGoal(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; goal: string; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  if (gate(authority, "append-typed-events") === "deny") {
    return { outcome: "denied", message: "The operator cannot draft the goal in this project." };
  }
  const goal = input.goal.trim();
  if (goal.length < 3) {
    return { outcome: "noop", message: "A goal of at least 3 characters is required." };
  }
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) {
    return { outcome: "noop", message: `Task ${input.taskKey} not found.` };
  }
  const current = existing.parsed.goal.trim();
  if (current !== "" && current !== DEFAULT_GOAL) {
    return {
      outcome: "noop",
      message:
        "The goal is already specified. Open an edit_goal packet to propose a change instead of overwriting it.",
    };
  }
  if (current === goal) {
    return { outcome: "noop", message: "Goal unchanged." };
  }
  let clearedPacket = false;
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.goal = goal;
    // Fulfil an awaiting goal-edit packet (the operator drafted the scope the
    // human asked it to) — clear it + lift its readiness gate, exactly like
    // updateTaskGoal does for a human edit.
    if (parsed.packet?.awaiting === "goal_edit") {
      const wasBlocked = parsed.packet.type === "blocked";
      parsed.packet = null;
      clearedPacket = true;
      if (wasBlocked && parsed.frontmatter.readiness === "blocked") {
        parsed.frontmatter.readiness = "ready";
      }
    }
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      // A drafted goal is a neutral lifecycle note, not a policy violation
      // (P13-LV-03 — this rendered as a coral "Policy violation" shield).
      type: "note",
      actor: { kind: "operator" },
      title: "Goal drafted",
      text: input.reason?.trim()
        ? `The operator drafted the task goal: ${input.reason.trim()}. Downstream agents re-anchor on the new goal.`
        : "The operator drafted the task goal from the request. Downstream agents re-anchor on the new goal.",
      toAgent: false,
      evidence: null,
    });
  });
  if (clearedPacket) {
    markTaskPacketApprovalRead(db, input.projectSlug, input.taskKey);
  }
  reproject(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.goal.updated",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { by: "operator" },
  });
  return { outcome: "done", message: "Task goal drafted." };
}

/**
 * F21-6 — what a NON-delivering engagement is called.
 *
 * The schema already distinguishes the two (`!delivers && verdictCapable` makes
 * a required reviewer; everything else is supporting — task-file.schema), and
 * the execution profile renders them under "SUPPORTING AGENTS". This copy did
 * not: every non-delivering engagement was announced "as a reviewer". Live, the
 * Web Verifier profile (verdict = Off, so its report gates nothing) was engaged
 * "as a reviewer" and then displayed as supporting — two names for one thing,
 * and the misleading one implies acceptance-gating authority it does not hold.
 *
 * An UNKNOWN profile (not deployed) reads as supporting: the weaker claim is the
 * honest one when the grant cannot be resolved.
 */
function supportingRoleWord(
  ctx: TaskMutationContext,
  projectSlug: string,
  profileId: string,
): "a reviewer" | "a supporting agent" {
  return deployedAgent(ctx, projectSlug, profileId)?.capabilities.verdict
    ? "a reviewer"
    : "a supporting agent";
}

// --------------------------------------------------- dispatch helpers

/** Resolve a deployed specialist's role + backend for a prompt/run. */
/** Org MCP names compared loosely: `qa_echo`, `qa-echo` and `QA-Echo` are
 *  one server (the tool prefix a model sees is `mcp__<name>__…`). */
function mcpNameKey(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

/**
 * F32-8 (pass 32): a directive that names an org MCP server the target profile
 * does NOT hold gets a server-attributed note appended — on the hand-off
 * comment AND the run's directive. Live (VIB-1, VIB-2) the operator's reviewer
 * brief said "re-call qa_echo yourself" to a Reviewer with no MCP grant (KBs are
 * inherited from the deliverer, R18-1; MCPs are not), and the reviewer burned
 * 20-30 turns per task hunting the tool. The snapshot the operator plans from
 * already carries `deployedSpecialists[].resources`; this makes the mismatch
 * impossible to hand off silently. Names are matched as whole words against
 * the instance registry, so ordinary prose never trips it.
 */
function annotateUngrantedMcps(
  db: DatabaseSync,
  agent: DeployedSpecialistView,
  prompt: string | undefined,
): string | undefined {
  if (!prompt) return prompt;
  const held = new Set(agent.resources.mcps.map(mcpNameKey));
  const text = mcpNameKey(prompt);
  const ungranted = listMcpServerNames(db).filter((name) => {
    const key = mcpNameKey(name);
    if (held.has(key)) return false;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9-])${escaped}([^a-z0-9-]|$)`).test(text);
  });
  if (ungranted.length === 0) return prompt;
  return (
    `${prompt}\n\n(Note from Viberr: ${agent.name} holds no MCP grant for ` +
    `${ungranted.map((n) => `\`${n}\``).join(", ")} on this project, so those ` +
    `tools will not be available to it — any evidence from them is already on ` +
    `the task timeline. Do not hunt for them.)`
  );
}

function deployedAgent(
  ctx: TaskMutationContext,
  projectSlug: string,
  profileId: string,
): DeployedSpecialistView | null {
  return (
    listDeployedSpecialists(projectSlug, ctx).find((s) => s.id === profileId) ??
    null
  );
}

/**
 * Best-effort task-key branch creation on GitHub when a specialist is about to
 * work. Isolated + swallowing so a GitHub failure (or unconfigured repo) can
 * never fail the operator's coordination — ensureTaskBranch already returns
 * typed results and writes the branch name into task.md on success.
 */
async function ensureTaskBranchBestEffort(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
): Promise<void> {
  const { ensureTaskBranchBestEffort: shared } = await import(
    "~/server/github/branch-sync.server"
  );
  await shared(db, { projectSlug, taskKey }, OPERATOR_AUDIT_ACTOR, {
    dataRoot: ctx.dataRoot,
  });
}

// ------------------------------------------------- generic agent dispatch

/** One agent-selection decision, as the trace records it. */
interface AgentSelection {
  projectSlug: string;
  taskKey: string;
  profileId: string;
  delivers: boolean;
  /** The operator's stated reason, when it gave one. */
  reason?: string;
}

/** Best-effort audit trace for every operator profile selection. */
function recordAgentSelectionTrace(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: AgentSelection,
): void {
  try {
    const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    const stage = file?.parsed.frontmatter.stage;
    const engagements = file?.parsed.frontmatter.engagements ?? [];
    const engaged = new Set(engagements.map((e) => e.profileId));
    const board = projectBoard(ctx, input.projectSlug);
    const candidates = listDeployedSpecialists(input.projectSlug, ctx).map(
      (s) => ({
        profileId: s.id,
        // Ruling 133: may it RUN here (declared, or the engaged deliverer).
        eligibleForStage: stage
          ? runEligibilityFor(s, engagements, s.id, stage, board).ok
          : false,
        alreadyEngaged: engaged.has(s.id),
        // The posture the dispatch will TAKE: for the chosen profile the
        // resolved delivers intent (auto-engage included, so a first
        // dispatch reads `true` while `alreadyEngaged` is false); for every
        // other candidate its current engagement's posture.
        deliveringAtSelection:
          s.id === input.profileId
            ? input.delivers
            : engagements.some((e) => e.profileId === s.id && e.delivers),
        chosen: s.id === input.profileId,
      }),
    );
    recordAudit(db, {
      action: "task.operator.agent_selected",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: {
        chosen: input.profileId,
        delivers: input.delivers,
        reason: input.reason ?? null,
        candidates,
      },
    });
  } catch {
    // Tracing must never block a routing decision.
  }
}

/**
 * The dynamic-dispatch rule this module and `startAgentRun`'s auto-engage
 * agree on (the trace below must record what the dispatch will actually do):
 * explicit hint wins; an engaged profile keeps its shape; an unengaged profile
 * delivers iff the task has no deliverer yet AND the profile holds a
 * repo-write grant — a verdict-only reviewer dispatched first on a fresh task
 * engages as supporting, never as a deliverer that can ship nothing.
 */
function resolveDeliversIntent(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  agent: DeployedSpecialistView,
  hint: boolean | undefined,
): boolean {
  if (hint !== undefined) return hint;
  const file = readTaskFile({
    projectSlug,
    taskKey,
    dataRoot: ctx.dataRoot,
  });
  const fm = file?.parsed.frontmatter;
  if (!fm) return false;
  const delivering = deliveringEngagement(fm);
  if (delivering?.profileId === agent.id) return true;
  if (fm.engagements.some((e) => e.profileId === agent.id)) return false;
  return delivering === null && agent.capabilities.delivery;
}

/**
 * Dynamic-dispatch rework (2026-08-29): the ONE operator action for putting an
 * agent to work — the collapsed replacement for engage_agent / run_agent /
 * prompt_agent and the specialist/reviewer function pairs behind them. Gated by
 * `dispatch-agents` (the collapsed assign/summon pair):
 *
 *   direct    → engage-if-needed (capability-derived posture, inside
 *               `startAgentRun`), post the prompt as an operator comment when
 *               one is given, and start the run with it as the directive. A
 *               bare dispatch (no prompt) starts the run with no synthetic
 *               comment — the agent re-anchors on task.md.
 *   recommend → ONE `run_agent` card carrying the profile + prompt, which a
 *               human applies (the applied dispatch then runs exactly this).
 *   deny      → refused out loud (R19-6).
 */
export async function operatorDispatchAgent(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    profileId: string;
    /** The run's directive; absent → a bare re-run with no hand-off comment. */
    prompt?: string;
    /** Explicit posture — `true` is a delivery hand-off (reassigns the
     *  delivering engagement); absent → derived (see resolveDeliversIntent). */
    delivers?: boolean;
    /** The operator's stated reason, when it gave one. */
    reason?: string;
  },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = dispatchGate(authority);
  if (g === "deny") {
    return {
      outcome: "denied",
      message: "Dispatching agents is not permitted for the operator here.",
    };
  }
  const agent = deployedAgent(ctx, input.projectSlug, input.profileId);
  if (!agent) {
    return {
      outcome: "noop",
      message: `No deployed agent "${input.profileId}" to run. Pick a profile from get_task's deployedSpecialists.`,
    };
  }
  const prompt = annotateUngrantedMcps(db, agent, input.prompt?.trim() || undefined);
  // Hunt 2026-08-29: refuse the two CONTRADICTORY hints up front, before any
  // card or trace can announce a posture the dispatch would not install.
  // (1) `delivers: true` for a profile with no repo-write grant — the dispatch
  // refuses it at both engage doors; filing a card for it would strand a
  // maintainer's Apply on that refusal.
  if (input.delivers === true && !agent.capabilities.delivery) {
    return {
      outcome: "noop",
      message:
        `${agent.name} holds no repo-write grant, so it cannot own delivery. ` +
        `Run it as a supporting agent (omit \`delivers\`), or a human grants ` +
        `"Execute code or write to the repo" on the project's Agents surface.`,
    };
  }
  // (2) `delivers: false` aimed at the CURRENT deliverer — dispatchAgentRun
  // deliberately keeps an engaged profile's shape (a delivering run cannot be
  // demoted per-dispatch), so honoring the hint in the label/trace while the
  // run went out `kind: "primary"` was a governed lie.
  const currentDeliverer = ((): string | null => {
    const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
    return file
      ? (deliveringEngagement(file.parsed.frontmatter)?.profileId ?? null)
      : null;
  })();
  if (input.delivers === false && currentDeliverer === input.profileId) {
    return {
      outcome: "noop",
      message:
        `${agent.name} IS the delivering agent on this task — its runs deliver. ` +
        `Omit \`delivers\` to run it, or hand delivery to another repo-write ` +
        `profile first (\`delivers: true\` on that profile).`,
    };
  }
  const delivers = resolveDeliversIntent(
    ctx,
    input.projectSlug,
    input.taskKey,
    agent,
    input.delivers,
  );
  const as = delivers
    ? "the delivering agent"
    : supportingRoleWord(ctx, input.projectSlug, input.profileId);

  if (g === "recommend") {
    const rec: Parameters<typeof addRecommendation>[4] = {
      kind: "run_agent",
      profileId: input.profileId,
      label: `Run ${agent.name}`,
    };
    if (prompt) rec.prompt = prompt;
    // Persist the EXPLICIT hint so Apply dispatches what this arm announced —
    // the card used to drop it and Apply re-derived, sometimes the opposite.
    if (input.delivers !== undefined) rec.delivers = input.delivers;
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      rec,
      input.reason ??
        prompt ??
        `${agent.name} fits what the current stage needs; a maintainer starts the run.`,
    );
    return {
      outcome: "recommended",
      message: `Recommended running ${agent.name} as ${as}.`,
    };
  }

  // direct
  const selection: AgentSelection = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    profileId: input.profileId,
    delivers,
  };
  if (input.reason) selection.reason = input.reason;
  recordAgentSelectionTrace(db, ctx, selection);
  if (delivers) {
    // Delivery spine (FR31): the agent is about to own the branch — ensure the
    // task-key branch exists on GitHub. Best-effort, degrades cleanly.
    await ensureTaskBranchBestEffort(db, ctx, input.projectSlug, input.taskKey);
  }
  // Ruling 152(c) (pass 35, G35-4): a HOLD is the task's state ruling the
  // dispatch out for now, which is exactly what `noop` means — never a
  // failure. The plan says so and the Codex operator makes it load-bearing:
  // its plan executor ABORTS every remaining action on a thrown one and writes
  // "Coordination stopped" on the timeline, so a held `run_agent` step cost the
  // rest of a paid turn (the transitions, comments and packets after it) for a
  // hold whose own note says nothing was dispatched and no decision is needed.
  // The retry is already on the task's schedule, so the message ends the
  // subject rather than inviting a packet.
  const heldNoop = (error: DispatchHeldError): OperatorActionResult => {
    // Ruling 207(h): the hold is scoped to (backend, TASK OWNER) — every run on
    // this task bills that one person (ruling 127) — so "pick a <other>
    // profile" only helps when the OWNER has the other backend connected. When
    // they do not, the operator follows the advice, the dispatch is refused on
    // the owner's credential, and the failure opens the very packet this
    // sentence forbade. So the alternative is offered only when it exists.
    const otherBackend: RealBackend = error.hold.backend === "codex" ? "claude" : "codex";
    const other = otherBackend === "claude" ? "Claude" : "Codex";
    const ownerId =
      readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey))?.parsed.frontmatter
        .ownerUserId ?? null;
    const fallbackReachable =
      ownerId !== null && isBackendAvailableFor(db, ownerId, otherBackend);
    return {
      outcome: "noop",
      message:
        `${error.userMessage} Do not open a packet for this; ` +
        (fallbackReachable
          ? `pick a ${other} profile if the work cannot wait.`
          : `there is no ${other} fallback either — this task's runs bill its owner, ` +
            `who has no ${other} account connected. The retry is already scheduled.`),
    };
  };
  if (prompt) {
    const promptInput: Parameters<typeof operatorPromptAgent>[1] = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      profileId: input.profileId,
      handle: agent.name,
      directive: prompt,
    };
    // Thread only the EXPLICIT hint: the auto-engage derives the posture with
    // the same rule as the trace above, and an explicit `true` is what asks
    // assignSpecialist for a delivery hand-off.
    if (input.delivers !== undefined) promptInput.delivers = input.delivers;
    let prompted: Awaited<ReturnType<typeof operatorPromptAgent>>;
    try {
      prompted = await operatorPromptAgent(db, promptInput, ctx);
    } catch (error) {
      if (isDispatchHeld(error)) return heldNoop(error);
      throw error;
    }
    // Ruling 263 (F37-93): "and started its run" was said for a run that was
    // refused before any process existed, and for one parked behind the cap.
    // The operator plans its next move on this sentence.
    if (prompted.outcome === "refused") {
      return {
        outcome: "noop",
        message:
          `The prompt is on the timeline for @${agent.name} (${as}), but no run started: ` +
          `${prompted.refusal ?? "the run was refused before any process started."} ` +
          `Re-send it once that is resolved.`,
      };
    }
    if (prompted.outcome === "queued") {
      return {
        outcome: "done",
        message:
          `Prompted @${agent.name} (${as}). The instance is at its concurrent-run cap, ` +
          `so the run is queued and starts when a slot frees.`,
      };
    }
    return {
      outcome: "done",
      message: `Prompted @${agent.name} (${as}) and started its run.`,
    };
  }
  const dispatch: Parameters<typeof startAgentRun>[1] = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    profileId: input.profileId,
  };
  if (input.delivers !== undefined) dispatch.delivers = input.delivers;
  let result: Awaited<ReturnType<typeof startAgentRun>>;
  try {
    result = await startAgentRun(db, dispatch, OPERATOR_TASK_ACTOR, opCtx(ctx));
  } catch (error) {
    if (isDispatchHeld(error)) return heldNoop(error);
    throw error;
  }
  if (result.outcome === "refused") {
    return {
      outcome: "noop",
      message:
        `No run started for ${agent.name} (${as}): ` +
        `${result.refusal ?? "the run was refused before any process started."} ` +
        `Try again once that is resolved.`,
    };
  }
  if (result.outcome === "queued") {
    return {
      outcome: "done",
      message:
        `${agent.name}'s (${as}) run is queued: the instance is at its concurrent-run cap, ` +
        `so it starts when a slot frees.`,
    };
  }
  return {
    outcome: "done",
    message: `Started a ${result.backend === "claude" ? "Claude" : "Codex"} run for ${agent.name} (${as}).`,
  };
}

/** The delivery audit row's details. */
type DeliveryAuditDetails = {
  status: string;
  /** Present only when a review PR actually exists. */
  prNumber?: number;
  /** Ruling 134: the head the delivery left on the PR, and whether the push
   *  (or the PR open) MOVED anything — `delivered` only. */
  headSha?: string | null;
  moved?: boolean;
};

/** The move an operator transition asks `transitionStage` to perform. */
type OperatorTransitionMove = {
  projectSlug: string;
  taskKey: string;
  toStageId: string;
  reason?: string;
  /** R7-4 rework routing — a validated backward move on failing work. */
  rework?: boolean;
};

/**
 * R15-2: DELIVER the task — push the deliverer's branch and open (or reuse) the
 * review PR. Delivery is the operator's decision, gated by `deliver-review-pr`:
 * `direct` performs it via the shared `performDelivery` core and reports the
 * push + PR outcome honestly (including `push_conflict`); `recommend` posts a
 * `delivery` recommendation card a human applies. The server executes the
 * mechanics either way; agents never push or open PRs themselves.
 */
export async function operatorDeliverForReview(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = deliverGate(authority);
  if (g === "deny") {
    return {
      outcome: "denied",
      message: "Delivering the branch & opening the review PR is not permitted for the operator here.",
    };
  }
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) {
    return { outcome: "noop", message: `Task ${input.taskKey} not found.` };
  }
  // Ruling 134 (pass 34, F34-11): NO cached-state short-circuit. The old
  // "PR #N is already open for review; there is nothing to deliver" answered
  // before `performDelivery` ran, so every commit an agent made after the first
  // delivery (a reviewer-requested rework, a resolved base conflict, the whole
  // JC-6 scaffold) stayed in the workspace. Delivery is defined by the REMOTE:
  // `pushWorkspaceBranch` reads origin's head and answers `up_to_date` when
  // there is nothing to push, and THAT is the only honest noop.
  const fm = existing.parsed.frontmatter;
  const livePr = fm.pr && fm.pr.state !== "closed" && fm.pr.state !== "merged" ? fm.pr : null;
  if (g === "recommend") {
    // The recommend arm reads the RECORDED fact, never the cache: with an open
    // PR and no unpushed revision on the record there is nothing to propose.
    const activeRevision = activeWorkRevision(fm.workRevision);
    const unpushed = unpushedRevisionOf(fm.pr, activeRevision?.headSha ?? null);
    if (livePr && !unpushed) {
      return {
        outcome: "noop",
        message: `PR #${livePr.number} already carries the delivered revision${activeRevision ? ` \`${activeRevision.headSha.slice(0, 7)}\`` : ""}; there is nothing to deliver.`,
      };
    }
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      {
        kind: "delivery",
        label: livePr && unpushed
          ? `Push \`${unpushed.revisionSha.slice(0, 7)}\` to PR #${livePr.number}`
          : "Deliver the branch & open the review PR",
      },
      input.reason ??
        (livePr && unpushed
          ? `The delivered revision \`${unpushed.revisionSha.slice(0, 7)}\` is not on PR #${livePr.number}; delivering pushes it to that PR.`
          : "The work is committed and ready for review; delivering pushes the task branch and opens the review PR."),
    );
    return {
      outcome: "recommended",
      message: livePr && unpushed
        ? `Recommended pushing \`${unpushed.revisionSha.slice(0, 7)}\` to PR #${livePr.number}.`
        : "Recommended delivering the branch & opening the review PR.",
    };
  }
  // F17-1: delivery THROUGH the operator's own tool is operator-authorized by
  // definition — mark the ctx so `performDelivery` attributes the "Opened PR"
  // event to the Operator, not to the sentinel "operator" user id rendered as a
  // human with a bogus "no longer a member" guest pill. (A human manual delivery
  // reaches performDelivery WITHOUT this flag and still renders as that human.)
  const outcome = await performDelivery(
    db,
    { ...ctx, operatorAuthorized: true },
    input.projectSlug,
    input.taskKey,
    OPERATOR_TASK_ACTOR,
  );
  // The PR number exists only on a DELIVERED outcome; a `prNumber` key on a
  // failed delivery would name a pull request that was never opened.
  const details: DeliveryAuditDetails = { status: outcome.status };
  if (outcome.status === "delivered") {
    details.prNumber = outcome.prNumber;
    details.headSha = outcome.headSha;
    details.moved = outcome.moved;
  }
  recordAudit(db, {
    action: "github.delivery.operator",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details,
  });
  switch (outcome.status) {
    case "delivered": {
      // Ruling 134(a): the message names what MOVED. A reuse whose push moved
      // the head says so with the sha; a reuse that pushed nothing is the one
      // honest noop, and it reads as one.
      const sha = outcome.headSha ? ` \`${outcome.headSha.slice(0, 7)}\`` : "";
      const message = outcome.created
        ? `Delivered: pushed${sha} and opened review PR #${outcome.prNumber}.`
        : outcome.moved
          ? `Delivered: pushed${sha} to the open review PR #${outcome.prNumber} (its head moved; the reviewers judge the new revision).`
          : outcome.pushStatus === "up_to_date"
            ? `Nothing to push: PR #${outcome.prNumber} already carries${sha || " the workspace head"}.`
            : `Delivered: push skipped (${outcome.pushStatus}), reusing open review PR #${outcome.prNumber}.`;
      return { outcome: "done", message };
    }
    case "push_conflict":
      return {
        outcome: "noop",
        message:
          `Delivery push CONFLICTED: ${outcome.message}. No PR was opened. This is a ` +
          `branch-history conflict on \`${outcome.branch}\`, not a credential problem. ` +
          `Open a decision packet with a \`resolve_remote_collision\` option — its ` +
          `ceremony closes the squatting PR (when one is recorded), deletes the stale ` +
          `remote branch, and re-delivers this task's local work — or an ` +
          `\`archive_task\` option to abandon the task. A \`discard_branch\` option ` +
          `destroys this task's LOCAL commits: the refused push means the revision never ` +
          `left the workspace, so it MAY be offered (ruling 161) when the person's choice is ` +
          `to throw the local work away, never as the way to clear the remote.`,
      };
    case "scope_violation":
      // Ruling 144: the remedy is a human's (grant the scope on GitHub, then
      // Re-check); the violation is already on the task and in the inbox.
      return {
        outcome: "noop",
        message:
          `Delivery was refused for a missing \`${outcome.scope}\` scope: ${outcome.message} ` +
          `A scope violation is open on the task; do not retry until the credential card shows the scope. ` +
          `Do not ask an agent to push.`,
      };
    case "store_layout":
      // Ruling 159: Viberr never publishes its own store layout into the
      // repository; the folder is a person's or the agent's to remove.
      return {
        outcome: "noop",
        message:
          `Delivery was refused: ${outcome.message} ` +
          `Nothing was pushed and no PR was opened. Re-prompt the delivering agent to remove ` +
          `${outcome.files.map((f) => `\`${f}\``).join(", ")} from the branch (the task's real ` +
          `attachments folder is outside the checkout; its prompt names the absolute path), then deliver again.`,
      };
    case "closed_by_human":
      // Ruling 160: a person's close is a decision about the task, answered
      // through the closed-PR recovery packet, never delivered around.
      return {
        outcome: "noop",
        message:
          `Delivery was refused: ${outcome.message} ` +
          `Do not deliver again and do not ask any agent to push or open a PR. ` +
          `The closed-PR recovery packet is the path: when no open packet already covers PR #${outcome.prNumber}, ` +
          `open ONE decision packet (type "input") with a \`custom\` option to rework (a later \`deliver_for_review\` then opens a fresh PR), ` +
          `an \`archive_task\` option, and an \`archive_task\` option with \`deleteBranch: true\`, ` +
          `and say that reopening the PR on GitHub is also a valid answer. Then wait for the person.`,
      };
    case "grant_withheld":
    case "push_failed":
    case "nothing_to_review":
    case "failed":
      return { outcome: "noop", message: `Delivery did not complete: ${outcome.message}` };
  }
}

export async function operatorTransitionStage(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; toStageId: string; reason?: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  const g = gate(authority, "stage-transitions");
  if (g === "deny") {
    return { outcome: "denied", message: "Stage transitions are not permitted for the operator here." };
  }
  // An `auto` boundary is ungoverned by the project's own workflow — it declares
  // "no approval needed" — so crossing it is not an exercise of governance
  // authority and does NOT wait on a human, even when the operator's
  // stage-transitions capability is `recommend` (supervised). Otherwise a task
  // strands at a pre-work stage (e.g. Ready→In Progress "when a specialist is
  // assigned") with a recommendation nobody needs to approve. Governed
  // boundaries (`approval`/`human`) still route through the recommend/deny gate.
  // R7-4 rework routing: a BACKWARD move to an earlier stage on a task whose
  // latest review is `failing` sends the rejected work back to the developer.
  // The operator does this directly (no human, no recommendation) so a failed
  // review re-drives itself; transitionStage vets that it is genuinely backward
  // + failing before honoring the off-graph move.
  const isRework = isReworkMove(ctx, input.projectSlug, input.taskKey, input.toStageId);
  const boundary = operatorBoundaryFor(ctx, input.projectSlug, input.taskKey, input.toStageId);
  const terminalId = resolveTerminalStageId(ctx, input.projectSlug);
  // F19-26: a transition whose TARGET is the terminal stage is an ACCEPTANCE,
  // whatever the tool it arrived through. A supervised operator calling
  // transition_stage(<terminal>) used to file a plain "Move the task to Done"
  // card whose Apply runs the full acceptance contract — a real, irreversible PR
  // merge — under a label that never says "accept" or "merge". Route it to the
  // acceptance path instead, which files a truthful `accept_completion` card
  // (and refuses out loud when the acceptance gates are not met).
  //
  // R19-6: rerouting also means this path must answer to the ACCEPTANCE
  // capability, not just `stage-transitions` — `stage-transitions: recommend`
  // with `completion-for-acceptance: off` was live-proven to produce a real
  // acceptance card + audit row through exactly this delegation. The gate is
  // the first thing `operatorAcceptCompletion` does, so the refusal is
  // inherited here rather than duplicated (one gate read, one sentence).
  //
  // Ruling 151 (pass 35, F35-2): the reroute now covers BOTH gates. Under
  // `direct` the bare move used to fall through to transitionStage's own
  // refusal ("reaches Done only by accepting completion"); acceptance has its
  // own capability, so the acceptance path answers here too.
  if (terminalId !== null && input.toStageId === terminalId) {
    return operatorAcceptCompletion(
      db,
      ctx,
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      authority,
    );
  }
  const name = stageNameOf(ctx, input.projectSlug, input.toStageId);
  // Ruling 162 (pass 35, F35-12 (b), owner Q35-17): Merge means mergeable. A
  // move INTO the acceptance stage (the stage with the edge into the terminal
  // one) is refused with the gate's own sentence while the review PR conflicts
  // with the base or lacks the delivered revision, so the task stays at the
  // work stage where the conflict packet is the path. Live (KNC-6, KNC-20) the
  // operator moved both to Merge and recommended acceptance on PRs whose
  // `mergeable: conflicting` was already on the file.
  {
    const mergeEntry = mergeStageEntryRefusal(ctx, input.projectSlug, input.taskKey, input.toStageId);
    // F39-10: `noop` — the PR's mergeability and its delivered revision are
    // task STATE, not a capability the project withheld.
    if (mergeEntry) return { outcome: "noop", message: mergeEntry };
  }
  // Ruling 151 (owner, Q35-1): the boundary the project author declared is the
  // contract every human reads on the Policy page and in project.md, and a
  // grant cannot void it. `direct` crosses `auto` boundaries only; a declared
  // `approval` boundary ALWAYS files a recommendation a human applies, under
  // either autonomy and either grant mode; a declared `human` boundary is
  // refused with a sentence. Live (KNC-1): `stage-transitions: direct` under
  // supervised autonomy moved Review to Merge with `boundary: approval, by:
  // operator` while every surface said a human approves it. Rework moves on a
  // failing task (R7-4) are unchanged.
  if (!isRework && boundary === "human") {
    return {
      outcome: "denied",
      message:
        `Moving ${input.taskKey} to ${name} is a human decision on this board; the operator ` +
        `cannot cross that boundary. A human moves the task or accepts the completion.`,
    };
  }
  if (!isRework && boundary === "approval") {
    const fromName = stageNameOf(ctx, input.projectSlug, currentStageOf(ctx, input));
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      {
        kind: "transition",
        toStageId: input.toStageId,
        label: `Move the task to ${name}`,
      },
      input.reason ?? `The work is ready to advance to ${name}.`,
    );
    return {
      outcome: "recommended",
      message:
        `Recommended moving the task to ${name}; the ${fromName} to ${name} boundary is ` +
        `approved by a human.`,
    };
  }
  if (g === "recommend" && boundary !== "auto" && !isRework) {
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      {
        kind: "transition",
        toStageId: input.toStageId,
        label: `Move the task to ${name}`,
      },
      input.reason ?? `The work is ready to advance to ${name}.`,
    );
    return { outcome: "recommended", message: `Recommended moving the task to ${name}.` };
  }
  const move: OperatorTransitionMove = { ...input };
  // `rework` is an off-graph escape hatch transitionStage re-validates; it must
  // reach it only on a genuine rework move.
  if (isRework) move.rework = true;
  await transitionStage(db, move, OPERATOR_TASK_ACTOR, opCtx(ctx));
  // Ruling 152(a) (pass 35, G35-5): the reply names the NEXT boundary so one
  // turn can walk consecutive `auto` boundaries instead of paying a fresh
  // operator turn per stage (KNC-1 took eight operator runs for a one-file
  // ADR). When the move lands on the acceptance boundary, the same turn files
  // the acceptance recommendation (owner, Q35-15: the fold), so an approval
  // costs one operator turn, not two.
  const folded = await foldAcceptanceRecommendation(
    db,
    ctx,
    { projectSlug: input.projectSlug, taskKey: input.taskKey },
    authority,
  );
  const next = folded
    ? folded.message
    : nextBoundarySentence(ctx, input.projectSlug, input.toStageId, name, authority);
  return {
    outcome: "done",
    message: `Moved ${input.taskKey} to ${name}.${next ? ` ${next}` : ""}`,
  };
}

/** The task's current stage id (the `from` of the move being judged). */
function currentStageOf(
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string },
): string {
  const task = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  return task?.parsed.frontmatter.stage ?? "";
}

/**
 * Ruling 152(a): what the operator should do about the boundary AFTER the one
 * it just crossed, so a turn continues instead of ending at a stage whose only
 * work is another transition. Empty when the stage has no outbound edge.
 */
function nextBoundarySentence(
  ctx: TaskMutationContext,
  projectSlug: string,
  stageId: string,
  stageDisplayName: string,
  authority: OperatorAuthority,
): string {
  const project = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
  if (!project) return "";
  const edge = project.parsed.frontmatter.workflow.find((w) => w.from === stageId);
  if (!edge) return "";
  const toName = stageName(project.parsed.frontmatter.stages, edge.to);
  const label = `The next boundary, ${stageDisplayName} to ${toName},`;
  if (edge.boundary === "auto") {
    return `${label} is auto: continue in this turn when nothing at ${stageDisplayName} needs an agent.`;
  }
  if (edge.boundary === "approval") {
    return `${label} is approved by a human: recommend it when the work is ready.`;
  }
  // A `human` boundary is the acceptance boundary: the fold above already
  // tried the recommendation; reaching here means the recommend branch does
  // not apply (full autonomy with a direct acceptance grant, or acceptance
  // withheld), so the reply names the tool that answers for it.
  return gate(authority, "completion-for-acceptance") === "deny"
    ? `${label} is a human decision: a human accepts the completion.`
    : `${label} is acceptance: call accept_completion when the review is clean.`;
}

/**
 * Owner decision Q35-15 (pass 35, G35-5, the FOLD): when a task lands on the
 * acceptance boundary (the review stage, or any stage with a declared edge into
 * the terminal one), the acceptance recommendation is written NOW, by whoever
 * made the move, instead of by a second paid operator turn whose only work was
 * that card (KNC-30: Review to Merge at 19:21Z, the acceptance card at 19:30Z,
 * two turns). Recommendation ONLY: a full-autonomy operator holding a direct
 * acceptance grant is never folded into an actual acceptance, and a withheld
 * capability files nothing (`completionCapabilityRefusal`). The shared
 * acceptance gate stack inside `operatorAcceptCompletion` decides whether the
 * card can be filed; its refusal sentence comes back as the message so the
 * caller can say why no card exists yet.
 *
 * Returns `null` when the fold does not apply (not at the boundary, direct
 * acceptance, capability withheld, no operator deployed); otherwise whether a
 * card was filed and the sentence to report.
 */
export async function foldAcceptanceRecommendation(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string },
  authority: OperatorAuthority,
): Promise<{ recommended: boolean; message: string } | null> {
  if (!authority.deployed) return null;
  if (completionCapabilityRefusal(authority, input.taskKey)) return null;
  if (authority.autonomy === "full" && gate(authority, "completion-for-acceptance") === "direct") {
    return null;
  }
  const project = readProjectFile({ projectSlug: input.projectSlug, dataRoot: ctx.dataRoot });
  const task = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!project || !task) return null;
  const stages = project.parsed.frontmatter.stages;
  const workflow = project.parsed.frontmatter.workflow;
  const roles = resolveStageRoles(stages, workflow);
  const stage = task.parsed.frontmatter.stage;
  const terminalId = roles.terminalId;
  if (terminalId === null || stage === terminalId) return null;
  const atBoundary =
    stage === roles.reviewId || workflow.some((w) => w.from === stage && w.to === terminalId);
  if (!atBoundary) return null;
  const result = await operatorAcceptCompletion(db, ctx, input, authority);
  if (result.outcome === "recommended") {
    return { recommended: true, message: result.message };
  }
  return {
    recommended: false,
    message: `Acceptance is not recommended yet: ${result.message}`,
  };
}

/** The project's terminal (Done-equivalent) stage id (B-WF4). `resolveStageRoles`
 *  already does the positional-last fallback internally, so there is nothing to
 *  add here. Named apart from task-actions' `terminalStageIdOf(project)` — this
 *  one reads the file, that one takes a loaded `ProjectContext`. */
function resolveTerminalStageId(
  ctx: TaskMutationContext,
  projectSlug: string,
): string | null {
  const file = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
  if (!file) return null;
  return resolveStageRoles(
    file.parsed.frontmatter.stages,
    file.parsed.frontmatter.workflow,
  ).terminalId;
}

/** Resolve a stage's display name for a recommendation label. */
function stageNameOf(
  ctx: TaskMutationContext,
  projectSlug: string,
  stageId: string,
): string {
  const file = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
  return file ? stageName(file.parsed.frontmatter.stages, stageId) : stageId;
}

/** True when moving `taskKey` to `toStageId` is an operator rework move (R7-4):
 *  a BACKWARD step to an earlier stage on a task whose latest review is
 *  `failing`. The operator performs these directly to route a rejected task
 *  back to the developer without a human. */
function isReworkMove(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  toStageId: string,
): boolean {
  const task = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  const project = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!task || !project) return false;
  const stages = project.parsed.frontmatter.stages;
  const fromIndex = stages.findIndex((s) => s.id === task.parsed.frontmatter.stage);
  const toIndex = stages.findIndex((s) => s.id === toStageId);
  const backward = toIndex >= 0 && fromIndex >= 0 && toIndex < fromIndex;
  if (!backward) return false;
  const validation = task.parsed.frontmatter.validation;
  if (validation === "failing") return true;
  // Ruling 163 (pass 35, F35-13): a revision that changed after a verdict is
  // rework by definition; the one backward move it licenses is INTO the review
  // stage, where the re-verdict can be given. Same predicate `transitionStage`
  // re-vets, and the same shape `reworkStages` offers.
  if (validation !== "changed") return false;
  const target = verdictStageFor(
    { stages, workflow: project.parsed.frontmatter.workflow },
    task.parsed.frontmatter,
    listDeployedSpecialists(projectSlug, ctx),
  );
  return target !== null && toStageId === target;
}

/**
 * Ruling 163 (pass 35, F35-13 (d)): the sentence naming the way back to the
 * review stage for a task standing past it with a changed or failing
 * revision, or null when it does not apply. The operator's move is the first
 * remedy (`transition_stage` to the review stage, a rework move it performs
 * itself); the person's stage picker on the task page is the second, named so
 * the operator can point a human at it when its own move is refused.
 */
function reworkRemedySentence(
  ctx: TaskMutationContext,
  projectSlug: string,
  fm: { stage: string; validation: string; engagements: Engagement[] },
  stages: { id: string; name: string }[],
): string | null {
  if (fm.validation !== "changed" && fm.validation !== "failing") return null;
  const project = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
  if (!project) return null;
  const target = verdictStageFor(
    { stages, workflow: project.parsed.frontmatter.workflow },
    fm,
    listDeployedSpecialists(projectSlug, ctx),
  );
  if (target === null) return null;
  const review = stageName(stages, target);
  return (
    `The revision changed after the last verdict, so the task belongs back at ${review} ` +
    `where the reviewers are eligible: move it there with transition_stage (a rework move ` +
    `you perform yourself); a person can also move it with the stage picker on the task page.`
  );
}

/**
 * Ruling 162: why the operator may not move `taskKey` INTO the acceptance
 * stage right now, or null. Reads `mergeReadinessRefusal`, the GitHub-fact
 * half of the acceptance gate, so the move and the acceptance refuse with one
 * sentence. Null for any other target stage.
 */
function mergeStageEntryRefusal(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  toStageId: string,
): string | null {
  const project = readProjectFile({ projectSlug, dataRoot: ctx.dataRoot });
  const task = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!project || !task) return null;
  const stages = project.parsed.frontmatter.stages;
  const reviewId = resolveStageRoles(stages, project.parsed.frontmatter.workflow).reviewId;
  if (reviewId === null || toStageId !== reviewId) return null;
  const refusal = mergeReadinessRefusal(task.parsed.frontmatter, taskKey);
  if (!refusal) return null;
  const from = stageName(stages, task.parsed.frontmatter.stage);
  const to = stageName(stages, reviewId);
  return (
    `${refusal} ${taskKey} stays at ${from}: ${to} is where acceptance happens, and the gate ` +
    `would refuse it. Open the conflict packet (update_branch_from_base) or deliver the ` +
    `revision instead of moving the task.`
  );
}

/** The workflow boundary the operator would cross to move a task from its
 *  current stage to `toStageId`, or null when it isn't a declared transition. */
function operatorBoundaryFor(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  toStageId: string,
): "auto" | "approval" | "human" | null {
  const task = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  const project = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!task || !project) return null;
  const from = task.parsed.frontmatter.stage;
  const w = project.parsed.frontmatter.workflow.find((b) => b.from === from && b.to === toStageId);
  return w ? w.boundary : null;
}

/**
 * R19-6 (owner ruling 2026-08-06) — `completion-for-acceptance` withheld is a
 * HARD REFUSE: no recommendation card, no audit row, an out-loud refusal.
 *
 * `gate()` collapses both withheld modes to `deny`, and they mean different
 * things, so the refusal names which one it is:
 *
 *  - **`off`** — "withheld entirely (the tool is not even offered)"
 *    (`project-file.schema.ts`). Nothing about acceptance may originate with the
 *    operator: not the act, not the recommendation, not the audit trace of one.
 *  - **`human`** — "reserved for a human to perform". Same refusal, deliberately.
 *    A recommendation card is not a neutral note: applying one IS the acceptance
 *    (ruling 22 — the Apply click is the authorization), so a card would put the
 *    operator back in the acceptance path a `human` grant just removed it from.
 *    The Claude toolkit already withholds the `accept_completion` tool for BOTH
 *    modes and the Codex plan schema drops it for both; this keeps every other
 *    route consistent with that instead of leaving a second door open.
 *  - **no operator deployed** — `gate()` denies everything (A4); the same
 *    refusal, phrased for a project that granted nothing at all.
 *
 * Returns null when acceptance may proceed (`direct` or `recommend`).
 */
function completionCapabilityRefusal(
  authority: OperatorAuthority,
  taskKey: string,
): string | null {
  if (gate(authority, "completion-for-acceptance") !== "deny") return null;
  const mode = authority.deployed
    ? (authority.policy.get("completion-for-acceptance") ?? "off")
    : "off";
  const because =
    mode === "human"
      ? "that capability is reserved for a human here"
      : "that capability is withheld from the operator here";
  return (
    `Accepting completion is not permitted for the operator here: ${because}, ` +
    `so I am not recommending it either. ${taskKey} stays where it is; ` +
    `a maintainer accepts it on the task page.`
  );
}

/**
 * Accept completion and move the task to Done. This is the ONE deliberate
 * exception to the human-only-Done invariant: it performs the move ONLY under
 * FULL autonomy (governed additionally by completion-for-acceptance). Under
 * supervised autonomy it never moves to Done — it opens a completion packet a
 * human resolves (the existing acceptance UX).
 */
export async function operatorAcceptCompletion(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string },
  authority: OperatorAuthority,
): Promise<OperatorActionResult> {
  // R19-6 — FIRST, before any read, card or audit row. This function's only
  // `gate()` read used to live inside the direct/recommend choice below
  // (`!== "direct"` ⇒ recommend), so a WITHHELD capability fell into the
  // recommend branch and produced exactly what the grant forbids: a real
  // `accept_completion` card plus a `task.operator.recommended_completion`
  // audit row. Live-proven this pass via the F19-26 reroute, which reaches this
  // function under `stage-transitions: recommend` alone.
  {
    const refusal = completionCapabilityRefusal(authority, input.taskKey);
    if (refusal) return { outcome: "denied", message: refusal };
  }
  const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!file) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const project = readProjectFile({
    projectSlug: input.projectSlug,
    dataRoot: ctx.dataRoot,
  });
  if (!project) throw AppError.notFound(`Project ${input.projectSlug} not found.`);
  const stages = project.parsed.frontmatter.stages;
  // B-WF4: the STRUCTURAL terminal stage (one resolver everywhere, which does
  // the positional-last fallback itself); `"done"` is the last-ditch only for a
  // stage-less board, so this comparison always has a string to test against.
  const doneStageId =
    resolveStageRoles(stages, project.parsed.frontmatter.workflow).terminalId ??
    "done";

  if (file.parsed.frontmatter.stage === doneStageId) {
    // U36-9 (pass 36): the terminal stage by the board's own name.
    return {
      outcome: "noop",
      message: `${input.taskKey} is already ${stageNameOf(ctx, input.projectSlug, doneStageId)}.`,
    };
  }

  // P14-LV-02/B-WF6: ONE shared gate — `acceptanceRefusalFor` reads the same
  // helper every human writer does (graph position, required reviewers, the
  // R15-1 verdict gate, blocked packet, closed/conflicting PR, archived task).
  // The per-gate copies this function used to stack on top had already drifted
  // in wording and would drift in behavior next. Checked before BOTH branches
  // below, so a supervised operator never posts a card acceptance would refuse
  // and a full-autonomy one never closes a task off-gate.
  // F28-L1: run the live no-change probe BEFORE the shared gate so a verified-
  // empty completion (the R20-2 auto-detect of a task the deliverer never
  // explicitly claimed `noChanges`) isn't refused "no review pull request" here
  // — the same fix the human accept path carries. Cheap for a task WITH a PR
  // (fails noChangeCandidate, no GitHub call). A stale claim on a branch that
  // gained commits still fails closed at the full-autonomy write below.
  const noChange = await acceptanceNoChangeCheck(
    db,
    ctx,
    input.projectSlug,
    input.taskKey,
  );
  {
    const refusal = acceptanceRefusalFor(
      { projectSlug: input.projectSlug, taskKey: input.taskKey },
      ctx,
      noChange,
    );
    if (refusal) {
      // Ruling 163 (pass 35, F35-13 (d)): a task past the review stage whose
      // revision changed or failed after a verdict names its way out, so the
      // operator never has to discover the gap (KNC-20's packet offered profile
      // surgery and force-accept; the working remedy was the stage move).
      const remedy = reworkRemedySentence(ctx, input.projectSlug, file.parsed.frontmatter, stages);
      return { outcome: "noop", message: remedy ? `${refusal} ${remedy}` : refusal };
    }
  }

  // Supervised, or `completion-for-acceptance: recommend` → recommend only: post
  // an actionable "accept completion → Done" recommendation card (symmetric with
  // the other stage-transition cards, so the review→done boundary gets the same
  // clear one-click prompt as impl→review) — never move to Done ourselves. A
  // maintainer applies it to accept completion into Done.
  //
  // R19-6: this branch is reached ONLY with a granted capability. It used to
  // read "or without the completion capability", which is what let `off`/`human`
  // file a card — the withheld modes now refuse at the top of the function and
  // never arrive here.
  if (authority.autonomy !== "full" || gate(authority, "completion-for-acceptance") !== "direct") {
    const doneName = stageNameOf(ctx, input.projectSlug, doneStageId);
    // R19-8: a task with nothing to deliver merges nothing, so the card must not
    // promise a merge — the old single sentence told a human that applying it
    // "merges the review PR", for a task that has no PR and never will. The card
    // wording keys on the DURABLE claim (unchanged by F28-L1, which only reorders
    // the acceptance GATE so a verified-empty completion is not refused).
    const isNoChange = noChangeApplies(file.parsed.frontmatter);
    const requiredHere = readRequiredReviewers(input.projectSlug, ctx);
    // Ruling 137: the offer binds to the revision it describes, so a later
    // delivery can withdraw it by name and the card can say which one.
    const offer: RecommendationInput = {
      kind: "accept_completion",
      toStageId: doneStageId,
      label: isNoChange
        ? `Complete ${input.taskKey} with no changes and move it to ${doneName}`
        : `Accept completion and move ${input.taskKey} to ${doneName}`,
    };
    const offeredHeadSha =
      activeWorkRevision(file.parsed.frontmatter.workRevision)?.headSha ?? null;
    if (offeredHeadSha) offer.forHeadSha = offeredHeadSha;
    await addRecommendation(
      db,
      ctx,
      input.projectSlug,
      input.taskKey,
      offer,
      // Ruling 384 (F39-12): the first clause is DERIVED, never asserted. The
      // card used to open "The review is clean and the work meets the goal" on
      // every acceptance offer — live on AX-12 that sentence sat on a task with
      // `verdicts: []`, `validation: none` and no reviewer ever engaged. The
      // second clause keys on whether a PR EXISTS (`noChangeCandidate`), not on
      // the agent's `noChanges` flag, which is the R20-2 lesson: an envelope
      // that forgets the flag must not make the card promise a merge for a task
      // that has no pull request and never will (R19-8, regressed through the
      // flag).
      `${acceptanceOfferBasis(file.parsed.frontmatter, requiredHere)} ` +
        (isNoChange
          ? `There is nothing to deliver: no branch carries work for ${input.taskKey}. Accepting moves it to ${doneName} as **completed with no changes**; nothing is merged, and the branch state is re-checked when you confirm.`
          : noChangeCandidate(file.parsed.frontmatter)
            ? `Accepting completion moves ${input.taskKey} to ${doneName}. There is no pull request on this task, so nothing is merged.`
            : `Accepting completion moves ${input.taskKey} to ${doneName} and merges the review PR when GitHub is reachable; otherwise it records the PR as accepted (merge pending).`),
    );
    recordAudit(db, {
      action: "task.operator.recommended_completion",
      actor: OPERATOR_AUDIT_ACTOR,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { toStage: doneStageId, forHeadSha: offeredHeadSha },
    });
    return {
      outcome: "recommended",
      message: `Recommended accepting completion: move ${input.taskKey} to ${doneName}.`,
    };
  }

  // FULL autonomy: the operator accepts completion and moves the task to Done.
  // A REAL PR merge is attributed to a human (mergeTaskPr requires a user
  // identity), so the operator cannot merge — it records the PR as "accepted"
  // (merge pending), never a false "merged". A human merges / reconciles later.
  // B-WF6: the Done write itself is the SHARED acceptance core
  // (`applyAcceptanceWrite`) — this inlined mutation historically mirrored the
  // human path gate by gate and shipped with a subset more than once. The core
  // also re-checks the refusal gates inside the write lock (B-WF1).
  const hasPr = !!file.parsed.frontmatter.pr;
  // R19-8: the operator closes a no-change task through the SAME live, fail-
  // closed re-check the humans do — it has no force override, so an unverifiable
  // remote (or a branch that gained commits) is a plain noop with the reason.
  // The probe was hoisted above the gate (F28-L1); reuse it here.
  if (noChange.refusal) return { outcome: "noop", message: noChange.refusal };
  // R17-1 (F17-L12): name any reviewed-revision drift on the completion record.
  const driftNote = revisionDriftNote(file.parsed.frontmatter);
  const { accepted } = await applyAcceptanceWrite(db, ctx, {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    doneStageId,
    prState: "accepted",
    noChangeCheck: noChange,
    event: noChange.applies
      ? noChangeCompletionEvent({
          taskKey: input.taskKey,
          actor: { kind: "operator" },
          occurredAt: new Date().toISOString(),
          by: "operator",
          verification: noChange.verification,
        })
      : {
          occurredAt: new Date().toISOString(),
          type: "completion",
          actor: { kind: "operator" },
          title: "Completion accepted",
          text:
            // U36-9 (pass 36): the terminal stage by the board's own name.
            (hasPr
              ? `Operator accepted completion under **full-autonomy** policy. ${input.taskKey} moved to ${stageNameOf(ctx, input.projectSlug, doneStageId)}; the review PR is **accepted, merge pending** (a human merges it).`
              : `Operator accepted completion under **full-autonomy** policy. ${input.taskKey} moved to ${stageNameOf(ctx, input.projectSlug, doneStageId)}.`) +
            driftNote,
          toAgent: false,
          evidence: null,
        },
  });
  // U3 (NFR16): `accepted: false` means the task was ALREADY Done when the write
  // lock was taken — a human acceptance (or a second operator turn) landed while
  // this one was running its no-change probe. The completion event, the merge
  // and the audit belong to THAT write; the row below would be a second,
  // operator-attributed record of one acceptance, and the "moved to Done"
  // message would credit this turn with a move it did not make. The early
  // already-Done return above reads the file OUTSIDE the lock, so it is a guess;
  // this is the decision. Same shape as `forceAcceptCompletion`, which has
  // followed the write rather than preceding it since U3.
  if (!accepted) {
    return {
      outcome: "noop",
      message: `${input.taskKey} is already ${stageNameOf(ctx, input.projectSlug, doneStageId)}.`,
    };
  }
  recordAudit(db, {
    action: "task.operator.accepted_completion",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { autonomy: "full", toStage: doneStageId },
  });
  return {
    outcome: "done",
    message: `Accepted completion: ${input.taskKey} moved to ${stageNameOf(ctx, input.projectSlug, doneStageId)}.`,
  };
}
