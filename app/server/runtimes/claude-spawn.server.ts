import { EventEmitter } from "node:events";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { realSignal, type SignalProcess } from "./run-processes.server";
import {
  launchedCommand,
  launchedSignal,
  type AgentLaunch,
} from "./agent-isolation.server";

/**
 * Ruling 142: the Claude CLI leads its own process group.
 *
 * The SDK's own local spawn is not detached, so its abort ladder signals the
 * CLI alone and the stdio MCP servers the CLI started in its group outlive a
 * SIGKILLed CLI (measured 2026-09-11: an orphaned server, ppid 1, in the dead
 * CLI's group). Through `spawnClaudeCodeProcess` (sdk.d.ts) Viberr spawns the
 * CLI `detached`, so its pid is its group id, and every signal the SDK sends —
 * its SIGTERM→SIGKILL close ladder and its kill-all when this server exits —
 * reaches the whole group through {@link ClaudeCli.process}'s `kill`.
 *
 * Two things the SDK's local spawn did are kept, because the SDK does neither
 * for a custom spawn: it reads nothing but stdin and stdout from the returned
 * process, so the CLI's stderr is drained here and its last 2 KB kept (the tail
 * the SDK appends to an exit error, which is how a missing resume session is
 * classified); and `exit` is delivered only once stderr has closed, bounded
 * like the SDK's, so that tail is complete when the stream fails.
 */

/** What the SDK hands `spawnClaudeCodeProcess` (its `SpawnOptions`). `signal`
 *  is the SDK's FORWARDED abort, which fires only after its stdin-EOF grace
 *  (sdk.d.ts), so handing it to `spawn` is safe. */
export interface ClaudeSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

/** What the SDK reads and drives: its `SpawnedProcess` interface. */
export interface ClaudeSpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: "exit", listener: ExitListener): void;
  on(event: "error", listener: ErrorListener): void;
  once(event: "exit", listener: ExitListener): void;
  once(event: "error", listener: ErrorListener): void;
  off(event: "exit", listener: ExitListener): void;
  off(event: "error", listener: ErrorListener): void;
}

/** The slice of a spawned child this module drives: what `spawn` returns,
 *  narrowed so a test can hand in a stand-in. */
export interface CliChild {
  readonly pid?: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: ExitListener): this;
  on(event: "error", listener: ErrorListener): this;
}

/** `spawn`, as this module calls it (injectable for tests). */
export type SpawnCli = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => CliChild;

const realSpawn: SpawnCli = (command, args, options): ChildProcessWithoutNullStreams =>
  spawn(command, args, options);

/** One run's CLI, as the adapter holds it. */
export interface ClaudeCli {
  /** Handed to the SDK. */
  readonly process: ClaudeSpawnedProcess;
  /** The CLI's pid, which is also its process-group id; null when the spawn
   *  itself failed. */
  readonly pid: number | null;
  /** The last 2 KB of the CLI's stderr, trimmed. */
  stderrTail(): string;
  /** Signal the CLI's whole group; falls back to the CLI alone when the group
   *  is gone. True when a signal was delivered. */
  signalGroup(signal: NodeJS.Signals): boolean;
  /** Resolves true once the CLI has exited (stderr drained), false when
   *  `timeoutMs` passes first. */
  exited(timeoutMs: number): Promise<boolean>;
}

/** The SDK's own stderr window (`qC` in sdk.mjs) and its drain bound (`zFe`). */
const STDERR_TAIL_CHARS = 2048;
const STDERR_DRAIN_MS = 200;

function keepTail(text: string): string {
  return text.length > 2 * STDERR_TAIL_CHARS ? text.slice(-STDERR_TAIL_CHARS) : text;
}

/**
 * Ruling 139: with `launch`, the CLI runs as its person's own OS user. What is
 * spawned is then the launcher (`viberr-launch`), detached so it leads the
 * group Viberr signals, with the SDK's command resolved to an absolute path in
 * `VIBERR_LAUNCH_EXEC`, the uid in `VIBERR_LAUNCH_UID` and the SDK's argv passed
 * through untouched. The launcher forks, drops to the uid in the child and
 * relays every signal it receives to the agent's own group — which the server
 * cannot signal itself, the processes being another user's. So the server's
 * SIGKILL becomes SIGUSR2, the launcher's "kill the whole group": a SIGKILL of
 * the launcher alone would orphan the agent's processes under a uid the
 * server cannot reach.
 */
export function spawnClaudeCli(
  request: ClaudeSpawnRequest,
  spawnImpl: SpawnCli = realSpawn,
  signalImpl: SignalProcess = realSignal,
  launch: AgentLaunch | null = null,
): ClaudeCli {
  const spawned = launch
    ? launchedCommand(launch, request.command, request.env)
    : { command: request.command, env: request.env };
  const options: SpawnOptionsWithoutStdio = {
    env: spawned.env,
    detached: true,
    windowsHide: true,
  };
  if (request.cwd) options.cwd = request.cwd;
  if (request.signal) options.signal = request.signal;
  // Node's own abort kill (the SDK's forwarded signal) is SIGTERM, which the
  // launcher relays as it is.
  const child = spawnImpl(spawned.command, request.args, options);
  const pid = child.pid ?? null;

  const decoder = new StringDecoder("utf8");
  let tail = "";
  let stderrClosed = false;
  let exitArgs: [number | null, NodeJS.Signals | null] | null = null;
  let delivered = false;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  const events = new EventEmitter();

  const deliverExit = () => {
    if (delivered || !exitArgs) return;
    delivered = true;
    if (drainTimer) clearTimeout(drainTimer);
    events.emit("exit", ...exitArgs);
  };
  child.stderr.on("data", (chunk: Buffer) => {
    tail = keepTail(tail + decoder.write(chunk));
  });
  // A failed stderr read loses only the tail; the run is the stream's business.
  child.stderr.on("error", () => {});
  child.stderr.once("close", () => {
    tail = keepTail(tail + decoder.end());
    stderrClosed = true;
    deliverExit();
  });
  child.once("exit", (code, signal) => {
    exitArgs = [code, signal];
    if (stderrClosed) return deliverExit();
    drainTimer = setTimeout(deliverExit, STDERR_DRAIN_MS);
    drainTimer.unref?.();
  });
  child.on("error", (error) => {
    // Re-emitted only to a listener: an unheard `error` on an EventEmitter
    // throws, and the SDK attaches its own before a spawn error can arrive.
    if (events.listenerCount("error") > 0) events.emit("error", error);
  });

  const signalGroup = (requested: NodeJS.Signals): boolean => {
    const signal = launch ? launchedSignal(requested) : requested;
    if (pid !== null && pid > 1) {
      try {
        signalImpl(-pid, signal);
        return true;
      } catch {
        // The group is gone (or never formed): the CLI alone, below.
      }
    }
    return child.kill(signal);
  };

  const proc: ClaudeSpawnedProcess = {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill: signalGroup,
    on: (event: "exit" | "error", listener: ExitListener | ErrorListener) => {
      events.on(event, listener);
    },
    once: (event: "exit" | "error", listener: ExitListener | ErrorListener) => {
      events.once(event, listener);
    },
    off: (event: "exit" | "error", listener: ExitListener | ErrorListener) => {
      events.off(event, listener);
    },
  };

  return {
    process: proc,
    pid,
    stderrTail: () => keepTail(tail).slice(-STDERR_TAIL_CHARS).trim(),
    signalGroup,
    exited: (timeoutMs) =>
      new Promise((resolve) => {
        if (delivered) return resolve(true);
        const timer = setTimeout(() => {
          events.off("exit", onExit);
          resolve(false);
        }, timeoutMs);
        timer.unref?.();
        const onExit = () => {
          clearTimeout(timer);
          resolve(true);
        };
        events.once("exit", onExit);
      }),
  };
}
