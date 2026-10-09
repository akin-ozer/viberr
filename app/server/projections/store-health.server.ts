/**
 * Ruling 22 (F37-37) and ruling 22 (F37-38): what viberr remembers about a
 * projection that stopped tracking its own files.
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
 * Ruling 22 made the latch PER FILE. My first version held one slot, so any
 * later rebuild that wrote cleared it — and ninety seconds after the corruption
 * was repaired, a transient `disk I/O error` left SHOP-4's row reading "waiting
 * on you" while its file said `waiting: agent`, with health back to `ok`
 * because some OTHER file had projected fine in between. A fault is a fact
 * about one file, and it is only over when THAT file projects again.
 *
 * Still a latch, never a probe: no `PRAGMA integrity_check` on an 87MB file
 * every health poll, and no alarm that outlives its fault.
 */

/** What is remembered while one file's projection is failing. */
export interface ProjectionFault {
  /** When the most recent failing rebuild of this file happened. */
  at: string;
  /** The canonical file whose projection could not be rebuilt. */
  sourcePath: string;
  /** The store's own words — `database disk image is malformed`, `CHECK
   *  constraint failed`, `disk I/O error`. */
  message: string;
  /** How many rebuilds of THIS file have failed since it last projected, so
   *  the reading separates one flaky write from a file that cannot project. */
  failures: number;
}

/**
 * Upper bound on remembered files. A store that is failing everything would
 * otherwise grow this map with every watcher tick. Past the cap the count is
 * still honest (`projectionFaultCount`), which is the number that matters when
 * it is that large.
 */
const MAX_TRACKED = 200;

const FAULT_KEY = Symbol.for("viberr.projectionFaults");

/** The process-global slot, a registry symbol so a dev-server HMR reload of
 *  this module keeps the same latch (the operator lease's own pattern). */
interface FaultHost {
  [FAULT_KEY]?: Map<string, ProjectionFault>;
}

function faults(): Map<string, ProjectionFault> {
  // SAFETY: `FAULT_KEY` is a registry symbol under a viberr-namespaced key that
  // only this module reads or writes, so the slot holds either the map this
  // function put there or nothing at all.
  const cache = globalThis as FaultHost;
  let map = cache[FAULT_KEY];
  if (!map) {
    map = new Map<string, ProjectionFault>();
    cache[FAULT_KEY] = map;
  }
  return map;
}

/** Record a rebuild that could not be written. Called from the ONE catch that
 *  swallows it, so the reading and the log line always agree. `message` is the
 *  store's own text, read off the caught error at that catch — this takes the
 *  sentence, not the throwable, so nothing unparsed crosses the boundary. */
export function recordProjectionFault(sourcePath: string, message: string): void {
  const map = faults();
  const prior = map.get(sourcePath);
  if (!prior && map.size >= MAX_TRACKED) {
    // Drop the OLDEST tracked file rather than refusing the new one: a
    // Map keeps insertion order, and the newest failure is the one a reader is
    // most likely to be looking at.
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(sourcePath, {
    at: new Date().toISOString(),
    sourcePath,
    message,
    failures: (prior?.failures ?? 0) + 1,
  });
}

/** THIS file projected: its fault is over. Ruling 22 — a success here says
 *  nothing about any other file, and must not clear one. */
export function clearProjectionFault(sourcePath: string): void {
  faults().delete(sourcePath);
}

/** Every standing fault, newest last (insertion order). */
function projectionFaults(): ProjectionFault[] {
  return [...faults().values()];
}

/** How many files currently cannot be projected. */
export function projectionFaultCount(): number {
  return faults().size;
}

/** The most recently failing file, or null when the mirror tracks every file
 *  it has been asked to rebuild. */
export function projectionFault(): ProjectionFault | null {
  const all = projectionFaults();
  return all.length > 0 ? all[all.length - 1]! : null;
}

/** Tests only: forget every fault. */
export function resetProjectionFaultsForTests(): void {
  faults().clear();
}
