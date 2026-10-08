import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../../../test-support/env";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { resetEnvCacheForTests } from "~/server/config/env.server";
import { taskDir } from "~/server/files/file-store-root.server";
import { COMPACTING_AFTER_RUN_STEP, RUN_PHASE } from "~/server/runtimes/adapter.server";
import { COMPLETION_COMPACT_DEADLINE_MS } from "~/server/runtimes/context-policy.server";
import { logger } from "~/server/logging/logger.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { formatBytes, measureDataRootSpace } from "./disk-space.server";

/**
 * Gaps 15 + 20 + 16 — retention existed but ran ONCE, at boot, which coupled
 * the whole policy to the restart a stable deployment never performs
 * (`compose.yml`: `restart: unless-stopped`). These pin the periodic pass, the
 * one guard that makes a mid-flight workspace reclaim safe, and the free-space
 * watch that acts instead of only reporting.
 */

const {
  activeRunCount,
  checkDiskPressure,
  maintenanceState,
  resetMaintenanceStateForTests,
  runMaintenancePass,
  startMaintenanceScheduler,
} = await import("./maintenance.server");

const ctx = createTestDbContext();

afterEach(() => {
  resetMaintenanceStateForTests();
  delete process.env.VIBERR_DISK_LOW_FREE_MB;
  delete process.env.VIBERR_DISK_CRITICAL_FREE_MB;
  resetEnvCacheForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  ctx.cleanup();
});

const DAY = 86_400_000;

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY).toISOString();
}

function insertRun(
  store: TestStore,
  id: string,
  state: "queued" | "running" | "finished",
): void {
  store.db
    .prepare(
      `INSERT INTO agent_runs (id, task_key, project_slug, thread_id, role, kind,
         backend, model, sdk, state, turns, input_tokens,
         cached_input_tokens, output_tokens, created_at, updated_at, agent_profile_id)
       VALUES (?, 'VIB-1', ?, 't', 'r', 'primary', 'claude', 'm', 's', ?,
         0, 0, 0, 0, ?, ?, 'developer')`,
    )
    .run(id, store.slug, state, iso(0), iso(0));
}

function seedWorkspace(store: TestStore, key: string): string {
  const root = path.join(taskDir(store.slug, key, store.dataRoot), "workspace");
  const repo = path.join(root, "viberr");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "chunk.bin"), "x".repeat(4096));
  return root;
}

function agedTranscript(store: TestStore, name: string, daysAgo: number): string {
  const file = path.join(store.dataRoot, "runtimes", "claude", name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{"line":1}\n'.repeat(20));
  const when = new Date(Date.now() - daysAgo * DAY);
  utimesSync(file, when, when);
  return file;
}

function storeWithTerminalTask(): TestStore {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", { stage: "done" }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  return store;
}

describe("runMaintenancePass (gaps 15 + 20)", () => {
  it("prunes SQLite rows AND on-disk transcripts AND workspaces in one pass", () => {
    const store = storeWithTerminalTask();
    const workspace = seedWorkspace(store, "VIB-1");
    const oldTranscript = agedTranscript(store, "run_old.jsonl", 40);
    const freshTranscript = agedTranscript(store, "run_new.jsonl", 1);
    insertRun(store, "run_old", "finished");
    store.db
      .prepare(
        `INSERT INTO run_log_lines (run_id, seq, occurred_at, raw_json, display_json, created_at)
         VALUES ('run_old', 1, ?, '{}', '{}', ?)`,
      )
      .run(iso(40), iso(40));

    const result = runMaintenancePass(store.db, {
      reason: "interval",
      dataRoot: store.dataRoot,
    });

    expect(result.retention.runLogLines).toBe(1);
    expect(result.transcripts.transcripts).toBe(1);
    expect(result.workspaces?.removed).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(existsSync(oldTranscript)).toBe(false);
    expect(existsSync(freshTranscript)).toBe(true);
    expect(existsSync(workspace)).toBe(false);
  });

  it("C02-R10 (pass 32): the injected data root scopes EVERY sweep — a sibling root's aged transcript is untouched", () => {
    // The retention windows are process-global (env), the root is injected:
    // pin that the pass never sweeps a root it was not handed.
    const store = storeWithTerminalTask();
    const other = storeWithTerminalTask();
    const mine = agedTranscript(store, "run_mine.jsonl", 40);
    const theirs = agedTranscript(other, "run_theirs.jsonl", 40);
    const result = runMaintenancePass(store.db, { reason: "interval", dataRoot: store.dataRoot });
    expect(result.transcripts.transcripts).toBe(1);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
  });

  it("SKIPS the workspace reclaim while any run is queued or running (P14-RT-09)", () => {
    const store = storeWithTerminalTask();
    const workspace = seedWorkspace(store, "VIB-1");
    insertRun(store, "run_live", "running");

    expect(activeRunCount(store.db)).toBe(1);
    const result = runMaintenancePass(store.db, {
      reason: "interval",
      dataRoot: store.dataRoot,
    });

    expect(result.workspaces).toBeNull();
    expect(result.workspacesSkipped).toBe("active-runs");
    // Boot can reclaim unguarded because it runs after recovery settles; a
    // timer has no such moment, and rm -rf'ing a live working tree kills a run.
    expect(existsSync(workspace)).toBe(true);

    // …and the retention half still ran — it is age-windowed, so it is safe
    // mid-flight and must not be held hostage by a busy instance.
    expect(result.retention).toBeDefined();
  });

  it("reclaims once the runs are terminal", () => {
    const store = storeWithTerminalTask();
    const workspace = seedWorkspace(store, "VIB-1");
    insertRun(store, "run_done", "finished");
    const result = runMaintenancePass(store.db, {
      reason: "interval",
      dataRoot: store.dataRoot,
    });
    expect(result.workspacesSkipped).toBeNull();
    expect(existsSync(workspace)).toBe(false);
  });

  it("ruling 701: a finished run whose session is still being compacted holds its folder", () => {
    // The compaction's CLI works in the run's folder after the run has
    // ended. CANARY: count live rows alone and a pass removes it under that
    // process.
    const store = storeWithTerminalTask();
    const workspace = seedWorkspace(store, "VIB-1");
    insertRun(store, "run_done", "finished");
    store.db
      .prepare(`UPDATE agent_runs SET phase = ?, step = ?, finished_at = ? WHERE id = 'run_done'`)
      .run(RUN_PHASE.compacting, COMPACTING_AFTER_RUN_STEP, new Date().toISOString());
    expect(activeRunCount(store.db)).toBe(1);
    const held = runMaintenancePass(store.db, { reason: "interval", dataRoot: store.dataRoot });
    expect(held.workspacesSkipped).toBe("active-runs");
    expect(existsSync(workspace)).toBe(true);
    // A mark that outlived twice the compaction's deadline is one whose clear
    // failed, not a compaction. CANARY: count every marked row and one failed
    // write holds every folder until the next restart.
    expect(activeRunCount(store.db, Date.now() + 2 * COMPLETION_COMPACT_DEADLINE_MS + 1_000)).toBe(0);
    // The mark goes when the compaction is over, and the folder with it.
    store.db.prepare(`UPDATE agent_runs SET phase = NULL, step = NULL WHERE id = 'run_done'`).run();
    expect(activeRunCount(store.db)).toBe(0);
    runMaintenancePass(store.db, { reason: "interval", dataRoot: store.dataRoot });
    expect(existsSync(workspace)).toBe(false);
  });

  it("boot's pass leaves workspaces to reconcileRestartedWork", () => {
    const store = storeWithTerminalTask();
    const workspace = seedWorkspace(store, "VIB-1");
    const result = runMaintenancePass(store.db, {
      reason: "boot",
      reclaimWorkspaces: false,
      dataRoot: store.dataRoot,
    });
    expect(result.workspacesSkipped).toBe("not-requested");
    expect(existsSync(workspace)).toBe(true);
  });

  it("logs every pass with what it removed — including a pass that removed nothing", () => {
    const store = storeWithTerminalTask();
    const info = vi.spyOn(logger, "info");
    runMaintenancePass(store.db, {
      reason: "interval",
      dataRoot: store.dataRoot,
    });
    const line = info.mock.calls.find(([msg]) => msg === "store maintenance pass");
    expect(line).toBeDefined();
    expect(line![1]).toMatchObject({
      reason: "interval",
      runLogLines: 0,
      transcripts: 0,
      workspaces: 0,
    });
  });

  it("records the pass so the health endpoint can prove the pruner is alive", () => {
    const store = storeWithTerminalTask();
    expect(maintenanceState().lastPassAt).toBeNull();
    runMaintenancePass(store.db, {
      reason: "interval",
      dataRoot: store.dataRoot,
    });
    const state = maintenanceState();
    expect(state.lastPassAt).not.toBeNull();
    expect(state.lastPassReason).toBe("interval");
    expect(state.intervalMs).toBe(6 * 60 * 60 * 1000);
  });
});

describe("startMaintenanceScheduler (gap 15)", () => {
  it("runs a pass on every interval tick — the long-lived deployment case", async () => {
    vi.useFakeTimers();
    const store = storeWithTerminalTask();
    const workspace = seedWorkspace(store, "VIB-1");
    agedTranscript(store, "run_old.jsonl", 40);

    // The period a deployment sets; the scheduler reads it once, at start.
    await withEnv({ VIBERR_MAINTENANCE_INTERVAL_SECONDS: "1" }, () =>
      startMaintenanceScheduler(store.db, { dataRoot: store.dataRoot }),
    );
    expect(maintenanceState().scheduled).toBe(true);
    expect(maintenanceState().lastPassAt).toBeNull(); // no immediate pass

    vi.advanceTimersByTime(1_000);

    expect(maintenanceState().lastPassAt).not.toBeNull();
    expect(maintenanceState().lastPassReason).toBe("interval");
    // The process never restarted, and the disk was still reclaimed.
    expect(existsSync(workspace)).toBe(false);
  });

  it("is idempotent: a second start leaves no timer the reset misses", async () => {
    vi.useFakeTimers();
    const store = storeWithTerminalTask();
    await withEnv({ VIBERR_MAINTENANCE_INTERVAL_SECONDS: "1" }, () => {
      startMaintenanceScheduler(store.db);
      startMaintenanceScheduler(store.db);
    });
    resetMaintenanceStateForTests();
    vi.advanceTimersByTime(10_000);
    expect(maintenanceState().lastPassAt).toBeNull();
    expect(maintenanceState().scheduled).toBe(false);
  });
});

describe("checkDiskPressure (gap 16)", () => {
  /**
   * The classification is driven through the thresholds the deployment already
   * configures (`VIBERR_DISK_*_FREE_MB`), set relative to what the volume under
   * the test's data root really has free — so `checkDiskPressure` runs against a
   * real `statfs` and the status it acts on is the one the product computes.
   * `× 2` rather than `+ 1` so a concurrent write cannot cross the line. The
   * thresholds are read through `getEnv()`, which parses once per process, so
   * pinning them drops the cached parse (ruling 458(c)).
   */
  function pinThresholds(
    dataRoot: string,
    verdict: "low" | "critical" | "ok",
  ): void {
    const real = measureDataRootSpace(dataRoot);
    if (!real) throw new Error("cannot measure the test data root");
    const aboveFreeMb = Math.ceil((real.freeBytes * 2) / (1024 * 1024));
    process.env.VIBERR_DISK_LOW_FREE_MB = verdict === "ok" ? "1" : String(aboveFreeMb);
    process.env.VIBERR_DISK_CRITICAL_FREE_MB =
      verdict === "critical" ? String(aboveFreeMb) : "1";
    resetEnvCacheForTests();
  }

  it("warns on the transition into low space and reclaims immediately", () => {
    const store = storeWithTerminalTask();
    const workspace = seedWorkspace(store, "VIB-1");
    const warn = vi.spyOn(logger, "warn");
    pinThresholds(store.dataRoot, "low");

    const observed = checkDiskPressure(store.db, store.dataRoot);

    expect(observed?.status).toBe("low");
    expect(warn).toHaveBeenCalledWith(
      "data root is low on free space",
      expect.objectContaining({ free: formatBytes(observed!.freeBytes) }),
    );
    // Acting, not just reporting: the pass that frees the 11-16 MB clones runs
    // now rather than at the next 6-hour tick.
    expect(maintenanceState().lastPassReason).toBe("disk-pressure");
    expect(existsSync(workspace)).toBe(false);
  });

  it("escalates a critical volume to error level", () => {
    const store = storeWithTerminalTask();
    const error = vi.spyOn(logger, "error");
    pinThresholds(store.dataRoot, "critical");
    const observed = checkDiskPressure(store.db, store.dataRoot);
    expect(observed?.status).toBe("critical");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("critically low on free space"),
      expect.objectContaining({ free: formatBytes(observed!.freeBytes) }),
    );
  });

  it("logs the TRANSITION only — not every sample", () => {
    const store = storeWithTerminalTask();
    pinThresholds(store.dataRoot, "low");
    checkDiskPressure(store.db, store.dataRoot);
    const warn = vi.spyOn(logger, "warn");
    checkDiskPressure(store.db, store.dataRoot);
    checkDiskPressure(store.db, store.dataRoot);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent, and triggers nothing, when there is room", () => {
    const store = storeWithTerminalTask();
    const workspace = seedWorkspace(store, "VIB-1");
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    pinThresholds(store.dataRoot, "ok");
    expect(checkDiskPressure(store.db, store.dataRoot)?.status).toBe("ok");
    expect(warn).not.toHaveBeenCalled();
    // The first sample after boot is a baseline: live on 2026-09-30 it logged
    // "data root free space recovered" five minutes after a clean boot.
    // CANARY: log every status change, the first sample included.
    expect(info).not.toHaveBeenCalledWith("data root free space recovered", expect.anything());
    expect(maintenanceState().lastPassAt).toBeNull();
    expect(existsSync(workspace)).toBe(true);
  });

  it("says the space recovered only after a low reading", () => {
    const store = storeWithTerminalTask();
    pinThresholds(store.dataRoot, "low");
    checkDiskPressure(store.db, store.dataRoot);
    const info = vi.spyOn(logger, "info");
    pinThresholds(store.dataRoot, "ok");
    checkDiskPressure(store.db, store.dataRoot);
    expect(info).toHaveBeenCalledWith(
      "data root free space recovered",
      expect.objectContaining({ source: "data-root" }),
    );
  });

  it("reports nothing when the volume cannot be measured (never a false alarm)", () => {
    const store = storeWithTerminalTask();
    const error = vi.spyOn(logger, "error");
    // A data root that is not there: `statfs` fails and the watch must stay
    // quiet rather than read the failure as "no space".
    const absent = path.join(store.dataRoot, "gone", "deeper");
    expect(checkDiskPressure(store.db, absent)).toBeNull();
    expect(error).not.toHaveBeenCalled();
    expect(maintenanceState().lastPassAt).toBeNull();
  });
});
