import { getEnv } from "../config/env.server";
import {
  DataRootLockedError,
  acquireDataRootLock,
  forceDataRootTakeover,
  type AcquireDataRootLockOptions,
  type DataRootLock,
} from "./data-root-lock.server";

/**
 * The single-writer lock (B-FD1) for the MAINTENANCE CLIs.
 *
 * `bootServer()` has taken the data-root lock since F18-5, so a second SERVER
 * is refused — but `npm run seed`, `npm run seed:demo` and `npm run rescan`
 * opened the same `state/projection.sqlite` and wrote it with no coordination
 * at all. That is the same two-writers-one-root shape that has already cost
 * this project a WAL: a host process and a container sharing `docker-data`
 * silently lost org tables (users, encrypted PATs, notifications), and
 * `PRAGMA integrity_check` passed both before and after, because it does not
 * detect lost transactions. The invariant was enforced against a second
 * server, not against a second WRITER — and the two commands most likely to be
 * run during an incident were the two that bypassed it (deployment.md §First
 * run recommends `docker compose exec app npm run seed` on a live container;
 * runbook.md offers `npm run rescan` as a live remedy).
 *
 * Every writing CLI now goes through {@link runWithDataRootWriterLock}: it
 * takes the same lock with the same semantics (no weakening of the inode +
 * bootId ownership proof, the same evidence-based staleness rules, the same
 * `VIBERR_FORCE_DATA_ROOT_LOCK` takeover boot honours) and fails CLOSED with a
 * message that names the current holder.
 *
 * READ-ONLY CLIs deliberately do NOT take it (`npm run backup`,
 * `npm run store:check`, `npm run keys -- status`): a reader is not a second
 * writer, and refusing to back up a running instance would defeat the point.
 * They open the projection read-only instead — see db/backup.server.ts.
 */

/** stdout/exit seam so a test can observe the refusal without dying. */
export interface CliRefusalIo {
  write(message: string): void;
  exit(code: number): never;
}

const PROCESS_REFUSAL_IO: CliRefusalIo = {
  write: (message) => {
    process.stderr.write(message);
  },
  exit: (code) => process.exit(code),
};

export interface CliLockOptions {
  /** Defaults to the configured data root. */
  dataRoot?: string;
  /**
   * A one-line "…and here is the safe way to do this while the app is up",
   * appended to the refusal. Only some commands have one (the in-app re-scan
   * does; there is no in-app equivalent of the product seed).
   */
  alternative?: string;
  io?: CliRefusalIo;
  /** Test seam for the env-driven takeover; production reads the env. */
  force?: boolean;
}

/**
 * The text an operator reads on stderr when a CLI refuses. Built from the
 * lock's own refusal — which already names the holder (pid, host, since) and
 * both remedies — with the command that was refused on the front, because the
 * lock's message says "Refusing to boot" and nobody was booting.
 */
export function cliLockRefusalMessage(
  command: string,
  error: DataRootLockedError,
  alternative?: string,
): string {
  return [
    `${command} refused to run: it would be a SECOND writer on this data root.`,
    error.message,
    ...(alternative ? [alternative] : []),
    "",
  ].join("\n");
}

/**
 * Acquire the writer lock for a CLI, or throw {@link DataRootLockedError}.
 * `releaseOnExit` is on: the lock file is removed when the command finishes,
 * however it finishes.
 */
export function acquireCliWriterLock(
  options: Pick<CliLockOptions, "dataRoot" | "force"> = {},
): DataRootLock {
  const request: AcquireDataRootLockOptions = {
    force: options.force ?? forceDataRootTakeover(),
    releaseOnExit: true,
  };
  // Naming a root at all is the caller's choice; left off, the lock resolves the
  // configured one itself.
  if (options.dataRoot) request.dataRoot = options.dataRoot;
  return acquireDataRootLock(request);
}

/**
 * Run `body` holding the data-root writer lock, or refuse and exit non-zero.
 *
 * The lock is released before returning (and by the `exit` hook if `body`
 * throws or the process is killed), so a failed CLI never leaves a lock behind
 * for the next boot to refuse.
 */
export async function runWithDataRootWriterLock<T>(
  command: string,
  body: () => T | Promise<T>,
  options: CliLockOptions = {},
): Promise<T> {
  const io = options.io ?? PROCESS_REFUSAL_IO;
  // Both are forwarded only when the caller set them: an absent `force` must
  // reach the env-driven default, not overwrite it with `undefined`.
  const request: Pick<CliLockOptions, "dataRoot" | "force"> = {};
  if (options.dataRoot) request.dataRoot = options.dataRoot;
  if (options.force !== undefined) request.force = options.force;
  let lock: DataRootLock;
  try {
    lock = acquireCliWriterLock(request);
  } catch (error) {
    if (!(error instanceof DataRootLockedError)) throw error;
    io.write(cliLockRefusalMessage(command, error, options.alternative));
    return io.exit(1);
  }
  try {
    return await body();
  } finally {
    lock.release();
  }
}

/** The data root these CLIs operate on (resolved once, for messages). */
export function cliDataRoot(): string {
  return getEnv().VIBERR_DATA_ROOT;
}
