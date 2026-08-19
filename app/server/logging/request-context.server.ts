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
 * Single-process app, so this is deliberately cheap: no sampling, no trace
 * propagation, no span tree. An inbound `X-Request-Id` (a proxy's, if one is
 * ever put in front) is reused so the id survives the hop.
 */

/** What a correlation field may hold: a log record is JSON, and correlation is
 *  the request's IDENTIFIERS (userId, runId, taskKey) plus counts/flags — never
 *  a payload. Anything richer belongs in the call site's own `fields`. */
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

/** Compact, log-greppable id. Not security-bearing — collisions only ever cost
 *  a confusing grep, so 12 hex chars is plenty. */
export function newRequestId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

/** The correlation seed for an inbound request: an upstream `X-Request-Id` when
 *  present, plus the method and path (never the query string — it can carry
 *  user data). */
export function correlationFor(request: Request): RequestCorrelation {
  const inbound = request.headers.get("X-Request-Id")?.trim();
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

/** The active request id, or null. */
export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

/**
 * Adds fields to the ACTIVE correlation, so everything logged later in the same
 * request carries them (e.g. `userId` once auth resolves, `runId` once a
 * runtime starts). No-op outside a request context, so call sites never need a
 * guard. `requestId` cannot be overwritten.
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
 * Route middleware that binds a correlation for the WHOLE request — loaders,
 * actions and the document render alike. `entry.server.tsx` binds the render
 * phase on its own (it is the only server entry point the app owns), but
 * loaders and actions run before it, so correlating those needs this mounted
 * once on the root route:
 *
 *   // app/root.tsx
 *   export const middleware = [requestContextMiddleware];
 *
 * Nested contexts are harmless: `entry.server.tsx` reuses the id already bound
 * here rather than minting a second one.
 */
export const requestContextMiddleware: MiddlewareFunction = (args, next) =>
  withRequestContext(args.request, next);
