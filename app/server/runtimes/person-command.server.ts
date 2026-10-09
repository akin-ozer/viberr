import { spawn, type ChildProcessByStdio } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import type { Readable, Writable } from "node:stream";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { errorMessage } from "~/shared/errors";
import {
  agentGitLaunchFor,
  launchEnv,
  launchedSignal,
  launchesAgents,
  type AgentLaunch,
} from "./agent-isolation.server";
import { reapRunProcesses } from "./run-processes.server";

/**
 * A command Viberr itself runs for a task, as the task's person.
 *
 * Two things do this: the project's gates (ruling 139) and the page capture
 * (ruling 194). Both run something an agent wrote (a repository's build, a
 * delivered page's scripts), so neither may run as the server where isolation
 * is on (ruling 139): the command goes through the launcher as the task
 * owner's agent uid, in a process group of its own, and is killed with its
 * group at its timeout. This module is the one home of that: who it runs as
 * ({@link taskOwnerLaunch}), how it runs and is stopped
 * ({@link runPersonCommand}), and how much of its output is kept
 * ({@link BoundedLog}).
 */

/** Output kept per command: the first part and the last part, the middle cut. */
const LOG_HEAD_BYTES = 256 * 1024;
const LOG_TAIL_BYTES = 1792 * 1024;
/** After a timeout's SIGTERM, how long a command has before its group is killed. */
const KILL_GRACE_MS = 5_000;
/** The leftover sweep after a command exits (daemons it forked). */
const REAP_GRACE_MS = 2_000;

/**
 * Who a task's own command runs as: the task owner's agent uid through the
 * launcher, or (isolation off) the server's own user. Throws when isolation is
 * on and nobody can be named, with `refusal` as the sentence the caller keeps:
 * ruling 139, never the server instead.
 */
export function taskOwnerLaunch(
  db: DatabaseSync,
  ownerUserId: string | null,
  dataRoot: string | undefined,
  refusal: string,
): AgentLaunch | null {
  if (!launchesAgents()) return null;
  if (!ownerUserId) {
    throw new AppError({ code: ERROR_CODES.RUN_UNAVAILABLE, status: 409, userMessage: refusal });
  }
  return agentGitLaunchFor(db, ownerUserId, dataRoot);
}

/** The combined output of one command, bounded: the head and the tail are
 *  kept, the middle is cut with a marker saying how much. */
class BoundedLog {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private cut = 0;

  push(chunk: Buffer): void {
    let rest = chunk;
    if (this.headBytes < LOG_HEAD_BYTES) {
      const room = LOG_HEAD_BYTES - this.headBytes;
      const take = rest.subarray(0, room);
      this.head.push(take);
      this.headBytes += take.length;
      rest = rest.subarray(take.length);
    }
    if (rest.length === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    while (this.tailBytes > LOG_TAIL_BYTES && this.tail.length > 0) {
      const first = this.tail[0]!;
      const over = this.tailBytes - LOG_TAIL_BYTES;
      if (first.length <= over) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.cut += first.length;
      } else {
        this.tail[0] = first.subarray(over);
        this.tailBytes -= over;
        this.cut += over;
      }
    }
  }

  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    if (this.cut === 0) return head + tail;
    return `${head}\n[… ${this.cut} bytes of output cut …]\n${tail}`;
  }
}

export interface PersonCommandInput {
  /** The executable: an absolute path, as the launcher execs only those. */
  file: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  launch: AgentLaunch | null;
  env: Record<string, string>;
  /** `VIBERR_RUN_ID` for the leftover sweep. */
  marker: string;
  /** The line the output gains when the command is stopped at its timeout. */
  timeoutNote: string;
  /** What the command reads on its standard input, which is then closed;
   *  absent, it has none. For what is too large to be an argument: the
   *  kernel bounds one argument (131,072 bytes on Linux) and the arguments
   *  and the environment together. */
  stdin?: string;
}

export interface PersonCommandOutcome {
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  output: string;
  /** The process could not be spawned at all. */
  spawnError: string | null;
}

/** `file args` as `launch` (or as the server), its own process group, killed
 *  with its group at the timeout. Never rejects. */
export function runPersonCommand(input: PersonCommandInput): Promise<PersonCommandOutcome> {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = new BoundedLog();
    let settled = false;
    const settle = (outcome: Omit<PersonCommandOutcome, "wallMs" | "output">): void => {
      if (settled) return;
      settled = true;
      resolve({ ...outcome, wallMs: Date.now() - started, output: log.text() });
    };
    let child: ChildProcessByStdio<Writable | null, Readable, Readable>;
    try {
      const file = input.launch ? input.launch.launcher : input.file;
      const env = input.launch ? launchEnv(input.launch, input.file, input.env) : input.env;
      const options = { cwd: input.cwd, env, detached: true, windowsHide: true };
      child =
        input.stdin === undefined
          ? spawn(file, [...input.args], { ...options, stdio: ["ignore", "pipe", "pipe"] })
          : spawn(file, [...input.args], { ...options, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      settle({ exitCode: null, timedOut: false, spawnError: errorMessage(error) });
      return;
    }
    if (child.stdin) {
      // A command that ends without reading closes the pipe under the write.
      child.stdin.on("error", () => {});
      child.stdin.end(input.stdin);
    }
    const pid = child.pid ?? null;
    const signalGroup = (requested: NodeJS.Signals): void => {
      const signal = input.launch ? launchedSignal(requested) : requested;
      if (pid !== null && pid > 1) {
        try {
          process.kill(-pid, signal);
          return;
        } catch {
          // The group is gone; the process alone, below.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    };
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      log.push(Buffer.from(input.timeoutNote));
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    }, input.timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => log.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => log.push(chunk));
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});
    let spawnError: string | null = null;
    child.on("error", (error) => {
      spawnError = errorMessage(error);
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      settle({ exitCode: null, timedOut: false, spawnError });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      // A process a signal ended reports the shell's convention, 128 + n, so
      // "killed" never reads as "did not start".
      const signalled =
        signal !== null ? 128 + (osConstants.signals[signal] ?? 0) : null;
      const exitCode = timedOut ? null : (code ?? signalled);
      void reapRunProcesses(
        { runIds: [input.marker], groupLeader: pid, launched: input.launch !== null },
        { graceMs: REAP_GRACE_MS },
      )
        .catch(() => undefined)
        .finally(() => settle({ exitCode, timedOut, spawnError }));
    });
  });
}
