import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
 */

// Toggles for the subsystems the loader reads. Each mock spreads the real
// module so only the one probe function is swapped.
let watcherAlive = true;
let kbWatcherAlive = true;
let lockHeld = true;
let disk: DiskSpace | null = null;
let dbThrows = false;

vi.mock("~/server/files/file-watch.service.server", async () => {
  const actual = await vi.importActual<
    typeof import("~/server/files/file-watch.service.server")
  >("~/server/files/file-watch.service.server");
  return { ...actual, isFileWatcherAlive: () => watcherAlive };
});
vi.mock("~/server/files/kb-watch.service.server", async () => {
  const actual = await vi.importActual<
    typeof import("~/server/files/kb-watch.service.server")
  >("~/server/files/kb-watch.service.server");
  return { ...actual, isKbWatcherAlive: () => kbWatcherAlive };
});
vi.mock("~/server/db/data-root-lock.server", async () => {
  const actual = await vi.importActual<
    typeof import("~/server/db/data-root-lock.server")
  >("~/server/db/data-root-lock.server");
  return {
    ...actual,
    heldDataRootLock: () =>
      lockHeld
        ? {
            holder: {
              pid: 4242,
              hostname: "test-host",
              startedAt: "2026-08-08T00:00:00.000Z",
            },
          }
        : null,
  };
});
vi.mock("~/server/ops/disk-space.server", async () => {
  const actual = await vi.importActual<
    typeof import("~/server/ops/disk-space.server")
  >("~/server/ops/disk-space.server");
  return { ...actual, cachedDataRootSpace: () => disk };
});
vi.mock("~/server/db/sqlite.server", async () => {
  const actual =
    await vi.importActual<typeof import("~/server/db/sqlite.server")>(
      "~/server/db/sqlite.server",
    );
  return {
    ...actual,
    getDb: () => {
      if (dbThrows) throw new Error("database is unreachable");
      return actual.getDb();
    },
  };
});

const GB = 1024 * 1024 * 1024;

function space(freeBytes: number, status: DiskSpace["status"]): DiskSpace {
  return {
    freeBytes,
    totalBytes: 100 * GB,
    usedPercent: 50,
    status,
    lowThresholdBytes: 2 * GB,
    criticalThresholdBytes: 512 * 1024 * 1024,
  };
}

interface HealthBody {
  ok: boolean;
  status: "ok" | "degraded" | "down";
  degraded?: string[];
  watcher?: boolean;
  kbWatcher?: boolean;
  lock?: unknown;
  backends?: { claude: string; codex: string };
  disk?: DiskSpace | null;
  maintenance?: { intervalMs: number; lastPassAt: string | null };
  build?: { version: string | null; revision: string | null };
}

let app: AppTestContext;

beforeAll(async () => {
  app = await setupAppTest();
});
afterAll(() => app.cleanup());

beforeEach(() => {
  watcherAlive = true;
  kbWatcherAlive = true;
  lockHeld = true;
  disk = space(50 * GB, "ok");
  dbThrows = false;
});

async function probe(
  url = "/resources/health",
): Promise<{ body: HealthBody; status: number }> {
  const { loader } = await import("~/routes/resources.health");
  const response = (await loader({ request: app.request(url) })) as {
    data: HealthBody;
    init?: { status?: number };
  };
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
    watcherAlive = false;
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
    watcherAlive = false;
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
    kbWatcherAlive = false;
    lockHeld = false;
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

  it("still answers 503 / down when the database is unreadable", async () => {
    dbThrows = true;
    const { body, status } = await probe();
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.status).toBe("down");
  });
});

describe("/resources/health — disk awareness (gap 16)", () => {
  it("carries free space and degrades on a low volume", async () => {
    disk = space(1 * GB, "low");
    const { body } = await probe();
    expect(body.disk).toMatchObject({ freeBytes: GB, status: "low" });
    expect(body.degraded).toContain("disk");
    expect((await probe("/resources/health?probe=readiness")).status).toBe(503);
  });

  it("degrades on a critical volume", async () => {
    disk = space(64 * 1024 * 1024, "critical");
    const { body } = await probe();
    expect(body.status).toBe("degraded");
    expect(body.degraded).toContain("disk");
  });

  it("an UNMEASURABLE volume is null and is not an alarm", async () => {
    disk = null;
    const { body } = await probe();
    expect(body.disk).toBeNull();
    expect(body.degraded).not.toContain("disk");
    expect(body.status).toBe("ok");
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
