import type { PillKind } from "~/ui/pill";
import type { RepoAccessResult } from "~/server/github/repo-access-check.server";

/**
 * Client-safe pill mappings for the GitHub view (github-view spec §4.3/§4.4,
 * ruling 12). These mirror the server contracts in
 * `app/server/github/pr-linker.server.ts` (`prPillFor`) and
 * `branch-sync.server.ts` (`deriveSyncState` labels) — duplicated here only
 * because server modules must never reach client components; the shapes are
 * covered by tests on both sides.
 */

export interface PillView {
  kind: PillKind;
  label: string;
}

/** Sync column vocabulary (ruling 12: merged > behind > synced). */
export type SyncState = "merged" | "behind_main" | "synced";

export const SYNC_PILL: Record<SyncState, PillView> = {
  merged: { kind: "done", label: "merged" },
  behind_main: { kind: "risk", label: "behind main" },
  synced: { kind: "ready", label: "synced" },
};

export function syncPill(state: SyncState): PillView {
  return SYNC_PILL[state] ?? SYNC_PILL.synced;
}

/**
 * PR state pill (ruling 12): merged → done, closed-unmerged → risk "closed"
 * (the rendering the mock never designed), anything else ("review",
 * open/draft) → info "in review".
 */
export function prStatePill(state: string): PillView {
  if (state === "merged") return { kind: "done", label: "merged" };
  if (state === "closed") return { kind: "risk", label: "closed" };
  return { kind: "info", label: "in review" };
}

/**
 * Connection pill from the typed `checkRepoAccess` result (spec §7.9c: the
 * pill must not claim `connected` in any degraded state — no design exists
 * for these, so the labels below are the authored V1 vocabulary, documented
 * in the phase report).
 */
export function connectionPill(
  connection: Pick<RepoAccessResult, "status"> &
    Partial<Pick<Extract<RepoAccessResult, { status: "auth_failed" }>, "reason">>,
): PillView {
  switch (connection.status) {
    case "connected":
      return { kind: "ready", label: "connected" };
    case "no_repo_configured":
      return { kind: "neutral", label: "no repository" };
    case "no_pat_configured":
      return { kind: "input", label: "no credential" };
    case "repo_not_found":
      return { kind: "risk", label: "repo not found" };
    case "auth_failed":
      return {
        kind: "blocked",
        label:
          connection.reason === "expired" ? "token expired" : "token revoked",
      };
    case "org_approval_missing":
      return { kind: "risk", label: "approval needed" };
    case "forbidden":
      return { kind: "risk", label: "access refused" };
    case "network_unavailable":
      return { kind: "neutral", label: "offline" };
    default:
      return { kind: "neutral", label: "unknown" };
  }
}
