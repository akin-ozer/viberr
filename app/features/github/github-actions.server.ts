import type Database from "better-sqlite3";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import {
  reconcileProject,
  type GithubActionContext,
} from "~/server/github/github-reconciler.server";
import { revalidateProjectCredential } from "~/server/secrets/pat-validator.server";
import { listScopeViolations } from "~/server/projections/policy-violations.server";
import { grantScopeToast, reconcileToast } from "./github-copy";

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
  const summary = await reconcileProject(db, projectSlug, actor, ctx);
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
