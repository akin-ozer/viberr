import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import {
  ensureConnectionFresh,
  getConnection,
  getDefaultConnection,
  type FreshnessOptions,
} from "~/server/org/connections.server";
import { getProject } from "~/server/projections/board-query.server";
import { slugify } from "~/shared/ids/slugify";
import {
  createGithubClient,
  type GithubClientOptions,
} from "~/server/github/github-client.server";
import {
  reconcileProject,
  type GithubActionContext,
} from "~/server/github/github-reconciler.server";
import {
  clearProjectCredential,
  getPatToken,
  getProjectCredential,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";
import {
  revalidateProjectCredential,
  type RevalidateContext,
} from "~/server/secrets/pat-validator.server";
import { listScopeViolations } from "~/server/projections/policy-violations.server";
import { logger } from "~/server/logging/logger.server";
import { grantScopeToast, reconcileToast } from "./github-copy";
import { invalidateRepoAccess } from "./github-query.server";
import { errorMessage } from "~/shared/errors";

/**
 * The two GitHub-view actions, as thin typed wrappers over the phase-7-core
 * services: every degraded mode (`no_pat_configured`, `network_unavailable`,
 * …) is a VALUE mapped to honest toast copy — these functions never throw
 * for expected states (degraded-mode contract, phase-7-core report §7).
 *
 * Kept out of the route module so tests can inject `fetchImpl` (the route
 * itself has no transport hook by design).
 */

/** The data-root + transport hooks a credential call threads through. */
export interface CredentialCallContext {
  dataRoot?: string;
  fetchImpl?: typeof fetch;
}

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
  // F21-9: the module contract above says these wrappers never throw for
  // expected states — but the pass reaches file, db and GitHub payloads, and an
  // UNEXPECTED failure used to leave the route with a raw 500 and the human
  // with a dead button. The per-task boundary inside the reconciler keeps one
  // bad task from ending the sweep; this is the last one, so the click always
  // gets an answer that says what happened.
  let summary: Awaited<ReturnType<typeof reconcileProject>>;
  try {
    summary = await reconcileProject(db, projectSlug, actor, ctx);
  } catch (error) {
    const message = errorMessage(error);
    logger.error("project reconcile failed unexpectedly", {
      projectSlug,
      err: message,
    });
    // One line, capped: the toast names the cause the log carries in full, and
    // a multi-line stack-shaped message never lands in the UI.
    const detail = (message.split("\n", 1)[0] ?? "").slice(0, 200);
    return {
      ok: true,
      toast: detail
        ? `Checking GitHub failed (nothing was changed): ${detail}`
        : "Checking GitHub failed (nothing was changed), and the failure carried no message",
      result: "error",
    };
  }
  // F15-02: a pass that scanned nothing must not read as "synced" — name the
  // no-branched-tasks case; degraded contexts keep their own honest copy below.
  if (summary.status === "ok" && summary.results.length === 0) {
    return {
      ok: true,
      toast: "Checked GitHub. No task has a delivery branch yet, nothing to sync.",
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
  ctx: CredentialCallContext = {},
): Promise<void> {
  const options: RevalidateContext = { dataRoot: ctx.dataRoot };
  if (ctx.fetchImpl) options.fetchImpl = ctx.fetchImpl;
  try {
    await revalidateProjectCredential(db, projectSlug, actor, options);
  } catch {
    // tolerated — the credential works; chips upgrade on the next re-check
  }
}

/**
 * Can THIS connection's token actually see the project's repository?
 *
 * `connection.owner` is a LABEL (which account the PAT was added under), never
 * an access boundary: one token routinely reaches org repos and collaborator
 * repos under other owners. So the only honest answer is GitHub's — one
 * `GET /repos/{repo}` with the candidate token.
 *
 * Three outcomes, because "we could not ask" is not "the answer is no": an
 * unreachable GitHub returns `unverified` and never blocks a bind (the same
 * rule `ensureConnectionFresh` applies to a network error).
 */
type RepoProbe =
  | { status: "reachable" }
  | { status: "access_miss"; detail: string }
  | { status: "unverified"; detail: string };

async function probeRepoWithConnection(
  db: DatabaseSync,
  patId: string,
  repo: string,
  fetchImpl?: typeof fetch,
): Promise<RepoProbe> {
  const token = getPatToken(db, patId);
  if (!token) {
    return { status: "unverified", detail: "its stored token could not be read" };
  }
  const clientOptions: GithubClientOptions = { token };
  if (fetchImpl) clientOptions.fetchImpl = fetchImpl;
  const client = createGithubClient(clientOptions);
  const result = await client.request("GET", `/repos/${repo}`, z.unknown());
  if (result.ok) return { status: "reachable" };
  if (result.kind === "network") {
    return {
      status: "unverified",
      detail: `GitHub is unreachable (${result.message})`,
    };
  }
  if (result.kind === "http") {
    if (result.status === 404) {
      return { status: "access_miss", detail: "GitHub answered 404 (not found)" };
    }
    if (result.status === 401) {
      return { status: "access_miss", detail: "GitHub rejected the token (401)" };
    }
    if (result.status === 403) {
      return {
        status: "access_miss",
        detail: `GitHub refused it with 403 (${result.message})`,
      };
    }
    return {
      status: "unverified",
      detail: `GitHub answered ${result.status}`,
    };
  }
  return { status: "unverified", detail: "GitHub gave no usable answer" };
}

/**
 * Attach / rotate the project's GitHub credential (finding #13): binds an org
 * connection to the project via the phase-7 set-PAT flow. "Rotate" is the same
 * operation on an already-bound project — the org connection is where a token
 * is actually replaced. A missing connection is a degraded VALUE, never a throw.
 *
 * B-GH3: this used to bind `getDefaultConnection` unconditionally, so in a
 * multi-connection org a project whose repo lives under a non-default owner was
 * silently swapped onto another owner's PAT — the failure arrived later, as a
 * repo-access miss blamed on the token. The connection matching the repo owner
 * is therefore PREFERRED.
 *
 * It is not REQUIRED, though: owner-matching was briefly a hard refusal, which
 * stranded the entirely legitimate one-PAT-many-owners setup (org repos,
 * collaborator repos) that `repairProjectRepo` explicitly supports — it accepts
 * any `owner/name` and infers nothing from connection owners. So a project with
 * no owner-matched connection falls back to the org default and asks GitHub
 * whether that token reaches the repo; only a real access miss refuses.
 */
export async function runSetCredential(
  db: DatabaseSync,
  projectSlug: string,
  actor: AuditActor,
  ctx: GithubActionContext = {},
): Promise<GithubActionOutcome> {
  const repo = getProject(db, projectSlug)?.repo?.trim() || null;
  const repoOwner = repo ? (repo.split("/")[0]?.trim() ?? null) : null;
  const owned = repoOwner ? getConnection(db, slugify(repoOwner)) : null;
  // Repo-less projects predate the repo-bound ruling; the org default is still
  // the only meaningful answer for them.
  const connection = owned ?? getDefaultConnection(db);
  if (!connection) {
    return {
      ok: true,
      toast: "No GitHub connection to attach. Add one in Instance settings first",
      result: "no_connection",
    };
  }
  // B-GH7: binding is a token USE. A connection whose cached "valid" has gone
  // stale gets re-proved here, so a token revoked on github.com is refused now
  // instead of being handed to a project as if it were healthy.
  const freshOptions: FreshnessOptions = {};
  if (ctx.fetchImpl) freshOptions.fetchImpl = ctx.fetchImpl;
  const fresh = await ensureConnectionFresh(db, connection.id, freshOptions);
  // Only GitHub's own rejection refuses the bind — a never-validated connection
  // keeps its historical benefit of the doubt.
  if (fresh && fresh.validationState === "failed") {
    return {
      ok: true,
      toast: `GitHub rejected ${connection.owner}'s token. Replace it in Instance settings, then attach it here`,
      result: "connection_invalid",
    };
  }

  // Borrowing another owner's connection is the only case that has to be
  // proved before the bind — an owner match is the setup this flow is built on.
  let borrowedUnverified: string | null = null;
  if (!owned && repo) {
    const probe = await probeRepoWithConnection(
      db,
      connection.patId,
      repo,
      ctx.fetchImpl,
    );
    if (probe.status === "access_miss") {
      return {
        ok: true,
        toast: `${connection.owner}'s token cannot reach ${repo}: ${probe.detail}. Add a PAT for ${repoOwner} in Instance settings, or fix the repository here.`,
        result: "no_repo_access",
      };
    }
    borrowedUnverified = probe.status === "unverified" ? probe.detail : null;
  }

  const wasBound = getProjectCredential(db, projectSlug) !== null;
  setProjectCredential(db, { projectSlug, patId: connection.patId }, actor);
  // LV-05: the connection pill is derived from a 30 s memoized `checkRepoAccess`
  // probe. Without this the row kept saying "no credential" after a full reload.
  invalidateRepoAccess(db, projectSlug);
  const proveCtx: CredentialCallContext = { dataRoot: ctx.dataRoot };
  if (ctx.fetchImpl) proveCtx.fetchImpl = ctx.fetchImpl;
  await proveAttachedCredential(db, projectSlug, actor, proveCtx);
  const head = wasBound
    ? `Credential rotated to ${connection.owner}'s connection`
    : `Credential attached from ${connection.owner}'s connection`;
  let toast = wasBound ? `${head}. Sync uses it now` : head;
  if (!owned && repo) {
    toast = borrowedUnverified
      ? `${head}. No ${repoOwner} PAT, and ${borrowedUnverified}, so its access to ${repo} is unverified`
      : `${head}. No ${repoOwner} PAT, but this token reaches ${repo}`;
  }
  return { ok: true, toast, result: wasBound ? "rotated" : "attached" };
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
      ? "Credential removed. Branch and PR sync goes offline until one is attached"
      : "No credential was attached",
    result: cleared ? "cleared" : "noop",
  };
}
