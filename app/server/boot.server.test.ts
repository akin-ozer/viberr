import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDbContext } from "../../test-support/test-db";
import { logger } from "./logging/logger.server";
import type {
  MaintenancePassOptions,
  MaintenancePassResult,
} from "./ops/maintenance.server";
import type { BuildInfo } from "./ops/build-info.server";
import type { DiskStatus } from "./ops/disk-space.server";
import {
  installCrashVisibilityHandlers,
  logBootIntegrity,
  reconcileRestartedWork,
  startStoreMaintenance,
  takeDataRootWriterLock,
} from "./boot.server";

/**
 * P14-RT-09: the boot reconcile chain is ORDERED.
 *
 * The workspace reclaim used to run right after `void`-scheduling the async
 * agent-reply recovery while its comment claimed to run "after the recovery pass
 * above" — so a recovered run's delivery reconcile could race the `rmSync` of
 * the workspace it was reading. These tests pin the sequence, and that one
 * failing step never stops the next.
 */

const calls: string[] = [];
const recoverUnreactedAgentRuns = vi.fn(async () => {
  calls.push("reply-recovery:start");
  await new Promise((r) => setTimeout(r, 5));
  calls.push("reply-recovery:end");
  return { recovered: 0, capped: 0 };
});
const recoverStrandedOperatorPlans = vi.fn(async () => {
  calls.push("plan-recovery:start");
  await new Promise((r) => setTimeout(r, 5));
  calls.push("plan-recovery:end");
  return { recovered: 0, stale: 0 };
});
const reclaimTerminalTaskWorkspaces = vi.fn(() => {
  calls.push("reclaim");
  return { removed: 0, bytes: 0 };
});
/** Injected through `reconcileRestartedWork`'s deps seam, so the chain's ORDER
 *  is observable without touching a live store. */
const reconcileDeps = {
  recoverUnreactedAgentRuns,
  recoverStrandedOperatorPlans,
  reclaimTerminalTaskWorkspaces,
};

/**
 * Gap 15: boot's retention step used to be the ONLY one in the process
 * lifetime. These two stand in for the periodic scheduler so the boot WIRING
 * (which cannot be exercised without booting a real server) is testable.
 */
/** Boot discards the pass result, so the stand-in answers the empty one —
 *  spelled out rather than faked, so it still satisfies the real signature. */
const EMPTY_PASS: MaintenancePassResult = {
  reason: "boot",
  retention: { runLogLines: 0, auditEvents: 0, notifications: 0 },
  transcripts: { transcripts: 0, sessions: 0, bytes: 0 },
  workspaces: null,
  workspacesSkipped: "not-requested",
  disk: null,
  freedBytes: 0,
};
const runMaintenancePass = vi.fn(
  (_db: DatabaseSync, _options: MaintenancePassOptions) => EMPTY_PASS,
);
const startMaintenanceScheduler = vi.fn((_db: DatabaseSync) => {});
/** Injected through `startStoreMaintenance`'s deps seam. */
const maintenanceDeps = { runMaintenancePass, startMaintenanceScheduler };

/**
 * SAFETY: the chain only passes the handle through — every step that would
 * query it is an injected stand-in above, and the one real call
 * (`reapStaleWarmups`, inside `startStoreMaintenance`) already runs under that
 * function's own catch. No assertion in this file depends on a live database.
 */
const db = {} as DatabaseSync;

beforeEach(() => {
  calls.length = 0;
  recoverUnreactedAgentRuns.mockClear();
  recoverStrandedOperatorPlans.mockClear();
  reclaimTerminalTaskWorkspaces.mockClear();
  runMaintenancePass.mockClear();
  runMaintenancePass.mockImplementation(() => EMPTY_PASS);
  startMaintenanceScheduler.mockClear();
});

/**
 * G1: a held data root must END the boot with the refusal MESSAGE. `bootServer`
 * is awaited from entry.server.tsx module scope, so an escaping throw reaches
 * the operator as an SSR module-init stack instead — the one text that names the
 * holder and the two remedies never gets read.
 */
describe("takeDataRootWriterLock (G1)", () => {
  const lockCtx = createTestDbContext();
  afterEach(lockCtx.cleanup);

  function foreignHostLock(): string {
    const dataRoot = lockCtx.makeTempDir();
    mkdirSync(path.join(dataRoot, "state"), { recursive: true });
    // The container-vs-host shape: a lock left by a host this process cannot
    // probe for liveness, which is exactly what a recreated container found.
    writeFileSync(
      path.join(dataRoot, "state", "writer.lock"),
      JSON.stringify({
        pid: 1,
        hostname: "some-dead-container",
        startedAt: "2026-07-28T09:00:00.000Z",
      }),
    );
    return dataRoot;
  }

  it("prints the readable refusal and exits 1 instead of throwing an SSR crash", () => {
    const written: string[] = [];
    const exits: number[] = [];

    expect(() =>
      takeDataRootWriterLock(
        { VIBERR_FORCE_DATA_ROOT_LOCK: undefined },
        {
          dataRoot: foreignHostLock(),
          io: {
            write: (message) => void written.push(message),
            exit: (code) => void exits.push(code),
          },
        },
      ),
    ).not.toThrow();

    expect(exits).toEqual([1]);
    const message = written.join("");
    expect(message).toContain("Refusing to boot");
    expect(message).toContain("some-dead-container");
    expect(message).toContain("different host");
    expect(message).toContain("VIBERR_FORCE_DATA_ROOT_LOCK=1");
    expect(message.endsWith("\n")).toBe(true);
  });

  it("the force override boots through the same refusal", async () => {
    const exits: number[] = [];
    takeDataRootWriterLock(
      { VIBERR_FORCE_DATA_ROOT_LOCK: "1" },
      {
        dataRoot: foreignHostLock(),
        io: { write: () => {}, exit: (code) => void exits.push(code) },
      },
    );
    expect(exits).toEqual([]);
    // A forced boot really holds the root afterwards — give it back.
    const { releaseDataRootLock } = await import("./db/data-root-lock.server");
    releaseDataRootLock();
  });
});

/**
 * F20-8(a): a fatal death must be visible. The handlers themselves call
 * `process.exit`, so the test spies on `process.on` (never registering a real
 * exit-on-crash handler into the suite) and only asserts the wiring: both fatal
 * channels are registered, exactly once.
 */
describe("installCrashVisibilityHandlers (F20-8a)", () => {
  const GUARD = Symbol.for("viberr.crashVisibilityInstalled");

  /** The process-global slot boot parks its once-only flag in — the same
   *  well-known symbol `boot.server.ts` writes, so clearing it here really does
   *  make the module believe nothing has installed the handlers yet. */
  interface CrashFlagHost {
    [GUARD]?: boolean;
  }

  // SAFETY: `GUARD` is a registry symbol under a viberr-namespaced name that
  // nothing outside boot.server.ts reads or writes, and `true` is the only
  // value that file ever stores there — so the slot holds that or nothing.
  const slot = globalThis as CrashFlagHost;

  it("registers uncaughtException + unhandledRejection once, idempotently", () => {
    slot[GUARD] = undefined; // pretend nothing has installed them yet
    const on = vi.spyOn(process, "on").mockImplementation(() => process);
    try {
      installCrashVisibilityHandlers();
      installCrashVisibilityHandlers(); // a second call must NOT stack a second pair
      expect(on.mock.calls.map((c) => c[0])).toEqual([
        "uncaughtException",
        "unhandledRejection",
      ]);
    } finally {
      on.mockRestore();
      slot[GUARD] = undefined;
    }
  });
});

describe("reconcileRestartedWork (P14-RT-09)", () => {
  it("reclaims workspaces only after BOTH recovery passes have COMPLETED", async () => {
    await reconcileRestartedWork(db, reconcileDeps);

    expect(calls).toEqual([
      "reply-recovery:start",
      "reply-recovery:end",
      "plan-recovery:start",
      "plan-recovery:end",
      "reclaim",
    ]);
  });

  it("a failing recovery pass never stops the rest of the chain", async () => {
    recoverUnreactedAgentRuns.mockRejectedValueOnce(new Error("boom"));

    await expect(reconcileRestartedWork(db, reconcileDeps)).resolves.toBeUndefined();

    expect(recoverStrandedOperatorPlans).toHaveBeenCalledTimes(1);
    expect(reclaimTerminalTaskWorkspaces).toHaveBeenCalledTimes(1);
  });
});

/**
 * Gap 15: retention was a one-shot boot step, so the more stable the
 * deployment the more it grew — and `compose.yml` sets `restart: unless-stopped`,
 * meaning a healthy container is only ever restarted by a human. Boot keeps its
 * pass AND now arms the timer that makes it recur.
 */
describe("startStoreMaintenance (gap 15)", () => {
  it("runs a boot pass and ARMS the periodic scheduler", () => {
    startStoreMaintenance(db, maintenanceDeps);

    expect(runMaintenancePass).toHaveBeenCalledTimes(1);
    expect(runMaintenancePass.mock.calls[0]![1]).toMatchObject({
      reason: "boot",
      // reconcileRestartedWork owns the reclaim at boot, sequenced AFTER run
      // recovery (P14-RT-09) — doing it here too would reintroduce that race.
      reclaimWorkspaces: false,
    });
    expect(startMaintenanceScheduler).toHaveBeenCalledTimes(1);
    expect(startMaintenanceScheduler.mock.calls[0]![0]).toBe(db);
  });

  it("still arms the scheduler when the boot pass throws", () => {
    runMaintenancePass.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    expect(() => startStoreMaintenance(db, maintenanceDeps)).not.toThrow();
    expect(startMaintenanceScheduler).toHaveBeenCalledTimes(1);
  });
});

/**
 * Gap 18: the boot integrity line was the doc's answer to "which build is
 * running" (deployment.md §First run) while carrying no build identity at all —
 * `latestMigration` is the constant `0001_baseline.sql` for every build.
 */
describe("logBootIntegrity (gaps 16 + 18)", () => {
  const bootCtx = createTestDbContext();
  afterEach(bootCtx.cleanup);

  /** The two fields gaps 18 + 16 added to boot's one integrity line — the only
   *  ones these tests read off it. */
  interface BootIntegrityLine {
    build: BuildInfo;
    disk: { free: string; total: string; status: DiskStatus } | null;
  }

  function integrityFields(): BootIntegrityLine {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      logBootIntegrity(bootCtx.makeDb());
      const line = info.mock.calls.find(
        ([msg]) => msg === "boot integrity check",
      );
      expect(line).toBeDefined();
      const fields = line![1]!;
      // SAFETY: the logger types every call's fields as the open bag any caller
      // may pass, but this line has ONE writer — `logBootIntegrity`, which
      // builds it from its own `BootIntegrityFields`, where `build` is
      // `getBuildInfo()`'s return and `disk` its formatted block or null.
      return {
        ...fields,
        build: fields.build as BuildInfo,
        disk: fields.disk as BootIntegrityLine["disk"],
      };
    } finally {
      info.mockRestore();
    }
  }

  it("names the running build", () => {
    const fields = integrityFields();
    expect(fields.build).toBeDefined();
    expect(fields.build).toHaveProperty("version");
    expect(fields.build).toHaveProperty("revision");
    expect(fields.build).toHaveProperty("revisionSource");
  });

  it("reports free space at the one moment an operator is reading this log", () => {
    expect(integrityFields()).toHaveProperty("disk");
  });
});

describe("projectionMissingColumns (pass-21 live-validation catch)", () => {
  it("names columns the live root lacks relative to the shipped baseline, and nothing on a healthy schema", async () => {
    const { projectionMissingColumns } = await import("./boot.server");
    const ctx = createTestDbContext();
    try {
      const db = ctx.makeDb();
      // Freshly migrated ⇒ healthy ⇒ nothing to report.
      expect(projectionMissingColumns(db)).toEqual([]);
      // An old root predating a baseline column addition (the real pass-21
      // shape: work_revision_sha reached only fresh roots).
      db.exec("ALTER TABLE task_projections DROP COLUMN work_revision_sha");
      expect(projectionMissingColumns(db)).toEqual(["work_revision_sha"]);
    } finally {
      ctx.cleanup();
    }
  });
});
