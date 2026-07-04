/**
 * Per-key in-process async mutex. Serializes writers touching the same file
 * (task.md event appends, project.md counter bumps) so concurrent actions
 * never interleave read-modify-write cycles.
 *
 * In-process is sufficient: the app is a single-node monolith (architecture
 * decision) — external editors are reconciled by the watcher, not locked out.
 * The chain map survives dev-server HMR via a well-known global symbol.
 */

const MUTEX_KEY = Symbol.for("viberr.fileMutex");

function getChains(): Map<string, Promise<unknown>> {
  const cache = globalThis as unknown as Record<
    symbol,
    Map<string, Promise<unknown>> | undefined
  >;
  let chains = cache[MUTEX_KEY];
  if (!chains) {
    chains = new Map();
    cache[MUTEX_KEY] = chains;
  }
  return chains;
}

/**
 * Runs `fn` exclusively for `key` (typically an absolute file path).
 * Errors propagate to the caller but never break the chain.
 */
export async function withFileLock<T>(
  key: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const chains = getChains();
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn); // run regardless of predecessor outcome
  // The stored tail swallows errors so later waiters are not poisoned.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}
