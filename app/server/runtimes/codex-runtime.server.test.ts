import { describe, expect, it } from "vitest";
import type { EmittedLine, RunExit, RunSpec } from "./adapter.server";
import { createCodexAdapter, type CodexClient, type CodexThread } from "./codex-runtime.server";

/** A fake Codex client: yields the given ThreadEvents, honors abort signal. */
function fakeCodex(events: unknown[]): { factory: () => CodexClient } {
  const makeThread = (): CodexThread => ({
    id: "0199a1f3-4c02-7d31",
    async runStreamed(_input, turnOptions) {
      const signal = turnOptions?.signal;
      const gen = (async function* () {
        for (const e of events) {
          if (signal?.aborted) throw new DOMException("aborted", "AbortError");
          yield e;
          // Yield to the event loop so an abort between events takes effect.
          await new Promise((r) => setTimeout(r, 0));
        }
      })();
      return { events: gen };
    },
  });
  const client: CodexClient = {
    startThread: () => makeThread(),
    resumeThread: () => makeThread(),
  };
  return { factory: () => client };
}

const SPEC: RunSpec = {
  runId: "r1",
  projectSlug: "viberr-core",
  taskKey: "VIB-1",
  threadId: "primary",
  role: "Primary specialist",
  kind: "primary",
  backend: "codex",
  model: "gpt-5.4-codex",
  prompt: "advise",
  workdir: "/tmp/x",
  autonomous: true,
};

async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("codex adapter (SDK, injected fake client)", () => {
  it("streams ThreadEvents → EmittedLine and finishes on turn.completed", async () => {
    const events = [
      { type: "thread.started", thread_id: "0199abc" },
      { type: "turn.started" },
      { type: "item.completed", item: { type: "agent_message", text: "advice" } },
      { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 } },
    ];
    const { factory } = fakeCodex(events);
    const adapter = createCodexAdapter({ codexFactory: factory });
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) });
    await drain();

    expect(lines.length).toBe(4);
    expect(JSON.parse(lines[0]!.raw).type).toBe("thread.started");
    expect(lines[0]!.facts.sessionId).toBe("0199abc");
    expect(exit).toMatchObject({ outcome: "finished", simulated: false, effectiveBackend: "codex" });
  });

  it("errors on turn.failed", async () => {
    const { factory } = fakeCodex([
      { type: "turn.started" },
      { type: "turn.failed", error: { message: "model stream ended" } },
    ]);
    const adapter = createCodexAdapter({ codexFactory: factory });
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: () => {}, onExit: (e) => (exit = e) });
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
  });

  it("errors when the stream ends with no turn.completed", async () => {
    const { factory } = fakeCodex([{ type: "thread.started", thread_id: "x" }, { type: "turn.started" }]);
    const adapter = createCodexAdapter({ codexFactory: factory });
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: () => {}, onExit: (e) => (exit = e) });
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
  });

  it("interrupt() aborts the signal and ends interrupted", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ type: "item.completed", item: { type: "agent_message", text: "m" + i } }));
    const { factory } = fakeCodex([{ type: "thread.started", thread_id: "x" }, ...many]);
    const adapter = createCodexAdapter({ codexFactory: factory });
    let exit: RunExit | null = null;
    const handle = adapter.start(SPEC, { onLine: () => {}, onExit: (e) => (exit = e) });
    // Let it start, then interrupt mid-stream.
    await new Promise((r) => setTimeout(r, 1));
    handle.interrupt("u1", "arda");
    await drain();
    expect(exit).toMatchObject({ outcome: "interrupted" });
  });
});
