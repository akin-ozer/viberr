/**
 * Real-process liveness for tests that spawn processes and assert the kernel's
 * answer (ruling 142: the Claude CLI spawn and the settle sweep).
 *
 * Signal 0 probes existence without delivering anything, and any throw reads
 * as not alive: these tests probe processes they spawned themselves. The
 * product's `isProcessAlive` (db/data-root-lock.server.ts) counts `EPERM` as
 * alive because it guards another user's lock holder, so it is a different
 * predicate and stays apart.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls every 25 ms until `pid` is gone (an orphan is reaped by init, not by
 *  us), up to `withinMs`; true once it is. */
export async function gone(pid: number, withinMs = 3000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}
