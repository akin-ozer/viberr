import { PassThrough, Readable } from "node:stream";

import type {
  EntryContext,
  HandleDataRequestFunction,
  HandleErrorFunction,
  RouterContextProvider,
} from "react-router";
import { isRouteErrorResponse, ServerRouter } from "react-router";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import { renderToPipeableStream } from "react-dom/server";

import { bootServer } from "./server/boot.server";
import { logger } from "./server/logging/logger.server";
import {
  correlationFor,
  currentCorrelation,
  echoRequestId,
  REQUEST_ID_HEADER,
  runWithRequestContext,
} from "./server/logging/request-context.server";
import { toError } from "./shared/errors";

// One-time startup: validate env (fail fast) + open db and run migrations.
await bootServer();

export const streamTimeout = 5_000;

/**
 * Server error sink (F12-02). Without a `handleError`, React Router's default
 * logs EVERY handler error — including routine 404s — so each `/favicon.ico`
 * hit (browsers auto-request it; we ship `favicon.svg`, linked in root.tsx)
 * and every crawler probe of a stray path spams the log with a full
 * "No route matches URL …" entry. Swallow aborted requests (client navigated
 * away / stream timed out) and route-not-found 404s as routine; log everything
 * else through the app logger like the streaming-render path does.
 */
export const handleError: HandleErrorFunction = (error, { request }) => {
  if (request.signal.aborted) return;
  if (isRouteErrorResponse(error) && error.status === 404) return;
  // P13-D-30: this had `request` in scope and logged neither the URL nor an id,
  // so a 500 in the log could not be tied to the request that caused it. When a
  // correlation is already bound (root middleware, or the render below) the
  // logger merges it automatically; otherwise seed one from the request so the
  // record is never anonymous. `correlationFor` gives one Request one
  // correlation, so the seeded id is the one the response echoes (ruling
  // 458(d)).
  const bound = currentCorrelation();
  const log = bound ? logger : logger.child(correlationFor(request));
  log.error("request handler error", {
    err: toError(error),
  });
};

/**
 * Ruling 458(d): every `.data` response carries its request's id. Route
 * middleware already stamped each matched one with the same id, which is kept;
 * this covers the ones React Router answers without running it — an unmatched
 * URL, a 405, a mutation refused as a potential CSRF attack. It runs after the
 * middleware's context has ended, so the id comes from the Request itself,
 * which names the same id `handleError` logged for it.
 */
export const handleDataRequest: HandleDataRequestFunction = (
  response,
  { request },
) => echoRequestId(response, request);

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  // P13-D-30: bind the request correlation for the document render, so the
  // streaming-render logs below (and anything they reach) carry the same
  // `requestId` as the rest of the request. Re-uses the id when the root
  // middleware already bound one; mints one when it did not, so this entry
  // point is never uncorrelated on its own.
  const correlation = currentCorrelation() ?? correlationFor(request);
  // Ruling 458(d): the document carries its id. Route middleware stamps every
  // response it produces; this covers the documents React Router renders
  // without running it (an unmatched URL's 404, a 405).
  responseHeaders.set(REQUEST_ID_HEADER, correlation.requestId);
  return runWithRequestContext(correlation, () =>
    renderDocument(
      request,
      responseStatusCode,
      responseHeaders,
      routerContext,
      loadContext,
    ),
  );
}

function renderDocument(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: RouterContextProvider,
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false;
    const readyOption: keyof RenderToPipeableStreamOptions =
      routerContext.isSpaMode ? "onAllReady" : "onShellReady";

    // Abort the rendering stream after the `streamTimeout` so it has time to
    // flush down the rejected boundaries
    let timeoutId: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => abort(),
      streamTimeout + 1000,
    );

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              // Clear the timeout to prevent retaining the closure and memory leak
              clearTimeout(timeoutId);
              timeoutId = undefined;
              callback();
            },
          });
          // SAFETY: `Readable.toWeb` is declared to return the `node:stream/web`
          // ReadableStream, which is a SEPARATE declaration of the very class
          // the DOM lib names — one runtime constructor, two .d.ts files, so
          // `Response` (which wants the DOM one) accepts this object as-is. The
          // chunks are what `pipe(body)` writes into the PassThrough: Buffers,
          // i.e. Uint8Arrays.
          const stream = Readable.toWeb(body) as ReadableStream<Uint8Array>;

          responseHeaders.set("Content-Type", "text/html");

          pipe(body);

          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          // Log streaming rendering errors from inside the shell.  Don't log
          // errors encountered during initial shell rendering since they'll
          // reject and get logged in handleDocumentRequest.
          if (shellRendered) {
            logger.error("streaming render error", {
              err: toError(error),
            });
          }
        },
      },
    );
  });
}
