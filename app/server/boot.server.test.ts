import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { lockPath } from "../../test-support/data-root-lock";
import { createTestDbContext } from "../../test-support/test-db";
import {
  HERMETIC_TOOLCHAIN,
  primeHermeticToolchain,
} from "../../test-support/toolchain";
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
/** The re-invokes boot's orphan sweep LAUNCHED — still cloning a task
 *  workspace when the chain reaches its reclaim. Reassigned per test. */
let orphanReinvokes: Promise<void> = Promise.resolve();
/** The sweep of the orphans' surviving processes (ruling 174) — still
 *  signalling when the chain reaches its reclaim. Reassigned per test. */
let orphanReaped: Promise<void> = Promise.resolve();
/** Ruling 215: what step 1 says it took this boot. Reassigned per test. */
let orphanClaimed: ReadonlySet<string> = new Set<string>();
const finalizeOrphanedRuns = vi.fn(() => {
  calls.push("orphan-finalize");
  return {
    finalized: 0,
    reinvoked: 0,
    capped: 0,
    reinvokes: orphanReinvokes,
    reaped: orphanReaped,
    notes: Promise.resolve(),
    claimedTasks: orphanClaimed,
  };
});
/** Ruling 213: the fourth recovery, and the only one that keys on the BOARD
 *  rather than on a run — it must land after the three that may start one. */
const settleAbandonedWaits = vi.fn(async (..._args: unknown[]) => {
  calls.push("settle-abandoned-waits");
  return 0;
});
/** Runs queued or running when the chain reaches its reclaim. Zero by default;
 *  a test that wants the guard to bite returns one. */
const activeRunCount = vi.fn(() => 0);
const reclaimTerminalTaskWorkspaces = vi.fn(() => {
  calls.push("reclaim");
  return { removed: 0, bytes: 0 };
});
/** Injected through `reconcileRestartedWork`'s deps seam, so the chain's ORDER
 *  is observable without touching a live store. */
const reconcileDeps = {
  finalizeOrphanedRuns,
  recoverUnreactedAgentRuns,
  recoverStrandedOperatorPlans,
  settleAbandonedWaits,
  activeRunCount,
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
  // A pending re-invoke promise left by one test must not steer the next.
  orphanReinvokes = Promise.resolve();
  orphanReaped = Promise.resolve();
  orphanClaimed = new Set<string>();
  finalizeOrphanedRuns.mockClear();
  recoverUnreactedAgentRuns.mockClear();
  activeRunCount.mockClear();
  activeRunCount.mockReturnValue(0);
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
      lockPath(dataRoot),
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
      "orphan-finalize",
      "reply-recovery:start",
      "reply-recovery:end",
      "plan-recovery:start",
      "plan-recovery:end",
      // Ruling 213: the board sweep runs after all three run-keyed passes, so
      // it sees the board they leave behind — a pass that STARTS a run sets
      // `waiting: agent`, and sweeping before it would settle a task that is
      // about to be worked.
      "settle-abandoned-waits",
      "reclaim",
    ]);
  });

  /**
   * Ruling 215 (F37-35). The deploy that shipped 213 wrote BOTH restart notes
   * on SHOP-4 and SHOP-16: "the run … was still running when the server
   * stopped" and, beside it, "no run was live when the server came back". Step
   * 1's job is to move those live runs to `interrupted`, and its own re-invokes
   * are launched after step 4 runs — so step 4 saw a board with no live runs
   * and claimed tasks that were never abandoned. Contradicting itself in two
   * consecutive timeline entries is the "viberr lying" bar, and the second
   * re-invoke spent a coordination run on top of it.
   */
  it("tells the board sweep which tasks the orphan sweep already took (ruling 215)", async () => {
    orphanClaimed = new Set(["shop/SHOP-4"]);

    await reconcileRestartedWork(db, reconcileDeps);

    // CANARY: drop the third argument at the call site and this is `undefined`
    // — the sweep then re-claims every task step 1 just finalized.
    expect(settleAbandonedWaits).toHaveBeenCalledWith(db, {}, orphanClaimed);
  });

  it("reclaims only after the orphan sweep's own re-invokes have finished", async () => {
    // A re-invoked operator drive is still cloning `<taskDir>/workspace/<repo>`
    // — the directory the reclaim would rmSync out from under it. The sweep
    // launches those drives detached, so only a joined handle can order this.
    orphanReinvokes = new Promise<void>((resolve) => {
      setTimeout(() => {
        calls.push("reinvoke:end");
        resolve();
      }, 20);
    });

    await reconcileRestartedWork(db, reconcileDeps);

    // Both must be present AND in this order: an absent "reinvoke:end" would
    // pass a bare index comparison at -1, which is exactly the broken state.
    expect(calls).toContain("reinvoke:end");
    expect(calls).toContain("reclaim");
    expect(calls.indexOf("reinvoke:end")).toBeLessThan(calls.indexOf("reclaim"));
  });

  it("reclaims only after the orphans' surviving processes have been swept (ruling 174)", async () => {
    // A CLI the dead server left running could still be writing the tree the
    // reclaim deletes; its sweep is mid-grace (SIGTERM sent, SIGKILL pending).
    orphanReaped = new Promise<void>((resolve) => {
      setTimeout(() => {
        calls.push("reap:end");
        resolve();
      }, 20);
    });

    await reconcileRestartedWork(db, reconcileDeps);

    expect(calls).toContain("reap:end");
    expect(calls).toContain("reclaim");
    expect(calls.indexOf("reap:end")).toBeLessThan(calls.indexOf("reclaim"));
  });

  it("skips the reclaim while a run is in flight", async () => {
    // A completion recovered by step 1 re-invoked the operator, so that drive
    // holds a working tree: this boot's "nothing is running" moment never came.
    // Skipping costs disk until the next scheduled pass; reclaiming costs a run.
    activeRunCount.mockReturnValue(1);

    await reconcileRestartedWork(db, reconcileDeps);

    expect(reclaimTerminalTaskWorkspaces).not.toHaveBeenCalled();
    expect(calls).not.toContain("reclaim");
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

  it("ruling 182: carries the host toolchain, resolved here so the first health request does not pay for the probe", () => {
    // The suite's primed reading (setup-env), not a live probe — what matters
    // is that the boot line reads the ONE memoized toolchain.
    expect(integrityFields()).toHaveProperty("toolchain", HERMETIC_TOOLCHAIN);
  });

  it("ruling 185: no sandbox WARN survives — there is no sandbox to be unavailable", () => {
    // Canary: re-add either warn (the ruling-182 refusal or the ruling-184
    // child-process limit) and this fails. Both existed only because Viberr
    // asked the Codex CLI to confine a run; it no longer does, so a boot line
    // about the sandbox would be a claim about nothing.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      logBootIntegrity(bootCtx.makeDb());
      expect(warn.mock.calls.find(([msg]) => /codex sandbox/i.test(msg))).toBeUndefined();
      expect(warn.mock.calls.find(([msg]) => /child process/i.test(msg))).toBeUndefined();
    } finally {
      warn.mockRestore();
      info.mockRestore();
      primeHermeticToolchain();
    }
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
      // shape: work_revision_sha reached only fresh roots). Names are
      // table-qualified since the check grew a second rebuilder table.
      db.exec("ALTER TABLE task_projections DROP COLUMN work_revision_sha");
      expect(projectionMissingColumns(db)).toEqual([
        "task_projections.work_revision_sha",
      ]);
      // Same trap, second table: the event INSERT names attachments_json.
      db.exec("ALTER TABLE task_events DROP COLUMN attachments_json");
      expect(projectionMissingColumns(db)).toEqual([
        "task_projections.work_revision_sha",
        "task_events.attachments_json",
      ]);
    } finally {
      ctx.cleanup();
    }
  });
});

/**
 * Ruling 140 (pass 34): the notifications CHECK is the same silent-drift class
 * as the validation CHECK, one table over — a root that predates a kind
 * rejects every INSERT of it and the fail-open swallows the throw. The boot
 * line now names the gap, table-qualified.
 *
 * Canary: revert `projectionCheckGaps` to the `task_projections`-only read and
 * the `notifications.kind: ownership` entry is never reported.
 */
describe("projectionCheckGaps (ruling 140)", () => {
  it("reports a notifications CHECK that lacks a declared kind, beside the validation gaps", async () => {
    const { projectionCheckGaps } = await import("./boot.server");
    const ctx = createTestDbContext();
    try {
      const db = ctx.makeDb();
      expect(projectionCheckGaps(db)).toEqual([]);
      // Rebuild `notifications` with the pre-pass-34 CHECK (sqlite cannot ALTER
      // a CHECK in place) — exactly what an existing root carries.
      db.exec(`
        DROP TABLE notifications;
        CREATE TABLE notifications (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('packet', 'approval', 'mention', 'quality', 'policy', 'controller')),
          ptype TEXT CHECK (ptype IN ('input', 'blocked')),
          title TEXT,
          text TEXT NOT NULL,
          actor_json TEXT,
          project_slug TEXT,
          task_key TEXT,
          occurred_at TEXT NOT NULL,
          read_at TEXT,
          created_at TEXT NOT NULL
        );
      `);
      expect(projectionCheckGaps(db)).toEqual([
        "notifications.kind: question",
        "notifications.kind: dependency",
        "notifications.kind: ownership",
        "notifications.kind: epic",
      ]);
    } finally {
      ctx.cleanup();
    }
  });

  it("ruling 503: reports an epic_projections status CHECK that lacks a declared status", async () => {
    // CANARY: drop the `epic_projections.status` arm from `projectionCheckGaps`.
    const { projectionCheckGaps } = await import("./boot.server");
    const ctx = createTestDbContext();
    try {
      const db = ctx.makeDb();
      expect(projectionCheckGaps(db)).toEqual([]);
      // A root whose epic table predates a status the file schema declares.
      db.exec(`
        DROP TABLE epic_projections;
        CREATE TABLE epic_projections (
          project_slug TEXT NOT NULL,
          epic_id TEXT NOT NULL,
          epic_number INTEGER NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('planned', 'in_progress', 'done')),
          color TEXT NOT NULL,
          source_path TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          PRIMARY KEY (project_slug, epic_id)
        );
      `);
      expect(projectionCheckGaps(db)).toEqual([
        "epic_projections.status: paused",
        "epic_projections.status: cancelled",
      ]);
    } finally {
      ctx.cleanup();
    }
  });
});

/**
 * Ruling 481(a): a root whose `notifications.kind` CHECK predates a kind is
 * widened in place at boot, keeping every row and index, instead of refusing
 * the new kind at INSERT until someone re-baselines (and loses sign-ins).
 *
 * Canary: return `[]` from `widenNotificationKindCheck` before the rebuild and
 * the gap survives, the `question` insert throws, and the index check fails.
 */
describe("widenNotificationKindCheck (ruling 481)", () => {
  it("rebuilds a lagging notifications table with the shipped CHECK, rows and indexes kept", async () => {
    const { projectionCheckGaps, widenNotificationKindCheck } = await import("./boot.server");
    const ctx = createTestDbContext();
    try {
      const db = ctx.makeDb();
      // A current root: nothing to do.
      expect(widenNotificationKindCheck(db)).toEqual([]);
      // What a root first opened before ruling 481 carries.
      db.exec(`
        DROP TABLE notifications;
        CREATE TABLE notifications (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('packet', 'approval', 'mention', 'quality', 'policy', 'controller', 'dependency', 'ownership')),
          ptype TEXT CHECK (ptype IN ('input', 'blocked')),
          title TEXT,
          text TEXT NOT NULL,
          actor_json TEXT,
          project_slug TEXT,
          task_key TEXT,
          occurred_at TEXT NOT NULL,
          read_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_notifications__user ON notifications (user_id, occurred_at DESC);
        INSERT INTO notifications (id, user_id, kind, ptype, title, text, occurred_at, read_at, created_at)
        VALUES ('ntf_old', 'u_1', 'packet', 'input', 'Decision needed', 'body',
                '2026-09-25T03:00:00.000Z', NULL, '2026-09-25T03:00:00.000Z');
      `);
      const insertQuestion = () =>
        db
          .prepare(
            `INSERT INTO notifications (id, user_id, kind, text, occurred_at, created_at)
             VALUES ('ntf_q', 'u_1', 'question', 't', '2026-09-25T03:05:00.000Z', '2026-09-25T03:05:00.000Z')`,
          )
          .run();
      expect(insertQuestion).toThrow(/CHECK constraint failed/);
      // Ruling 503's `epic` postdates this root too.
      expect(projectionCheckGaps(db)).toEqual(["notifications.kind: question", "notifications.kind: epic"]);

      expect(widenNotificationKindCheck(db)).toEqual(["question", "epic"]);

      expect(projectionCheckGaps(db)).toEqual([]);
      expect(db.prepare(`SELECT id, kind, ptype, title FROM notifications`).all()).toEqual([
        { id: "ntf_old", kind: "packet", ptype: "input", title: "Decision needed" },
      ]);
      insertQuestion();
      const indexes = db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND tbl_name = 'notifications' AND sql IS NOT NULL
           ORDER BY name`,
        )
        .all()
        .map((row) => row.name);
      expect(indexes).toEqual(["idx_notifications__user", "idx_notifications__user_task"]);
      // Idempotent: the next boot finds nothing to widen.
      expect(widenNotificationKindCheck(db)).toEqual([]);
    } finally {
      ctx.cleanup();
    }
  });
});
