import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { logger } from "~/server/logging/logger.server";

/**
 * Ruling 174: a settled run leaves no live process behind, on either backend.
 *
 * The vendor CLIs defeat a process-group kill on their own (measured on the
 * pinned Claude CLI, 2026-09-11). Claude Code starts every Bash command in a
 * session of its own (`detached`), so a `sleep 600 &` left by a finished
 * command, or the command a SIGKILLed CLI was still running, sits in no group
 * Viberr can name, reparented to init; the Playwright browser MCP launches
 * Chromium the same way. What all of them keep is the ENVIRONMENT they were
 * started with: the CLI's env reaches its shells, and Claude merges it under
 * each stdio MCP declaration's own `env`. So every run carries
 * {@link RUN_MARKER_ENV} = its run id (`startRun`), the Codex adapter exports
 * it to the model's shell and to each stdio server explicitly (its shell policy
 * inherits only "core" names), and the settle sweep below finds a run's
 * processes by it. The Claude CLI additionally leads its own process group
 * (`claude-spawn.server.ts`), so the MCP servers it starts in that group are
 * reached by one group signal even if one of them scrubbed its environment.
 *
 * A process that removes the marker from its own environment escapes the
 * sweep. This is cleanup of what a run forgot, not a containment boundary: the
 * container and the server-owned delivery gate are (ruling 93).
 */
export const RUN_MARKER_ENV = "VIBERR_RUN_ID";

/** The one variable a run's processes carry so the sweep can find them. */
export function runMarkerEnv(runId: string) {
  return { [RUN_MARKER_ENV]: runId };
}

/**
 * Ruling 376: the completion compaction runs AFTER the run's own CLI has
 * exited, under the same credential overlay — and the settle sweep that reaps
 * a run's leftovers by its marker five seconds after that exit would reap the
 * compaction too (live, 2026-09-21: both epilogues died by SIGTERM). So the
 * epilogue carries its own marker value, which the settle sweep does not
 * target and the boot sweep does (`compactionRunId` is listed beside every
 * run id it settles), and the run service reaps it itself once the
 * compaction has answered.
 */
export function compactionRunId(runId: string): string {
  return `${runId}:compaction`;
}

export function compactionMarkerEnv(runId: string) {
  return { [RUN_MARKER_ENV]: compactionRunId(runId) };
}

/** How long a signalled process gets between SIGTERM and SIGKILL — the grace
 *  the Claude CLI gives its own shells before it escalates. */
export const RUN_REAP_GRACE_MS = 5_000;

/** `pid → run id` for this user's live processes whose environment carries the
 *  marker of one of `runIds`. */
export type FindRunProcesses = (
  runIds: ReadonlySet<string>,
) => Promise<Map<number, string>>;

/** `process.kill`'s shape: a negative pid addresses a process group, signal 0
 *  only probes. Throws when there is no such process (or group). */
export type SignalProcess = (pid: number, signal: NodeJS.Signals | 0) => void;

const MARKER_PREFIX = `${RUN_MARKER_ENV}=`;

function markedRun(entry: string, runIds: ReadonlySet<string>): string | null {
  if (!entry.startsWith(MARKER_PREFIX)) return null;
  const id = entry.slice(MARKER_PREFIX.length);
  return runIds.has(id) ? id : null;
}

/**
 * Linux (the image): `/proc/<pid>/environ` is the environment a process was
 * started with. Another user's is unreadable (EACCES) and a process that exits
 * mid-scan is gone (ENOENT); both are skipped, and so is a zombie, whose
 * environ reads empty.
 */
async function findOnLinux(runIds: ReadonlySet<string>): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return found;
  }
  await Promise.all(
    entries.map(async (name) => {
      if (!/^\d+$/.test(name)) return;
      const pid = Number(name);
      if (pid === process.pid) return;
      let environ: string;
      try {
        environ = await readFile(`/proc/${name}/environ`, "latin1");
      } catch {
        return;
      }
      for (const entry of environ.split("\0")) {
        const id = markedRun(entry, runIds);
        if (id) {
          found.set(pid, id);
          return;
        }
      }
    }),
  );
  return found;
}

/**
 * macOS (a development host): `ps -E` appends the environment of this user's
 * own processes to their command line. The marker is a single token (a run id
 * holds no whitespace), so it is matched as a whole token.
 */
async function findOnDarwin(runIds: ReadonlySet<string>): Promise<Map<number, string>> {
  const found = new Map<number, string>();
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      "ps",
      ["-A", "-E", "-ww", "-o", "pid=,command="],
      { maxBuffer: 64 * 1024 * 1024 },
      (error, out) => resolve(error ? "" : out),
    );
  });
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    const pidText = match?.[1];
    const rest = match?.[2];
    if (pidText === undefined || rest === undefined) continue;
    const pid = Number(pidText);
    if (pid === process.pid) continue;
    for (const token of rest.split(/\s+/)) {
      const id = markedRun(token, runIds);
      if (id) {
        found.set(pid, id);
        break;
      }
    }
  }
  return found;
}

/** The live processes carrying one of `runIds`' markers. Other platforms have
 *  no environment scan here and find none. */
export const findRunProcesses: FindRunProcesses = async (runIds) => {
  if (runIds.size === 0) return new Map();
  if (process.platform === "linux") return findOnLinux(runIds);
  if (process.platform === "darwin") return findOnDarwin(runIds);
  return new Map();
};

/** What one sweep signalled. */
export interface ReapReport {
  /** Processes (and at most one group) sent SIGTERM. */
  terminated: number;
  /** Of those, still alive after the grace and sent SIGKILL. */
  killed: number;
}

export interface ReapTargets {
  /** The runs whose marked processes are swept. */
  runIds: readonly string[];
  /** A process-group leader whose whole group is signalled as well — the
   *  Claude CLI, which leads its own group. */
  groupLeader?: number | null;
}

export interface ReapDeps {
  find?: FindRunProcesses;
  signal?: SignalProcess;
  graceMs?: number;
}

/** The sweep as the adapters and boot recovery call it (injectable). */
export type ReapRunProcesses = (targets: ReapTargets) => Promise<ReapReport>;

const realSignal: SignalProcess = (pid, signal) => {
  process.kill(pid, signal);
};

/** True when the signal was delivered, false when there was no such target. */
function send(signal: SignalProcess, pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    signal(pid, sig);
    return true;
  } catch {
    return false;
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * SIGTERM everything the runs left alive, wait the grace, then SIGKILL what is
 * still there. The second pass re-scans rather than reusing the first list, so
 * a pid the kernel recycled in between is never signalled: only a process that
 * still carries the marker is.
 */
export async function reapRunProcesses(
  targets: ReapTargets,
  deps: ReapDeps = {},
): Promise<ReapReport> {
  const find = deps.find ?? findRunProcesses;
  const signal = deps.signal ?? realSignal;
  const graceMs = deps.graceMs ?? RUN_REAP_GRACE_MS;
  const runIds = new Set(targets.runIds);
  const leader = targets.groupLeader ?? null;
  const group = leader !== null && leader > 1 ? -leader : null;

  const marked = await find(runIds);
  let terminated = 0;
  if (group !== null && send(signal, group, "SIGTERM")) terminated += 1;
  for (const pid of marked.keys()) {
    if (send(signal, pid, "SIGTERM")) terminated += 1;
  }
  if (terminated === 0) return { terminated: 0, killed: 0 };

  await pause(graceMs);
  let killed = 0;
  if (group !== null && send(signal, group, 0) && send(signal, group, "SIGKILL")) {
    killed += 1;
  }
  for (const pid of (await find(runIds)).keys()) {
    if (send(signal, pid, "SIGKILL")) killed += 1;
  }
  logger.info("reaped the processes a settled run left behind", {
    runIds: [...runIds],
    terminated,
    killed,
  });
  return { terminated, killed };
}
