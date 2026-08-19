import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { logger } from "./logger.server";
import {
  bindCorrelation,
  correlationFor,
  currentRequestId,
  newRequestId,
  runWithRequestContext,
  withRequestContext,
} from "./request-context.server";

/**
 * P13-D-30: `architecture.md` promises request/job correlation identifiers in
 * the structured logs and prescribes this module. The affordance shipped once
 * as an opt-in `logger.child({ requestId })`, was never called, and was
 * deleted — so correlation is only real if it lands on records WITHOUT the
 * call site asking. These tests assert exactly that.
 */

/**
 * One captured stdout line, parsed back into the record the logger wrote: the
 * `{ level, time, msg }` envelope plus whatever correlation and call-site
 * fields were merged on top — `looseObject` keeps those, since they are exactly
 * what these cases assert on.
 */
const logRecordSchema = z.looseObject({
  level: z.string(),
  time: z.string(),
  msg: z.string(),
});
type LogRecord = z.infer<typeof logRecordSchema>;

function captureLog(fn: () => void): LogRecord[] {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.map((l) => logRecordSchema.parse(JSON.parse(l)));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("log correlation", () => {
  it("stamps requestId on every record inside a context, with no call-site work", () => {
    const records = captureLog(() => {
      runWithRequestContext(
        { requestId: "req_abc", method: "POST", path: "/projects/x" },
        () => {
          logger.info("first");
          logger.warn("second", { taskKey: "VIB-1" });
        },
      );
    });

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      msg: "first",
      requestId: "req_abc",
      method: "POST",
      path: "/projects/x",
    });
    expect(records[1]).toMatchObject({ msg: "second", requestId: "req_abc", taskKey: "VIB-1" });
  });

  it("leaves records outside a request untouched", () => {
    const records = captureLog(() => {
      logger.info("boot integrity check", { users: 3 });
    });
    expect(records[0]).toMatchObject({ msg: "boot integrity check", users: 3 });
    expect(records[0]).not.toHaveProperty("requestId");
  });

  it("lets an explicit field win over correlation (a domain id is never lost)", () => {
    const records = captureLog(() => {
      runWithRequestContext({ requestId: "req_1", path: "/a" }, () => {
        logger.info("run started", { path: "/deliberate" });
      });
    });
    expect(records[0]!.path).toBe("/deliberate");
    expect(records[0]!.requestId).toBe("req_1");
  });

  it("carries fields bound mid-request onto LATER records only", () => {
    const records = captureLog(() => {
      runWithRequestContext({ requestId: "req_2" }, () => {
        logger.info("before auth");
        bindCorrelation({ userId: "u_1", runId: "run_9" });
        logger.info("after auth");
      });
    });
    expect(records[0]).not.toHaveProperty("userId");
    expect(records[1]).toMatchObject({ userId: "u_1", runId: "run_9" });
  });

  it("refuses to let bindCorrelation overwrite the request id, and no-ops outside a request", () => {
    const records = captureLog(() => {
      runWithRequestContext({ requestId: "req_3" }, () => {
        bindCorrelation({ requestId: "spoofed", stage: "impl" });
        logger.info("x");
      });
      // Outside a context this must not throw — call sites carry no guard.
      bindCorrelation({ userId: "nobody" });
      logger.info("y");
    });
    expect(records[0]).toMatchObject({ requestId: "req_3", stage: "impl" });
    expect(records[1]).not.toHaveProperty("userId");
  });

  it("survives async boundaries within the request", async () => {
    const records: LogRecord[] = [];
    const lines: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        lines.push(String(chunk));
        return true;
      });
    await runWithRequestContext({ requestId: "req_async" }, async () => {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      logger.info("after await");
    });
    spy.mockRestore();
    records.push(...lines.map((l) => logRecordSchema.parse(JSON.parse(l))));
    expect(records[0]).toMatchObject({ requestId: "req_async" });
  });
});

describe("logger.child", () => {
  it("stamps bound fields on job paths that have no HTTP request", () => {
    const records = captureLog(() => {
      const runLog = logger.child({ runId: "run_1", backend: "codex" });
      runLog.info("run started");
      runLog.error("run failed", { runId: "run_override" });
    });
    expect(records[0]).toMatchObject({ runId: "run_1", backend: "codex" });
    // Explicit fields still win over bound ones.
    expect(records[1]).toMatchObject({ runId: "run_override", backend: "codex" });
  });
});

describe("correlationFor", () => {
  it("reuses an upstream X-Request-Id and never captures the query string", () => {
    const c = correlationFor(
      new Request("http://localhost/projects/x?token=secret", {
        method: "POST",
        headers: { "X-Request-Id": "upstream-42" },
      }),
    );
    expect(c).toEqual({
      requestId: "upstream-42",
      method: "POST",
      path: "/projects/x",
    });
  });

  it("mints an id when there is none, and rejects an absurdly long one", () => {
    const fresh = correlationFor(new Request("http://localhost/"));
    expect(fresh.requestId).toMatch(/^[0-9a-f]{12}$/);
    const long = correlationFor(
      new Request("http://localhost/", {
        headers: { "X-Request-Id": "x".repeat(200) },
      }),
    );
    expect(long.requestId).not.toContain("xxxx");
  });

  it("newRequestId is unique enough to grep by", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
    expect(ids.size).toBe(200);
  });
});

describe("withRequestContext", () => {
  it("binds a correlation seeded from the request", () => {
    const seen = withRequestContext(
      new Request("http://localhost/board", {
        headers: { "X-Request-Id": "req_from_header" },
      }),
      () => currentRequestId(),
    );
    expect(seen).toBe("req_from_header");
    expect(currentRequestId()).toBeNull();
  });
});
