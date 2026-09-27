/**
 * Settling and polling for a fire-and-forget effect, at the three cadences the
 * suites share: the delivery tests' (`flush`, `waitFor`: a 5 ms timer and a
 * 2 s ceiling), the runtime suites' `settle` (thirty zero-delay timer turns)
 * and the agent suites' `pollUntil` (every 25 ms, answering whether the
 * condition held). A suite at another cadence (50 ms with a nudge) keeps its
 * own loop.
 */

/** `autoInvokeOperator` is fire-and-forget (`void`): let its microtasks
 *  settle, then one 5 ms timer turn. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));
}

/**
 * Wait for a fire-and-forget effect to actually land.
 *
 * A fixed `flush()` cannot express this: `autoInvokeOperator` awaits a
 * dynamic import before it ever reaches `runOperator`, and on a cold module
 * graph those resolve well past a 5ms timer — so the fixed wait passed or
 * failed depending on what the rest of the suite had already imported. That is
 * a test that reports module-load timing, not behavior. Poll the condition
 * instead, with a ceiling that still fails loudly if the effect never happens.
 */
export async function waitFor(
  cond: () => boolean,
  what: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Thirty zero-delay timer turns: long enough for a run's fire-and-forget
 *  completion chain to come to rest before a runtime suite reads what it
 *  left. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Poll `cond` every 25 ms until it holds or `timeoutMs` passes, and answer
 *  whether it held; unlike `waitFor`, a miss is the caller's to assert. */
export async function pollUntil(
  cond: () => boolean,
  timeoutMs = 6_000,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (cond()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}
