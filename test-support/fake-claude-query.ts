import type { ClaudeQuery } from "~/server/runtimes/claude-runtime.server";

/**
 * A Claude SDK query as the adapter consumes it: an async generator of SDK
 * messages plus `interrupt`. Yields the given messages, then completes.
 *
 * It fakes the SDK query the REAL Claude adapter reads, one layer below
 * `fake-runtime.ts` (which replaces the whole adapter). The `ClaudeQuery`
 * import is type-only, so a test that guards what loads at module scope
 * (harness-hermeticity) loads nothing new by importing this.
 */
export function fakeClaudeQuery(...messages: unknown[]): ClaudeQuery {
  const gen = (async function* (): AsyncGenerator<unknown, void> {
    for (const message of messages) yield message;
  })();
  return Object.assign(gen, { interrupt: async () => {} });
}
