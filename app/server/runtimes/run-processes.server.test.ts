import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  findRunProcesses,
  reapRunProcesses,
  RUN_MARKER_ENV,
  runMarkerEnv,
  type SignalProcess,
} from "./run-processes.server";

/**
 * Ruling 174: the settle sweep finds a run's processes by the marker in their
 * environment and signals them, because the vendor CLIs put what they start in
 * sessions of their own. These tests use REAL processes — the thing under test
 * is the kernel's answer (`/proc` on Linux, `ps -E` on macOS) — each carrying a
 * run id no real run can have.
 */

const HOLD = "setInterval(() => {}, 1000)";
/** Installs its SIGTERM handler BEFORE it says it is ready. */
const STUBBORN =
  "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)";

const children: ChildProcess[] = [];
const loosePids: number[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  for (const pid of loosePids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

let seq = 0;
function testRunId(): string {
  seq += 1;
  return `run_test-sweep-${process.pid}-${seq}`;
}

/** A held node process, its own group leader, carrying `runId`'s marker (or none). */
function hold(runId: string | null, script = HOLD): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (runId) Object.assign(env, runMarkerEnv(runId));
  const child = spawn(process.execPath, ["-e", script], {
    env,
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });
  children.push(child);
  return child;
}

/** A shell that backgrounds a held node process and prints its pid: the
 *  `sleep 600 &` shape. With `wait` the shell stays (a group of two); without
 *  it the shell exits and the held process is orphaned, reparented to init. */
function background(runId: string | null, opts: { keepShell: boolean }) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_BIN: process.execPath, HOLD };
  if (runId) Object.assign(env, runMarkerEnv(runId));
  const script = opts.keepShell
    ? '"$NODE_BIN" -e "$HOLD" & echo $!; wait'
    : '"$NODE_BIN" -e "$HOLD" & echo $!';
  const shell = spawn("/bin/sh", ["-c", script], {
    env,
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });
  children.push(shell);
  const heldPid = new Promise<number>((resolve, reject) => {
    shell.stdout?.once("data", (chunk: Buffer) => {
      const pid = Number(chunk.toString().trim());
      if (Number.isInteger(pid) && pid > 1) {
        loosePids.push(pid);
        resolve(pid);
      } else reject(new Error(`no pid in ${JSON.stringify(chunk.toString())}`));
    });
  });
  return { shell, heldPid };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls until `pid` is gone (an orphan is reaped by init, not by us). */
async function gone(pid: number, withinMs = 3000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

/** Polls until the scan sees `pid` (a fresh process's env is readable at once
 *  on Linux; macOS's `ps` can lag a spawn by a moment). */
async function seen(runId: string, pid: number, withinMs = 3000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if ((await findRunProcesses(new Set([runId]))).get(pid) === runId) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

const scans = process.platform === "linux" || process.platform === "darwin";

describe("runMarkerEnv", () => {
  it("names the run by the one variable the sweep reads", () => {
    expect(runMarkerEnv("run_abc")).toEqual({ [RUN_MARKER_ENV]: "run_abc" });
    expect(RUN_MARKER_ENV).toBe("VIBERR_RUN_ID");
  });
});

describe.skipIf(!scans)("findRunProcesses (real processes)", () => {
  it("finds a live process by its run's marker, and only that run's", async () => {
    const runId = testRunId();
    const other = testRunId();
    const mine = hold(runId);
    const theirs = hold(other);
    const unmarked = hold(null);
    expect(await seen(runId, mine.pid ?? -1)).toBe(true);

    const found = await findRunProcesses(new Set([runId]));
    expect(found.get(mine.pid ?? -1)).toBe(runId);
    expect(found.has(theirs.pid ?? -1)).toBe(false);
    expect(found.has(unmarked.pid ?? -1)).toBe(false);
    expect(found.has(process.pid)).toBe(false);
  });

  it("finds nothing for no run ids without scanning", async () => {
    expect((await findRunProcesses(new Set())).size).toBe(0);
  });
});

describe.skipIf(!scans)("reapRunProcesses (real processes)", () => {
  it("SIGTERMs every marked process and leaves another run's and an unmarked one alive", async () => {
    const runId = testRunId();
    const mine = hold(runId);
    const theirs = hold(testRunId());
    const unmarked = hold(null);
    expect(await seen(runId, mine.pid ?? -1)).toBe(true);
    const exited = once(mine, "exit");

    const report = await reapRunProcesses({ runIds: [runId] }, { graceMs: 200 });

    const [, signal] = await exited;
    expect(signal).toBe("SIGTERM");
    expect(report).toEqual({ terminated: 1, killed: 0 });
    expect(alive(theirs.pid ?? -1)).toBe(true);
    expect(alive(unmarked.pid ?? -1)).toBe(true);
  });

  it("SIGKILLs a marked process still alive after the grace", async () => {
    const runId = testRunId();
    const stubborn = hold(runId, STUBBORN);
    await once(stubborn.stdout ?? stubborn, "data");
    expect(await seen(runId, stubborn.pid ?? -1)).toBe(true);
    const exited = once(stubborn, "exit");

    const report = await reapRunProcesses({ runIds: [runId] }, { graceMs: 150 });

    const [, signal] = await exited;
    expect(signal).toBe("SIGKILL");
    expect(report).toEqual({ terminated: 1, killed: 1 });
  });

  it("reaches the `&` a finished command left behind — orphaned to init, in no group of ours", async () => {
    // The live finding (2026-09-11): Claude Code's Bash tool runs each command
    // in its own session, so `sleep 600 &` outlives the command, the CLI and
    // any group kill. Only its environment still says whose it is.
    const runId = testRunId();
    const { shell, heldPid } = background(runId, { keepShell: false });
    const pid = await heldPid;
    await once(shell, "exit");
    expect(alive(pid)).toBe(true);
    expect(await seen(runId, pid)).toBe(true);

    const report = await reapRunProcesses({ runIds: [runId] }, { graceMs: 200 });

    expect(report.terminated).toBe(1);
    expect(await gone(pid)).toBe(true);
  });

  it("signals a group leader's whole group, marker or not", async () => {
    const { shell, heldPid } = background(null, { keepShell: true });
    const pid = await heldPid;
    const shellExited = once(shell, "exit");

    const report = await reapRunProcesses(
      { runIds: [], groupLeader: shell.pid ?? null },
      { graceMs: 200 },
    );

    await shellExited;
    expect(report.terminated).toBe(1);
    expect(await gone(pid)).toBe(true);
  });
});

describe("reapRunProcesses (scripted scan)", () => {
  function recorder() {
    const sent: [number, NodeJS.Signals | 0][] = [];
    const signal: SignalProcess = (pid, sig) => {
      sent.push([pid, sig]);
    };
    return { sent, signal };
  }

  it("signals nothing and does not wait when nothing is found", async () => {
    const { sent, signal } = recorder();
    const report = await reapRunProcesses(
      { runIds: ["run_x"] },
      { find: async () => new Map(), signal, graceMs: 60_000 },
    );
    expect(report).toEqual({ terminated: 0, killed: 0 });
    expect(sent).toEqual([]);
  });

  it("re-scans before SIGKILL, so a process that died in the grace is not signalled again", async () => {
    const { sent, signal } = recorder();
    const scans = [new Map([[111, "run_x"]]), new Map<number, string>()];
    const report = await reapRunProcesses(
      { runIds: ["run_x"] },
      { find: async () => scans.shift() ?? new Map(), signal, graceMs: 1 },
    );
    expect(sent).toEqual([[111, "SIGTERM"]]);
    expect(report).toEqual({ terminated: 1, killed: 0 });
  });

  it("SIGKILLs only what the second scan still finds, and a group only if it still has members", async () => {
    const sent: [number, NodeJS.Signals | 0][] = [];
    let groupAlive = true;
    const signal: SignalProcess = (pid, sig) => {
      if (pid === -50 && sig === 0 && !groupAlive) throw new Error("ESRCH");
      sent.push([pid, sig]);
      if (pid === -50 && sig === "SIGTERM") groupAlive = false;
    };
    const scans = [
      new Map([
        [111, "run_x"],
        [222, "run_x"],
      ]),
      new Map([[222, "run_x"]]),
    ];
    const report = await reapRunProcesses(
      { runIds: ["run_x"], groupLeader: 50 },
      { find: async () => scans.shift() ?? new Map(), signal, graceMs: 1 },
    );
    expect(sent).toEqual([
      [-50, "SIGTERM"],
      [111, "SIGTERM"],
      [222, "SIGTERM"],
      [222, "SIGKILL"],
    ]);
    expect(report).toEqual({ terminated: 3, killed: 1 });
  });
});
