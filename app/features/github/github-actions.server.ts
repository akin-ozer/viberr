import type { DatabaseSync } from "node:sqlite";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import {
  ensureConnectionFresh,
  getConnection,
  getDefaultConnection,
} from "~/server/org/connections.server";
import { getProject } from "~/server/projections/board-query.server";
import { slugify } from "~/shared/ids/slugify";
import {
  reconcileProject,
  type GithubActionContext,
} from "~/server/github/github-reconciler.server";
import {
  clearProjectCredential,
  getProjectCredential,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";
import { revalidateProjectCredential } from "~/server/secrets/pat-validator.server";
import { listScopeViolations } from "~/server/projections/policy-violations.server";
import { grantScopeToast, reconcileToast } from "./github-copy";
import { invalidateRepoAccess } from "./github-query.server";

/**
 * The two GitHub-view actions, as thin typed wrappers over the phase-7-core
 * services: every degraded mode (`no_pat_configured`, `network_unavailable`,
 * …) is a VALUE mapped to honest toast copy — these functions never throw
 * for expected states (degraded-mode contract, phase-7-core report §7).
 *
 * Kept out of the route module so tests can inject `fetchImpl` (the route
 * itself has no transport hook by design).
 */

export interface GithubActionOutcome {
  ok: true;
  toast: string;
  /** Machine-readable result for tests / callers. */
  result: string;
}

/** Reconcile button (github-view §4.1/§5.1): reconcileProject → toast. */
export async function runReconcile(
  db: DatabaseSync,
  projectSlug: string,
  actor: AuditActor,
  ctx: GithubActionContext = {},
): Promise<GithubActionOutcome> {
  const summary = await reconcileProject(db, projectSlug, actor, ctx);
  // F15-02: a pass that scanned nothing must not read as "synced" — name the
  // no-branched-tasks case; degraded contexts keep their own honest copy below.
  if (summary.status === "ok" && summary.results.length === 0) {
    return {
      ok: true,
      toast: "Checked GitHub — no task has a delivery branch yet, nothing to sync.",
      result: "no_branched_tasks",
    };
  }
  const failures = summary.results.filter(
    (r) => r.status !== "reconciled" && r.status !== "no_branch",
  );
  const toast = reconcileToast({
    status: summary.status,
    reconciled: summary.reconciled,
    failed: summary.failed,
    allFailuresOffline:
      failures.length > 0 &&
      failures.every((r) => r.status === "network_unavailable"),
  });
  return { ok: true, toast, result: summary.status };
}

/**
 * Grant scope / re-check (settings spec §5.4, surfaced here until Phase 9
 * ships the Settings card): revalidateProjectCredential resolves every open
 * violation the fresh validation clears and writes the typed `policy`
 * event to each violation's own task — this wrapper only picks the toast.
 */
export async function runGrantScope(
  db: DatabaseSync,
  projectSlug: string,
  actor: AuditActor,
  ctx: { dataRoot?: string; fetchImpl?: typeof fetch } = {},
): Promise<GithubActionOutcome> {
  const result = await revalidateProjectCredential(db, projectSlug, actor, ctx);
  // LV-05: a re-validation can change the credential's health, so the memoized
  // connection probe must not keep serving the pre-check answer.
  invalidateRepoAccess(db, projectSlug);

  if (result.status !== "revalidated") {
    return {
      ok: true,
      toast: grantScopeToast({ status: result.status, resolvedCount: 0 }),
      result: result.status,
    };
  }

  const stillOpen = listScopeViolations(db, projectSlug, { status: "open" });
  return {
    ok: true,
    toast: grantScopeToast({
      status: "revalidated",
      validationStatus: result.validation.status,
      resolvedCount: result.resolvedViolations.length,
      resolvedTaskKey: result.resolvedViolations[0]?.taskKey ?? null,
      stillMissingScope: stillOpen[0]?.scope ?? null,
    }),
    result:
      result.resolvedViolations.length > 0 ? "resolved" : "revalidated",
  };
}

/**
 * Prove the freshly-bound PAT against the project's REAL repository.
 *
 * The connection modal necessarily validates with `repo: null`, which pins a
 * fine-grained token at all-"assumed" (`~`) scope chips forever — on the org
 * card too, since both surfaces render the same per-PAT cache. A project-scoped
 * run upgrades `repo` and `pull_request:write` to dry-run-probe verdicts.
 *
 * Best-effort by contract: the bind has already happened, and a degraded GitHub
 * must not fail it. Exported so EVERY path that binds a credential (attach,
 * rotate, project creation) proves it the same way — F15-01 was exactly one
 * such path skipping the probes, leaving a card with zero proven scopes.
 */
export async function proveAttachedCredential(
  db: DatabaseSync,
  projectSlug: string,
  actor: AuditActor,
  ctx: { dataRoot?: string; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  try {
    await revalidateProjectCredential(db, projectSlug, actor, {
      dataRoot: ctx.dataRoot,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
  } catch {
    // tolerated — the credential works; chips upgrade on the next re-check
  }
}

/**
 * Attach / rotate the project's GitHub credential (finding #13): binds the
 * connection that OWNS the project's repository to the project via the phase-7
 * set-PAT flow. "Rotate" is the same operation on an already-bound project — it
 * re-points at that owner's current connection (the org connection is where a
 * token is actually replaced). A missing connection is a degraded VALUE, never
 * a throw.
 *
 * B-GH3: this used to bind `getDefaultConnection` unconditionally, while
 * project creation resolved the connection matching the repo OWNER. In a
 * multi-connection org, rotating a project whose repo lives under a non-default
 * owner silently swapped it onto a different owner's PAT — the failure then
 * arrived later, as a repo-access miss blamed on the token.
 */
export async function runSetCredential(
  db: DatabaseSync,
  projectSlug: string,
  actor: AuditActor,
  ctx: GithubActionContext = {},
): Promise<GithubActionOutcome> {
  const repoOwner = getProject(db, projectSlug)?.repo?.split("/")[0]?.trim();
  const connection = repoOwner
    ? getConnection(db, slugify(repoOwner))
    : // Repo-less projects predate the repo-bound ruling; the org default is
      // still the only meaningful answer for them.
      getDefaultConnection(db);
  if (!connection) {
    return {
      ok: true,
      toast: repoOwner
        ? `No GitHub connection for ${repoOwner} — this project's repo lives there, so add that owner's PAT in org settings first`
        : "No GitHub connection to attach — add one in org settings first",
      result: repoOwner ? "no_owner_connection" : "no_connection",
    };
  }
  // B-GH7: binding is a token USE. A connection whose cached "valid" has gone
  // stale gets re-proved here, so a token revoked on github.com is refused now
  // instead of being handed to a project as if it were healthy.
  const fresh = await ensureConnectionFresh(db, connection.id, {
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  // Only GitHub's own rejection refuses the bind — a never-validated connection
  // keeps its historical benefit of the doubt.
  if (fresh && fresh.validationState === "failed") {
    return {
      ok: true,
      toast: `GitHub rejected ${connection.owner}'s token — replace it in org settings, then attach it here`,
      result: "connection_invalid",
    };
  }

  const wasBound = getProjectCredential(db, projectSlug) !== null;
  setProjectCredential(db, { projectSlug, patId: connection.patId }, actor);
  // LV-05: the connection pill is derived from a 30 s memoized `checkRepoAccess`
  // probe. Without this the row kept saying "no credential" after a full reload.
  invalidateRepoAccess(db, projectSlug);
  await proveAttachedCredential(db, projectSlug, actor, {
    dataRoot: ctx.dataRoot,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  return {
    ok: true,
    toast: wasBound
      ? `Credential rotated to ${connection.owner}'s connection — sync uses it now`
      : `Credential attached from ${connection.owner}'s connection`,
    result: wasBound ? "rotated" : "attached",
  };
}

/**
 * Remove the project's GitHub credential (finding #13): unbinds the stored PAT
 * so branch/PR sync goes offline (the health reader falls back to the
 * credentialPolicy display, or "none"). Idempotent.
 */
export function runClearCredential(
  db: DatabaseSync,
  projectSlug: string,
  actor: AuditActor,
): GithubActionOutcome {
  const cleared = clearProjectCredential(db, projectSlug, actor);
  // LV-05: same invalidation on removal — otherwise the pill keeps claiming
  // "connected" for up to 30 s after the credential is gone.
  invalidateRepoAccess(db, projectSlug);
  return {
    ok: true,
    toast: cleared
      ? "Credential removed — branch and PR sync goes offline until one is attached"
      : "No credential was attached",
    result: cleared ? "cleared" : "noop",
  };
}
