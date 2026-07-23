import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { seedInitialAdmin } from "./auth/seed-admin.server";
import { getEnv } from "./config/env.server";
import { getDb } from "./db/sqlite.server";
import { applyRetention } from "./db/retention.server";
import { startEventPublisher } from "./events/event-publisher.server";
import {
  DATA_ROOT_SUBDIRS,
  ensureDataRootDirs,
  getDataRoot,
} from "./files/file-store-root.server";
import { startFileWatcher } from "./files/file-watch.service.server";
import { startKbWatcher } from "./files/kb-watch.service.server";
import { logger } from "./logging/logger.server";
import { rescanProjections } from "./projections/rescan.server";
import {
  finalizeOrphanedRuns,
  recoverUnreactedAgentRuns,
} from "./runtimes/run-recovery.server";
import { seedDefaultAgentAssets } from "./seed/default-assets.server";
import { ensureBaseAgentsDeployed } from "./seed/ensure-base-agents.server";
import { startScheduleRunner } from "./tasks/schedule.server";

// Survives dev-server HMR module reloads via a well-known symbol.
const BOOT_KEY = Symbol.for("viberr.booted");

/**
 * Boot integrity report (Phase 10): data-root dirs + migration state +
 * projection counts, logged once at startup. Basic runtime sanity — no
 * security posture implied.
 */
function logBootIntegrity(db: DatabaseSync): void {
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

/**
 * One-time server startup: validates the environment (fail fast with a
 * clear message), opens the database (applying pending migrations), seeds
 * the initial admin when the users table is empty, starts the SSE event
 * publisher, and reconciles any offline projection drift before the file
 * watcher takes over.
 * Called from entry.server.tsx module scope; safe to call repeatedly.
 */
export async function bootServer(): Promise<void> {
  const cache = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (cache[BOOT_KEY]) return;

  const env = getEnv();
  ensureDataRootDirs();
  // Ship the default agent assets (each agent's expertise skill + its detailed
  // definition + the base profile templates) into the store when a store lacks
  // them — before anything reads them. Idempotent and best-effort (never blocks
  // boot).
  seedDefaultAgentAssets();
  const db = getDb();

  await seedInitialAdmin(db, {
    email: env.VIBERR_SEED_ADMIN_EMAIL,
    password: env.VIBERR_SEED_ADMIN_PASSWORD,
  });

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

  // Knowledge-base watcher (R-D): re-index a KB when its store files change,
  // so "on change" is real instead of a decorative cadence label.
  startKbWatcher();

  // Finalize non-terminal runs at boot: a run left `running`/`queued` has no
  // live process in this fresh boot. Orphans become `error`
  // (interrupted-by-restart) and their tasks are re-coordinated. Runs BEFORE
  // the reply recovery below so a just-finalized run is a clean terminal state.
  try {
    finalizeOrphanedRuns(db);
  } catch (error) {
    logger.error("orphaned-run finalize failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }

  // F10-29: bounded retention/compaction of the high-volume log/audit/
  // notification tables so a long-lived deployment doesn't grow the SQLite file
  // without limit. Best-effort; canonical task files (source of truth) untouched.
  try {
    applyRetention(db);
  } catch (error) {
    logger.error("retention pass failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }

  // Recover dropped agent-reply reactions (NFR17, B9): if the server restarted
  // after a specialist/reviewer run finished but before its in-process reply
  // callback fired, the task stalled at waiting=agent with no error. Post the
  // missing reply + re-invoke the operator. Idempotent; failures never block
  // boot. Fire-and-forget — the reconciler awaits its own runs internally.
  void recoverUnreactedAgentRuns(db).catch((error) => {
    logger.error("agent-reply recovery failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  });

  // Start the server-side schedule runner (O-3): fire due scheduled operator
  // re-runs once at boot (catching any that came due while down), then on an
  // interval. Backend-agnostic — it calls runOperator, so Claude & Codex behave
  // identically. Idempotent start; the timer is unref'd so it never blocks exit.
  startScheduleRunner(db);

  logBootIntegrity(db);

  logger.info("viberr server booted", {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    dataRoot: env.VIBERR_DATA_ROOT,
  });

  cache[BOOT_KEY] = true;
}
