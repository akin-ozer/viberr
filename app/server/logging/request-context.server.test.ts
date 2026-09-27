import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { logger } from "./logger.server";
import {
  bindCorrelation,
  carryCorrelation,
  correlationFor,
  currentCorrelation,
  currentRequestId,
  echoRequestId,
  forkCorrelation,
  REQUEST_ID_HEADER,
  requestContextMiddleware,
  runWithRequestContext,
  type RequestCorrelation,
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
});

/**
 * Ruling 458(d): one Request names ONE id wherever it is seeded. React Router
 * hands the same Request to the route middleware, the entry's render, its
 * `handleError` and its data hook; a response the middleware never saw is
 * logged by one and echoed by another, so they must agree.
 */
describe("correlationFor keeps one correlation per Request (ruling 458(d))", () => {
  it("answers the same object for the same Request and a fresh id for another", () => {
    const request = new Request("http://localhost/board");
    const first = correlationFor(request);
    expect(correlationFor(request)).toBe(first);
    expect(correlationFor(new Request("http://localhost/board")).requestId).not.toBe(
      first.requestId,
    );
  });
});

describe("echoRequestId (ruling 458(d))", () => {
  it("stamps the request's id on the response it was handed", () => {
    const request = new Request("http://localhost/x");
    const response = new Response("ok");
    const echoed = echoRequestId(response, request);
    expect(echoed).toBe(response);
    expect(echoed.headers.get(REQUEST_ID_HEADER)).toBe(correlationFor(request).requestId);
  });

  it("names the id the request's context carries, inside or outside it", () => {
    const request = new Request("http://localhost/x", {
      headers: { "X-Request-Id": "req_upstream" },
    });
    const inside = runWithRequestContext(correlationFor(request), () =>
      echoRequestId(new Response("a"), request),
    );
    // Outside the context (React Router's data hook runs there).
    const outside = echoRequestId(new Response("b"), request);
    expect(inside.headers.get(REQUEST_ID_HEADER)).toBe("req_upstream");
    expect(outside.headers.get(REQUEST_ID_HEADER)).toBe("req_upstream");
  });

  it("copies a response whose headers are immutable instead of throwing", () => {
    const request = new Request("http://localhost/x");
    const redirect = Response.redirect("http://localhost/login", 302);
    const echoed = echoRequestId(redirect, request);
    expect(echoed).not.toBe(redirect);
    expect(echoed.status).toBe(302);
    expect(echoed.headers.get("Location")).toBe("http://localhost/login");
    expect(echoed.headers.get(REQUEST_ID_HEADER)).toBe(correlationFor(request).requestId);
  });

  it("replaces an id that is not this request's", () => {
    const request = new Request("http://localhost/x");
    const response = new Response("ok", { headers: { "X-Request-Id": "someone-else" } });
    expect(echoRequestId(response, request).headers.get(REQUEST_ID_HEADER)).toBe(
      correlationFor(request).requestId,
    );
  });
});

describe("requestContextMiddleware (ruling 458(d))", () => {
  it("binds the request's id for everything below it and answers with it", async () => {
    const request = new Request("http://localhost/projects/x", {
      headers: { "X-Request-Id": "req_mw" },
    });
    let seenBelow: string | null = null;
    const response = await requestContextMiddleware(
      {
        request,
        url: new URL(request.url),
        params: {},
        pattern: "/",
        context: new RouterContextProvider(),
      },
      async () => {
        seenBelow = currentRequestId();
        return new Response("page");
      },
    );
    expect(seenBelow).toBe("req_mw");
    expect(response instanceof Response ? response.headers.get(REQUEST_ID_HEADER) : null).toBe(
      "req_mw",
    );
    // The binding ends with the request: nothing after it inherits its id.
    expect(currentRequestId()).toBeNull();
  });
});

/**
 * Ruling 458(d): a run binds its runId and taskKey on its own work. Every
 * continuation of a request shares one correlation object, so the run gets a
 * copy (`forkCorrelation`); a run parked behind the concurrency cap is launched
 * from another run's continuation, so it takes its own request's correlation
 * with it (`carryCorrelation`).
 */
describe("forkCorrelation and carryCorrelation (ruling 458(d))", () => {
  /** What a log record made now would carry, copied (the live object mutates). */
  function copyOfCurrent(): RequestCorrelation | undefined {
    const current = currentCorrelation();
    return current ? { ...current } : undefined;
  }

  it("a fork's bindings stay with the fork, and its async work keeps them", async () => {
    const seen: Array<RequestCorrelation | undefined> = [];
    await runWithRequestContext({ requestId: "req_fork", userId: "u_1" }, async () => {
      const later = forkCorrelation(() => {
        bindCorrelation({ runId: "run_a" });
        return new Promise<void>((resolve) =>
          setTimeout(() => {
            seen.push(copyOfCurrent());
            resolve();
          }, 1),
        );
      });
      forkCorrelation(() => bindCorrelation({ runId: "run_b" }));
      seen.push(copyOfCurrent());
      await later;
    });
    // The request's own record carries neither run; run_a's later work is not
    // re-stamped by run_b.
    expect(seen).toEqual([
      { requestId: "req_fork", userId: "u_1" },
      { requestId: "req_fork", userId: "u_1", runId: "run_a" },
    ]);
  });

  it("outside a request a fork just runs, and binds nothing", () => {
    const seen = forkCorrelation(() => {
      bindCorrelation({ runId: "run_x" });
      return currentCorrelation();
    });
    expect(seen).toBeUndefined();
  });

  it("a carried thunk runs in the correlation it was made in, wherever it is called", () => {
    const parked = runWithRequestContext({ requestId: "req_parker", userId: "u_p" }, () =>
      carryCorrelation(copyOfCurrent),
    );
    const orphan = carryCorrelation(() => currentCorrelation());
    runWithRequestContext({ requestId: "req_freer", userId: "u_f", runId: "run_f" }, () => {
      expect(parked()).toEqual({ requestId: "req_parker", userId: "u_p" });
      // Made outside any request: it runs outside one too.
      expect(orphan()).toBeUndefined();
    });
  });
});
