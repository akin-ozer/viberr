/**
 * Toast copy for the GitHub view's two actions, in ONE pure module so the
 * matrix is unit-testable and every caller shows identical strings.
 *
 * The two reconcile strings are the VERBATIM spec contract (github-view
 * §4.6); the grant-scope success string is the mock's, with the task key
 * interpolated per spec §5.3. Everything else covers typed degraded
 * results the mock never designed (no PAT, offline, revoked …) — honest
 * copy authored here, flagged in the phase report.
 */

export const RECONCILE_START_TOAST = "Updating branch and PR status from GitHub…";
export const RECONCILE_DONE_TOAST =
  "Status updated. Every branch and PR maps to its task key";

/** Input distilled from a ProjectReconcileSummary (server maps to this). */
export interface ReconcileToastInput {
  status: "ok" | "no_pat_configured" | "no_repo_configured";
  reconciled: number;
  failed: number;
  /** True when every failed task hit network_unavailable. */
  allFailuresOffline: boolean;
}

export function reconcileToast(input: ReconcileToastInput): string {
  if (input.status === "no_pat_configured") {
    return "No GitHub credential configured. Connect a PAT to reconcile branches and PRs.";
  }
  if (input.status === "no_repo_configured") {
    return "No repository configured for this project.";
  }
  if (input.failed === 0) return RECONCILE_DONE_TOAST;
  if (input.allFailuresOffline) {
    // Spec §7.10: stale-but-labeled beats blank — last-known data stays up.
    return "GitHub is unreachable. Showing the last-known branch and PR state.";
  }
  return `Reconciled ${input.reconciled} of ${input.reconciled + input.failed} branches. ${input.failed} couldn't sync; last-known state kept.`;
}

/** Input distilled from a RevalidateProjectCredentialResult (+ post-state). */
export interface GrantScopeToastInput {
  status: "no_pat_configured" | "network_unavailable" | "revalidated";
  /** validation.status when revalidated ("valid", "revoked", …). */
  validationStatus?: string;
  /** Task key of the first violation this run resolved (mock: VIB-142). */
  resolvedTaskKey?: string | null;
  resolvedCount: number;
  /** First scope still flagged open after the run, if any. */
  stillMissingScope?: string | null;
}

export function grantScopeToast(input: GrantScopeToastInput): string {
  if (input.status === "no_pat_configured") {
    return "No GitHub credential configured. Connect a PAT before re-checking scopes.";
  }
  if (input.status === "network_unavailable") {
    return "GitHub is unreachable. Kept the last-known scope results.";
  }
  if (input.resolvedCount > 0) {
    // Mock string with the flagged task interpolated (spec §5.3).
    const flag = input.resolvedTaskKey ?? "project";
    return `Scope granted · ${flag} policy flag resolved`;
  }
  switch (input.validationStatus) {
    case "revoked":
      return "Re-check failed: the credential was revoked on GitHub.";
    case "expired":
      return "Re-check failed: the credential has expired.";
    case "repo_not_found":
      return "Re-check couldn't see the repository. The credential may lack repo access.";
    case "org_approval_missing":
      return "Re-check blocked: the token is pending organization approval.";
    default:
      break;
  }
  if (input.stillMissingScope) {
    return `Re-checked. ${input.stillMissingScope} is still missing on the project credential.`;
  }
  return "Scopes re-checked. All required scopes granted.";
}
