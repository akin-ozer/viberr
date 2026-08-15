import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { seedInitialAdmin } from "./auth/seed-admin.server";
import { getEnv, type Env } from "./config/env.server";
import {
  acquireDataRootLock,
  DataRootLockedError,
  forceDataRootTakeover,
  startDataRootLockGuard,
} from "./db/data-root-lock.server";
import { getDb } from "./db/sqlite.server";
import { startEventPublisher } from "./events/event-publisher.server";
import { armProcessShutdown } from "./events/sse-broker.server";
import {
  DATA_ROOT_SUBDIRS,
  ensureDataRootDirs,
  getDataRoot,
} from "./files/file-store-root.server";
import { startFileWatcher } from "./files/file-watch.service.server";
import { startKbWatcher } from "./files/kb-watch.service.server";
import { startGithubReconcilePoller } from "./github/reconcile-poller.server";
import { reapStaleWarmups } from "~/server/org/mcp-warmup.server";
import { logger, writeFatalSync } from "./logging/logger.server";
import { getBuildInfo } from "./ops/build-info.server";
import { formatBytes, measureDataRootSpace } from "./ops/disk-space.server";
import {
  runMaintenancePass,
  startMaintenanceScheduler,
} from "./ops/maintenance.server";
import { rescanProjections } from "./projections/rescan.server";
import {
  finalizeOrphanedRuns,
  recoverStrandedOperatorPlans,
  recoverUnreactedAgentRuns,
} from "./runtimes/run-recovery.server";
import { seedDefaultAgentAssets } from "./seed/default-assets.server";
import { ensureBaseAgentsDeployed } from "./seed/ensure-base-agents.server";
import { startScheduleRunner } from "./tasks/schedule.server";
import { reclaimTerminalTaskWorkspaces } from "./tasks/workspace-retention.server";

// Survives dev-server HMR module reloads via a well-known symbol.
const BOOT_KEY = Symbol.for("viberr.booted");

// Installed once (survives HMR via a well-known symbol), same pattern as BOOT_KEY.
const CRASH_HANDLERS_KEY = Symbol.for("viberr.crashVisibilityInstalled");

/**
 * F20-8(a): make a fatal process death VISIBLE. On 2026-08-14 the app process
 * vanished with zero output — `docker logs -t` went straight from a 200 request
 * line to the restart's lock refusal, no stack, no signal, no FATAL line. Node's
 * default prints an uncaught exception then exits, but the app's own `logger.error`
 * is an async `process.stdout.write` that the following `process.exit` truncates,
 * so nothing durable reached the log. These handlers flush ONE synchronous stderr
 * line (`writeFatalSync` → `fs.writeSync(2, …)`, which returns only once the OS has
 * the bytes) BEFORE exiting, so a crash is never silent again.
 *
 * Registering an `uncaughtException`/`unhandledRejection` handler SUPPRESSES Node's
 * own crash-and-exit, so each handler exits itself to keep the fail-fast contract:
 * a process that limps on after an uncaught error (half-torn state, a lock it may
 * no longer own) is worse than one that dies loudly. Installed once, before any
 * request — `bootServer` is awaited from `entry.server.tsx` module scope.
 */
export function installCrashVisibilityHandlers(): void {
  const slot = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (slot[CRASH_HANDLERS_KEY]) return;
  slot[CRASH_HANDLERS_KEY] = true;
  process.on("uncaughtException", (error) => {
    writeFatalSync("FATAL: uncaught exception — shutting down", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    writeFatalSync("FATAL: unhandled promise rejection — shutting down", {
      err: reason instanceof Error ? reason : new Error(String(reason)),
    });
    process.exit(1);
  });
}

/**
 * Boot integrity report (Phase 10): data-root dirs + migration state +
 * projection counts, logged once at startup. Basic runtime sanity — no
 * security posture implied.
 *
 * Gap 18: it now also names the BUILD. deployment.md §First run tells the
 * operator to "watch the boot integrity log", and §Upgrades to roll back by
 * "redeploying the previous image" — neither was verifiable, because the only
 * identity-shaped field here was `latestMigration`, a constant
 * (`0001_baseline.sql`) for every build ever made. Exported so the line's
 * contents are testable instead of only asserted in a comment.
 */
export function logBootIntegrity(db: DatabaseSync): void {
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
  const build = getBuildInfo();
  const disk = measureDataRootSpace();
  logger.info("boot integrity check", {
    dataRoot: root,
    dataRootDirsOk: missingDirs.length === 0,
    ...(missingDirs.length > 0 ? { missingDirs } : {}),
    migrationsApplied: migrations.c,
    latestMigration: migrations.latest,
    projections: { projects, tasks },
    users,
    // Which build this is. Nulls are honest — an image built without a version
    // stamp says so rather than printing a placeholder.
    build,
    // Gap 16: how much room is left, at the one moment an operator is already
    // reading this log. `null` when the filesystem could not be measured.
    ...(disk
      ? {
          disk: {
            free: formatBytes(disk.freeBytes),
            total: formatBytes(disk.totalBytes),
            status: disk.status,
          },
        }
      : { disk: null }),
  });
}

/**
 * Boot's store-maintenance step, and the timer that makes it recur (gaps 15/20).
 *
 * Retention ran exactly once per process, at boot — coupled to the restart a
 * stable deployment never performs. Boot keeps its one-shot pass (it is the
 * cheapest moment to prune, and it must happen before the first request), and
 * now also arms the periodic scheduler so a container that stays up for three
 * months prunes ~360 times instead of never.
 *
 * `reclaimWorkspaces: false` here is deliberate: `reconcileRestartedWork` owns
 * the workspace reclaim at boot, sequenced AFTER run recovery so nothing in
 * flight is touched (P14-RT-09). Doing it here as well would reintroduce
 * exactly that race. The periodic pass has its own active-run guard instead.
 *
 * Exported so the wiring is testable without booting a real server.
 */
export function startStoreMaintenance(db: DatabaseSync): void {
  try {
    // R19-18: a background MCP install belongs to the process that started it,
    // so a restart leaves rows flagged "installing" with no installer behind
    // them. Clear them first — a stale flag is indistinguishable from a live
    // one to the reader, and the row's own affordance (retest) restarts it.
    const reaped = reapStaleWarmups(db);
    if (reaped > 0) {
      logger.info("cleared MCP installs interrupted by a restart", { reaped });
    }
  } catch (error) {
    logger.error("could not clear interrupted MCP installs", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
  try {
    runMaintenancePass(db, { reason: "boot", reclaimWorkspaces: false });
  } catch (error) {
    logger.error("boot maintenance pass failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
  startMaintenanceScheduler(db);
}

/**
 * Everything a restart stranded mid-completion, recovered in ONE ordered chain,
 * then the disk it frees reclaimed. Every step is idempotent and self-catching:
 * one failure never stops the next, and none of them blocks boot.
 *
 *  1. agent replies (NFR17, B9) — a specialist/reviewer run that finished before
 *     its in-process reply callback fired left the task at waiting=agent with no
 *     error. Post the reply + re-invoke the operator.
 *  2. codex operator plans (P14-RT-08) — a Codex operator coordinates AFTER its
 *     run finishes, so the same restart window loses the entire turn.
 *  3. workspace reclaim (P13, ARCH-6 audit) — each task that ever ran a
 *     specialist holds an 11-16 MB working tree and nothing had ever removed
 *     one; a one-project test instance was already carrying 101 MB. The clone is
 *     a cache (canonical state is task.md, delivered work is on the remote) and
 *     a reopened task simply re-clones.
 *
 * P14-RT-09: the reclaim used to run right after SCHEDULING step 1 while
 * claiming to run "after the recovery pass above", so a recovered run's delivery
 * reconcile could race the `rmSync` of the very workspace it reads. It is
 * sequenced now, which is what the claim always said. Exported so that ordering
 * is testable rather than only asserted in a comment.
 */
export async function reconcileRestartedWork(db: DatabaseSync): Promise<void> {
  try {
    await recoverUnreactedAgentRuns(db);
  } catch (error) {
    logger.error("agent-reply recovery failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
  try {
    await recoverStrandedOperatorPlans(db);
  } catch (error) {
    logger.error("codex operator plan recovery failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
  try {
    const reclaimed = reclaimTerminalTaskWorkspaces(db);
    if (reclaimed.removed > 0) {
      logger.info("reclaimed finished task workspaces", {
        workspaces: reclaimed.removed,
        mb: Math.round((reclaimed.bytes / (1024 * 1024)) * 10) / 10,
      });
    }
  } catch (error) {
    logger.error("task workspace reclamation failed", {
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/** Where the boot refusal is printed and how the process ends. Injected by the
 *  test, which cannot let a real `process.exit` take the worker with it. */
export interface BootRefusalIo {
  write: (message: string) => void;
  exit: (code: number) => void;
}

const PROCESS_REFUSAL_IO: BootRefusalIo = {
  write: (message) => void process.stderr.write(message),
  exit: (code) => void process.exit(code),
};

/**
 * Take the data root's single-writer lock, or END the boot with the refusal on
 * stderr (B-FD1/G1).
 *
 * `bootServer` is awaited from `entry.server.tsx` MODULE SCOPE, so an escaping
 * throw surfaces as an SSR module-init stack trace: the operator sees a React
 * Router crash page instead of the one message that says which process holds
 * the root and how to take it over. The refusal is the whole diagnosis, so it
 * gets printed and the process exits 1 — a refusal to boot, not a crash.
 * Anything else still throws: an unexpected failure must not read as "held".
 */
export function takeDataRootWriterLock(
  env: Pick<Env, "VIBERR_FORCE_DATA_ROOT_LOCK">,
  opts: {
    io?: BootRefusalIo;
    /** Test override; production takes the configured data root. */
    dataRoot?: string;
  } = {},
): void {
  const io = opts.io ?? PROCESS_REFUSAL_IO;
  try {
    acquireDataRootLock({
      force: forceDataRootTakeover(env),
      ...(opts.dataRoot ? { dataRoot: opts.dataRoot } : {}),
    });
  } catch (error) {
    if (!(error instanceof DataRootLockedError)) throw error;
    io.write(`${error.message}\n`);
    io.exit(1);
  }
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
  // F20-8(a): first of all, so even a failure DURING boot — before the lock, the
  // db, the first request — dies loudly instead of vanishing.
  installCrashVisibilityHandlers();
  const cache = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (cache[BOOT_KEY]) return;

  const env = getEnv();

  // P11-03: behind a reverse proxy, better-auth needs BETTER_AUTH_URL to build
  // OAuth callback + cookie URLs; unset, getAuth collapses trustedOrigins to []
  // (see app/lib/auth.server.ts) and the OAuth flow breaks. Only matters when an
  // OAuth provider is configured — without one the inferred origin is fine.
  if (
    !env.BETTER_AUTH_URL &&
    (env.GITHUB_OAUTH_CLIENT_ID || env.GOOGLE_OAUTH_CLIENT_ID)
  ) {
    logger.warn(
      "BETTER_AUTH_URL is unset but OAuth is configured — behind a reverse proxy this collapses trustedOrigins to [] and breaks OAuth callback/cookie URLs. Set BETTER_AUTH_URL to the app's public origin.",
    );
  }

  ensureDataRootDirs();
  // B-FD1: BEFORE anything opens the database or writes a file — one app
  // process per data root, ever. A second writer is not a slow path, it is
  // corruption (WAL clobbering over a shared mount, per-process run handles
  // finalizing each other's runs), and it has happened twice on this project.
  // A held root stops the boot with a message naming the holder.
  takeDataRootWriterLock(env);
  // …and arm the signal handler that RELEASES it. Registration used to ride on
  // the first SSE publish/connect, so a warm store that emitted nothing on boot
  // shut down without ever running it — leaving the lock behind for the next
  // container to refuse.
  armProcessShutdown();
  // F18-5: the lock keeps an fd open for the process lifetime but nothing
  // re-checked the FILE still exists. A store reset that deleted state/ left this
  // process writing lock-less while a second one booted into the freed path — two
  // writers, silent SQLite loss. The guard re-verifies ownership on a timer and
  // fails CLOSED (loud shutdown) the moment the file is gone or replaced.
  startDataRootLockGuard();
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

  // F10-29 + gaps 15/20: bounded retention/compaction of the high-volume
  // log/audit/notification tables AND the raw run transcripts / provider session
  // homes on disk, so a long-lived deployment doesn't grow without limit —
  // once here, then on a timer for the deployment that never restarts.
  // Best-effort; canonical task files (source of truth) untouched.
  startStoreMaintenance(db);

  // Fire-and-forget: the chain awaits its own runs internally and must never
  // hold up the server coming online.
  void reconcileRestartedWork(db);

  // Start the server-side schedule runner (O-3): fire due scheduled operator
  // re-runs once at boot (catching any that came due while down), then on an
  // interval. Backend-agnostic — it calls runOperator, so Claude & Codex behave
  // identically. Idempotent start; the timer is unref'd so it never blocks exit.
  startScheduleRunner(db);

  // Start the GitHub PR-status poller (P11-14): reconcile every active branched
  // project once at boot, then every 5 minutes, so a PR merged/closed out-of-band
  // surfaces automatically instead of only when a maintainer clicks the manual
  // "Update status" button. Idempotent start; the timer is unref'd.
  startGithubReconcilePoller(db);

  logBootIntegrity(db);

  logger.info("viberr server booted", {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    dataRoot: env.VIBERR_DATA_ROOT,
  });

  cache[BOOT_KEY] = true;
}
