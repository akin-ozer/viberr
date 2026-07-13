import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { seedInitialAdmin } from "./auth/seed-admin.server";
import { getEnv } from "./config/env.server";
import { getDb } from "./db/sqlite.server";
import { startEventPublisher } from "./events/event-publisher.server";
import {
  DATA_ROOT_SUBDIRS,
  ensureDataRootDirs,
  getDataRoot,
  projectsDir,
} from "./files/file-store-root.server";
import { readProjectFile } from "./files/project-writer.server";
import { startFileWatcher } from "./files/file-watch.service.server";
import { logger } from "./logging/logger.server";
import { rescanProjections } from "./projections/rescan.server";
import { registerSeededLiveFromData } from "./runtimes/seed-resumer.server";
import {
  recoverUnreactedAgentRuns,
  type AgentRunRecoveryOptions,
} from "./runtimes/run-recovery.server";
import {
  drainAutoOperatorQueue,
  recoverAutoOperatorQueue,
} from "./runtimes/operator-dispatch.server";
import { recoverUnappliedOperatorEffects } from "./runtimes/operator-effect-recovery.server";
import { drainPendingOperatorTriggers } from "./runtimes/operator-run.server";
import { seedDefaultAgentAssets } from "./seed/default-assets.server";
import { ensureBaseAgentsDeployed } from "./seed/ensure-base-agents.server";
import { ProjectionIntegrityError } from "./db/database-integrity.server";
import { recoverProjectDeletions } from "./projects/project-operational-state.server";
import { recoverGithubMergeIntents } from "./github/github-reconciler.server";
import { recoverGithubPrOpenIntents } from "./github/pr-open.server";
import {
  recoverTaskAcceptanceIntents,
  recoverTaskCompletionIntents,
} from "./tasks/task-completion-recovery.server";
import { recoverOperatorRoutingIntents } from "./tasks/operator-actions.server";
import { recoverProjectLifecycleIntents } from "./projects/project-lifecycle.server";
import { recoverOwnershipCleanupIntents } from "./tasks/ownership-cleanup.server";
import { revokeProjectCompletionEffects } from "./runtimes/run-completion-state.server";
import type { TaskMutationContext } from "./tasks/task-actions.server";

// Survives dev-server HMR module reloads via a well-known symbol.
const BOOT_KEY = Symbol.for("viberr.booted");

/**
 * Boot integrity report (Phase 10): data-root dirs + migration state +
 * projection counts, logged once at startup. Basic runtime sanity — no
 * security posture implied.
 */
function logBootIntegrity(db: Database.Database): void {
  const root = getDataRoot();
  const missingDirs = DATA_ROOT_SUBDIRS.filter(
    (dir) => !existsSync(path.join(root, dir)),
  );
  const migrations = db
    .prepare(
      `SELECT count(*) AS c, max(filename) AS latest FROM schema_migrations`,
    )
    .get() as { c: number; latest: string | null };
  const projects = (
    db.prepare(`SELECT count(*) AS c FROM projects`).get() as { c: number }
  ).c;
  const tasks = (
    db.prepare(`SELECT count(*) AS c FROM task_projections`).get() as {
      c: number;
    }
  ).c;
  const users = (
    db.prepare(`SELECT count(*) AS c FROM users`).get() as { c: number }
  ).c;
  logger.info("boot integrity check", {
    dataRoot: root,
    dataRootDirsOk: missingDirs.length === 0,
    ...(missingDirs.length > 0 ? { missingDirs } : {}),
    migrationsApplied: migrations.c,
    latestMigration: migrations.latest,
    projections: { projects, tasks },
    users,
  });
}

/** Recreate the in-memory lifecycle fence from canonical project.md files
 * before any merge/completion recovery runs. Archived projects must start
 * revoked after a process restart even when their archive intent converged in
 * an earlier process. */
export function revokeCanonicalArchivedProjects(
  db: Database.Database,
  dataRoot?: string,
): string[] {
  const root = projectsDir(dataRoot);
  if (!existsSync(root)) return [];
  const revoked: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const project = readProjectFile({
      projectSlug: entry.name,
      ...(dataRoot !== undefined ? { dataRoot } : {}),
    });
    if (!project?.parsed.frontmatter.archived) continue;
    revokeProjectCompletionEffects(db, entry.name);
    revoked.push(entry.name);
  }
  return revoked;
}

/** Boot owns both sides of this ordering. A queued/running prompt row can look
 * ambiguous during the first routing pass; orphan recovery terminalizes that
 * process-owned row, then the second routing pass cancels its exact staged
 * intent instead of leaving it replayable from stale facts. */
export async function recoverAgentRunsThenRoutingIntents(
  db: Database.Database,
  ctx: TaskMutationContext = {},
  options: AgentRunRecoveryOptions = {},
): Promise<{
  agentRuns: Awaited<ReturnType<typeof recoverUnreactedAgentRuns>>;
  routing: Awaited<ReturnType<typeof recoverOperatorRoutingIntents>>;
}> {
  const agentRuns = await recoverUnreactedAgentRuns(db, ctx, options);
  const routing = await recoverOperatorRoutingIntents(db);
  return { agentRuns, routing };
}

/**
 * One-time server startup: validates the environment (fail fast with a
 * clear message), opens the database (applying pending migrations), seeds
 * the initial admin when the users table is empty, starts the SSE event
 * publisher, and reconciles any offline projection drift before the file
 * watcher takes over.
 * Called from entry.server.tsx module scope; safe to call repeatedly.
 */
export function bootServer(): void {
  const cache = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (cache[BOOT_KEY]) return;

  const env = getEnv();
  ensureDataRootDirs();
  // Ship the default agent assets (each agent's expertise skill + its detailed
  // definition + the base profile templates) into the store when a store lacks
  // them — before anything reads them. Idempotent and best-effort (never blocks
  // boot).
  seedDefaultAgentAssets();
  let db: Database.Database;
  try {
    db = getDb();
  } catch (error) {
    if (error instanceof ProjectionIntegrityError) {
      // Keep the HTTP process alive so /resources/health can expose the
      // operator-facing recovery contract. No watcher/runtime starts against a
      // malformed projection.
      logger.error("viberr boot paused — projection recovery required", {
        faults: error.report.messages.slice(0, 5),
      });
      cache[BOOT_KEY] = true;
      return;
    }
    throw error;
  }

  seedInitialAdmin(db, {
    email: env.VIBERR_SEED_ADMIN_EMAIL,
    password: env.VIBERR_SEED_ADMIN_PASSWORD,
  });

  // Destructive deletion commits when the canonical project directory leaves
  // its live path. Finish any interrupted operational purge and stable audit
  // before projection rescan can resurrect stale rows from the old process.
  const deletionRecovery = recoverProjectDeletions(db);
  if (
    deletionRecovery.completed > 0 ||
    deletionRecovery.cancelled > 0 ||
    deletionRecovery.errors > 0
  ) {
    logger.info("project deletion recovery complete", deletionRecovery);
  }
  const lifecycleRecovery = recoverProjectLifecycleIntents(db);
  if (
    lifecycleRecovery.completed > 0 ||
    lifecycleRecovery.cancelled > 0 ||
    lifecycleRecovery.errors > 0
  ) {
    logger.info("project lifecycle recovery complete", lifecycleRecovery);
  }
  const archivedRevocations = revokeCanonicalArchivedProjects(db);
  if (archivedRevocations.length > 0) {
    logger.info("canonical archived projects revoked", {
      projects: archivedRevocations,
    });
  }
  const completionRecovery = recoverTaskCompletionIntents(db);
  if (
    completionRecovery.completed > 0 ||
    completionRecovery.cancelled > 0 ||
    completionRecovery.retained > 0 ||
    completionRecovery.errors > 0
  ) {
    logger.info("task completion recovery complete", completionRecovery);
  }

  // SSE bridge FIRST (Phase 6): projection emitter → broker, so watcher
  // reprojects and every mutation reach connected clients from the start.
  startEventPublisher();

  // Boot reconcile (Phase 10 recovery): edits made while the server was
  // down never reached the watcher (ignoreInitial) — one hash-short-circuit
  // rescan converges projections with the store before the watcher takes
  // over. Cheap on a clean tree; failures must never block boot.
  try {
    const summary = rescanProjections(db);
    if (summary.changed > 0 || summary.removed > 0 || summary.errors > 0) {
      logger.info("boot rescan reconciled offline drift", { ...summary });
    }
  } catch (error) {
    logger.error("boot rescan failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }

  // Preinstall the built-in agents — the operator (ADR-002, one per active task,
  // so the create-time auto-invoke fires everywhere) plus the base specialists
  // (Developer, Reviewer) — into every project that lacks any of them,
  // so they are usable across all boards, including projects that predate them.
  // Runs after the rescan (so the project list is populated) and before the
  // watcher (no concurrent writer).
  try {
    ensureBaseAgentsDeployed(db);
  } catch (error) {
    logger.error("built-in agent backfill failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }

  // File-native store watcher (dev AND prod) — drives incremental
  // projection rebuilds when project.md / task.md files change on disk.
  startFileWatcher();

  // Seed running-run resumer (Phase 8): re-register the seeded "running"
  // runs' live lines in THIS process so the first client subscribe drips
  // them over SSE (the seed's own registration ran in a separate process).
  registerSeededLiveFromData(db);

  // Resume automatic Triage assessments that were queued (or whose process
  // died mid-dispatch) under the same concurrency/cost limits.
  recoverAutoOperatorQueue(db, undefined, { deferDrain: true });

  // Recover dropped agent-reply reactions (NFR17, B9): if the server restarted
  // after a specialist/reviewer run finished but before its in-process reply
  // callback fired, the task stalled at waiting=agent with no error. Post the
  // missing reply + re-invoke the operator. Idempotent; failures never block
  // boot. Fire-and-forget — the reconciler awaits its own runs internally.
  // Resolve ambiguous terminal operator effects before launching replacement
  // dispatches or replaying specialist completions. This ordering prevents a
  // fresh operator from duplicating a plan whose prior process may have
  // partially applied it.
  // An interrupted Automatic Review open must converge before merge/
  // acceptance recovery inspects linked-PR state.
  void recoverOwnershipCleanupIntents(db)
    .then(async (ownershipRecovery) => {
      if (
        ownershipRecovery.completed > 0 ||
        ownershipRecovery.cancelled > 0 ||
        ownershipRecovery.errors > 0
      ) {
        logger.info("ownership cleanup recovery complete", {
          ...ownershipRecovery,
        });
      }
      return recoverGithubPrOpenIntents(db);
    })
    .then(async (prOpenRecovery) => {
      if (
        prOpenRecovery.completed > 0 ||
        prOpenRecovery.cancelled > 0 ||
        prOpenRecovery.deferred > 0 ||
        prOpenRecovery.errors > 0
      ) {
        logger.info("GitHub PR-open recovery complete", { ...prOpenRecovery });
      }
      const mergeRecovery = await recoverGithubMergeIntents(db);
      if (
        mergeRecovery.completed > 0 ||
        mergeRecovery.cancelled > 0 ||
        mergeRecovery.errors > 0
      ) {
        logger.info("GitHub merge recovery complete", { ...mergeRecovery });
      }
      // The broader human-acceptance journal is consumed only after the
      // narrower remote-merge facts have converged, preserving the original
      // accepter across both irreversible boundaries.
      const acceptanceRecovery = await recoverTaskAcceptanceIntents(db);
      if (
        acceptanceRecovery.completed > 0 ||
        acceptanceRecovery.pending > 0 ||
        acceptanceRecovery.cancelled > 0 ||
        acceptanceRecovery.errors > 0
      ) {
        logger.info("task acceptance recovery complete", {
          ...acceptanceRecovery,
        });
      }
      // A routed operator action can cross its canonical/provider boundary
      // before the rationale timeline and audit converge. Finish only intents
      // backed by objective assignment/recommendation/run evidence before any
      // operator effect is replayed or a replacement operator is launched.
      const routingRecovery = await recoverOperatorRoutingIntents(db);
      if (
        routingRecovery.completed > 0 ||
        routingRecovery.pending > 0 ||
        routingRecovery.cancelled > 0 ||
        routingRecovery.errors > 0
      ) {
        logger.info("operator routing decision recovery complete", {
          ...routingRecovery,
        });
      }
      await recoverUnappliedOperatorEffects(db);
      const postAgentRecovery = await recoverAgentRunsThenRoutingIntents(db);
      if (
        postAgentRecovery.routing.completed > 0 ||
        postAgentRecovery.routing.pending > 0 ||
        postAgentRecovery.routing.cancelled > 0 ||
        postAgentRecovery.routing.errors > 0
      ) {
        logger.info("post-agent operator routing recovery complete", {
          ...postAgentRecovery.routing,
        });
      }
      // Human @operator/manual instructions and source-linked reactions which
      // coalesced behind a pre-crash lease are admitted only after ambiguous
      // operator effects and specialist completions have converged.
      await drainPendingOperatorTriggers(db);
      // Automatic create/transition assessments are lowest priority at boot:
      // they must snapshot the task only after completion replay and explicit
      // human/source-linked instructions have been admitted.
      await drainAutoOperatorQueue(db);
    })
    .catch((error) => {
      logger.error("runtime completion recovery failed", {
        err: error instanceof Error ? error : new Error(String(error)),
      });
    });

  logBootIntegrity(db);

  logger.info("viberr server booted", {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    dataRoot: env.VIBERR_DATA_ROOT,
  });

  cache[BOOT_KEY] = true;
}
