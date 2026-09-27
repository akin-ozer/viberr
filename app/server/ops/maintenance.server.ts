import type { DatabaseSync } from "node:sqlite";
import { getEnv } from "~/server/config/env.server";
import { applyRetention, type RetentionResult } from "~/server/db/retention.server";
import { logger } from "~/server/logging/logger.server";
import {
  reclaimTerminalTaskWorkspaces,
  type WorkspaceReclamation,
} from "~/server/tasks/workspace-retention.server";
import {
  formatBytes,
  measureDataRootSpace,
  type DiskSpace,
  type DiskStatus,
} from "./disk-space.server";
import {
  pruneRuntimeTranscripts,
  type TranscriptReclamation,
  type TranscriptRetentionOptions,
} from "./transcript-retention.server";
import { toError } from "~/shared/errors";

/**
 * Periodic store maintenance (gaps 15, 20, 16).
 *
 * Retention was real but ran ONCE, at boot: `applyRetention` from
 * `bootServer`, `reclaimTerminalTaskWorkspaces` from `reconcileRestartedWork`.
 * The runbook sells retention as the thing that stops "a long-lived deployment"
 * growing without bound, and it was coupled to restarts — the one event a
 * stable deployment avoids (`compose.yml` sets `restart: unless-stopped`, so a
 * healthy container is only ever restarted by a human). The behaviour was
 * backwards: the more stable the deployment, the more it grew, and the
 * documented remedy for disk pressure was `rm -rf` by hand plus a restart.
 *
 * This applies the periodic-task pattern the codebase already uses five times
 * over (schedule runner, GitHub reconcile poller, SSE heartbeat, lock guard,
 * rate-limit prune): one interval, non-overlapping, unref'd, idempotent start.
 *
 * ## Single-writer safety
 *
 * This introduces NO new writer. The scheduler runs inside the app process that
 * already holds the data-root lock (boot refuses to start otherwise, B-FD1),
 * on the same `getDb()` handle boot passes in, and it deletes only things this
 * process owns. It is a timer in the existing writer, not a second process — the
 * hazard that ate the WAL twice on this project stays closed.
 *
 * ## The one genuinely unsafe step, and its guard
 *
 * Workspace reclaim is the step boot could take for free and a timer cannot.
 * `workspace-retention.server.ts` relies on being sequenced AFTER run recovery,
 * "at that moment no run of this process can be holding a working tree open"
 * (P14-RT-09 records the real race that ordering fixed). Mid-flight there is no
 * such moment, so a periodic reclaim first asks whether ANY run is queued or
 * running and skips the whole step if one is. That is deliberately coarser than
 * per-task exclusion: the reclaim is not urgent (it runs on the next tick, and
 * a busy instance is one that will be idle later), and a coarse guard cannot be
 * wrong about a task whose run row is written by another code path. The
 * retention and transcript passes need no such guard — both are age-windowed
 * (30/90 days), and `IDEMPOTENCY_AUDIT_ACTIONS` already protects the two audit
 * rows boot recovery reads, so neither can touch anything in flight.
 */

/** Floor between disk-pressure-triggered passes, so a wedged low-space
 *  condition cannot turn the disk check into a busy loop of sweeps. */
const MIN_PRESSURE_PASS_GAP_MS = 30 * 60_000;

export type MaintenanceReason = "boot" | "interval" | "disk-pressure";

export interface MaintenancePassResult {
  reason: MaintenanceReason;
  retention: RetentionResult;
  transcripts: TranscriptReclamation;
  /** null when the reclaim did not run — `workspacesSkipped` says why. */
  workspaces: WorkspaceReclamation | null;
  workspacesSkipped: "active-runs" | "not-requested" | null;
  /** Free space AFTER the pass; null when it could not be measured. */
  disk: DiskSpace | null;
  /** Bytes freed on disk by this pass (transcripts + workspaces). */
  freedBytes: number;
}

export interface MaintenancePassOptions {
  reason: MaintenanceReason;
  /** Default true. Boot passes false: `reconcileRestartedWork` owns the reclaim
   *  there, sequenced after run recovery. */
  reclaimWorkspaces?: boolean;
  dataRoot?: string;
  now?: Date;
}

/** The one line every pass logs — what it removed, and what it skipped.
 *  Optional fields are OMITTED rather than nulled: see `runMaintenancePass`. */
type MaintenancePassLog = {
  reason: MaintenanceReason;
  runLogLines: number;
  auditEvents: number;
  notifications: number;
  transcripts: number;
  sessionFiles: number;
  workspaces: number;
  freed: string;
  workspacesSkipped?: MaintenancePassResult["workspacesSkipped"];
  diskFree?: string;
  diskStatus?: DiskStatus;
};

const EMPTY_RETENTION: RetentionResult = {
  runLogLines: 0,
  auditEvents: 0,
  notifications: 0,
};

/** Runs that could be holding a working tree open right now. */
export function activeRunCount(db: DatabaseSync): number {
  try {
    // SAFETY: `SELECT count(*) AS c` is an aggregate with no GROUP BY — sqlite
    // answers it with exactly one row carrying the single integer column `c`.
    const row = db
      .prepare(
        `SELECT count(*) AS c FROM agent_runs WHERE state IN ('queued', 'running')`,
      )
      .get() as { c: number };
    return row.c;
  } catch {
    // Unreadable table → assume busy. Skipping a reclaim costs disk; doing one
    // over a live working tree costs a run.
    return 1;
  }
}

/**
 * One maintenance pass. Every step is independently caught: a failure in one
 * never stops the next, and none of them can throw at the caller (a timer tick
 * and a boot step both want that).
 */
export function runMaintenancePass(
  db: DatabaseSync,
  options: MaintenancePassOptions,
): MaintenancePassResult {
  const wantWorkspaces = options.reclaimWorkspaces !== false;

  let retention = EMPTY_RETENTION;
  try {
    // The audit purge's export-before-delete (ruling 102) writes into the data
    // root, so the pass's own root override must reach it — the same forwarding
    // the transcript/workspace sweeps below already do.
    retention = applyRetention(
      db,
      options.now,
      options.dataRoot ? { dataRoot: options.dataRoot } : {},
    );
  } catch (error) {
    logger.error("retention pass failed", {
      err: toError(error),
    });
  }

  let transcripts: TranscriptReclamation = {
    transcripts: 0,
    sessions: 0,
    bytes: 0,
  };
  // Both keys are left OFF when the caller named neither, so the pruner falls
  // back to the configured data root and the real clock.
  const transcriptOptions: TranscriptRetentionOptions = {};
  if (options.dataRoot) transcriptOptions.dataRoot = options.dataRoot;
  if (options.now) transcriptOptions.now = options.now;
  try {
    transcripts = pruneRuntimeTranscripts(transcriptOptions);
  } catch (error) {
    logger.error("runtime transcript retention failed", {
      err: toError(error),
    });
  }

  let workspaces: WorkspaceReclamation | null = null;
  let workspacesSkipped: MaintenancePassResult["workspacesSkipped"] = null;
  if (!wantWorkspaces) {
    workspacesSkipped = "not-requested";
  } else if (activeRunCount(db) > 0) {
    workspacesSkipped = "active-runs";
  } else {
    try {
      workspaces = reclaimTerminalTaskWorkspaces(
        db,
        options.dataRoot ? { dataRoot: options.dataRoot } : {},
      );
    } catch (error) {
      logger.error("task workspace reclamation failed", {
        err: toError(error),
      });
    }
  }

  const disk = measureDataRootSpace(options.dataRoot);
  const freedBytes = transcripts.bytes + (workspaces?.bytes ?? 0);

  const summary: MaintenancePassLog = {
    reason: options.reason,
    runLogLines: retention.runLogLines,
    auditEvents: retention.auditEvents,
    notifications: retention.notifications,
    transcripts: transcripts.transcripts,
    sessionFiles: transcripts.sessions,
    workspaces: workspaces?.removed ?? 0,
    freed: formatBytes(freedBytes),
  };
  // Both are stated only when they happened: a pass that reclaimed workspaces
  // has no reason to skip, and an unmeasurable filesystem has no free space to
  // report — a `null` in either would read as a measurement.
  if (workspacesSkipped) summary.workspacesSkipped = workspacesSkipped;
  if (disk) {
    summary.diskFree = formatBytes(disk.freeBytes);
    summary.diskStatus = disk.status;
  }
  // Every pass logs what it removed — including a pass that removed nothing,
  // which is how an operator confirms the scheduler is alive at all.
  logger.info("store maintenance pass", summary);

  recordPass(options.reason, freedBytes);
  return {
    reason: options.reason,
    retention,
    transcripts,
    workspaces,
    workspacesSkipped,
    disk,
    freedBytes,
  };
}

// -------------------------------------------------- observable state

export interface MaintenanceState {
  intervalMs: number;
  diskCheckIntervalMs: number;
  /** null until the first pass — a never-run scheduler is neutral, not alarming. */
  lastPassAt: string | null;
  lastPassReason: MaintenanceReason | null;
  lastFreedBytes: number;
  scheduled: boolean;
}

let lastPassAt: string | null = null;
let lastPassReason: MaintenanceReason | null = null;
let lastFreedBytes = 0;
let lastPassMs = 0;

function recordPass(reason: MaintenanceReason, freedBytes: number): void {
  lastPassMs = Date.now();
  lastPassAt = new Date(lastPassMs).toISOString();
  lastPassReason = reason;
  lastFreedBytes = freedBytes;
}

/** The two timer periods in ms. The env schema owns them in seconds (defaults,
 *  the one-day cap and the refusal of a value that does not parse live there:
 *  rulings 458(c) and 458(i)). */
function configuredPeriodsMs(): Pick<MaintenanceState, "intervalMs" | "diskCheckIntervalMs"> {
  const env = getEnv();
  return {
    intervalMs: env.VIBERR_MAINTENANCE_INTERVAL_SECONDS * 1000,
    diskCheckIntervalMs: env.VIBERR_DISK_CHECK_INTERVAL_SECONDS * 1000,
  };
}

/** What /resources/health reports about maintenance — proof the timer is live. */
export function maintenanceState(): MaintenanceState {
  return {
    ...configuredPeriodsMs(),
    lastPassAt,
    lastPassReason,
    lastFreedBytes,
    scheduled: timers().length > 0,
  };
}

// -------------------------------------------------- the scheduler

const TIMER_KEY = Symbol.for("viberr.maintenanceTimers");
const DISK_STATUS_KEY = Symbol.for("viberr.lastDiskStatus");

/** The process-global slots the scheduler parks its live state in — well-known
 *  symbols, so a dev-server HMR reload of this module keeps the timers it
 *  already armed instead of arming a second set. */
interface MaintenanceGlobals {
  [TIMER_KEY]?: ReturnType<typeof setInterval>[];
  [DISK_STATUS_KEY]?: DiskStatus | null;
}

function schedulerGlobals(): MaintenanceGlobals {
  // SAFETY: both keys are registry symbols under viberr-namespaced names that
  // nothing outside this module reads or writes, so each slot holds either what
  // the setters below put there or nothing at all.
  return globalThis as MaintenanceGlobals;
}

function timers(): ReturnType<typeof setInterval>[] {
  return schedulerGlobals()[TIMER_KEY] ?? [];
}

function setTimers(handles: ReturnType<typeof setInterval>[]): void {
  schedulerGlobals()[TIMER_KEY] = handles;
}

function lastDiskStatus(): DiskStatus | null {
  return schedulerGlobals()[DISK_STATUS_KEY] ?? null;
}

function setLastDiskStatus(status: DiskStatus | null): void {
  schedulerGlobals()[DISK_STATUS_KEY] = status;
}

/**
 * The free-space watch. Logs every TRANSITION (not every sample, which would be
 * 288 identical lines a day) and, on entering a low/critical state, triggers an
 * out-of-band maintenance pass — the app's one real defence, since the biggest
 * reclaimable item on the volume is exactly what that pass removes (11-16 MB
 * per finished task's clone). Rate-limited by MIN_PRESSURE_PASS_GAP_MS.
 */
export function checkDiskPressure(
  db: DatabaseSync,
  dataRoot?: string,
): DiskSpace | null {
  const disk = measureDataRootSpace(dataRoot);
  if (!disk) return null;
  const previous = lastDiskStatus();
  setLastDiskStatus(disk.status);

  if (disk.status !== previous) {
    const detail = {
      free: formatBytes(disk.freeBytes),
      total: formatBytes(disk.totalBytes),
      usedPercent: disk.usedPercent,
      lowThreshold: formatBytes(disk.lowThresholdBytes),
      criticalThreshold: formatBytes(disk.criticalThresholdBytes),
    };
    if (disk.status === "critical") {
      logger.error(
        "data root is critically low on free space — writes (task files, SQLite WAL) can start failing",
        detail,
      );
    } else if (disk.status === "low") {
      logger.warn("data root is low on free space", detail);
    } else {
      logger.info("data root free space recovered", detail);
    }
  }

  if (
    disk.status !== "ok" &&
    Date.now() - lastPassMs >= MIN_PRESSURE_PASS_GAP_MS
  ) {
    const passOptions: MaintenancePassOptions = { reason: "disk-pressure" };
    if (dataRoot) passOptions.dataRoot = dataRoot;
    runMaintenancePass(db, passOptions);
  }
  return disk;
}

/**
 * Start the periodic maintenance timers. Idempotent (a second call is a no-op),
 * unref'd (never keeps the process alive), non-overlapping.
 *
 * NO immediate pass: boot runs its own ordered one (retention + transcripts
 * before the first request, workspace reclaim after run recovery), and an
 * immediate reclaim here would race the recovery that boot has just scheduled —
 * the exact P14-RT-09 hazard. The first timer tick is the first periodic pass.
 */
export function startMaintenanceScheduler(
  db: DatabaseSync,
  options: {
    intervalMs?: number;
    diskCheckIntervalMs?: number;
    /** Production takes the configured data root; tests pass their own. */
    dataRoot?: string;
  } = {},
): void {
  if (timers().length > 0) return;

  const configured = configuredPeriodsMs();
  const intervalMs = options.intervalMs ?? configured.intervalMs;
  const diskMs = options.diskCheckIntervalMs ?? configured.diskCheckIntervalMs;
  const rootOption = options.dataRoot ? { dataRoot: options.dataRoot } : {};

  let passRunning = false;
  const passTimer = setInterval(() => {
    if (passRunning) return;
    passRunning = true;
    try {
      runMaintenancePass(db, { reason: "interval", ...rootOption });
    } catch (error) {
      logger.warn("maintenance tick failed", {
        err: toError(error),
      });
    } finally {
      passRunning = false;
    }
  }, intervalMs);

  const diskTimer = setInterval(() => {
    try {
      checkDiskPressure(db, options.dataRoot);
    } catch (error) {
      logger.warn("disk-space check failed", {
        err: toError(error),
      });
    }
  }, diskMs);

  for (const handle of [passTimer, diskTimer]) handle.unref?.();
  setTimers([passTimer, diskTimer]);
  logger.info("store maintenance scheduled", {
    everyMinutes: Math.round(intervalMs / 60_000),
    diskCheckMinutes: Math.round(diskMs / 60_000),
  });
}

/** Test-only: stop the timers and forget the recorded pass + disk transition
 *  state. (No shutdown path needs a stop: the timers are unref'd.) */
export function resetMaintenanceStateForTests(): void {
  for (const handle of timers()) clearInterval(handle);
  setTimers([]);
  lastPassAt = null;
  lastPassReason = null;
  lastFreedBytes = 0;
  lastPassMs = 0;
  setLastDiskStatus(null);
}
