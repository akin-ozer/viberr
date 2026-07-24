import type { DatabaseSync } from "node:sqlite";
import { formatRelative } from "~/shared/dates/format";
import { deriveSyncState } from "~/server/github/branch-sync.server";
import { githubWebHost } from "~/server/github/github-client.server";
import {
  checkRepoAccess,
  type RepoAccessResult,
} from "~/server/github/repo-access-check.server";
import {
  getProject,
  listProjectTasks,
} from "~/server/projections/board-query.server";
import {
  getProjectCredentialHealth,
  type ProjectCredentialHealth,
} from "~/server/secrets/pat-store.server";
import type { SyncState } from "./github-pills";

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
}

export interface BranchRowView {
  taskKey: string;
  /** Task title (the Task cell). */
  title: string;
  branch: string;
  pr: { number: number; state: string } | null;
  sync: SyncState;
  /** Task-key-associated commits from the github cache (VIB-142 seeds 3). */
  commitCount: number;
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
 * Latest reconciled behindBy per task file, from provenance — or **null when the
 * branch was never compared** (UI-05). This used to return 0 for "no data",
 * which `deriveSyncState` cannot distinguish from a real "0 commits behind", so
 * an unreconciled branch was painted green "synced".
 *
 * Factory: prepare the provenance statement ONCE and map many branch rows
 * through it, instead of re-preparing + running it per row inside `.map`
 * (pass-4 WI-10 n+1).
 */
function createBehindByResolver(
  db: DatabaseSync,
): (sourcePath: string) => number | null {
  const stmt = db.prepare(
    `SELECT details_json FROM provenance
     WHERE source_path = ? AND action = 'github.reconcile'
     ORDER BY id DESC LIMIT 1`,
  );
  return (sourcePath: string): number | null => {
    const row = stmt.get(sourcePath) as
      | { details_json: string | null }
      | undefined;
    if (!row?.details_json) return null;
    try {
      const details = JSON.parse(row.details_json) as { behindBy?: unknown };
      return typeof details.behindBy === "number" ? details.behindBy : null;
    } catch {
      return null;
    }
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
  const behindByFor = createBehindByResolver(db);

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
        pr: t.pr ? { number: t.pr.number, state: t.pr.state } : null,
        // UI-05: a merged PR is authoritative regardless of compare data;
        // otherwise a branch with NO compare data reports `unknown`
        // ("not compared") rather than borrowing `deriveSyncState`'s
        // "behindBy === 0 → synced" rule for a measurement that never ran.
        sync:
          t.pr?.state === "merged"
            ? deriveSyncState({ prMerged: true, behindBy: 0 })
            : behindBy === null
              ? ("unknown" as const)
              : deriveSyncState({ prMerged: false, behindBy }),
        commitCount: t.commits.length,
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
    }))
    .sort((a, b) => b.number - a.number);

  // F10-28: GitHub state is served from cached projections refreshed by the
  // newest reconcile — the manual "Update status" button OR the 5-min
  // background poller (P11-14). Surface the freshest reconcile time so stale
  // cached PR/branch state can't silently look current. `null` = never
  // reconciled. Newest `github.reconcile` provenance across the project's tasks.
  const lastReconcileRow = db
    .prepare(
      `SELECT MAX(observed_at) AS latest FROM provenance
        WHERE action = 'github.reconcile' AND source_path LIKE ?`,
    )
    .get(`projects/${projectSlug}/%`) as { latest: string | null } | undefined;
  const lastReconciledAt = lastReconcileRow?.latest ?? null;
  // Computed server-side (SSR-stable, no client clock): the label is as-of page
  // load and refreshes when the loader revalidates on the next GitHub SSE event.
  const reconciledMs = lastReconciledAt ? Date.parse(lastReconciledAt) : NaN;
  const reconcile = {
    at: lastReconciledAt,
    label: Number.isFinite(reconciledMs) ? formatRelative(lastReconciledAt!) : null,
    // Stale = never reconciled, or older than an hour. With the 5-min poller
    // (P11-14) healthy this only trips when GitHub/config has been broken for
    // an hour — surfaced honestly by the freshness chip rather than a lie.
    stale:
      !Number.isFinite(reconciledMs) ||
      Date.now() - reconciledMs > 60 * 60_000,
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
