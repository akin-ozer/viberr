import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * F20-8(a): the crash paths (`installCrashVisibilityHandlers`,
 * `loudlyShutDownOnStolenLock`) call `process.exit` on the line after they log, so
 * the normal async `process.stdout.write` is truncated and the death is silent.
 * `writeFatalSync` must instead put a complete line on the wire SYNCHRONOUSLY
 * before the exit. These pin that: it goes to fd 2 (stderr), it is one JSON line,
 * it serializes an Error's stack, and it never throws even when the write fails.
 */

const state = vi.hoisted(() => ({
  writes: [] as Array<{ fd: number; data: string }>,
  fail: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: (fd: number, data: unknown) => {
      if (state.fail) throw new Error("EBADF");
      const text = String(data);
      state.writes.push({ fd, data: text });
      return text.length;
    },
  };
});

const { writeFatalSync } = await import("./logger.server");

afterEach(() => {
  state.writes.length = 0;
  state.fail = false;
});

describe("writeFatalSync (F20-8a)", () => {
  it("writes exactly one synchronous error line to stderr (fd 2)", () => {
    writeFatalSync("FATAL: uncaught exception — shutting down");
    expect(state.writes).toHaveLength(1);
    const { fd, data } = state.writes[0];
    expect(fd).toBe(2); // stderr, not the async stdout the truncated logger uses
    expect(data.endsWith("\n")).toBe(true);
    const record = JSON.parse(data.trimEnd());
    expect(record.level).toBe("error");
    expect(record.msg).toBe("FATAL: uncaught exception — shutting down");
    expect(typeof record.time).toBe("string");
  });

  it("serializes an Error field down to its message and stack", () => {
    const err = new Error("boom");
    writeFatalSync("FATAL: crash", { err });
    const record = JSON.parse(state.writes[0].data.trimEnd());
    expect(record.err.name).toBe("Error");
    expect(record.err.message).toBe("boom");
    expect(record.err.stack).toContain("boom");
  });

  it("never throws — and still emits a line — when fields are not serializable", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => writeFatalSync("FATAL: crash", { circular })).not.toThrow();
    const record = JSON.parse(state.writes[0].data.trimEnd());
    expect(record.loggingError).toBe("fields were not serializable");
    expect(record.msg).toBe("FATAL: crash");
  });

  it("swallows a failed write rather than masking the fatal it reports", () => {
    state.fail = true;
    expect(() => writeFatalSync("FATAL: crash")).not.toThrow();
    expect(state.writes).toHaveLength(0);
  });
});
