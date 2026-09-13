/**
 * Ruling 217 (F37-37): the latch that remembers a projection which stopped
 * tracking the files.
 *
 * Viberr's whole claim is that the markdown IS the record and SQLite is a
 * mirror of it. The mirror is rebuilt by `rebuildPath`, whose catch logs
 * "projection rebuild failed" and moves on — deliberately, because one bad file
 * must not take the process down. Live on pass 37 the store went to
 * `SQLITE_CORRUPT` under the process: every rebuild threw, every task page
 * 500ed, a run sat `running` for twenty minutes with no process behind it, and
 * `/resources/health` answered `{"ok":true,"status":"ok","degraded":[]}` for
 * twelve minutes straight. Viberr knew — it wrote the error to the log each
 * time — and had nowhere to put the fact.
 *
 * `boot.server.ts` already says this about the CHECK-constraint case it probes
 * for: "the task stops projecting and its row goes stale, with nothing on any
 * surface saying why." That is this module's whole reason to exist, for every
 * cause rather than one.
 *
 * The latch is a process fact, not a stored one: it says "the mirror cannot
 * currently be rebuilt from the files", and the next rebuild that succeeds
 * clears it. That makes it self-healing and costs nothing per health poll — no
 * `PRAGMA integrity_check` on an 87MB file every few seconds, and no alarm that
 * outlives the fault.
 */

/** What the latch holds while a projection rebuild is failing. */
export interface ProjectionFault {
  /** When the most recent failing rebuild happened. */
  at: string;
  /** The canonical file whose projection could not be rebuilt. */
  sourcePath: string;
  /** The store's own words — `database disk image is malformed`, `CHECK
   *  constraint failed`, `disk I/O error`. */
  message: string;
  /** How many rebuilds have failed since the last success, so the reading
   *  separates one bad file from a store that stopped accepting writes. */
  failures: number;
}

const FAULT_KEY = Symbol.for("viberr.projectionFault");

/** The process-global slot, a registry symbol so a dev-server HMR reload of
 *  this module keeps the same latch (the lease's own pattern). */
interface FaultHost {
  [FAULT_KEY]?: ProjectionFault | null;
}

function host(): FaultHost {
  // SAFETY: `FAULT_KEY` is a registry symbol under a viberr-namespaced key that
  // only this module reads or writes, so the slot holds either the value this
  // module put there or nothing at all.
  return globalThis as FaultHost;
}

/** Record a rebuild that could not be written. Called from the ONE catch that
 *  swallows it, so the reading and the log line always agree. `message` is the
 *  store's own text, read off the caught error at that catch — this takes the
 *  sentence, not the throwable, so nothing unparsed crosses the boundary. */
export function recordProjectionFault(sourcePath: string, message: string): void {
  const prior = host()[FAULT_KEY] ?? null;
  host()[FAULT_KEY] = {
    at: new Date().toISOString(),
    sourcePath,
    message,
    failures: (prior?.failures ?? 0) + 1,
  };
}

/** A rebuild wrote successfully: the mirror tracks the files again. */
export function clearProjectionFault(): void {
  host()[FAULT_KEY] = null;
}

/** The standing fault, or null when the last rebuild succeeded. */
export function projectionFault(): ProjectionFault | null {
  return host()[FAULT_KEY] ?? null;
}
