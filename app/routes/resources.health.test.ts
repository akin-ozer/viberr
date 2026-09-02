import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../test-support/test-app";
import type { DiskSpace } from "~/server/ops/disk-space.server";

/**
 * Gap 17 — `/resources/health` answered 200 / `ok: true` to everything except
 * an unreadable database. A container with a DEAD STORE WATCHER (the board
 * serving cached projections while task files on disk drift — the runbook says
 * `watcher: false` is "a REAL dead watcher") reported healthy forever, and
 * compose's status-only healthcheck could never act on the fields in the body.
 *
 * Also covers the two things the payload had to start carrying: free space
 * (gap 16) and build identity (gap 18).
 *
 * Every subsystem the loader reads is driven through its own real controls —
 * the watchers are started and stopped, the writer lock is taken and released,
 * the disk thresholds are the configurable ones measured against the real
 * volume — so what these pin is the probe's reading of actual process state.
 */

/** A threshold no real volume can satisfy: 1 PiB, expressed in the MiB the
 *  `VIBERR_DISK_*_FREE_MB` overrides take. */
const UNREACHABLE_THRESHOLD_MB = 1024 * 1024 * 1024;
const UNREACHABLE_THRESHOLD_BYTES = UNREACHABLE_THRESHOLD_MB * 1024 * 1024;

interface HealthBody {
  ok: boolean;
  status: "ok" | "degraded" | "down";
  degraded?: string[];
  watcher?: boolean;
  kbWatcher?: boolean;
  lock?: unknown;
  backends?: { claude: string; codex: string };
  browser?: { status: "ready" | "unavailable"; reason?: string };
  disk?: DiskSpace | null;
  maintenance?: { intervalMs: number; lastPassAt: string | null };
  build?: { version: string | null; revision: string | null };
}

let app: AppTestContext;

/** Both watchers running and the single-writer lock held: what a serving
 *  process looks like, and the baseline every test starts from. */
async function bringSubsystemsUp(): Promise<void> {
  const [
    { startFileWatcher },
    { startKbWatcher },
    { acquireDataRootLock, heldDataRootLock },
  ] = await Promise.all([
    import("~/server/files/file-watch.service.server"),
    import("~/server/files/kb-watch.service.server"),
    import("~/server/db/data-root-lock.server"),
  ]);
  startFileWatcher({ dataRoot: app.dataRoot });
  startKbWatcher({ dataRoot: app.dataRoot });
  if (!heldDataRootLock()) acquireDataRootLock({ dataRoot: app.dataRoot });
}

async function takeSubsystemsDown(): Promise<void> {
  const [{ stopFileWatcher }, { stopKbWatcher }, { releaseDataRootLock }] =
    await Promise.all([
      import("~/server/files/file-watch.service.server"),
      import("~/server/files/kb-watch.service.server"),
      import("~/server/db/data-root-lock.server"),
    ]);
  stopFileWatcher();
  stopKbWatcher();
  releaseDataRootLock();
}

/** Pin the configurable free-space thresholds low enough that a real volume
 *  with any room at all classifies `ok` — the "low"/"critical" cases raise
 *  them instead of fabricating a measurement. */
async function setDiskThresholds(lowMb: number, criticalMb: number): Promise<void> {
  process.env.VIBERR_DISK_LOW_FREE_MB = String(lowMb);
  process.env.VIBERR_DISK_CRITICAL_FREE_MB = String(criticalMb);
  const { resetDiskSpaceCacheForTests } = await import(
    "~/server/ops/disk-space.server"
  );
  resetDiskSpaceCacheForTests();
}

beforeAll(async () => {
  app = await setupAppTest();
  const { ensureDataRootDirs } = await import(
    "~/server/files/file-store-root.server"
  );
  ensureDataRootDirs(app.dataRoot);
});

afterAll(async () => {
  await takeSubsystemsDown();
  delete process.env.VIBERR_DISK_LOW_FREE_MB;
  delete process.env.VIBERR_DISK_CRITICAL_FREE_MB;
  app.cleanup();
});

beforeEach(async () => {
  await bringSubsystemsUp();
  await setDiskThresholds(1, 1);
});

async function probe(
  url = "/resources/health",
): Promise<{ body: HealthBody; status: number }> {
  const { loader } = await import("~/routes/resources.health");
  const response = await loader({ request: app.request(url) });
  return { body: response.data, status: response.init?.status ?? 200 };
}

describe("/resources/health — honest status (gap 17)", () => {
  it("reports ok with nothing degraded when every subsystem is up", async () => {
    const { body, status } = await probe();
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ok");
    expect(body.degraded).toEqual([]);
  });

  it("names a dead store watcher in the payload and downgrades the verdict", async () => {
    const { stopFileWatcher } = await import(
      "~/server/files/file-watch.service.server"
    );
    stopFileWatcher();
    const { body, status } = await probe();
    expect(body.status).toBe("degraded");
    expect(body.degraded).toContain("watcher");
    // Liveness stays 200: restarting the container does not revive a watcher
    // any faster than the operator can, and killing a serving instance is worse
    // than a stale board. The verdict lives in `status`.
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("fails the READINESS probe so an orchestrator can act on it", async () => {
    const { stopFileWatcher } = await import(
      "~/server/files/file-watch.service.server"
    );
    stopFileWatcher();
    const { body, status } = await probe("/resources/health?probe=readiness");
    expect(status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.degraded).toContain("watcher");
    // `?probe=ready` is the same probe.
    expect((await probe("/resources/health?probe=ready")).status).toBe(503);
  });

  it("keeps readiness green while everything is healthy", async () => {
    expect((await probe("/resources/health?probe=readiness")).status).toBe(200);
  });

  it("reports a dead KB watcher and a missing writer lock", async () => {
    const [{ stopKbWatcher }, { releaseDataRootLock }] = await Promise.all([
      import("~/server/files/kb-watch.service.server"),
      import("~/server/db/data-root-lock.server"),
    ]);
    stopKbWatcher();
    releaseDataRootLock();
    const { body } = await probe();
    expect(body.degraded).toEqual(
      expect.arrayContaining(["kbWatcher", "lock"]),
    );
    expect(body.lock).toBeNull();
  });

  it("does NOT treat an unconfigured backend as degraded (R17-5)", async () => {
    // An instance that only ever uses Claude is a CORRECT deployment, and the
    // probe is env-presence only — it has never checked a token's validity. A
    // never-checked thing renders neutral; alarming here would train the
    // operator to ignore the whole field.
    const { setBackendAvailability } = await import(
      "~/server/runtimes/runtime-registry.server"
    );
    setBackendAvailability("codex", false);
    try {
      const { body, status } = await probe();
      expect(body.backends?.codex).toBe("unavailable");
      expect(body.status).toBe("ok");
      expect(body.degraded).toEqual([]);
      expect(status).toBe(200);
      expect(
        (await probe("/resources/health?probe=readiness")).status,
      ).toBe(200);
    } finally {
      setBackendAvailability("codex", true);
    }
  });

  it("reports the browser runtime status — ready when installed, unavailable (never degraded) when chromium is missing", async () => {
    // @playwright/mcp is a production dependency, so on a default host with no
    // executable pinned the browser runtime is ready.
    const ready = await probe();
    expect(ready.body.browser?.status).toBe("ready");
    expect(ready.body.degraded).toEqual([]);

    // A pinned-but-absent executable makes the runtime unavailable, with a
    // reason — but it is NOT a degraded fault (the same R17-5 stance as
    // backends: a deployment that never grants the browser is still correct;
    // this just makes a broken chromium visible before a run is spent).
    const { resetEnvCacheForTests } = await import("~/server/config/env.server");
    process.env.VIBERR_BROWSER_EXECUTABLE =
      "/nonexistent/chromium-not-installed";
    resetEnvCacheForTests();
    try {
      const { body, status } = await probe();
      expect(body.browser?.status).toBe("unavailable");
      expect(body.browser?.reason).toContain("VIBERR_BROWSER_EXECUTABLE");
      // C05-A (pass 32): this body is unauthenticated, so the configured host
      // path never appears in it — the variable's NAME is the whole reason.
      expect(body.browser?.reason).not.toContain("/nonexistent");
      expect(JSON.stringify(body)).not.toContain("/nonexistent");
      expect(body.status).toBe("ok");
      expect(body.degraded).toEqual([]);
      expect(status).toBe(200);
      expect((await probe("/resources/health?probe=readiness")).status).toBe(
        200,
      );
    } finally {
      process.env.VIBERR_BROWSER_EXECUTABLE = "";
      resetEnvCacheForTests();
    }
  });
});

describe("/resources/health — disk awareness (gap 16)", () => {
  it("carries free space and degrades on a low volume", async () => {
    // A low threshold above anything a real volume has free, with the critical
    // one left at the floor: the classification is the real one.
    await setDiskThresholds(UNREACHABLE_THRESHOLD_MB, 1);
    const { body } = await probe();
    expect(body.disk).toMatchObject({
      status: "low",
      lowThresholdBytes: UNREACHABLE_THRESHOLD_BYTES,
    });
    expect(body.disk!.freeBytes).toBeGreaterThan(0);
    expect(body.degraded).toContain("disk");
    expect((await probe("/resources/health?probe=readiness")).status).toBe(503);
  });

  it("degrades on a critical volume", async () => {
    await setDiskThresholds(UNREACHABLE_THRESHOLD_MB, UNREACHABLE_THRESHOLD_MB);
    const { body } = await probe();
    expect(body.disk?.status).toBe("critical");
    expect(body.status).toBe("degraded");
    expect(body.degraded).toContain("disk");
  });

  it("an UNMEASURABLE volume is null and is not an alarm", async () => {
    // A data root that is not there: `statfs` fails, and the payload has to say
    // "not measured" rather than fabricate a zero.
    const { resetEnvCacheForTests } = await import("~/server/config/env.server");
    const gone = path.join(tmpdir(), "viberr-health-absent-root");
    rmSync(gone, { recursive: true, force: true });
    process.env.VIBERR_DATA_ROOT = gone;
    resetEnvCacheForTests();
    await setDiskThresholds(1, 1);
    try {
      const { body } = await probe();
      expect(body.disk).toBeNull();
      expect(body.degraded).not.toContain("disk");
      expect(body.status).toBe("ok");
    } finally {
      process.env.VIBERR_DATA_ROOT = app.dataRoot;
      resetEnvCacheForTests();
    }
  });

  it("surfaces the maintenance schedule so the pruner is provable", async () => {
    const { body } = await probe();
    expect(body.maintenance?.intervalMs).toBeGreaterThan(0);
    // Never-run is null, not zero — neutral, not alarming.
    expect(body.maintenance).toHaveProperty("lastPassAt");
  });
});

describe("/resources/health — build identity (gap 18)", () => {
  it("names the running build", async () => {
    // build-info resolves identity ONCE per process and caches it. Its ambient
    // source is the checkout's `.git`, but the suite runs inside a git WORKTREE
    // where `.git` is a pointer FILE, not a directory — so the ambient read
    // yields a null revision (the very "no checkout to read" case build-info
    // documents). Pin the build-time env sha instead: that is the ONLY source a
    // container ever has, so this proves what the endpoint SURFACES,
    // deterministically, independent of the checkout layout.
    const { resetBuildInfoCacheForTests } = await import(
      "~/server/ops/build-info.server"
    );
    const prevSha = process.env.VIBERR_BUILD_SHA;
    process.env.VIBERR_BUILD_SHA = "abcdef1234567890abcdef1234567890abcdef12";
    resetBuildInfoCacheForTests();
    try {
      const { body } = await probe();
      expect(body.build).toBeDefined();
      expect(body.build).toHaveProperty("version");
      expect(body.build).toHaveProperty("revision");
      // The short (12-char) sha, straight from the build-time stamp — a real
      // identity, never a fabricated placeholder.
      expect(body.build!.revision).toBe("abcdef123456");
      expect(body.build!.revision).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      if (prevSha === undefined) delete process.env.VIBERR_BUILD_SHA;
      else process.env.VIBERR_BUILD_SHA = prevSha;
      resetBuildInfoCacheForTests();
    }
  });
});

describe("/resources/health — the database is the one fatal subsystem", () => {
  it("still answers 503 / down when the database is unreadable", async () => {
    // A data root whose `state` path is a FILE: the projection database under
    // it cannot be opened at all, which is what "unreadable" means here. This
    // runs last because it swaps the process's open handle.
    const { resetEnvCacheForTests } = await import("~/server/config/env.server");
    const { closeDb, getDb } = await import("~/server/db/sqlite.server");
    const broken = mkdtempSync(path.join(tmpdir(), "viberr-health-broken-"));
    writeFileSync(path.join(broken, "state"), "not a directory");
    process.env.VIBERR_DATA_ROOT = broken;
    resetEnvCacheForTests();
    closeDb();
    try {
      const { body, status } = await probe();
      expect(status).toBe(503);
      expect(body.ok).toBe(false);
      expect(body.status).toBe("down");
    } finally {
      process.env.VIBERR_DATA_ROOT = app.dataRoot;
      resetEnvCacheForTests();
      closeDb();
      getDb();
      rmSync(broken, { recursive: true, force: true });
    }
  });
});
