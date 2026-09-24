/**
 * Settling and polling for a fire-and-forget effect, at the delivery tests'
 * timings: a 5 ms timer and a 2 s ceiling. Other suites poll at their own
 * cadence (25 ms, 50 ms with a nudge) and keep their own loops.
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
