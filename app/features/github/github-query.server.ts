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
 * mock's conflation, dropped per spec §7.3). A never-reconciled branch has
 * no compare data and honestly renders `synced`.
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
  /** F10-28: freshness of the cached GitHub state (last manual reconcile). */
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
 * Latest reconciled behindBy per task file, from provenance (or 0). Factory:
 * prepare the provenance statement ONCE and map many branch rows through it,
 * instead of re-preparing + running it per row inside `.map` (pass-4 WI-10 n+1).
 */
function createBehindByResolver(
  db: DatabaseSync,
): (sourcePath: string) => number {
  const stmt = db.prepare(
    `SELECT details_json FROM provenance
     WHERE source_path = ? AND action = 'github.reconcile'
     ORDER BY id DESC LIMIT 1`,
  );
  return (sourcePath: string): number => {
    const row = stmt.get(sourcePath) as
      | { details_json: string | null }
      | undefined;
    if (!row?.details_json) return 0;
    try {
      const details = JSON.parse(row.details_json) as { behindBy?: unknown };
      return typeof details.behindBy === "number" ? details.behindBy : 0;
    } catch {
      return 0;
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
    .map((t) => ({
      taskKey: t.key,
      title: t.title,
      branch: t.branch,
      pr: t.pr ? { number: t.pr.number, state: t.pr.state } : null,
      sync: deriveSyncState({
        prMerged: t.pr?.state === "merged",
        behindBy: behindByFor(t.filePath),
      }),
      commitCount: t.commits.length,
    }));

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

  // F10-28: GitHub state is served from cached projections + the LAST manual
  // reconcile — there is no scheduled sync. Surface the freshest reconcile time
  // so stale cached PR/branch state can't silently look current. `null` = never
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
    // Stale = never reconciled, or older than an hour (manual-only sync).
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
    // GHE-safe web host (WI-17) — the view must never hardcode github.com.
    githubHost: githubWebHost(),
    connection,
    credential,
    prs,
    branches,
    reconcile,
  };
}
