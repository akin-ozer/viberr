import type Database from "better-sqlite3";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { getDefaultConnection } from "~/server/org/connections.server";
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
import {
  projectCompletionSignal,
  withProjectCompletionEffect,
} from "~/server/runtimes/run-completion-state.server";

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
  db: Database.Database,
  projectSlug: string,
  actor: AuditActor,
  ctx: GithubActionContext = {},
): Promise<GithubActionOutcome> {
  const signal = projectCompletionSignal(db, projectSlug);
  return withProjectCompletionEffect(db, projectSlug, async () => {
    const summary = await reconcileProject(db, projectSlug, actor, {
      ...ctx,
      signal,
    });
    if (signal.aborted) {
      throw new DOMException("Project lifecycle ownership was revoked.", "AbortError");
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
  });
}

/**
 * Grant scope / re-check (settings spec §5.4, surfaced here until Phase 9
 * ships the Settings card): revalidateProjectCredential resolves every open
 * violation the fresh validation clears and writes the typed `policy`
 * event to each violation's own task — this wrapper only picks the toast.
 */
export async function runGrantScope(
  db: Database.Database,
  projectSlug: string,
  actor: AuditActor,
  ctx: { dataRoot?: string; fetchImpl?: typeof fetch } = {},
): Promise<GithubActionOutcome> {
  const result = await revalidateProjectCredential(db, projectSlug, actor, ctx);

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
 * Attach / rotate the project's GitHub credential (finding #13): binds the
 * org DEFAULT connection's PAT to the project via the phase-7 set-PAT flow.
 * "Rotate" is the same operation on an already-bound project — it re-points at
 * the current default (the org connection is where a token is actually
 * replaced). No default connection is a degraded VALUE, never a throw.
 */
export function runSetCredential(
  db: Database.Database,
  projectSlug: string,
  actor: AuditActor,
): GithubActionOutcome {
  const connection = getDefaultConnection(db);
  if (!connection) {
    return {
      ok: true,
      toast: "No GitHub connection to attach — add one in org settings first",
      result: "no_connection",
    };
  }
  const wasBound = getProjectCredential(db, projectSlug) !== null;
  setProjectCredential(db, { projectSlug, patId: connection.patId }, actor);
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
  db: Database.Database,
  projectSlug: string,
  actor: AuditActor,
): GithubActionOutcome {
  const cleared = clearProjectCredential(db, projectSlug, actor);
  return {
    ok: true,
    toast: cleared
      ? "Credential removed — branch and PR sync goes offline until one is attached"
      : "No credential was attached",
    result: cleared ? "cleared" : "noop",
  };
}
