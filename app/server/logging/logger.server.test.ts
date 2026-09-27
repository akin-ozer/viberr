import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { writeFatalSync, type SyncWriter } from "./logger.server";

/**
 * F20-8(a): the crash paths (`installCrashVisibilityHandlers`,
 * `loudlyShutDownOnStolenLock`) call `process.exit` on the line after they log, so
 * the normal async `process.stdout.write` is truncated and the death is silent.
 * `writeFatalSync` must instead put a complete line on the wire SYNCHRONOUSLY
 * before the exit. These pin that: it goes to fd 2 (stderr), it is one JSON line,
 * it serializes an Error's stack, and it never throws even when the write fails.
 */

/** One captured `sync` call: the descriptor it targeted and the line. */
interface SyncWrite {
  fd: number;
  data: string;
}

let writes: SyncWrite[] = [];

/** Stands in for `node:fs`'s `writeSync` on the real sink parameter. */
const capture: SyncWriter = (fd, data) => {
  writes.push({ fd, data });
  return data.length;
};

/** A descriptor already closed during teardown — the write throws EBADF. */
const closedFd: SyncWriter = () => {
  throw new Error("EBADF");
};

/** A field JSON.stringify cannot serialize — it points back at itself. A type
 *  alias, not an interface, so it passes as a `LogValue` object without a cast
 *  (only a type alias gets the implicit index signature). */
type SelfReferential = {
  self?: SelfReferential;
};

/** The line as a reader of fd 2 has to take it — parsed off the wire, not
 *  hand-decoded. `err` carries the Error `assign` flattens; `loggingError`
 *  appears only on the unserializable-fields fallback. */
const fatalLineSchema = z.object({
  level: z.string(),
  time: z.string(),
  msg: z.string(),
  err: z
    .object({ name: z.string(), message: z.string(), stack: z.string() })
    .optional(),
  loggingError: z.string().optional(),
});

function fatalLine(write: SyncWrite) {
  return fatalLineSchema.parse(JSON.parse(write.data.trimEnd()));
}

beforeEach(() => {
  writes = [];
});

describe("writeFatalSync (F20-8a)", () => {
  it("writes exactly one synchronous error line to stderr (fd 2)", () => {
    writeFatalSync("FATAL: uncaught exception — shutting down", undefined, capture);
    expect(writes).toHaveLength(1);
    const { fd, data } = writes[0]!;
    expect(fd).toBe(2); // stderr, not the async stdout the truncated logger uses
    expect(data.endsWith("\n")).toBe(true);
    const record = fatalLine(writes[0]!);
    expect(record.level).toBe("error");
    expect(record.msg).toBe("FATAL: uncaught exception — shutting down");
    expect(record.time).toEqual(expect.any(String));
  });

  it("serializes an Error field down to its message and stack", () => {
    const err = new Error("boom");
    writeFatalSync("FATAL: crash", { err }, capture);
    const record = fatalLine(writes[0]!);
    expect(record.err!.name).toBe("Error");
    expect(record.err!.message).toBe("boom");
    expect(record.err!.stack).toContain("boom");
  });

  it("never throws — and still emits a line — when fields are not serializable", () => {
    const circular: SelfReferential = {};
    circular.self = circular;
    expect(() =>
      writeFatalSync("FATAL: crash", { circular }, capture),
    ).not.toThrow();
    const record = fatalLine(writes[0]!);
    expect(record.loggingError).toBe("fields were not serializable");
    expect(record.msg).toBe("FATAL: crash");
  });

  it("swallows a failed write rather than masking the fatal it reports", () => {
    expect(() => writeFatalSync("FATAL: crash", undefined, closedFd)).not.toThrow();
    expect(writes).toHaveLength(0);
  });
});
