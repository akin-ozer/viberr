import { describe, expect, it, vi } from "vitest";
import type { EmittedLine, RunExit, RunSpec } from "./adapter.server";
import { startSimulated, type SimulatedScript } from "./simulated-runtime.server";
import { projectEnvelope } from "./wire-format.server";

const SPEC: RunSpec = {
  runId: "r1", projectSlug: "p", taskKey: "T", threadId: "primary",
  role: "R", kind: "primary", backend: "claude", model: "claude-sonnet-4-5",
  prompt: "go", workdir: "/tmp", autonomous: true,
};

/** Fake timers that run scheduled callbacks immediately (in order). */
function immediateTimers() {
  const queue: (() => void)[] = [];
  const timers = {
    setTimeout: ((fn: () => void) => {
      queue.push(fn);
      return queue.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
  };
  const flush = () => {
    let n = 0;
    while (queue.length && n < 1000) {
      const fn = queue.shift()!;
      fn();
      n += 1;
    }
  };
  return { timers, flush };
}

describe("simulated runtime — spec-conformant wire lines", () => {
  it("emits authentic wire JSON per line (raw re-projects to the same display)", () => {
    const script: SimulatedScript = {
      lines: [
        { t: "1", ev: "init", tag: "system·init", text: "session x" },
        { t: "2", ev: "tool", tag: "tool_use", name: "Bash", text: "npm test" },
        { t: "3", ev: "result", tag: "result", text: "done", stats: { dur: 1, api: 1, turns: 1, cost: 0.1, in: 5, cached: 2, out: 3 } },
      ],
      sessionId: "sess-abc", backend: "claude", model: "claude-sonnet-4-5", op: false, instant: true,
    };
    const { timers, flush } = immediateTimers();
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    startSimulated(SPEC, { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) }, script, timers);
    flush();

    expect(lines).toHaveLength(3);
    // Every raw line is valid wire JSON.
    for (const l of lines) {
      const parsed = JSON.parse(l.raw);
      expect(parsed.type).toBeTruthy();
    }
    expect(JSON.parse(lines[0]!.raw)).toMatchObject({ type: "system", subtype: "init", session_id: "sess-abc" });
    // Facts come from the normalized envelope (real usage, no fabrication).
    const resultLine = lines[2]!;
    expect(resultLine.facts.costUsd).toBe(0.1);
    expect(exit).toMatchObject({ outcome: "finished", simulated: true });
  });

  it("grows live usage + turns across content lines toward the result total", () => {
    const script: SimulatedScript = {
      lines: [
        { t: "1", ev: "init", tag: "system·init", text: "session x" },
        { t: "2", ev: "text", tag: "assistant", text: "working on it" },
        { t: "3", ev: "tool", tag: "tool_use", name: "Bash", text: "npm test" },
        { t: "4", ev: "result", tag: "result", text: "done", stats: { dur: 1, api: 1, turns: 4, cost: 0.1, in: 1000, cached: 0, out: 400 } },
      ],
      sessionId: "s", backend: "claude", model: "claude-sonnet-4-5", op: false, instant: true,
    };
    const { timers, flush } = immediateTimers();
    const lines: EmittedLine[] = [];
    startSimulated(SPEC, { onLine: (l) => lines.push(l), onExit: () => {} }, script, timers);
    flush();

    const out = lines.map((l) => l.facts.usage?.output_tokens ?? 0);
    // Output tokens climb monotonically across the stream instead of staying 0.
    expect(out[0]!).toBeGreaterThan(0);
    expect(out[1]!).toBeGreaterThan(out[0]!);
    expect(out[2]!).toBeGreaterThanOrEqual(out[1]!);
    // The result line still carries the authoritative total.
    expect(lines[3]!.facts.usage!.output_tokens).toBe(400);
    expect(lines[3]!.facts.turns).toBe(4);
    // Turns climb too (start at ≥1, end at the result's total).
    expect(lines[0]!.facts.turns ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("operator run stamps the task-store MCP into its init envelope", () => {
    const script: SimulatedScript = {
      lines: [{ t: "1", ev: "init", tag: "system·init", text: "op session" }],
      sessionId: "op-sid", backend: "claude", model: "m", op: true, instant: true,
    };
    const { timers, flush } = immediateTimers();
    const lines: EmittedLine[] = [];
    startSimulated({ ...SPEC, kind: "operator" }, { onLine: (l) => lines.push(l), onExit: () => {} }, script, timers);
    flush();
    expect(lines[0]!.raw).toContain("viberr-task-store");
  });

  it("a result with an error subtype ends the run in error", () => {
    const script: SimulatedScript = {
      lines: [{ t: "1", ev: "result", tag: "result", text: "halt", stats: { subtype: "error_during_execution", dur: 1, api: 1, turns: 1, cost: 0, in: 0, cached: 0, out: 0 } }],
      sessionId: "s", backend: "claude", model: "m", op: false, instant: true,
    };
    const { timers, flush } = immediateTimers();
    let exit: RunExit | null = null;
    startSimulated(SPEC, { onLine: () => {}, onExit: (e) => (exit = e) }, script, timers);
    flush();
    expect(exit).toMatchObject({ outcome: "error" });
  });

  it("interrupt stops the drip and ends interrupted (no exit envelope forced)", () => {
    vi.useFakeTimers();
    try {
      const script: SimulatedScript = {
        lines: Array.from({ length: 10 }, (_, i) => ({ t: String(i), ev: "text" as const, tag: "assistant", text: "l" + i })),
        sessionId: "s", backend: "claude", model: "m", op: false, keepRunning: true,
      };
      const emitted: EmittedLine[] = [];
      let exit: RunExit | null = null;
      const handle = startSimulated(SPEC, { onLine: (l) => emitted.push(l), onExit: (e) => (exit = e) }, script);
      vi.advanceTimersByTime(3000); // a few lines drip
      const before = emitted.length;
      handle.interrupt("u1", "arda");
      vi.advanceTimersByTime(10000);
      expect(exit).toMatchObject({ outcome: "interrupted" });
      // No further lines after interrupt.
      expect(emitted.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keepRunning script leaves the run open (no exit) after its lines drain", () => {
    const script: SimulatedScript = {
      lines: [{ t: "1", ev: "text", tag: "assistant", text: "hi" }],
      sessionId: "s", backend: "claude", model: "m", op: false, keepRunning: true, instant: true,
    };
    const { timers, flush } = immediateTimers();
    let exit: RunExit | null = null;
    startSimulated(SPEC, { onLine: () => {}, onExit: (e) => (exit = e) }, script, timers);
    flush();
    expect(exit).toBeNull();
  });
});
