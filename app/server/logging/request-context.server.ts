import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { MiddlewareFunction } from "react-router";

/**
 * Request/job correlation context (P13-D-30).
 *
 * `architecture.md` promises "structured JSON logs with request/job correlation
 * identifiers" and prescribes this module next to the logger. It shipped once
 * as a `logger.child({ requestId })` affordance, was never called from
 * anywhere, and was deleted — so of the server's `logger.*` sites, 75
 * hand-carried a domain id and 71 carried nothing, and there was no way to tie
 * a loader log to the render log of the same request.
 *
 * An `AsyncLocalStorage` holds one mutable correlation object per request. The
 * logger reads it on every record (see logger.server.ts), so a call site gets
 * correlation for free — the reason the previous attempt died is that it
 * required every call site to opt in.
 *
 * Ruling 458(d): a record also names WHO and WHAT is behind it. The session
 * guard binds `userId` once the session resolves (`require-user.server.ts`),
 * and a run's own work carries its `runId` and `taskKey` (`run-service`'s
 * `launch`). The id goes back out too: every response the app answers carries
 * it as `X-Request-Id` (this module's middleware, plus `entry.server.tsx` for
 * the responses React Router answers without route middleware), so a failure a
 * person reports can be matched to the server's log line.
 *
 * Single-process app, so this is deliberately cheap: no sampling, no trace
 * propagation, no span tree. An inbound `X-Request-Id` (a proxy's, if one is
 * ever put in front) is reused so the id survives the hop.
 */

/** The header that carries a request's id in (a proxy's) and out (ours). */
export const REQUEST_ID_HEADER = "X-Request-Id";

/** What a correlation field may hold: a log record is JSON, and correlation is
 *  the request's IDENTIFIERS (userId, runId, taskKey) plus counts/flags — never
 *  a payload, and never anything credential-shaped (a session token, a key).
 *  Anything richer belongs in the call site's own `fields`. */
export type CorrelationValue = string | number | boolean | null | undefined;

/** Correlation fields merged into every log record made inside the context.
 *  Mutable: `bindCorrelation` adds ids (userId, runId, taskKey) as a request
 *  learns them, and every LATER record in that request carries them. */
export interface RequestCorrelation {
  requestId: string;
  method?: string;
  path?: string;
  [field: string]: CorrelationValue;
}

const storage = new AsyncLocalStorage<RequestCorrelation>();

/** One correlation per inbound Request object, however many places seed it. */
const seeded = new WeakMap<Request, RequestCorrelation>();

/** Compact, log-greppable id. Not security-bearing — collisions only ever cost
 *  a confusing grep, so 12 hex chars is plenty. */
export function newRequestId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

/**
 * The correlation of an inbound request: an upstream `X-Request-Id` when
 * present, plus the method and path (never the query string — it can carry
 * user data).
 *
 * The same Request object always gets the same correlation. React Router hands
 * one Request to the route middleware, the entry's document render, its
 * `handleError` and its data hook, and a response the middleware never saw (an
 * unmatched `.data` URL, a refused mutation) is logged by `handleError` and
 * echoed by the data hook — so both must name ONE id, or the header would
 * point at a log line that does not exist.
 */
export function correlationFor(request: Request): RequestCorrelation {
  const known = seeded.get(request);
  if (known) return known;
  const inbound = request.headers.get(REQUEST_ID_HEADER)?.trim();
  let path: string | undefined;
  try {
    path = new URL(request.url).pathname;
  } catch {
    path = undefined;
  }
  const correlation: RequestCorrelation = {
    requestId: inbound && inbound.length <= 128 ? inbound : newRequestId(),
    method: request.method,
  };
  // A URL that would not parse has no path to correlate on — the key stays
  // ABSENT so the log record does not carry an empty `path`.
  if (path) correlation.path = path;
  seeded.set(request, correlation);
  return correlation;
}

/** Runs `fn` with `correlation` bound to the current async execution. */
export function runWithRequestContext<T>(
  correlation: RequestCorrelation,
  fn: () => T,
): T {
  return storage.run(correlation, fn);
}

/** {@link runWithRequestContext} seeded from an inbound Request. */
export function withRequestContext<T>(request: Request, fn: () => T): T {
  return storage.run(correlationFor(request), fn);
}

/** The active correlation, or undefined outside a request (boot, watchers,
 *  timers — those log with their own domain ids). */
export function currentCorrelation(): RequestCorrelation | undefined {
  return storage.getStore();
}

/** The active request id, or null outside a request. Ruling 458(d): the id
 *  {@link echoRequestId} answers with. */
export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

/**
 * Adds fields to the ACTIVE correlation, so everything logged later in the same
 * request carries them. Ruling 458(d): the session guard binds `userId` once
 * the session resolves, and `run-service`'s `launch` binds `runId` and
 * `taskKey` inside the run's own {@link forkCorrelation}. No-op outside a
 * request context, so call sites never need a guard. `requestId` cannot be
 * overwritten.
 */
export function bindCorrelation(
  fields: Record<string, CorrelationValue>,
): void {
  const store = storage.getStore();
  if (!store) return;
  for (const [key, value] of Object.entries(fields)) {
    if (key === "requestId") continue;
    store[key] = value;
  }
}

/**
 * Runs `fn` in its OWN copy of the active correlation: what `fn` binds, and what
 * its async work logs later, stays with it and never reaches the caller's
 * records. Every continuation of a request shares one correlation object, so
 * work that outlives the request and binds ids of its own (an agent run, whose
 * completion may start the next run in the same lineage) needs a copy, or the
 * newest binding would re-stamp every record of the work before it. Outside a
 * request it just runs `fn`.
 */
export function forkCorrelation<T>(fn: () => T): T {
  const store = storage.getStore();
  return store ? storage.run({ ...store }, fn) : fn();
}

/**
 * `fn`, bound to the correlation active NOW — or to none, outside a request —
 * wherever it later runs. For work parked now and run later from someone
 * else's continuation: a run queued behind the concurrency cap is launched by
 * whichever run frees the slot, and without this it would log under that run's
 * request and user.
 */
export function carryCorrelation<T>(fn: () => T): () => T {
  const store = storage.getStore();
  return store ? () => storage.run(store, fn) : () => storage.exit(fn);
}

/**
 * `response`, carrying its request's id as `X-Request-Id` (ruling 458(d)): the
 * active request's id, or, outside its context (React Router's data hook runs
 * after the middleware returned), the one {@link correlationFor} gives that
 * Request. Both name one id, the one the request's log records carry. A
 * response whose headers are immutable (`Response.redirect`, a proxied
 * `fetch`) is copied, since a throw here would answer with a 500 instead.
 */
export function echoRequestId(response: Response, request: Request): Response {
  const requestId = currentRequestId() ?? correlationFor(request).requestId;
  if (response.headers.get(REQUEST_ID_HEADER) === requestId) return response;
  try {
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.set(REQUEST_ID_HEADER, requestId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/**
 * Route middleware that binds a correlation for the WHOLE request — loaders,
 * actions and the document render alike — and echoes its id on the response
 * (ruling 458(d)). Mounted once, on the root route (`app/root.tsx`), so it
 * wraps every matched document, `.data` and resource-route request.
 * `entry.server.tsx` binds the render phase on its own as well, reusing the id
 * bound here, so the render and the data phase share it; it also stamps the
 * responses React Router answers without running route middleware (an
 * unmatched URL, a 405, a refused `.data` mutation).
 */
export const requestContextMiddleware: MiddlewareFunction<Response> = (
  args,
  next,
) =>
  withRequestContext(args.request, async () =>
    echoRequestId(await next(), args.request),
  );
