import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  installFakeRuntime,
  startedRunSpecs,
} from "../../../test-support/fake-runtime";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import type { TaskFrontmatter } from "~/schemas/task-file.schema";
import { getProject } from "~/server/projections/board-query.server";
import type { RunHandle, RunSpec, RuntimeAdapter } from "~/server/runtimes/adapter.server";
import { configureRunServiceForTests } from "~/server/runtimes/run-service.server";
import { resetOperatorLeasesForTests } from "~/server/runtimes/operator-run.server";
import type { TaskFileEvent, TaskSchedule } from "~/schemas/task-file.schema";
import { cloneTimeoutMs } from "./git-clone-auth.server";
import {
  claimLeaseMs,
  cancelScheduledAction,
  fireDueSchedules,
  scheduleTaskAction,
  tasksWithUnresolvedSchedules,
} from "./schedule.server";

let ctx: TestDbContext;
let store: TestStore;

const actor = () => ({ userId: store.users.elif.id, label: "Elif Demir" });
const terminalStage = () => {
  const stages = getProject(store.db, store.slug)?.stages ?? [];
  return stages[stages.length - 1]!.id;
};
const schedules = (key: string): TaskSchedule[] =>
  readTaskFile({ projectSlug: store.slug, taskKey: key, dataRoot: store.dataRoot })!.parsed
    .frontmatter.schedules;
const timeline = (key: string): TaskFileEvent[] =>
  readTaskFile({ projectSlug: store.slug, taskKey: key, dataRoot: store.dataRoot })!.parsed
    .timeline;
const operatorRunCount = () =>
  startedRunSpecs().filter((s) => s.kind === "operator").length;
const dctx = () => ({ dataRoot: store.dataRoot });

/**
 * Poll until a schedule reaches an expected status (the F10-16 finalize is a
 * detached async step after the synchronous claim).
 *
 * The budget bounds a HANG, it does not measure anything: a green run returns
 * on the first poll. It is generous because what it waits on is a whole
 * `runOperator` — which since R19-1 provisions a repository checkout, i.e.
 * spawns a subprocess, before it starts the drive. A budget tuned to the
 * pre-R19-1 path is how this file's assertions started failing with
 * "never reached fired (last: claimed)" while the product was working.
 */
async function waitForSchedule(
  key: string,
  id: string,
  status: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (schedules(key).find((s) => s.id === id)?.status === status) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  const actual = schedules(key).find((s) => s.id === id)?.status;
  throw new Error(`schedule ${id} never reached ${status} (last: ${actual})`);
}

/**
 * A runtime adapter whose first `start` closes the task — the mid-tick
 * acceptance, made deterministic.
 *
 * The schedule runner claims every due occurrence first, then drives them one
 * awaited `runOperator` at a time. The in-flight turn is frequently the one
 * that calls `accept_completion`, so "the task went Done between the claim and
 * the next drive" is the ordinary case, not an exotic one. Everything under
 * test — the guard, the refusal, the retirement, the audit — is real; only the
 * moment the task closes is pinned.
 *
 * The close goes through `updateTaskFile` rather than a raw `writeTask`, and
 * that is what makes it deterministic rather than racy. Per-file writes are
 * FIFO on one lock: this one is enqueued from inside `start`, so it is already
 * queued when the runner's own finalize for the first occurrence enqueues
 * behind it — and the runner AWAITS that finalize before driving the second
 * occurrence. (A raw `writeTask` also loses outright: landing inside 100 ms of
 * the claim's write, `repairStaleRead` correctly reads it as a stale view of
 * the writer's own cache and undoes it.)
 */
class ClosesTheTaskOnFirstStart implements RuntimeAdapter {
  readonly backend = "claude" as const;
  readonly starts: RunSpec[] = [];
  closed: Promise<unknown> | null = null;
  readonly taskKey: string;

  constructor(taskKey: string) {
    this.taskKey = taskKey;
  }

  start(spec: RunSpec): RunHandle {
    this.starts.push(spec);
    if (this.starts.length === 1) {
      const stage = terminalStage();
      this.closed = updateTaskFile(
        { projectSlug: store.slug, taskKey: this.taskKey, dataRoot: store.dataRoot },
        (parsed) => {
          parsed.frontmatter.stage = stage;
        },
      );
    }
    // The run is deliberately never completed: the drive stays in flight, just
    // as it would while the next occurrence in the same tick is being driven.
    return { runId: spec.runId, interrupt() {} };
  }
}

/** A raw schedule object (bypasses the future-only guard) for fire tests. */
function rawSchedule(over: Partial<TaskSchedule> = {}): TaskSchedule {
  return {
    id: "sch_test1",
    action: "run-operator",
    dueAt: new Date(Date.now() - 60_000).toISOString(), // already due
    profileId: null,
    prompt: "re-check",
    createdBy: "u_elif",
    createdByLabel: "Elif",
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    status: "pending",
    firedAt: null,
    claimedAt: null,
    retries: 0,
    ...over,
  };
}

/**
 * Hermetic git for this file. R19-1 made `runOperator` provision a read-only
 * repository checkout before it starts a drive, and the fixture project has a
 * `repo` — so every scheduled re-run here started a REAL `git clone` against
 * github.com from a unit test. It failed (no credential), but only after a
 * network round trip, which is what made this file's two poll-based
 * assertions flap: `waitForSchedule` allows 4s and the clone regularly ate
 * more, so the occurrence was still `claimed` when the poll gave up, and the
 * drive that was still holding the operator lease made the NEXT test's run
 * queue instead of start.
 *
 * Point `https://github.com/` at a directory that does not exist and forbid
 * every protocol but `file`, so the clone fails instantly and OFFLINE. The
 * drive then takes `ensureOperatorRepoCheckout`'s `unavailable` arm — which is
 * the honest answer for a fixture project with no credential anyway — and the
 * schedule lifecycle, which is what this file is about, is what gets timed.
 */
const GIT_ENV_KEYS = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_ALLOW_PROTOCOL"] as const;
let savedGitEnv: Partial<Record<(typeof GIT_ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  // Project the project so getProject() has its stages (terminal-stage checks).
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  installFakeRuntime();

  const gitRoot = ctx.makeTempDir();
  const configPath = path.join(gitRoot, "gitconfig");
  writeFileSync(
    configPath,
    `[url "${path.join(gitRoot, "no-such-origin")}${path.sep}"]\n\tinsteadOf = https://github.com/\n`,
  );
  savedGitEnv = Object.fromEntries(GIT_ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.GIT_CONFIG_GLOBAL = configPath;
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  // Belt and braces: if the rewrite ever stopped applying, git must FAIL rather
  // than quietly reach github.com from a unit test.
  process.env.GIT_ALLOW_PROTOCOL = "file";
});
afterEach(() => {
  for (const key of GIT_ENV_KEYS) {
    const value = savedGitEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // The operator lease is module state: a test that leaves a drive in flight
  // (below) must not hand the next one a held lease.
  resetOperatorLeasesForTests();
  ctx.cleanup();
});

describe("scheduleTaskAction", () => {
  it("adds a pending schedule to the task file + projection", async () => {
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const s = await scheduleTaskAction(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", dueAt: new Date(Date.now() + 3_600_000).toISOString(), prompt: "check overnight" },
      actor(),
      dctx(),
    );
    expect(s.status).toBe("pending");
    // R22: no backend/autonomy pinned on the entry — the run resolves the live
    // deployed operator profile at fire time.
    expect(s).not.toHaveProperty("backend");
    expect(s).not.toHaveProperty("autonomy");
    expect(schedules("VIB-1")).toHaveLength(1);
    // Projected to schedules_json so the runner can find it.
    // SAFETY: the SELECT names one column, 0001_baseline declares
    // `task_projections.schedules_json` NOT NULL, and the rebuild above
    // projected VIB-1 — so the row exists and carries this shape.
    const row = store.db.prepare(`SELECT schedules_json FROM task_projections WHERE task_key=?`).get("VIB-1") as { schedules_json: string };
    expect(row.schedules_json).toContain('"status":"pending"');
    // Audited.
    expect(listAuditEvents(store.db).some((e) => e.action === "task.schedule.created")).toBe(true);
  });

  /**
   * T17 (pass 31) — UC-20, verified live: "Run operator in 5 min" wrote a
   * schedules entry carrying WHO scheduled it, and the task page shows that
   * attribution on the pending row. Nothing read `createdBy`/`createdByLabel`
   * back off a real `scheduleTaskAction` — the only occurrences in this file
   * are hand-written `rawSchedule()` literals, which never exercise the writer.
   * A schedule fires an autonomous operator turn minutes later; "who armed it"
   * is the audit trail for that turn.
   */
  it("T17: the created entry records WHO scheduled it (creator attribution round-trips)", async () => {
    // Canary: drop `createdByLabel: actor.label` (or swap `createdBy` for
    // "system") in scheduleTaskAction and this reads the wrong author back.
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await scheduleTaskAction(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
        prompt: "re-check the review queue",
      },
      actor(),
      dctx(),
    );

    // Read it off the FILE, not the returned object — the canonical store is
    // what the runner and the task page both read.
    const stored = schedules("VIB-1")[0]!;
    expect(stored.createdBy).toBe(store.users.elif.id);
    expect(stored.createdByLabel).toBe("Elif Demir");
    expect(stored.prompt).toBe("re-check the review queue");
    // …and the timeline names the human too, so the arming is visible in situ.
    expect(timeline("VIB-1").some((e) => e.actor?.kind === "human")).toBe(true);
  });

  it("R22: pins no autonomy or backend — the run resolves the live profile at fire time", async () => {
    // R22 supersedes R19-A's schedule-time clamp: the entry stores nothing to
    // clamp, so the fired run resolves AND clamps against whatever operator
    // profile is deployed when it fires (see runOperator → resolveOperatorAuthority).
    // Canary: re-add `autonomy`/`backend` to the stored entry in
    // schedule.server.ts and these read back a value instead of undefined.
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await scheduleTaskAction(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", dueAt: new Date(Date.now() + 3_600_000).toISOString() },
      actor(),
      dctx(),
    );
    const stored = schedules("VIB-1")[0]!;
    expect(stored).not.toHaveProperty("autonomy");
    expect(stored).not.toHaveProperty("backend");
  });

  it("run-agent (dynamic dispatch): pins the DEPLOYED profile id + prompt; an undeployed id is refused at create time", async () => {
    // Deploy `dev` so the picker has something real; the entry pins ONLY the
    // profile identity (R22's rule: backend/model/capabilities resolve from the
    // LIVE deployment at fire time — nothing else is stored).
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      agents: [
        {
          profileId: "dev",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist", name: "dev", role: "developer",
            backends: ["claude"], model: "sonnet", effort: "xhigh",
          },
        },
      ],
    });
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const s = await scheduleTaskAction(
      store.db,
      {
        projectSlug: store.slug, taskKey: "VIB-1",
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
        action: "run-agent", profileId: "dev", prompt: "re-run the flaky suite",
      },
      actor(),
      dctx(),
    );
    expect(s.status).toBe("pending");
    const stored = schedules("VIB-1")[0]!;
    expect(stored).toMatchObject({
      action: "run-agent",
      profileId: "dev",
      prompt: "re-run the flaky suite",
    });
    // Still nothing but identity pinned (the R22 canary, agent arm).
    expect(stored).not.toHaveProperty("backend");
    expect(stored).not.toHaveProperty("autonomy");
    // The timeline names the agent, not a generic re-run.
    expect(timeline("VIB-1").some((e) => e.text.includes("a **dev** run"))).toBe(true);

    // Create-time validation: a profile that is not deployed NOW cannot be
    // scheduled (the picker must not schedule a phantom).
    await expect(
      scheduleTaskAction(
        store.db,
        {
          projectSlug: store.slug, taskKey: "VIB-1",
          dueAt: new Date(Date.now() + 3_600_000).toISOString(),
          action: "run-agent", profileId: "ghost",
        },
        actor(),
        dctx(),
      ),
    ).rejects.toThrow(/"ghost" is not deployed/);
    // …and the agent arm without a profile at all is refused too.
    await expect(
      scheduleTaskAction(
        store.db,
        {
          projectSlug: store.slug, taskKey: "VIB-1",
          dueAt: new Date(Date.now() + 3_600_000).toISOString(),
          action: "run-agent",
        },
        actor(),
        dctx(),
      ),
    ).rejects.toThrow(/Pick which agent/);
  });

  it("rejects a past due time", async () => {
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await expect(
      scheduleTaskAction(store.db, { projectSlug: store.slug, taskKey: "VIB-1", dueAt: new Date(Date.now() - 1000).toISOString() }, actor(), dctx()),
    ).rejects.toThrow(/future/i);
  });

  it("rejects scheduling on a Done (terminal) task", async () => {
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-2", { stage: terminalStage() }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    await expect(
      scheduleTaskAction(store.db, { projectSlug: store.slug, taskKey: "VIB-2", dueAt: new Date(Date.now() + 3_600_000).toISOString() }, actor(), dctx()),
    ).rejects.toThrow(/Done/i);
  });
});

describe("cancelScheduledAction", () => {
  it("marks a pending schedule cancelled + audits", async () => {
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", schedules: [rawSchedule({ dueAt: new Date(Date.now() + 3_600_000).toISOString() })] }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const res = await cancelScheduledAction(store.db, { projectSlug: store.slug, taskKey: "VIB-1", scheduleId: "sch_test1" }, actor(), dctx());
    expect(res.cancelled).toBe(true);
    expect(schedules("VIB-1")[0]!.status).toBe("cancelled");
    expect(listAuditEvents(store.db).some((e) => e.action === "task.schedule.cancelled")).toBe(true);
    // Idempotent — a second cancel is a no-op.
    expect((await cancelScheduledAction(store.db, { projectSlug: store.slug, taskKey: "VIB-1", scheduleId: "sch_test1" }, actor(), dctx())).cancelled).toBe(false);
  });

  /**
   * T17 (pass 31) — cancel means the run NEVER HAPPENS, which the test above
   * does not check: it asserts the status flip and the audit row, both of which
   * a "cancel, then fire anyway" bug would leave intact. The occurrence here is
   * already DUE when it is cancelled — the only window where the distinction
   * between "marked cancelled" and "never fired" is observable, and the window
   * a human uses (they cancel because the run is about to start).
   */
  it("T17: a cancelled schedule is never fired — no run starts and firedAt stays null", async () => {
    // Canary: drop the `status !== "pending"` guard from the fire path's claim
    // (schedule.server.ts) and this fires a cancelled occurrence.
    writeTask(store.dataRoot, store.slug, {
      // Already due, not in the future: the cancel has to beat the tick.
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", schedules: [rawSchedule()] }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const res = await cancelScheduledAction(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", scheduleId: "sch_test1" },
      actor(),
      dctx(),
    );
    expect(res.cancelled).toBe(true);

    const tick = await fireDueSchedules(store.db, dctx());
    expect(tick.fired).toBe(0);

    const after = schedules("VIB-1")[0]!;
    expect(after.status).toBe("cancelled");
    // P11-75: a cancelled occurrence carries no fire timestamp — the field is
    // what every surface reads to say "this ran".
    expect(after.firedAt).toBeNull();
    expect(after.claimedAt).toBeNull();
    // And the thing that actually matters: no operator turn was started.
    expect(operatorRunCount()).toBe(0);
    expect(
      listAuditEvents(store.db).some((e) => e.action === "task.schedule.fired"),
    ).toBe(false);
  });
});

describe("fireDueSchedules", () => {
  it("fires a due pending schedule (marks fired + audits) and leaves a future one pending", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        schedules: [
          rawSchedule({ id: "sch_due" }),
          rawSchedule({ id: "sch_future", dueAt: new Date(Date.now() + 3_600_000).toISOString() }),
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.fired).toBe(1);
    expect(res.skipped).toBe(0);
    // F10-16 lifecycle: the occurrence is CLAIMED synchronously, then finalized
    // to `fired` after the detached operator enqueue completes. Wait for it.
    await waitForSchedule("VIB-1", "sch_due", "fired");
    const after = schedules("VIB-1");
    expect(after.find((s) => s.id === "sch_due")!.status).toBe("fired");
    expect(after.find((s) => s.id === "sch_due")!.firedAt).toBeTruthy();
    expect(after.find((s) => s.id === "sch_due")!.claimedAt).toBeNull();
    expect(after.find((s) => s.id === "sch_future")!.status).toBe("pending");
    const fired = listAuditEvents(store.db).filter((e) => e.action === "task.schedule.fired");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.details?.outcome).toBe("claimed");
    // FR39's terminal-stage refusal must not swallow the ordinary path: a due
    // schedule on a LIVE task really starts an operator turn.
    expect(operatorRunCount()).toBe(1);
    expect(timeline("VIB-1").some((e) => e.text.includes("no run was started"))).toBe(
      false,
    );

    // Idempotent — a second pass finds nothing due (already fired).
    expect((await fireDueSchedules(store.db, dctx())).fired).toBe(0);
  });

  /**
   * T17 (pass 31) — the claim protocol's whole reason for existing is that two
   * ticks can be in flight at once (the boot pass and the interval; an HMR
   * reload; a slow drive overlapping the next tick). Every existing test drives
   * `fireDueSchedules` SEQUENTIALLY, so the in-lock re-check
   * (`target.status !== "pending" && !isStaleClaim(target)`) has never been put
   * under the race it was written for. One occurrence must produce ONE claim
   * and ONE operator run, whichever tick wins.
   *
   * The trigger is asserted alongside it: a scheduled fire is not an ordinary
   * react, and the operator's prompt has to say so (B-WF3) — F11 this pass was
   * the operator confabulating "this scheduled run" on runs that were nothing
   * of the kind.
   */
  it("T17: two ticks racing one due occurrence claim it EXACTLY once — one operator run, one audit row", async () => {
    // Canary: drop the in-lock `status !== "pending"` re-check in the fire
    // path and both ticks claim, producing two operator runs.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        schedules: [rawSchedule({ id: "sch_raced", prompt: "re-check before standup" })],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const [first, second] = await Promise.all([
      fireDueSchedules(store.db, dctx()),
      fireDueSchedules(store.db, dctx()),
    ]);
    // Exactly one tick got the occurrence — either one may win.
    expect(first.fired + second.fired).toBe(1);

    await waitForSchedule("VIB-1", "sch_raced", "fired");
    expect(schedules("VIB-1")[0]!.claimedAt).toBeNull();
    const fired = listAuditEvents(store.db).filter((e) => e.action === "task.schedule.fired");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.details?.outcome).toBe("claimed");
    // ONE operator turn, not two — the cost of a lost race is a duplicate
    // autonomous run on the same task.
    expect(operatorRunCount()).toBe(1);

    // …and that run is a SCHEDULED one carrying the reason it was armed with.
    const spec = startedRunSpecs().find((s) => s.kind === "operator")!;
    expect(spec.prompt).toContain("SCHEDULED re-check");
    expect(spec.prompt).toContain("re-check before standup");
  });

  it("P14-RV-03: an ARCHIVED task never fires — the run is retired, not started", async () => {
    // R14-3 calls archive a terminal disposition, and the dialog promises the
    // task "leaves the board and the review queue". Archiving withdrew the
    // packet and the recommendations but never touched `schedules`, so the one
    // thing it failed to stop was the one thing that acts with NO human
    // watching (FR39): a scheduled operator re-run on abandoned work.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", {
        stage: "impl",
        archived: true,
        schedules: [rawSchedule({ id: "sch_arch" })],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.fired).toBe(0);
    expect(res.skipped).toBe(1);
    // The occurrence is RETIRED (recorded), not left pending to fire later.
    expect(schedules("VIB-9").find((s) => s.id === "sch_arch")!.status).not.toBe(
      "pending",
    );
    // The retirement IS audited (the occurrence must never vanish), but the
    // outcome names WHY it did not run — no operator was enqueued.
    const audit = listAuditEvents(store.db).filter(
      (e) => e.action === "task.schedule.fired",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.details).toMatchObject({ outcome: "skipped-archived" });
  });

  it("hunt 2026-08-29: an ARCHIVED PROJECT never fires — the freeze the fire path's operatorAuthorized bypassed", async () => {
    // The fire arm runs under `operatorAuthorized: true`, which skips
    // requireRunAgents and with it the F17/R6-3 archived-project read-only
    // freeze — so a pending schedule kept engaging profiles and launching
    // unattended runs on a project every interactive door refuses. The claim
    // now folds the project's own archived flag into mootness.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        schedules: [
          rawSchedule({ id: "sch_frozen", action: "run-agent", profileId: "dev" }),
        ],
      }),
    });
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      archived: true,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.fired).toBe(0);
    expect(res.skipped).toBe(1);
    expect(schedules("VIB-1").find((s) => s.id === "sch_frozen")!.status).toBe("fired");
    expect(startedRunSpecs()).toHaveLength(0);
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    // No engagement was written and the note names the PROJECT freeze.
    expect(file.parsed.frontmatter.engagements).toHaveLength(0);
    const note = file.parsed.timeline.find((e) =>
      /Scheduled action skipped/.test(e.text ?? ""),
    );
    expect(note?.text).toContain("project has been archived");
  });

  it("hunt 2026-08-29: a run-agent entry with NO profileId is retired as failed — never a surprise operator turn", async () => {
    // The fire arm used to select on `action === "run-agent" && profileId`, so
    // a hand-edited entry with a null profile fell through to the OPERATOR arm
    // under a claim note that announced an agent run.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        schedules: [
          rawSchedule({ id: "sch_noprof", action: "run-agent", profileId: null }),
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await fireDueSchedules(store.db, dctx());
    await waitForSchedule("VIB-1", "sch_noprof", "failed");
    expect(startedRunSpecs()).toHaveLength(0);
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    const note = file.parsed.timeline.find((e) =>
      /Scheduled action failed/.test(e.text ?? ""),
    );
    expect(note?.text).toContain("names no agent to run");
  });

  it("the claim lease outlives the slowest LEGITIMATE start (a clone), so a live drive is never re-driven", () => {
    // R19-1 put a repository clone inside `runOperator`, BEFORE the drive
    // starts: a healthy scheduled drive can now sit there for up to
    // `cloneTimeoutMs()`. A lease shorter than that declares that live drive
    // crashed, and the next tick re-drives the same occurrence — two unwatched
    // operator turns for one scheduled action, which is the exact thing FR39
    // exists to prevent. Pinned as a RELATIONSHIP, not a number, so raising
    // `VIBERR_GIT_CLONE_TIMEOUT_MS` cannot silently reintroduce the overlap.
    expect(claimLeaseMs()).toBeGreaterThan(cloneTimeoutMs());
  });

  it("F10-16: re-drives a STALLED claim (crash recovery — never lost)", async () => {
    // A claim whose lease expired = the enqueuing tick crashed before finalize.
    // Derived from the lease rather than a literal: this fixture used to say
    // "10 minutes", which encoded the OLD 5-minute lease and silently became a
    // FRESH claim — testing the opposite of its own name — the moment R19-1's
    // clone forced the lease up.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        schedules: [
          rawSchedule({
            id: "sch_stale",
            status: "claimed",
            claimedAt: new Date(Date.now() - claimLeaseMs() - 60_000).toISOString(),
          }),
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.fired).toBe(1); // the stalled claim was recovered and re-driven
    await waitForSchedule("VIB-1", "sch_stale", "fired");
  });

  /**
   * The lease outlasting a clone is only half the invariant. The drain is
   * SEQUENTIAL, so a later occurrence's drive begins long after the tick that
   * claimed it: with several due at once, its WAIT alone can outlast
   * claimLeaseMs(), and the next tick then reads the claim as crashed and
   * re-drives it — two unwatched turns for one occurrence. The lease must be
   * re-stamped as each drive STARTS, so it measures time-since-this-drive.
   */
  it("re-stamps a queued claim's lease when its own drive starts", async () => {
    const QUEUE_DELAY_MS = 40;
    const leaseOf = (key: string) =>
      schedules(key).find((s) => s.id.startsWith("sch_"))?.claimedAt ?? null;
    /** The lease the SECOND-driven task carried while it waited its turn. */
    let queuedLeaseBefore: string | null = null;
    /** The lease it carried once its own drive began. */
    let queuedLeaseAtStart: string | null = null;

    // Two TASKS, so the operator's per-task single flight cannot mask the
    // queueing this is about: one tick claims both, the drain drives them one
    // after the other. Which one goes first is not ours to decide, so the
    // assertions are written from the drive ORDER, not from task identity.
    class SlowFirstDrive implements RuntimeAdapter {
      readonly backend = "claude" as const;
      private starts = 0;
      private firstKey = "";
      start(spec: RunSpec): RunHandle {
        this.starts += 1;
        const key = spec.taskKey ?? "";
        if (this.starts === 1) {
          this.firstKey = key;
          const other = key === "VIB-9" ? "VIB-10" : "VIB-9";
          queuedLeaseBefore = leaseOf(other);
          // Hold the drain, synchronously, the way a slow clone would. The
          // defect IS a wait outlasting the lease, so the test needs a wait.
          const until = Date.now() + QUEUE_DELAY_MS;
          while (Date.now() < until) {
            /* deliberately blocking: the next occurrence must queue behind */
          }
        } else if (this.starts === 2 && key !== this.firstKey) {
          queuedLeaseAtStart = leaseOf(key);
        }
        return { runId: spec.runId, interrupt() {} };
      }
    }
    const adapter = new SlowFirstDrive();
    configureRunServiceForTests({ claude: adapter, codex: adapter });

    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", {
        stage: "impl",
        schedules: [rawSchedule({ id: "sch_a" })],
      }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-10", {
        stage: "impl",
        schedules: [rawSchedule({ id: "sch_b" })],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    expect((await fireDueSchedules(store.db, dctx())).fired).toBe(2);
    // The drain runs detached from the tick that claimed the batch, and drives
    // sequentially — wait for BOTH, or the second drive has not begun yet.
    await waitForSchedule("VIB-9", "sch_a", "fired");
    await waitForSchedule("VIB-10", "sch_b", "fired");

    expect(queuedLeaseBefore).not.toBeNull();
    expect(queuedLeaseAtStart).not.toBeNull();
    // Measured from ITS drive, not from the tick that claimed the batch —
    // otherwise a long queue burns the lease and a later tick re-drives an
    // occurrence that is already running.
    expect(Date.parse(queuedLeaseAtStart!)).toBeGreaterThanOrEqual(
      Date.parse(queuedLeaseBefore!) + QUEUE_DELAY_MS,
    );
  });

  it("F10-16: does NOT re-drive a FRESH claim (still within its lease)", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        schedules: [
          rawSchedule({
            id: "sch_fresh",
            status: "claimed",
            claimedAt: new Date().toISOString(),
          }),
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.fired).toBe(0); // an in-flight claim is left alone
    expect(schedules("VIB-1")[0]!.status).toBe("claimed");
  });

  it("retires a due schedule on a Done task WITHOUT running the operator (skipped-done)", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", { stage: terminalStage(), schedules: [rawSchedule({ id: "sch_done" })] }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.fired).toBe(0);
    expect(res.skipped).toBe(1);
    expect(schedules("VIB-3")[0]!.status).toBe("fired");
    const ev = listAuditEvents(store.db).find((e) => e.action === "task.schedule.fired");
    expect(ev!.details?.outcome).toBe("skipped-done");
  });

  it("F19-20: a task Done'd AFTER the tick's SELECT is retired, not run (the file decides, not the projection)", async () => {
    // The tick reads candidates from `task_projections`, then works through
    // them one awaited locked write at a time. An acceptance landing in that
    // gap left `row.stage` stale, and the in-lock re-check only looked at
    // `target.status` — which an acceptance never touches — so the occurrence
    // was CLAIMED and a real unwatched operator turn was enqueued against a
    // merged, Done task. FR39: never on a terminal stage.
    //
    // The projection row keeps the pre-accept stage while the FILE is already
    // Done — exactly the mid-tick state, reproduced without a race.
    //
    // Canary: re-derive `mootBecause` from `row.stage` instead of
    // `parsed.frontmatter.stage` and this fires an operator run.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-7", {
        stage: "impl",
        schedules: [rawSchedule({ id: "sch_toctou" })],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // …and now the task reaches Done in the file, with the projection unrebuilt.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-7", {
        stage: terminalStage(),
        schedules: [rawSchedule({ id: "sch_toctou" })],
      }),
    });
    // SAFETY: the SELECT names one column, 0001_baseline declares
    // `task_projections.stage` TEXT NOT NULL, and VIB-7 was projected above.
    expect(
      (
        store.db
          .prepare(`SELECT stage FROM task_projections WHERE task_key='VIB-7'`)
          .get() as { stage: string }
      ).stage,
    ).toBe("impl"); // the stale snapshot the tick will select

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.fired).toBe(0);
    expect(res.skipped).toBe(1);
    expect(schedules("VIB-7").find((s) => s.id === "sch_toctou")!.status).toBe("fired");
    const ev = listAuditEvents(store.db).find((e) => e.action === "task.schedule.fired");
    expect(ev!.details?.outcome).toBe("skipped-done");
    // No operator turn was enqueued against the closed task.
    expect(startedRunSpecs().some((s) => s.kind === "operator")).toBe(false);
  });

  it("F19-20: a task Done'd AFTER its occurrence was CLAIMED is refused at fire time — and the task SAYS no run started", async () => {
    // The claim-time re-check above closes the window it can see. This is the
    // one it cannot: both occurrences were claimed while the task was live, and
    // the FIRST drive's turn closes the task before the second is driven. FR39
    // says never on a terminal stage, so `runOperator` refuses — and the
    // occurrence's own record has to match, because the claim already wrote
    // "Scheduled action starting" to the timeline and an audit row saying
    // `claimed`. A `fired` occurrence whose only trace claims a run happened is
    // the dishonest outcome.
    //
    // Canary (both verified): drop the `refusedTerminal` handling in the
    // finalize block of fireDueSchedules and the note + the final audit row
    // disappear. Drop runOperator's `scheduled` guard and the same assertions
    // fail for the worse reason — nothing refuses, so the second occurrence is
    // silently QUEUED behind the live drive to start on its release, and its
    // record still says a run was started on a task that is Done.
    const adapter = new ClosesTheTaskOnFirstStart("VIB-8");
    configureRunServiceForTests({ claude: adapter, codex: adapter });

    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-8", {
        stage: "impl",
        schedules: [rawSchedule({ id: "sch_first" }), rawSchedule({ id: "sch_second" })],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const res = await fireDueSchedules(store.db, dctx());
    // Both were claimed: at claim time the file really was live.
    expect(res.fired).toBe(2);
    expect(res.skipped).toBe(0);
    await waitForSchedule("VIB-8", "sch_second", "fired");
    await adapter.closed; // surface a failed close rather than a silent one

    // Two scheduled occurrences, one operator turn — the second never started.
    expect(adapter.starts).toHaveLength(1);
    expect(
      timeline("VIB-8").some((e) => e.text.includes("no run was started")),
    ).toBe(true);

    // `listAuditEvents` is newest-first.
    const second = listAuditEvents(store.db).filter(
      (e) => e.action === "task.schedule.fired" && e.details?.scheduleId === "sch_second",
    );
    // The claim-time row (`claimed`) is true as of when it was written; the
    // occurrence's FINAL disposition is recorded too, so the trail and the
    // timeline agree about whether an agent turn happened.
    expect(second).toHaveLength(2);
    expect(second.at(-1)!.details).toMatchObject({ outcome: "claimed" });
    expect(second[0]!.details).toMatchObject({
      outcome: "skipped-done",
      refusedAtStart: true,
    });
  });

  it("B-WF3: the operator run says it is SCHEDULED and carries the note", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        schedules: [
          rawSchedule({ id: "sch_note", prompt: "re-check whether CI went green" }),
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    expect((await fireDueSchedules(store.db, dctx())).fired).toBe(1);
    await waitForSchedule("VIB-1", "sch_note", "fired");

    // The reason a human scheduled the re-run has to reach the turn: as a bare
    // `manual` trigger the operator could not tell a scheduled re-check from
    // someone pressing "Run operator", and the note existed only in a timeline
    // entry the prompt never pointed at.
    const prompt = startedRunSpecs().find((s) => s.kind === "operator")?.prompt ?? "";
    expect(prompt).toContain("SCHEDULED re-check");
    expect(prompt).toContain("re-check whether CI went green");
  });

  /**
   * Build the exact state a tick opens with when an acceptance (or an archive)
   * lands between the candidate SELECT and this row's claim: the FILE has moved
   * on, the projection row still shows the pre-move stage.
   */
  function withStaleProjection(
    key: string,
    after: { stage?: string; archived?: boolean },
  ): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(key, {
        stage: "impl",
        schedules: [rawSchedule({ id: "sch_race" })],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // Deliberately NOT reprojected — that staleness IS the defect.
    // `archived` is set only when asked: an absent key and `archived: false`
    // are different task files, and the absent one is the default shape.
    const patch: Partial<TaskFrontmatter> = {
      stage: after.stage ?? "impl",
      schedules: [rawSchedule({ id: "sch_race" })],
    };
    if (after.archived) patch.archived = true;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter(key, patch),
    });
  }

  it("F19-20/FR39: a task that reached Done AFTER the tick's snapshot never fires", async () => {
    // `row.stage` came from a SELECT taken at the top of the tick. An
    // acceptance landing before this row's turn left the runner deciding
    // mootness from a pre-accept stage, so it claimed the occurrence and
    // enqueued a real, unwatched operator turn on a task that is Done and
    // merged. FR39 says that never happens; the claim's own locked read now
    // decides.
    // Canary: restore `const isMoot = row.archived === 1 || row.stage ===
    // terminalFor(...)` and use it in the callback → fired becomes 1, an
    // operator run spec appears, and the audit outcome reads "claimed".
    withStaleProjection("VIB-4", { stage: terminalStage() });

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.fired).toBe(0);
    expect(res.skipped).toBe(1);
    expect(schedules("VIB-4")[0]!.status).toBe("fired");
    const ev = listAuditEvents(store.db).find((e) => e.action === "task.schedule.fired");
    expect(ev!.details?.outcome).toBe("skipped-done");
    expect(startedRunSpecs().some((s) => s.kind === "operator")).toBe(false);
  });

  it("F19-20: an archive that lands mid-tick retires the occurrence with its own words", async () => {
    // Archive survived the stale snapshot only because `setTaskArchived` ALSO
    // cancels the schedules in the file, so the `status !== "pending"` re-check
    // caught it. Both dimensions are now decided from the same locked read, and
    // the note says which one it was.
    // Canary: collapse the two copy branches into one → the "archived" copy
    // assertion fails; drop the archived clause from `mootNow` and rely on the
    // projection again → the outcome reads "claimed".
    withStaleProjection("VIB-5", { archived: true });

    const res = await fireDueSchedules(store.db, dctx());
    expect(res.skipped).toBe(1);
    const ev = listAuditEvents(store.db).find((e) => e.action === "task.schedule.fired");
    expect(ev!.details?.outcome).toBe("skipped-archived");
    const timeline = readTaskFile({
      projectSlug: store.slug, taskKey: "VIB-5", dataRoot: store.dataRoot,
    })!.parsed.timeline;
    const note = timeline.find((e) => /Scheduled action skipped/.test(e.text ?? ""))?.text ?? "";
    expect(note).toContain("has been archived");
    expect(note).not.toContain("is already Done");
  });
});

describe("tasksWithUnresolvedSchedules (B-WF5)", () => {
  it("selects on the schedule's own status, whatever the JSON formatting", () => {
    // A fired occurrence is not a candidate; a pending one is.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-4", {
        stage: "impl",
        schedules: [
          rawSchedule({
            id: "sch_fired",
            status: "fired",
            firedAt: new Date().toISOString(),
          }),
        ],
      }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-5", {
        stage: "impl",
        schedules: [rawSchedule({ id: "sch_pending" })],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    expect(tasksWithUnresolvedSchedules(store.db).map((r) => r.task_key)).toEqual([
      "VIB-5",
    ]);

    // Same data, formatted differently. The old scan matched the literal bytes
    // `"status":"pending"`, so one space after a colon silently dropped a due
    // schedule from every tick — it would never fire and never be reported.
    // SAFETY: as above — one NOT NULL column, on a task the rebuild projected.
    const raw = store.db
      .prepare(`SELECT schedules_json FROM task_projections WHERE task_key = 'VIB-5'`)
      .get() as { schedules_json: string };
    store.db
      .prepare(`UPDATE task_projections SET schedules_json = ? WHERE task_key = 'VIB-5'`)
      .run(JSON.stringify(JSON.parse(raw.schedules_json), null, 2));

    expect(tasksWithUnresolvedSchedules(store.db).map((r) => r.task_key)).toEqual([
      "VIB-5",
    ]);
  });

  it("ignores a task with no schedules at all", () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-6", { stage: "impl" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    expect(tasksWithUnresolvedSchedules(store.db)).toEqual([]);
  });
});
