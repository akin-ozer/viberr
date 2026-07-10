/**
 * THE canonical audit-action catalog (Phase 10).
 *
 * Every `recordAudit` call site in the app must use an action name listed
 * here — `audit-coverage.server.test.ts` statically extracts the literals
 * from every recordAudit call and asserts set-equality with this catalog in
 * BOTH directions (an unregistered action fails the build; a stale catalog
 * entry does too). Add the action here in the same change that adds the
 * recorder call.
 *
 * Naming: lowercase dot-separated facts, `<subject-family>.<entity>.<fact>`
 * (matching the phase 2–9 vocabulary; historical rows are never renamed).
 *
 * `scope` documents which subject-reference fields a recorder call must
 * set — enforced by the table-driven half of the coverage test:
 * - "task"    → projectSlug AND taskKey
 * - "project" → projectSlug (taskKey optional)
 * - "org" | "auth" | "system" → no project/task refs required
 */

export type AuditScope = "auth" | "org" | "project" | "task" | "system";

export const AUDIT_ACTIONS: Record<string, AuditScope> = {
  // -- authentication & identity (phase 2 / 9C / 10) ----------------------
  "auth.login.success": "auth",
  "auth.login.failure": "auth",
  "auth.login.rate_limited": "auth",
  "auth.logout": "auth",
  "auth.oauth.login": "auth",
  "auth.oauth.user_provisioned": "auth", // google domain allowlist provisioning
  "auth.oauth.placeholder_claimed": "auth", // github handle placeholder claim
  "auth.password.changed": "auth",
  "auth.password.reset": "auth",
  "auth.password.forced_reset_completed": "auth",
  "identity.github.disconnected": "auth",
  "profile.updated": "auth",

  // -- org administration (phases 2 + 9B) ---------------------------------
  "org.user.created": "org",
  "org.user.updated": "org",
  "org.user.disabled": "org",
  "org.user.enabled": "org",
  "org.user.removed": "org",
  "org.user.whitelisted": "org",
  "org.domain.whitelisted": "org",
  "org.domain.removed": "org",
  "org.connection.created": "org",
  "org.connection.token_replaced": "org",
  "org.connection.default_changed": "org",
  "org.connection.removed": "org",
  "org.kb.created": "org",
  "org.kb.updated": "org",
  "org.kb.deleted": "org",
  "org.kb.reindexed": "org",
  "org.mcp.added": "org",
  "org.mcp.updated": "org",
  "org.mcp.removed": "org",
  "org.skill.created": "org",
  "org.skill.updated": "org",
  "org.skill.deleted": "org",
  "org.agent_profile.created": "org",
  "org.agent_profile.updated": "org",
  "org.agent_profile.deleted": "org",
  "org.store.files_added": "org",
  "org.store.folder_created": "org",
  "org.store.file_deleted": "org",
  "org.store.folder_deleted": "org",
  "org.store.github_import": "org",

  // -- project governance (phases 4 + 9A) ---------------------------------
  "project.created": "project",
  "project.deleted": "project",
  "project.archived": "project",
  "project.unarchived": "project",
  "project.settings.updated": "project",
  "project.repo_override.changed": "project",
  "project.stage.added": "project",
  "project.stage.renamed": "project",
  "project.stage.removed": "project",
  "project.stage.reordered": "project",
  "project.member.invited": "project",
  "project.member.removed": "project",
  "project.member.role_changed": "project",
  "project.policy.boundary_changed": "project",
  "project.agent_profile.created": "project",
  "project.agent_profile.updated": "project",
  "project.agent_profile.deleted": "project",

  // -- task lifecycle (phases 3 + 5) ---------------------------------------
  "task.created": "task",
  "task.comment": "task",
  "task.transition": "task",
  "task.packet.resolved": "task",
  "task.ownership.taken": "task",
  "task.ownership.handed_off": "task",
  "task.ownership.released": "task",
  "task.ownership.admin_released": "task",
  "task.specialist.assigned": "task",
  "task.specialist.run_started": "task",
  "task.reviewer.assigned": "task",
  "task.reviewer.removed": "task",
  "task.reviewer.run_started": "task",
  "task.agent.replied": "task",
  "task.quality.flagged": "task",
  // Operator-authored governance actions (operator-actions.server).
  "task.operator.commented": "task",
  "task.operator.recommended": "task",
  "task.operator.recommended_completion": "task",
  "task.operator.accepted_completion": "task",
  "task.operator.packet_opened": "task",
  // Human resolution of operator recommendation cards.
  "task.recommendation.applied": "task",
  "task.recommendation.dismissed": "task",

  // -- GitHub integration (phase 7) ----------------------------------------
  "github.pat.created": "org",
  "github.pat.token_replaced": "org",
  "github.pat.deleted": "org",
  "github.credential.assigned": "project",
  "github.credential.cleared": "project",
  "github.credential.revalidated": "project", // Phase 10: grant/re-check attempt
  "github.branch.created": "task",
  "github.reconcile.task": "task",
  "github.reconcile.project": "project",
  "github.pr.opened": "task",
  "github.pr.merged": "task",
  "github.pr.merge_refused": "task",
  // scope-violation rows may be project-wide (taskKey nullable).
  "github.scope_violation.opened": "project",
  "github.scope_violation.resolved": "project",

  // -- runtimes (phases 8 + 10) --------------------------------------------
  "runtime.run.started": "task",
  "runtime.run.interrupted": "task",

  // -- store / projections & maintenance (phases 3 + 10) --------------------
  "projection.rescan": "system",
  "projection.rebuild": "system",
  "seed.demo_dataset": "system",
  "seed.org_resources": "system",
};

export const AUDIT_ACTION_NAMES = Object.keys(AUDIT_ACTIONS).sort();
