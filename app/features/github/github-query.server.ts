import type { DatabaseSync } from "node:sqlite";
import { formatRelative } from "~/shared/dates/format";
import { deriveSyncState } from "~/server/github/branch-sync.server";
import { githubWebHost } from "~/server/github/github-client.server";
import { recordRepoAccess } from "~/server/github/repo-health.server";
import {
  checkRepoAccess,
  type RepoAccessResult,
} from "~/server/github/repo-access-check.server";
import {
  getProject,
  listProjectTasks,
} from "~/server/projections/board-query.server";
import { isReconcileStale } from "~/server/interpretation/freshness-policy.server";
import {
  createReconcileBehindByLookup,
  latestProjectReconcileAt,
} from "~/server/provenance/provenance-query.server";
import {
  getProjectCredentialHealth,
  type ProjectCredentialHealth,
} from "~/server/secrets/pat-store.server";
import type { SyncState } from "./github-pills";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import {
  mapPrChecks,
  mapPrChecksUnread,
  type PrChecksUnread,
  prChecksRead,
  mapPrMergeable,
  mapPrReview,
  type PrChecksRender,
} from "~/shared/mapping/task.server";
import type { PrMergeable } from "~/schemas/task-file.schema";
import type { PrReviewState } from "~/schemas/task-file.schema";

/**
 * Loader assembly for /projects/:slug/github (github-view spec §3.1
 * `GithubViewData`, built on the phase-7-core recipe: `checkRepoAccess` +
 * `getProjectCredentialHealth` for the repository panel; task_projections
 * columns (branch / pr_json / github_json) for the PR + branch tables).
 *
 * Sync pill (ruling 12, merged > behind > synced): `merged` from the
 * projected pr.state; `behind_main` from the REAL compare captured by the
 * latest `github.reconcile` provenance row for the task (the reconciler
 * records behindBy there) — never from `validation === "failing"` (the
 * mock's conflation, dropped per spec §7.3). UI-05: a never-reconciled branch
 * has NO compare data and renders `unknown` ("not compared") — the old comment
 * claimed rendering it `synced` was honest; it was the opposite.
 */

export interface PrRowView {
  taskKey: string;
  number: number;
  /** Cache vocabulary: "review" | "merged" | "closed" (ruling 12). */
  state: string;
  /** PR title (the row headline in the mock). */
  title: string;
  branch: string | null;
  /** P13-D-28: CI health + GitHub's review verdict. Both were fetched-and-
   *  discarded or never read; the narrowing right here to number/state/title
   *  IS the "every consumer narrows" the finding describes. */
  checks: PrChecksRender | null;
  /** Ruling 276: whether GitHub's check state has ever been read for this PR.
   *  `checks: null` with `checksRead: true` means GitHub reported NO check
   *  runs; with `checksRead: false` it means nobody has looked. */
  checksRead: boolean;
  /** Ruling 360: the refused read, while nothing was ever read. */
  checksUnread?: PrChecksUnread | null;
  review: PrReviewState | null;
  /** P14-LV-07 / F17-L6: GitHub's last-read mergeability for an open PR — the
   *  conflict state the acceptance chain already knows but this page did not
   *  surface. Null = never read / not applicable (a settled PR). */
  mergeable: PrMergeable | null;
}

export interface BranchRowView {
  taskKey: string;
  /** Task title (the Task cell). */
  title: string;
  branch: string;
  pr: {
    number: number;
    state: string;
    /** P13-D-28. */
    checks: PrChecksRender | null;
    checksUnread?: PrChecksUnread | null;
    review: PrReviewState | null;
    /** F17-L6: conflict/mergeable state for an open PR (null when settled). */
    mergeable: PrMergeable | null;
  } | null;
  sync: SyncState;
  /** Task-key-associated commits from the github cache (VIB-142 seeds 3). */
  commitCount: number;
  /** Ruling 187: how many of `commitCount` the remote does not have. */
  unpushedCommitCount: number;
}

export interface GithubViewData {
  project: {
    slug: string;
    name: string;
    repo: string | null;
    defaultBranch: string;
  };
  /** GHE-safe web host for "Open on GitHub" links (WI-17). */
  githubHost: string;
  connection: RepoAccessResult;
  credential: ProjectCredentialHealth;
  prs: PrRowView[];
  branches: BranchRowView[];
  /** F10-28: freshness of the cached GitHub state — the newest reconcile,
   * from either the manual "Update status" button or the 5-min background
   * poller (P11-14). */
  reconcile: {
    /** ISO of the newest reconcile across the project's tasks, or null. */
    at: string | null;
    /** Relative label ("3m ago"), computed server-side; null when never. */
    label: string | null;
    /** Never reconciled or older than an hour → the state may be out of date. */
    stale: boolean;
  };
}

/**
 * Short-lived in-process cache for `checkRepoAccess` (pass-4 WI-10): a live
 * `GET /repos/:repo` runs on every loader call, and project-scope SSE
 * revalidates this loader on every task/project event while the view is open —
 * so a burst of board mutations would otherwise cost one GitHub round-trip
 * (and rate-limit budget) each. Only the production path (no injected
 * `fetchImpl`) is cached; tests always inject a `fetchImpl` and assert the
 * fresh per-call result, so they bypass the cache entirely. Keyed per Database
 * instance so parallel test DBs (and any future multi-tenant DB) never share
 * an entry.
 */
const REPO_ACCESS_TTL_MS = 30_000;
const repoAccessCache = new WeakMap<
  DatabaseSync,
  Map<string, { result: RepoAccessResult; at: number }>
>();

/**
 * LV-05: drop the memoized repo-access result for a project.
 *
 * Attaching a credential from the project GitHub page rendered the full scope
 * list while the Connection row kept the amber "no credential" pill **through a
 * full reload** — the 30 s memo above is per PROCESS, so a reload re-served the
 * pre-attach `no_pat_configured` answer, and only "Update status" (which takes
 * longer than the TTL to click) appeared to fix it. Every credential mutation
 * invalidates the entry so the next loader re-probes with the new credential.
 */
export function invalidateRepoAccess(
  db: DatabaseSync,
  projectSlug: string,
): void {
  repoAccessCache.get(db)?.delete(projectSlug);
}

async function checkRepoAccessCached(
  db: DatabaseSync,
  projectSlug: string,
  ctx: { fetchImpl?: typeof fetch },
): Promise<RepoAccessResult> {
  if (ctx.fetchImpl) {
    return checkRepoAccess(db, projectSlug, { fetchImpl: ctx.fetchImpl });
  }
  let byDb = repoAccessCache.get(db);
  if (!byDb) {
    byDb = new Map();
    repoAccessCache.set(db, byDb);
  }
  const now = Date.now();
  const hit = byDb.get(projectSlug);
  if (hit && now - hit.at < REPO_ACCESS_TTL_MS) return hit.result;
  const result = await checkRepoAccess(db, projectSlug);
  byDb.set(projectSlug, { result, at: now });
  // U33-2: this page is one of the two places that already knows the answer, so
  // it is where the board and the home card get theirs from. The in-memory cache
  // above is per process and per 30s; the row is what survives a restart and
  // what a surface with no business calling GitHub reads.
  recordRepoAccess(db, projectSlug, result);
  return result;
}

export async function getGithubViewData(
  db: DatabaseSync,
  projectSlug: string,
  ctx: { fetchImpl?: typeof fetch } = {},
): Promise<GithubViewData | null> {
  const project = getProject(db, projectSlug);
  if (!project) return null;

  const credential = getProjectCredentialHealth(db, projectSlug);
  const connection = await checkRepoAccessCached(db, projectSlug, ctx);

  const tasks = listProjectTasks(db, projectSlug);
  // P13-D-16: provenance reads live in server/provenance, not here.
  const behindByFor = createReconcileBehindByLookup(db);

  // Branch table: every task with a branch, in task-key order (the query
  // already sorts numerically — spec §7.11 deterministic-order deviation).
  const branches: BranchRowView[] = tasks
    .filter((t): t is typeof t & { branch: string } => t.branch !== null)
    .map((t) => {
      const behindBy = behindByFor(t.filePath);
      return {
        taskKey: t.key,
        title: t.title,
        branch: t.branch,
        pr: t.pr
          ? {
              number: t.pr.number,
              state: t.pr.state,
              checks: mapPrChecks(t.pr),
              checksUnread: mapPrChecksUnread(t.pr),
              review: mapPrReview(t.pr),
              mergeable: mapPrMergeable(t.pr),
            }
          : null,
        // UI-05: a merged PR is authoritative regardless of compare data;
        // otherwise a branch with NO compare data reports `unknown`
        // ("not compared") rather than borrowing `deriveSyncState`'s
        // "behindBy === 0 → synced" rule for a measurement that never ran.
        //
        // Ruling 401: and a FINISHED task that never committed anything has no
        // execution branch at all — the name was allocated at creation and
        // nothing was ever pushed to it. Whatever the last compare said about
        // its recorded revision, "behind main" is a demand nobody can meet on
        // work that is done. Checked before the compare, because the compare
        // is exactly what produces the wrong answer here.
        sync:
          t.pr?.state === "merged"
            ? deriveSyncState({ prMerged: true, behindBy: 0 })
            : isTerminalStage(t.stage, project.stages) &&
                !t.pr &&
                t.commits.length === 0
              ? ("no_branch" as const)
              : behindBy === null
                ? ("unknown" as const)
                : deriveSyncState({ prMerged: false, behindBy }),
        commitCount: t.commits.length,
        // Ruling 187 (pass 37, F37-8): how many of those the REMOTE does not
        // have. A commit an agent made in its workspace is real work and
        // belongs in the count, but rendering it identically to a pushed one
        // is what let SHOP-2 read "1 commit · synced" for a change that
        // existed nowhere. `pushed: undefined` means no compare could judge
        // it, which is not the same as false and is not counted here.
        unpushedCommitCount: t.commits.filter((c) => c.pushed === false).length,
      };
    });

  // PR list: every task with a PR, newest PR first (spec §7.11).
  const prs: PrRowView[] = tasks
    .filter((t) => t.pr !== null)
    .map((t) => ({
      taskKey: t.key,
      number: t.pr!.number,
      state: t.pr!.state,
      title: t.pr!.title,
      branch: t.branch,
      checks: mapPrChecks(t.pr),
      // Ruling 276: a null `checks` is two different facts, and the file keeps
      // them apart. Carried beside the render rather than folded into it, so
      // the page's "no pill for zero checks" stays exactly as it was.
      checksRead: prChecksRead(t.pr),
      checksUnread: mapPrChecksUnread(t.pr),
      review: mapPrReview(t.pr),
      mergeable: mapPrMergeable(t.pr),
    }))
    .sort((a, b) => b.number - a.number);

  // F10-28: GitHub state is served from cached projections refreshed by the
  // newest reconcile — the manual "Update status" button OR the 5-min
  // background poller (P11-14). Surface the freshest reconcile time so stale
  // cached PR/branch state can't silently look current. `null` = never
  // reconciled. P13-D-16/D-32: the provenance read is in server/provenance and
  // the staleness rule is in server/interpretation — neither belongs here.
  const lastReconciledAt = latestProjectReconcileAt(db, projectSlug);
  // Computed server-side (SSR-stable, no client clock): the label is as-of page
  // load and refreshes when the loader revalidates on the next GitHub SSE event.
  const reconcile = {
    at: lastReconciledAt,
    label:
      lastReconciledAt && Number.isFinite(Date.parse(lastReconciledAt))
        ? formatRelative(lastReconciledAt)
        : null,
    stale: isReconcileStale(lastReconciledAt),
  };

  return {
    project: {
      slug: project.slug,
      name: project.name,
      repo: project.repo,
      defaultBranch: project.defaultBranch,
    },
    // UI-11: this is `https://github.com` today and can be nothing else — no
    // connection record stores an API base URL, so `githubWebHost()` is always
    // called with no argument (here and in routes/project.task.tsx) and always
    // returns the default. The indirection is kept as the ONE place a future
    // GHE base URL would be threaded through; the previous comment ("GHE-safe
    // — the view must never hardcode github.com") advertised support that does
    // not exist. V1 is github.com-only (github-reconciler.server.ts says so).
    githubHost: githubWebHost(),
    connection,
    credential,
    prs,
    branches,
    reconcile,
  };
}
