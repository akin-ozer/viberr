import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { VALIDATION_VALUES, WAITING_VALUES } from "~/schemas/task-file.schema";
import { EPIC_STATUS_VALUES } from "~/schemas/epic-file.schema";
import { NOTIFICATION_KINDS } from "~/shared/mapping/notification.server";
import { runMigrations } from "./db/migration-runner.server";
import { withTransaction } from "./db/transaction.server";
import { seedInitialAdmin } from "./auth/seed-admin.server";
import {
  getEnv,
  insecureAuthOriginWarning,
  type Env,
} from "./config/env.server";
import {
  acquireDataRootLock,
  DataRootLockedError,
  forceDataRootTakeover,
  startDataRootLockGuard,
  type AcquireDataRootLockOptions,
} from "./db/data-root-lock.server";
import { getDb, getProjectionDbPath } from "./db/sqlite.server";
import { selfHealProjectionDbIfCorrupt } from "./db/self-heal.server";
import { repairCodexRolloutPaths } from "./runtimes/user-homes.server";
import { bootAgentIsolation } from "./runtimes/agent-isolation.server";
import { startEventPublisher } from "./events/event-publisher.server";
import { armProcessShutdown } from "./events/sse-broker.server";
import { startMcpGateway } from "./mcp-proxy/gateway.server";
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
import { getBuildInfo, type BuildInfo } from "./ops/build-info.server";
import { cachedToolchain, type Toolchain } from "./ops/toolchain.server";
import {
  formatBytes,
  measureDataRootSpace,
  type DiskSource,
  type DiskStatus,
} from "./ops/disk-space.server";
import {
  // The periodic pass's own reclaim guard, reused rather than re-derived: two
  // callers of the same destructive reclaim must ask the same question.
  activeRunCount,
  runMaintenancePass,
  startMaintenanceScheduler,
} from "./ops/maintenance.server";
import { rescanProjections } from "./projections/rescan.server";
import {
  ensureProjectionDerivation,
  PROJECTION_DERIVATION_VERSION,
} from "./projections/derivation-version.server";
import {
  finalizeOrphanedRuns,
  recoverStrandedOperatorPlans,
  settleAbandonedWaits,
  recoverUnreactedAgentRuns,
} from "./runtimes/run-recovery.server";
import { seedDefaultAgentAssets } from "./seed/default-assets.server";
import { ensureBaseAgentsDeployed } from "./seed/ensure-base-agents.server";
import { convertTemplateReviewEntry } from "./seed/review-entry-conversion.server";
import { startScheduleRunner } from "./tasks/schedule.server";
import { startDependencyRunner } from "./tasks/dependencies.server";
import { convertGoalsToEpics } from "./tasks/goal-epic-conversion.server";
import { recoverControllerConversations } from "./controller/controller-run.server";
import { purgeOrphanedConversationLogs } from "./controller/controller-purge.server";
import { backfillMcpGrantScopes } from "./org/mcp-oauth.server";
import { reclaimTerminalTaskWorkspaces } from "./tasks/workspace-retention.server";
import { recoverProjectGates } from "./tasks/project-gates.server";
import { toError } from "~/shared/errors";

// Survives dev-server HMR module reloads via a well-known symbol.
const BOOT_KEY = Symbol.for("viberr.booted");

// Installed once (survives HMR via a well-known symbol), same pattern as BOOT_KEY.
const CRASH_HANDLERS_KEY = Symbol.for("viberr.crashVisibilityInstalled");

/** The process-global slots boot parks its two once-only flags in — well-known
 *  symbols, so a dev-server HMR reload of this module still sees what the
 *  previous instance already did. */
interface BootFlagHost {
  [BOOT_KEY]?: boolean;
  [CRASH_HANDLERS_KEY]?: boolean;
}

function bootFlags(): BootFlagHost {
  // SAFETY: both keys are registry symbols under viberr-namespaced names that
  // nothing outside this module reads or writes, and the only value this file
  // ever stores in either is `true` — so a slot holds that or nothing at all.
  return globalThis as BootFlagHost;
}

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
  const slot = bootFlags();
  if (slot[CRASH_HANDLERS_KEY]) return;
  slot[CRASH_HANDLERS_KEY] = true;
  process.on("uncaughtException", (error) => {
    writeFatalSync("FATAL: uncaught exception, shutting down", {
      err: toError(error),
    });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    writeFatalSync("FATAL: unhandled promise rejection, shutting down", {
      err: toError(reason),
    });
    process.exit(1);
  });
}

/** The one line `logBootIntegrity` writes. */
type BootIntegrityFields = {
  dataRoot: string;
  dataRootDirsOk: boolean;
  /** Absent when every expected data-root directory is present. */
  missingDirs?: string[];
  migrationsApplied: number;
  latestMigration: string | null;
  projections: { projects: number; tasks: number };
  users: number;
  build: BuildInfo;
  disk: { free: string; total: string; status: DiskStatus; source: DiskSource } | null;
  /** Ruling 182: what this host can run, probed once here so the first health
   *  request does not pay for it. */
  toolchain: Toolchain;
  /** F21-1 / ruling 140: absent on a healthy schema — see
   *  `projectionCheckGaps` (table-qualified CHECK gaps). */
  projectionSchemaDrift?: string[];
  /** Absent on a healthy schema — see `projectionMissingColumns`. */
  projectionMissingColumns?: string[];
};

/** One `count(*) AS c` aggregate → its number. */
function countRows(db: DatabaseSync, sql: string): number {
  // SAFETY: every caller passes a `SELECT count(*) AS c` aggregate with no
  // GROUP BY, which sqlite answers with exactly one row whose only column is
  // the integer `c`.
  const row = db.prepare(sql).get() as { c: number };
  return row.c;
}

/**
 * F21-1 — which `VALIDATION_VALUES` members THIS database's
 * `task_projections.validation` CHECK will refuse. Empty on a healthy schema.
 *
 * The CHECK is a hand-written mirror of `VALIDATION_VALUES` in
 * `db/migrations/0001_baseline.sql`, and the repository pins the two together
 * (`boot.server.test.ts` "projectionCheckGaps"). That pin cannot reach a
 * database that already exists: migrations are squashed and forward-only, so
 * widening the baseline's CHECK changes what a FRESH `projection.sqlite` gets and
 * nothing else. A deployed root carries whatever CHECK shipped the day it was
 * first opened.
 *
 * The drift is silent and expensive. `deriveValidation` returns a value the CHECK
 * rejects, the INSERT throws `CHECK constraint failed`, and `rebuildPath`'s catch
 * swallows it as "projection rebuild failed" — so the task stops projecting and
 * its row goes stale, with nothing on any surface saying why. Reading the DDL
 * sqlite itself stored is the cheapest honest way to see it coming, and boot is
 * the one moment an operator is already reading this log.
 */
function projectionValidationGaps(db: DatabaseSync): string[] {
  return checkListGaps(db, "task_projections", "validation", VALIDATION_VALUES);
}

/**
 * Ruling 140 (pass 34): the SAME drift, one table over. `notifications.kind` is
 * a CHECK over `NOTIFICATION_KINDS`, pinned to the baseline by
 * `notification.server.test.ts` — which, like the validation pin, reaches only
 * FRESH roots. On an existing root every INSERT of a kind the CHECK predates
 * throws, `createNotification`'s fail-open swallows it, and the person is never
 * told: exactly the silent drop a new notification kind (`dependency`,
 * `ownership`) would produce on every deployed root the day it shipped. Read
 * the stored DDL and name what is missing, with the same remedy line.
 */
function notificationKindGaps(db: DatabaseSync): string[] {
  return checkListGaps(db, "notifications", "kind", NOTIFICATION_KINDS);
}

/** One `PRAGMA table_info` read → the column names, in table order. */
function tableColumns(db: DatabaseSync, table: string): string[] {
  // SAFETY: `PRAGMA table_info` rows always carry a non-null TEXT `name`
  // column; only `name` is read. `table` is a literal at every call site.
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/**
 * Ruling 481(a): widen a lagging `notifications.kind` CHECK in place, at boot.
 *
 * The drift WARN above names the gap and prescribes re-baselining the
 * projection database, which also destroys the users, sessions, sealed PATs,
 * audit and notifications nothing can rebuild. For this one table the fix
 * needs none of that: `notifications` is app-owned, nothing references it, and
 * the new CHECK admits every value the old one did. So the table is rebuilt
 * from the shipped baseline's own DDL (read from a throwaway in-memory
 * migration, as `projectionMissingColumns` does), its rows copied across, and
 * its indexes recreated, in one transaction (sqlite cannot ALTER a CHECK).
 * Without it, the day ruling 481 shipped every agent question on a deployed
 * root would have thrown at the INSERT and reached nobody, which is worse than
 * the mis-filed row it replaced.
 *
 * Returns the kinds it admitted; empty when the CHECK was current (the common
 * path, which reads one DDL row and changes nothing).
 */
export function widenNotificationKindCheck(db: DatabaseSync): string[] {
  const missing = notificationKindGaps(db);
  if (missing.length === 0) return [];
  const expectedDb = new DatabaseSync(":memory:");
  try {
    runMigrations(expectedDb);
    // SAFETY: the baseline creates `notifications`, so its CREATE TABLE row is
    // present and `sql` is non-null for a table.
    const table = expectedDb
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'`)
      .get() as { sql: string };
    // SAFETY: `sql` is null only for sqlite's own automatic indexes, which the
    // filter excludes; every remaining row is a CREATE INDEX statement.
    const indexes = expectedDb
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'notifications' AND sql IS NOT NULL`,
      )
      .all() as Array<{ sql: string }>;
    const live = new Set(tableColumns(db, "notifications"));
    const kept = tableColumns(expectedDb, "notifications")
      .filter((column) => live.has(column))
      .join(", ");
    withTransaction(db, () => {
      db.exec(
        table.sql.replace(/^CREATE TABLE notifications\b/, "CREATE TABLE notifications__widened"),
      );
      db.exec(
        `INSERT INTO notifications__widened (${kept}) SELECT ${kept} FROM notifications`,
      );
      db.exec(`DROP TABLE notifications`);
      db.exec(`ALTER TABLE notifications__widened RENAME TO notifications`);
      for (const index of indexes) db.exec(index.sql);
    });
  } finally {
    expectedDb.close();
  }
  return missing;
}

/**
 * The CHECK gaps the boot integrity line reports, table-qualified
 * (`notifications.kind: ownership`), so the WARN names where the ALTER must
 * land. Generalised from the validation-only read (F21-1) in pass 34 — a value
 * the code declares that the live root's CHECK does not admit.
 */
export function projectionCheckGaps(db: DatabaseSync): string[] {
  return [
    ...projectionValidationGaps(db).map((value) => `task_projections.validation: ${value}`),
    // Ruling 225 (F37-45): the THIRD instance of this drift, and the one that
    // shows the read above was a list of the columns someone had been bitten by
    // rather than of the columns at risk. `waiting` is a CHECK over a TS enum
    // the projector derives into, exactly like `validation` beside it, and when
    // `schedule` joined the enum the live root refused it with the same
    // swallowed "projection rebuild failed" and the same stale row. Every such
    // column belongs here the day it is written, not the day it breaks.
    ...checkListGaps(db, "task_projections", "waiting", WAITING_VALUES).map(
      (value) => `task_projections.waiting: ${value}`,
    ),
    ...notificationKindGaps(db).map((value) => `notifications.kind: ${value}`),
    // Ruling 503: an epic's status is the same shape, a CHECK over the enum
    // the epic file schema declares, so it belongs here from its first day.
    ...checkListGaps(db, "epic_projections", "status", EPIC_STATUS_VALUES).map(
      (value) => `epic_projections.status: ${value}`,
    ),
  ];
}

/**
 * Values `declared` that the live `<table>.<column>` CHECK IN-list does not
 * admit. Reads the DDL sqlite itself stored — the cheapest honest way to see a
 * CHECK-constraint drift coming, at the one moment an operator is already
 * reading this log.
 */
function checkListGaps(
  db: DatabaseSync,
  table: string,
  column: string,
  declared: readonly string[],
): string[] {
  // SAFETY: `sql` is the only selected column; `sqlite_master.sql` is TEXT and
  // is non-null for every CREATE TABLE row (it is null only for the indexes
  // sqlite auto-creates). `.get()` yields undefined when the table is absent.
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  const ddl = row?.sql;
  // No table at all is not drift — a database this early has nothing to
  // lose, and the migration runner is the thing that would have complained.
  if (!ddl) return [];
  const check = ddl.match(
    new RegExp(
      `${column}\\s+TEXT\\s+NOT\\s+NULL\\s+CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`,
      "i",
    ),
  );
  // A column with no CHECK at all admits everything — the reverse of drift.
  if (!check) return [];
  const admitted = new Set(
    check[1]!.split(",").map((value) => value.trim().replace(/^'|'$/g, "")),
  );
  return declared.filter((value) => !admitted.has(value));
}

/**
 * Pass-21 live-validation catch (sibling of `projectionValidationGaps`):
 * `task_projections` columns THIS database is missing relative to what the
 * current build's baseline creates. A squashed, forward-only baseline means a
 * column added to `0001_baseline.sql` (e.g. `work_revision_sha`) reaches only
 * FRESH data roots — on an existing root the rebuilder's INSERT then fails
 * with "no such column" for EVERY task, which is strictly worse than the CHECK
 * drift above (nothing projects at all). The expectation is read from the real
 * migrations run against a throwaway in-memory database, so this can never
 * drift from the shipped baseline; the cost is one schema-only migration run
 * at boot.
 *
 * Exported for the drift test beside `logBootIntegrity`.
 */
export function projectionMissingColumns(db: DatabaseSync): string[] {
  // The tables the rebuilder INSERTs into by explicit column list — a column
  // added to the (squashed, forward-only) baseline never reaches an existing
  // root, and the first reprojection then fails with 'no such column'.
  const rebuilderTables = ["task_projections", "task_events"];
  const expectedDb = new DatabaseSync(":memory:");
  try {
    runMigrations(expectedDb);
    const missing: string[] = [];
    for (const table of rebuilderTables) {
      // SAFETY: `PRAGMA table_info` rows always carry a non-null TEXT `name`
      // column; only `name` is read.
      const live = db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      // No table at all is the migration runner's problem, same stance as above.
      if (live.length === 0) continue;
      // SAFETY: same `PRAGMA table_info` row shape as the live read above.
      const expected = expectedDb
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      const liveNames = new Set(live.map((column) => column.name));
      for (const column of expected) {
        if (!liveNames.has(column.name)) missing.push(`${table}.${column.name}`);
      }
    }
    return missing;
  } finally {
    expectedDb.close();
  }
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
  // SAFETY: `count()`/`max()` with no GROUP BY is an aggregate — sqlite answers
  // it with exactly one row, and this SELECT names both of its columns: `c`
  // (integer count) and `latest` (max of `schema_migrations.filename`, null on
  // an empty table).
  const migrations = db
    .prepare(
      `SELECT count(*) AS c, max(filename) AS latest FROM schema_migrations`,
    )
    .get() as { c: number; latest: string | null };
  const projects = countRows(db, `SELECT count(*) AS c FROM projects`);
  const tasks = countRows(db, `SELECT count(*) AS c FROM task_projections`);
  const users = countRows(db, `SELECT count(*) AS c FROM users`);
  const disk = measureDataRootSpace();
  const fields: BootIntegrityFields = {
    dataRoot: root,
    dataRootDirsOk: missingDirs.length === 0,
    migrationsApplied: migrations.c,
    latestMigration: migrations.latest,
    projections: { projects, tasks },
    users,
    // Which build this is. Nulls are honest — an image built without a version
    // stamp says so rather than printing a placeholder.
    build: getBuildInfo(),
    // Gap 16: how much room is left, at the one moment an operator is already
    // reading this log. `null` when the filesystem could not be measured.
    disk: disk
      ? {
          free: formatBytes(disk.freeBytes),
          total: formatBytes(disk.totalBytes),
          status: disk.status,
          source: disk.source,
        }
      : null,
    // Ruling 182: resolved here, once, so the probe's cost lands in boot and
    // the toolchain is on the one line an operator reads after a deploy.
    toolchain: cachedToolchain(),
  };
  // Named only when some are actually gone: a healthy boot has nothing to list,
  // and an empty `missingDirs: []` reads like a finding that isn't there.
  if (missingDirs.length > 0) fields.missingDirs = missingDirs;
  const validationGaps = projectionCheckGaps(db);
  if (validationGaps.length > 0) fields.projectionSchemaDrift = validationGaps;
  const missingColumns = projectionMissingColumns(db);
  if (missingColumns.length > 0) fields.projectionMissingColumns = missingColumns;
  logger.info("boot integrity check", fields);
  // F21-1: loud and separate. Folded into the info line it would be one more
  // key on a line nobody greps; a task that silently stops projecting earns its
  // own WARN, carrying the remedy AND the remedy's cost.
  if (validationGaps.length > 0 || missingColumns.length > 0) {
    const drift: Record<string, string | string[]> = {};
    if (validationGaps.length > 0) drift.refuses = validationGaps;
    if (missingColumns.length > 0) drift.missingColumns = missingColumns;
    drift.impact =
      missingColumns.length > 0
        ? "the rebuilder INSERT names these columns, so EVERY task fails to " +
          "project ('no such column') and rows go stale behind " +
          "'projection rebuild failed'"
        : "every write of a value the live CHECK does not admit fails: a task " +
          "whose derived validation lands on one of these stops projecting " +
          "(its row goes stale behind 'projection rebuild failed'), and a " +
          "notification of a kind the CHECK predates is dropped by the " +
          "fail-open insert with nothing on any surface";
    drift.remedy =
      (missingColumns.length > 0 && validationGaps.length === 0
        ? "additive drift only: `ALTER TABLE <table> ADD COLUMN <column>` for " +
          "each table-qualified entry above matches the baseline without " +
          "touching the non-derived rows. Otherwise (or to be certain): "
        : "") +
      "re-baseline the projection database: stop the app, delete " +
      "<dataRoot>/state/projection.sqlite* , restart; projection tables rebuild " +
      "from projects/ at boot. This also destroys the NON-derived rows in that file " +
      "(users, sessions, sealed PATs, audit, notifications), so run `npm run backup` " +
      "first and expect to re-establish sign-ins. See docs/operations/deployment.md " +
      "§Re-baselining the projection database";
    logger.warn(
      "projection schema drift: this root's rebuilder tables lag the shipped baseline",
      drift,
    );
  }
}

/** The two maintenance entry points `startStoreMaintenance` wires. */
interface StoreMaintenanceDeps {
  runMaintenancePass: typeof runMaintenancePass;
  startMaintenanceScheduler: typeof startMaintenanceScheduler;
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
 * Exported so the wiring is testable without booting a real server; the two
 * maintenance entry points are injectable for the same reason, defaulting to
 * the real implementations.
 */
export function startStoreMaintenance(
  db: DatabaseSync,
  deps: StoreMaintenanceDeps = { runMaintenancePass, startMaintenanceScheduler },
): void {
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
      err: toError(error),
    });
  }
  try {
    deps.runMaintenancePass(db, { reason: "boot", reclaimWorkspaces: false });
  } catch (error) {
    logger.error("boot maintenance pass failed", {
      err: toError(error),
    });
  }
  deps.startMaintenanceScheduler(db);
}

/** The steps of the boot reconcile chain, in the order they must run. */
interface ReconcileRestartedWorkDeps {
  finalizeOrphanedRuns: typeof finalizeOrphanedRuns;
  recoverUnreactedAgentRuns: typeof recoverUnreactedAgentRuns;
  recoverStrandedOperatorPlans: typeof recoverStrandedOperatorPlans;
  settleAbandonedWaits: typeof settleAbandonedWaits;
  activeRunCount: typeof activeRunCount;
  reclaimTerminalTaskWorkspaces: typeof reclaimTerminalTaskWorkspaces;
}

/**
 * Everything a restart stranded mid-completion, recovered in ONE ordered chain,
 * then the disk it frees reclaimed. Every step is idempotent and self-catching:
 * one failure never stops the next, and none of them blocks boot.
 *
 *  0. orphaned runs (F7-BOOT1) — a run row left `running`/`queued` has no live
 *     process in a fresh boot. Each is finalized to `error`
 *     (interrupted-by-restart) and its task's operator re-invoked. It leads the
 *     chain so step 1 reads clean terminal states, and its re-invokes are JOINED
 *     before step 3: those drives clone the very workspaces the reclaim deletes.
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
 * sequenced now, which is what the claim always said. Exported — and the three
 * steps injectable, defaulting to the real implementations — so that ordering
 * is testable rather than only asserted in a comment.
 */
export async function reconcileRestartedWork(
  db: DatabaseSync,
  deps: ReconcileRestartedWorkDeps = {
    finalizeOrphanedRuns,
    recoverUnreactedAgentRuns,
    recoverStrandedOperatorPlans,
    settleAbandonedWaits,
    activeRunCount,
    reclaimTerminalTaskWorkspaces,
  },
): Promise<void> {
  // The operator drives this sweep launches clone `<taskDir>/workspace/<repo>`,
  // which is exactly what step 3 deletes — so the chain keeps the handle and
  // joins it there. `reinvokes` never rejects, so the await needs no catch.
  let orphanReinvokes: Promise<void> = Promise.resolve();
  // Ruling 174: the orphans' surviving processes are swept alongside, and the
  // reclaim waits for that too — a CLI the dead server left running could still
  // be writing a tree the reclaim deletes. Never rejects either.
  let orphanReaped: Promise<void> = Promise.resolve();
  /** Ruling 215: the tasks step 1 took, withheld from step 4 (see below). */
  let orphanTasks: ReadonlySet<string> = new Set<string>();
  try {
    const finalization = deps.finalizeOrphanedRuns(db);
    orphanReinvokes = finalization.reinvokes;
    orphanReaped = finalization.reaped;
    orphanTasks = finalization.claimedTasks;
  } catch (error) {
    logger.error("orphaned-run finalize failed", {
      err: toError(error),
    });
  }
  try {
    await deps.recoverUnreactedAgentRuns(db);
  } catch (error) {
    logger.error("agent-reply recovery failed", {
      err: toError(error),
    });
  }
  try {
    await deps.recoverStrandedOperatorPlans(db);
  } catch (error) {
    logger.error("codex operator plan recovery failed", {
      err: toError(error),
    });
  }
  try {
    // Ruling 213: LAST of the four, deliberately. The three above all key on a
    // run and may themselves set `waiting: agent` by starting one; this sweep
    // asks the leftover question — which tasks claim an agent that no run
    // backs — so it has to see the board they leave behind.
    //
    // Ruling 215: which is exactly why it must be told what step 1 took. That
    // step's whole job is to move live runs to `interrupted`, and its own
    // re-invokes are launched below, AFTER this line — so on the deploy that
    // shipped 213 two tasks got both notes at once, the second one saying "no
    // run was live when the server came back" about runs that had been live and
    // had their own "Interrupted by a restart" note two lines above. Same
    // board, two contradictory sentences, and two operator drives for one
    // event.
    await deps.settleAbandonedWaits(db, {}, orphanTasks);
  } catch (error) {
    logger.error("abandoned-wait settle failed", {
      err: toError(error),
    });
  }
  await orphanReinvokes;
  await orphanReaped;
  try {
    // The reclaim's precondition is that NO run of this process holds a working
    // tree: it rmSyncs `<taskDir>/workspace` for every terminal-stage task, and
    // an operator drive re-invoked by the steps above clones exactly that path.
    // Sequencing alone cannot establish it — a recovered completion LAUNCHES a
    // run and returns — so boot asks the same question the periodic pass asks
    // before it reclaims. Skipping costs disk until the next scheduled pass;
    // reclaiming over a live tree costs a run.
    const active = deps.activeRunCount(db);
    if (active > 0) {
      logger.info("skipped the boot workspace reclaim: runs are in flight", {
        activeRuns: active,
      });
    } else {
      const reclaimed = deps.reclaimTerminalTaskWorkspaces(db);
      if (reclaimed.removed > 0) {
        logger.info("reclaimed finished task workspaces", {
          workspaces: reclaimed.removed,
          mb: Math.round((reclaimed.bytes / (1024 * 1024)) * 10) / 10,
        });
      }
    }
  } catch (error) {
    logger.error("task workspace reclamation failed", {
      err: toError(error),
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
  const lockOptions: AcquireDataRootLockOptions = {
    force: forceDataRootTakeover(env),
  };
  // Only the test override names a root; production leaves the key off so the
  // lock resolves the configured one itself.
  if (opts.dataRoot) lockOptions.dataRoot = opts.dataRoot;
  try {
    acquireDataRootLock(lockOptions);
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
  const cache = bootFlags();
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
      "BETTER_AUTH_URL is unset but OAuth is configured; behind a reverse proxy this collapses trustedOrigins to [] and breaks OAuth callback/cookie URLs. Set BETTER_AUTH_URL to the app's public origin.",
    );
  }

  // U8: …and the other half of the same variable. Set to an `http://` origin in
  // production it silently issues session cookies with no Secure attribute (the
  // rule and its exact reasoning live with the env schema).
  const insecureOrigin = insecureAuthOriginWarning(env);
  if (insecureOrigin) logger.warn(insecureOrigin);

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
  // Before the first handle opens: if the projection database is corrupt (a WAL
  // clobbered over a bind mount, a torn page after a hard kill), salvage its
  // non-reconstructable rows and rebuild a fresh, valid file instead of
  // FATAL-crash-looping the boot. Projections rebuild from the .md files on the
  // rescan below; the corrupt file is preserved for forensics. A healthy file
  // (the common path) is left untouched.
  const heal = selfHealProjectionDbIfCorrupt(getProjectionDbPath());
  if (heal.healed) {
    logger.warn(
      "recovered a corrupt projection database at boot: projections rebuild from the .md files on the rescan below; the corrupt file is preserved",
      {
        movedTo: heal.movedTo,
        salvaged: heal.salvaged,
        // Non-empty ⇒ some readable rows could not be reinserted (constraint /
        // bind) and are only in the preserved file — a cue to look there. An
        // empty set logs `undefined`, which JSON.stringify drops, so the record
        // carries no `skipped` key at all (same as `movedTo` above).
        skipped: Object.keys(heal.skipped).length > 0 ? heal.skipped : undefined,
      },
    );
  }
  const db = getDb();

  // Ruling 481(a): before anything can write a notification. A root whose
  // `notifications.kind` CHECK predates a kind gets it widened in place, so an
  // agent question (the kind that ruling added) is never refused at INSERT.
  try {
    const admitted = widenNotificationKindCheck(db);
    if (admitted.length > 0) {
      logger.info("widened the notifications kind CHECK in place", { admitted });
    }
  } catch (error) {
    // The integrity line below still names the gap and the remedy.
    logger.error("could not widen the notifications kind CHECK", { err: toError(error) });
  }

  // Ruling 460: before anything spawns an agent or creates a workspace — the
  // server's umask, the store layout, every person's home handed to their
  // agent uid, and the probe that says whether the store enforces any of it
  // (`/resources/health` → `agentIsolation`). Without a launcher (the host dev
  // server) it only records `off`. Never throws: a layout it could not set is
  // logged and the probe reports the outcome.
  try {
    bootAgentIsolation(db);
  } catch (error) {
    logger.error("agent isolation could not be set up at boot", { err: toError(error) });
  }

  await seedInitialAdmin(db, {
    email: env.VIBERR_SEED_ADMIN_EMAIL,
    password: env.VIBERR_SEED_ADMIN_PASSWORD,
  });

  // Ruling 461: the loopback MCP gateway, before anything can start a run
  // (recovery, the schedule and goal runners, a request). A run reaches every
  // org MCP server with a stored credential through it; one that fails to bind
  // leaves those servers unmountable — each run's prompt then says why — and
  // health reports `mcpProxy.listening: false`, so boot carries on.
  try {
    await startMcpGateway({ port: env.VIBERR_MCP_PROXY_PORT });
  } catch (error) {
    logger.error("mcp gateway failed to start; credentialed MCP servers cannot be mounted", {
      port: env.VIBERR_MCP_PROXY_PORT,
      err: toError(error),
    });
  }

  // SSE bridge FIRST (Phase 6): projection emitter → broker, so watcher
  // reprojects and every mutation reach connected clients from the start.
  startEventPublisher();

  // Boot reconcile (Phase 10 recovery): edits made while the server was
  // down never reached the watcher (ignoreInitial) — one hash-short-circuit
  // rescan converges projections with the store before the watcher takes
  // over. Cheap on a clean tree; failures must never block boot.
  try {
    // A derivation change (derivation-version.server.ts) needs a FORCED full
    // rebuild the hash short-circuit below would never perform; it runs first
    // and, when it ran, already covers the drift rescan.
    const derivation = ensureProjectionDerivation(db);
    if (derivation.rebuilt) {
      const detail = {
        from: derivation.previous,
        to: PROJECTION_DERIVATION_VERSION,
        ...derivation.rebuilt,
      };
      if (derivation.stamped) {
        logger.info("boot rebuilt every projection for a derivation change", detail);
      } else {
        // A file failed to project, so the stamp was withheld and the next boot
        // rebuilds again — say so where an operator will look.
        logger.warn(
          "boot rebuilt projections for a derivation change with errors; will retry next boot",
          detail,
        );
      }
    } else {
      const summary = rescanProjections(db);
      if (summary.changed > 0 || summary.removed > 0 || summary.errors > 0) {
        logger.info("boot rescan reconciled offline drift", { ...summary });
      }
    }
  } catch (error) {
    logger.error("boot rescan failed", {
      err: toError(error),
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
      err: toError(error),
    });
  }

  // Ruling 519: a board created before the move into Review became automatic
  // gets the template's `auto` edge in place of its old approval. After the
  // rescan (the project rows exist) and before the watcher (no concurrent
  // writer); a converted edge is not converted again.
  try {
    await convertTemplateReviewEntry(db);
  } catch (error) {
    logger.error("making the move into Review automatic failed", {
      err: toError(error),
    });
  }

  // Ruling 503: every chained goal becomes the epic with its number, its
  // tasks join it, its unstarted links become held tasks, and every wait on a
  // goal link is respelled by task key. Once: a converted goal file is filed
  // under `goals/converted/`. After the rescan (task rows exist to validate
  // waits against) and the agent backfill (a task it makes has its operator),
  // and before the watcher (no concurrent writer).
  try {
    await convertGoalsToEpics(db);
  } catch (error) {
    logger.error("goal-to-epic conversion failed", {
      err: toError(error),
    });
  }

  // Ruling 486 (live verification 2026-09-25): an OAuth sign-in made before the
  // public half carried its grant shows it from the sealed half's token scope.
  try {
    backfillMcpGrantScopes(db);
  } catch (error) {
    logger.error("MCP grant-scope backfill failed", {
      err: toError(error),
    });
  }

  // File-native store watcher (dev AND prod) — drives incremental
  // projection rebuilds when project.md / task.md files change on disk.
  startFileWatcher();

  // Knowledge-base watcher (R-D): re-index a KB when its store files change,
  // so "on change" is real instead of a decorative cadence label.
  startKbWatcher();

  // F10-29 + gaps 15/20: bounded retention/compaction of the high-volume
  // log/audit/notification tables AND the raw run transcripts / provider session
  // homes on disk, so a long-lived deployment doesn't grow without limit —
  // once here, then on a timer for the deployment that never restarts.
  // Best-effort; canonical task files (source of truth) untouched.
  startStoreMaintenance(db);

  // Ruling 199: the Codex CLI records each rollout under the PER-RUN home it
  // was written through, and that home is removed when the run settles — so
  // every thread recorded before the settle learned to re-point is aimed at a
  // path that no longer exists, and every `thread/resume` fails. The transcripts
  // themselves are in the shared `sessions/` directory all along. One idempotent
  // pass restores them; it never throws and it only ever moves a path onto a
  // file that is really there.
  {
    const repaired = repairCodexRolloutPaths();
    if (repaired > 0) {
      logger.info("re-pointed Codex rollout paths left behind by removed run homes", {
        threads: repaired,
      });
    }
  }

  // Fire-and-forget: the chain finalizes restart-orphaned runs, recovers what a
  // restart stranded, joins the re-invokes it launched and only then reclaims
  // disk — all awaited internally, and it must never hold up the server coming
  // online.
  void reconcileRestartedWork(db);

  // Ruling 482: a project gate run the previous process left queued or running
  // has no worker behind it, and the acceptance gate would wait on it forever.
  // Each is queued again; the runs themselves happen off this path.
  void (async () => {
    try {
      await recoverProjectGates(db);
    } catch (error) {
      logger.warn("interrupted project gate runs could not be recovered", {
        err: toError(error),
      });
    }
  })();

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

  // Ruling 131(e): release every held task whose wait was satisfied while the
  // process was down, then sweep on a one-minute interval (the goal runner's
  // tick, kept when ruling 503 retired the chains); and give any conversation
  // whose turn a restart orphaned an honest "interrupted" note instead of
  // eternal silence.
  startDependencyRunner(db);
  try {
    recoverControllerConversations(db);
  } catch (error) {
    logger.warn("controller conversation recovery failed", {
      err: toError(error),
    });
  }
  // Ruling 525: and finish the purge for a deleted conversation whose running
  // turn a restart cut off before it settled.
  try {
    purgeOrphanedConversationLogs(db);
  } catch (error) {
    logger.warn("deleted controller conversation purge failed", {
      err: toError(error),
    });
  }

  logBootIntegrity(db);

  logger.info("viberr server booted", {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    dataRoot: env.VIBERR_DATA_ROOT,
  });

  cache[BOOT_KEY] = true;
}
