import type { DatabaseSync } from "node:sqlite";
import { SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { logger } from "~/server/logging/logger.server";
import { createNotification } from "~/server/projections/notifications.server";
import { listProjectMembers } from "~/server/projections/board-query.server";
import {
  reconcileProject,
  RECONCILE_POLL_TASK_BUDGET,
  type GithubActionContext,
} from "./github-reconciler.server";

/**
 * Background PR-status poller (P11-14, owner ruling 2026-07-24). The R8-6
 * divergence reconciler (a PR merged/closed out-of-band) used to run ONLY when a
 * maintainer clicked the manual button, so out-of-band GitHub changes went
 * unnoticed indefinitely. This polls every ACTIVE (non-archived) project that has
 * task branches, every 5 minutes, so the divergence event + watcher notification
 * + recommendation-withdrawal fire automatically. Poller ticks suppress the
 * per-project summary audit (`skipProjectAudit`) to avoid audit-log spam; the
 * meaningful per-task divergence events still fire, and the manual "Update
 * status" button keeps its human audit.
 */

export const RECONCILE_POLL_MS = 5 * 60_000; // 5 minutes

const POLICY_ENGINE_NOTIFY_FROM = {
  kind: "system" as const,
  name: "Policy engine",
};

/**
 * Nudge for tasks accepted into Done whose PR is still OPEN on GitHub — the
 * "merge pending" state (F12-05). An Autonomous-preset operator can self-accept
 * a task (Done), but `merge-pull-request` is always-human, so nothing actually
 * merges the PR: without a nudge, a Done task's PR dangles unmerged forever.
 * Deduped by the notification's distinctive per-(project, task, PR) title so a
 * steady poll doesn't re-notify. (Notification retention can eventually evict an
 * old nudge row, after which the poller re-reminds — benign, since the merge is
 * genuinely still pending.) A human completes the merge (Complete-merge / gh).
 */
async function nudgeMergePendingTasks(
  db: DatabaseSync,
  ctx: GithubActionContext,
): Promise<number> {
  // B9: this matched `pr_json LIKE '%"state":"accepted"%'` — a substring scan of
  // a JSON blob, which a PR TITLE containing that text satisfies just as well.
  // `json_extract` asks the question the code actually means; the re-parse below
  // stays because the projection column is still a blob and the number matters.
  // SAFETY: `project_slug` and `task_key` are NOT NULL TEXT on
  // `task_projections` (0001_baseline.sql), and the WHERE clause admits only
  // rows whose `pr_json` is non-null valid JSON — so every selected row carries
  // the three strings named here.
  const rows = db
    .prepare(
      `SELECT t.project_slug AS slug, t.task_key AS key, t.pr_json AS pr
         FROM task_projections t
         JOIN projects p ON p.slug = t.project_slug
        WHERE p.archived = 0
          AND t.pr_json IS NOT NULL
          AND json_valid(t.pr_json)
          AND json_extract(t.pr_json, '$.state') = 'accepted'`,
    )
    .all() as { slug: string; key: string; pr: string }[];
  let nudged = 0;
  for (const row of rows) {
    let pr: { number?: number; state?: string };
    try {
      pr = JSON.parse(row.pr);
    } catch {
      continue;
    }
    if (pr.state !== "accepted" || !pr.number) continue;
    const title = `PR #${pr.number} accepted: merge to finish ${row.key}`;
    const exists = db
      .prepare(
        `SELECT 1 FROM notifications
          WHERE project_slug = ? AND task_key = ? AND kind = 'policy' AND title = ? LIMIT 1`,
      )
      .get(row.slug, row.key, title);
    if (exists) continue;
    const { notifyTaskWatchers } = await import(
      "~/server/tasks/task-actions.server"
    );
    notifyTaskWatchers(
      db,
      {
        projectSlug: row.slug,
        taskKey: row.key,
        kind: "policy",
        title,
        text: `${row.key} was accepted into Done, but PR #${pr.number} is still open on GitHub. Merge it to finish delivery. (The completion was accepted with the merge still pending: a full-autonomy operator can't merge, and a human accept records "merge pending" when GitHub was unreachable or the merge was refused; a human completes it from the task's Complete-merge button or via GitHub.)`,
        from: POLICY_ENGINE_NOTIFY_FROM,
      },
      ctx,
    );
    nudged += 1;
  }
  return nudged;
}

/**
 * C7 (pass 23): a persistent reconcile failure for a project (a revoked PAT, a
 * network partition) was invisible — PRs GitHub merged/closed days ago still show
 * open on the board, and every 5-minute tick logged the same warn with no
 * notification or health surface. After this many CONSECUTIVE failures for a
 * project (~15 min at the poll cadence), raise ONE deduped policy notification to
 * the people who can fix it (project admins + maintainers); a later success
 * clears the streak so a fresh outage re-alerts. In-memory + reset-on-restart,
 * exactly like the poller handle: a restart re-counts from zero and re-crosses
 * the threshold within N ticks if the outage persists.
 */
export const RECONCILE_FAILURE_ALERT_THRESHOLD = 3;

const FAILURE_KEY = Symbol.for("viberr.githubReconcileFailures");
interface FailureHost {
  [FAILURE_KEY]?: Map<string, { fails: number; alerted: boolean }>;
}
function failureTracker(): Map<string, { fails: number; alerted: boolean }> {
  // SAFETY: a viberr-namespaced registry symbol only these two helpers touch.
  const host = globalThis as FailureHost;
  return (host[FAILURE_KEY] ??= new Map());
}

/** A project reconcile succeeded — clear any failure streak so a new outage
 *  re-alerts (and, if we had alerted, stop suppressing future alerts). */
export function noteReconcileSuccess(slug: string): void {
  const tracker = failureTracker();
  if (tracker.has(slug)) tracker.delete(slug);
}

/** A project reconcile threw — count it, and at the threshold notify the people
 *  who can fix the credential, exactly once until it recovers. Best-effort:
 *  the alert must never turn a per-project failure into a poll-aborting throw. */
export function noteReconcileFailure(db: DatabaseSync, slug: string): void {
  const tracker = failureTracker();
  const entry = tracker.get(slug) ?? { fails: 0, alerted: false };
  entry.fails += 1;
  tracker.set(slug, entry);
  if (entry.fails < RECONCILE_FAILURE_ALERT_THRESHOLD || entry.alerted) return;
  try {
    // Admins + maintainers: the roles that manage the GitHub connection (admin)
    // and bind the project credential (maintainer). A contributor/viewer can do
    // nothing about a failing token, so alerting them would only be noise.
    const recipients = listProjectMembers(db, slug).filter(
      (m) => m.role === "admin" || m.role === "maintainer",
    );
    const title = "GitHub sync is failing for this project";
    const text = `Viberr has been unable to reach GitHub for this project's repository across ${entry.fails} checks. Branch and PR status may be stale (a merged or closed PR can still show open). Check the project's GitHub credential — the token may be expired, revoked, or missing repository access.`;
    for (const member of recipients) {
      createNotification(db, {
        // Deterministic id → restart-safe idempotency (INSERT OR REPLACE), on
        // top of the in-memory `alerted` flag that stops per-tick repeats.
        id: `ntf_ghsync_${slug}_${member.userId}`,
        userId: member.userId,
        kind: "policy",
        projectSlug: slug,
        title,
        text,
        from: POLICY_ENGINE_NOTIFY_FROM,
      });
    }
    entry.alerted = true;
    logger.warn("github reconcile failing — alerted project admins", {
      projectSlug: slug,
      consecutiveFailures: entry.fails,
      recipients: recipients.length,
    });
  } catch (error) {
    logger.error("could not raise github-sync-failing notification", {
      projectSlug: slug,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/** Active projects that have at least one branched task worth reconciling. */
function projectsToPoll(db: DatabaseSync): string[] {
  // SAFETY: `task_projections.project_slug` is NOT NULL TEXT
  // (0001_baseline.sql), so each row of this single-column SELECT holds a slug.
  return (
    db
      .prepare(
        `SELECT DISTINCT t.project_slug AS slug
           FROM task_projections t
           JOIN projects p ON p.slug = t.project_slug
          WHERE t.branch IS NOT NULL AND p.archived = 0
          ORDER BY t.project_slug ASC`,
      )
      .all() as { slug: string }[]
  ).map((r) => r.slug);
}

/**
 * One poll pass: reconcile every active branched project. Best-effort per
 * project — one project's GitHub failure never aborts the others. Returns a
 * summary for logging/tests.
 */
export async function pollGithubReconcile(
  db: DatabaseSync,
  ctx: GithubActionContext = {},
): Promise<{ projects: number; reconciled: number; changed: number }> {
  const slugs = projectsToPoll(db);
  let reconciled = 0;
  let changed = 0;
  for (const slug of slugs) {
    try {
      const summary = await reconcileProject(db, slug, SYSTEM_ACTOR, {
        // B-GH5: a background tick spends a bounded slice of the PAT's rate
        // limit per project; whatever it defers is picked up next tick.
        taskBudget: RECONCILE_POLL_TASK_BUDGET,
        ...ctx,
        skipProjectAudit: true,
        skipUnchangedProvenance: true,
      });
      reconciled += summary.reconciled;
      changed += summary.changed;
      // C7: a clean pass clears any failure streak so a fresh outage re-alerts.
      noteReconcileSuccess(slug);
    } catch (error) {
      logger.warn("github reconcile poll failed for a project", {
        projectSlug: slug,
        err: error instanceof Error ? error : new Error(String(error)),
      });
      // C7: after enough consecutive failures, tell the people who can fix it
      // instead of failing silently into the log forever.
      noteReconcileFailure(db, slug);
    }
  }
  // F12-05: nudge the human to finish any merge-pending (accepted-but-open) PR.
  // Best-effort — a nudge failure never aborts the poll.
  let nudged = 0;
  try {
    nudged = await nudgeMergePendingTasks(db, ctx);
  } catch (error) {
    logger.warn("merge-pending nudge failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
  if (changed > 0 || nudged > 0) {
    logger.info("github reconcile poll surfaced changes", {
      projects: slugs.length,
      reconciled,
      changed,
      mergePendingNudged: nudged,
    });
  }
  return { projects: slugs.length, reconciled, changed };
}

// HMR-safe singleton — the repo convention (boot, file-watch, kb-watch):
// module state resets on a dev reload, so a module-scoped handle would let a
// re-evaluated module stack a second interval next to the orphaned first. The
// handle lives behind a global symbol instead, making a repeat start() a true
// no-op — no duplicate interval and no re-fired boot poll.
const POLLER_KEY = Symbol.for("viberr.githubReconcilePoller");

/** The process-global slot the interval handle lives in. */
interface PollerHost {
  [POLLER_KEY]?: ReturnType<typeof setInterval>;
}

function pollerCache(): PollerHost {
  // SAFETY: `POLLER_KEY` is a registry symbol under a viberr-namespaced key
  // that only the two functions below read or write, so the slot holds either
  // the interval handle they put there or nothing at all.
  return globalThis as PollerHost;
}

/**
 * Start the poller: run once at boot (catch out-of-band changes that landed
 * while the process was down), then every RECONCILE_POLL_MS. Non-overlapping (a
 * slow tick can't stack), unref'd (never keeps the process alive), idempotent.
 */
export function startGithubReconcilePoller(db: DatabaseSync): void {
  const cache = pollerCache();
  if (cache[POLLER_KEY]) return;
  // Boot pass: log a failure like the interval tick does, so a boot-time poll
  // failure (e.g. a misconfigured PAT) is diagnosable instead of silent.
  void pollGithubReconcile(db).catch((error) => {
    logger.warn("github reconcile poller boot pass failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  });
  let running = false;
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    void pollGithubReconcile(db)
      .catch((error) => {
        logger.warn("github reconcile poller tick failed", {
          err: error instanceof Error ? error : new Error(String(error)),
        });
      })
      .finally(() => {
        running = false;
      });
  }, RECONCILE_POLL_MS);
  handle.unref?.();
  cache[POLLER_KEY] = handle;
}

/** Stop the poller (tests + graceful shutdown). */
export function stopGithubReconcilePoller(): void {
  const cache = pollerCache();
  const handle = cache[POLLER_KEY];
  if (handle) {
    clearInterval(handle);
    cache[POLLER_KEY] = undefined;
  }
}
